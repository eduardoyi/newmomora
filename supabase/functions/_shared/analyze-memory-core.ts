// Full analysis logic for `analyze-memory` / `analyze-emotion`
// (docs/plans/memory-book.md §5 Stage A). One multimodal OpenAI call per
// memory producing emotion, topics, labels, description, and a milestone
// claim; every axis is post-processed here in code, never trusted verbatim
// from the model (topic vocabulary validation, date gating, the milestone
// explicit-text-only rule, age-band plausibility, deterministic birthday
// resolution). Ported from the validated V1c eval
// (supabase/scripts/eval-memory-book-tagging.ts) -- this is the production
// counterpart, wired to the real database instead of markdown docs.
//
// PII rule (hard, repo-wide): memory content, captions, transcripts,
// descriptions, and labels must never appear in console.log/console.error --
// ids and error codes only. Every log call in this file is audited against
// that rule; keep it that way when extending.
import {
  buildMemoryContext,
  computeBirthdayMatch,
  gateTopicsByDate,
  formatMemoryContextForPrompt,
  type FamilyMemberForContext,
} from './date-context.ts';
import {
  formatMilestoneCatalogForPrompt,
  getMilestoneById,
  milestonesInBand,
  type AgeBandMonths,
  type MilestoneDefinition,
} from './memory-milestones.ts';
import {
  NEGATIVE_EXAMPLES,
  TOPIC_IDS,
  TOPICS,
  TOPICS_REQUIRING_DETAIL,
  TOPICS_VERSION,
  type TopicDefinition,
} from './memory-topics.ts';
import { stripUrls } from './link-preview.ts';
import { normalizeEmotionLabel, prepareVisionImageFromBytes } from './media-emotion.ts';
import { chatJsonWithVisionMulti, type ChatVisionUsage, type VisionImageInput } from './openai.ts';
import { EMOTION_PALETTES } from './prompts.ts';
import { getObjectBytes } from './r2.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ── Public input/output shapes ──────────────────────────────────────────

export interface MemoryForAnalysis {
  id: string;
  content: string | null;
  memoryType: string;
  /** `YYYY-MM-DD`. */
  memoryDate: string;
  audioTranscript: string | null;
}

export interface MediaAssetForAnalysis {
  objectKey: string;
  contentType: string;
  position: number;
  previewObjectKey: string | null;
}

export interface TaggedMemberForAnalysis {
  id: string;
  name: string;
  dateOfBirth: string | null;
}

export interface MemoryMilestoneWrite {
  milestoneId: string;
  detail: string | null;
  outOfBand: boolean;
  familyMemberId: string | null;
}

export type MemoryAnalysisResult =
  | { skipped: true }
  | {
      skipped: false;
      emotion: string;
      colorPalette: string;
      topics: TopicAssignment[];
      topicDetails: Record<string, string>;
      labels: string[];
      description: string;
      milestones: MemoryMilestoneWrite[];
      /** Token usage from the one OpenAI call, when the provider reported
       * it. Consumed by the backfill script's cost/summary reporting
       * (supabase/scripts/backfill-memory-analysis.ts); the Edge Function
       * handlers don't use it (no response contract change). */
      usage: ChatVisionUsage | null;
    };

export interface RunMemoryAnalysisInput {
  memory: MemoryForAnalysis;
  taggedMembers: TaggedMemberForAnalysis[];
  /** Ordered by `position` ascending -- callers must sort before calling. */
  media: MediaAssetForAnalysis[];
}

// ── Image candidate selection (ported from selectImageCandidates in
// supabase/scripts/eval-memory-book-tagging.ts) ─────────────────────────

export type ImageSource =
  | 'preview'
  | 'fallback_original'
  | 'skipped_heic_no_preview'
  | 'skipped_video_no_poster'
  | 'skipped_unsupported';

export interface ImageCandidate {
  source: ImageSource;
  objectKey: string | null;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | null;
}

const FALLBACK_ORIGINAL_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_ANALYSIS_IMAGES = 4;

/**
 * Prefers `preview_object_key` for every media row (present for both photo
 * previews and video poster frames, always JPEG). Falls back to the
 * original ONLY for jpeg/png/webp photos with no preview; HEIC/HEIF
 * originals with no preview and videos with no poster are skipped (never
 * fetched) -- this is what makes a video WITH a backfilled poster usable
 * (closes the "video has no emotion in MVP" gap) while a video with no
 * poster degrades the same way a HEIC-with-no-preview photo does.
 */
export function selectImageCandidates(media: MediaAssetForAnalysis[]): ImageCandidate[] {
  return media.map((row) => {
    if (row.previewObjectKey) {
      return { source: 'preview', objectKey: row.previewObjectKey, contentType: 'image/jpeg' };
    }

    if (FALLBACK_ORIGINAL_CONTENT_TYPES.has(row.contentType)) {
      return {
        source: 'fallback_original',
        objectKey: row.objectKey,
        contentType: row.contentType as 'image/jpeg' | 'image/png' | 'image/webp',
      };
    }

    const isVideo = row.contentType.startsWith('video/');
    return { source: isVideo ? 'skipped_video_no_poster' : 'skipped_heic_no_preview', objectKey: null, contentType: null };
  });
}

// ── Per-memory-type input building (plan brief: "text memories -> text
// only; media memories -> up to 4 images ... plus caption text; audio
// memories -> audio_transcript as text input (no images)") ─────────────

export interface AnalysisTextAndImages {
  text: string | null;
  imageCandidates: ImageCandidate[];
}

export function buildAnalysisInput(
  memoryType: string,
  content: string | null,
  audioTranscript: string | null,
  media: MediaAssetForAnalysis[],
): AnalysisTextAndImages {
  if (memoryType === 'text_illustration' || memoryType === 'text_only') {
    const stripped = content ? stripUrls(content).trim() : '';
    return { text: stripped || null, imageCandidates: [] };
  }

  if (memoryType === 'audio') {
    // Mirrors buildAudioEmotionClassifierInput's existing skip logic
    // (docs/features/audio-memories.md): either the visible description or
    // the invisible transcript alone is enough; both empty is a no-op skip,
    // never an error.
    const strippedContent = content ? stripUrls(content).trim() : '';
    const strippedTranscript = audioTranscript ? stripUrls(audioTranscript).trim() : '';
    const combined = [strippedContent, strippedTranscript].filter(Boolean).join(' ');
    return { text: combined || null, imageCandidates: [] };
  }

  // 'media': caption text plus up to 4 usable images by position.
  const stripped = content ? stripUrls(content).trim() : '';
  const candidates = selectImageCandidates(media)
    .filter((candidate) => candidate.objectKey !== null)
    .slice(0, MAX_ANALYSIS_IMAGES);
  return { text: stripped || null, imageCandidates: candidates };
}

// ── Topic parsing + validation (ported from parseTopics in
// eval-memory-book-tagging.ts, bound to the production vocabulary) ──────

export interface TopicAssignment {
  id: string;
  detail: string | null;
}

const MAX_TOPICS = 3;

function normalizeTopicId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function firstStringValue(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

const REJECTED_ITEM_PREVIEW_MAX_CHARS = 60;

function previewRejectedItem(item: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(item) ?? String(item);
  } catch {
    json = String(item);
  }
  return json.length > REJECTED_ITEM_PREVIEW_MAX_CHARS
    ? `${json.slice(0, REJECTED_ITEM_PREVIEW_MAX_CHARS)}…`
    : json;
}

export interface ParsedTopics {
  topics: TopicAssignment[];
  rejectedIds: string[];
  missingDetailIds: string[];
}

/**
 * Tolerant by design (models don't reliably follow the requested
 * `{"id": string, "detail": string|null}` shape): a bare string item is
 * read as the id directly; an object item's id is read from
 * `id ?? topic ?? name ?? theme`. Every resolved id is normalized before
 * the vocabulary check. An id not in the approved vocabulary (even after
 * normalization) is dropped and recorded in `rejectedIds`; a required-detail
 * topic missing its detail is KEPT (the assignment may still be right even
 * if the model forgot the detail) but recorded in `missingDetailIds`. Caps
 * at MAX_TOPICS after validation.
 */
export function parseTopics(value: unknown): ParsedTopics {
  const topics: TopicAssignment[] = [];
  const rejectedIds: string[] = [];
  const missingDetailIds: string[] = [];

  if (!Array.isArray(value)) {
    return { topics, rejectedIds, missingDetailIds };
  }

  for (const item of value) {
    let rawId: string | null = null;
    let rawDetail: string | null = null;

    if (typeof item === 'string') {
      rawId = item;
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      rawId = firstStringValue([o.id, o.topic, o.name, o.theme]);
      rawDetail = firstStringValue([o.detail, o.note]);
    }

    if (!rawId) {
      rejectedIds.push(previewRejectedItem(item));
      continue;
    }

    const normalizedId = normalizeTopicId(rawId);

    if (!TOPIC_IDS.has(normalizedId)) {
      rejectedIds.push(normalizedId);
      continue;
    }

    const requiresDetail = TOPICS_REQUIRING_DETAIL.has(normalizedId);
    const detail = requiresDetail && rawDetail ? rawDetail.trim() || null : null;

    if (requiresDetail && !detail) {
      missingDetailIds.push(normalizedId);
    }

    topics.push({ id: normalizedId, detail });
  }

  return { topics: topics.slice(0, MAX_TOPICS), rejectedIds, missingDetailIds };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

const MAX_LABELS = 10;

// ── Milestone claim parsing ──────────────────────────────────────────────

export interface ParsedMilestoneClaim {
  claim: string;
  catalogId: string | null;
  detail: string | null;
}

export function parseMilestoneClaim(value: unknown): ParsedMilestoneClaim | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj.claim !== 'string' || !obj.claim.trim()) {
    return null;
  }

  const rawCatalogId = typeof obj.catalog_id === 'string' ? obj.catalog_id : null;
  const catalogId = rawCatalogId && getMilestoneById(rawCatalogId) ? rawCatalogId : null;
  const detail = typeof obj.detail === 'string' && obj.detail.trim() ? obj.detail.trim() : null;

  return { claim: obj.claim.trim(), catalogId, detail };
}

// ── Full model-output parsing ────────────────────────────────────────────

export interface ParsedMemoryAnalysisOutput {
  topics: TopicAssignment[];
  topicsRejected: string[];
  topicsMissingDetail: string[];
  labels: string[];
  description: string;
  emotion: string;
  colorPalette: string;
  milestoneClaim: ParsedMilestoneClaim | null;
}

export function parseMemoryAnalysisModelOutput(raw: unknown): ParsedMemoryAnalysisOutput {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const { topics, rejectedIds, missingDetailIds } = parseTopics(obj.topics);
  const labels = toStringArray(obj.labels).slice(0, MAX_LABELS);
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  const normalized = normalizeEmotionLabel(typeof obj.emotion === 'string' ? obj.emotion : undefined, EMOTION_PALETTES);
  const milestoneClaim = parseMilestoneClaim(obj.milestone);

  return {
    topics,
    topicsRejected: rejectedIds,
    topicsMissingDetail: missingDetailIds,
    labels,
    description,
    emotion: normalized.emotion,
    colorPalette: normalized.colorPalette,
    milestoneClaim,
  };
}

// ── Milestone resolution (age-band plausibility + deterministic birthday) ─

function memberFitsBand(ageMonths: number | null, band: AgeBandMonths): boolean {
  if (band.min === null || band.max === null) {
    return true; // `any`-band milestone.
  }
  if (ageMonths === null) {
    return false;
  }
  return ageMonths >= band.min && ageMonths <= band.max;
}

/**
 * Age-band check sets `out_of_band` rather than rejecting the claim (plan
 * brief -- parents backfill old memories; dates can be approximate).
 * `family_member_id` is set only when EXACTLY ONE tagged member fits the
 * band; zero or multiple fits leave it null (ambiguous or nobody plausible).
 */
function resolveMilestoneMembership(
  taggedMembersWithAge: Array<{ id: string; ageMonths: number | null }>,
  band: AgeBandMonths,
): { outOfBand: boolean; familyMemberId: string | null } {
  const fitting = taggedMembersWithAge.filter((member) => memberFitsBand(member.ageMonths, band));
  return {
    outOfBand: fitting.length === 0,
    familyMemberId: fitting.length === 1 ? fitting[0].id : null,
  };
}

/**
 * The catalog subset relevant to this memory's tagged members (plan brief:
 * "the child's age on memory_date filters the catalog to in-band entries
 * before the model call; any-band entries are always included"). Unions
 * each tagged member's in-band set -- an adult tagged alongside a child
 * naturally contributes only the `any`-band entries, since no finite band
 * in the catalog reaches adult ages. Falls back to the `any`-band-only set
 * when no member is tagged at all.
 */
export function buildRelevantMilestoneCatalog(
  taggedMembersWithAge: Array<{ ageMonths: number | null }>,
): MilestoneDefinition[] {
  if (taggedMembersWithAge.length === 0) {
    return milestonesInBand(null);
  }

  const byId = new Map<string, MilestoneDefinition>();
  for (const member of taggedMembersWithAge) {
    for (const entry of milestonesInBand(member.ageMonths)) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}

export interface ComputeMilestoneRowsInput {
  /** Explicit-text-only gate: when false, `milestoneClaim` is ignored even
   * if the model returned one -- a photo-only memory must never produce a
   * milestone claim from the claim path (the deterministic birthday path
   * below is the one sanctioned non-text exception). */
  textPresent: boolean;
  milestoneClaim: ParsedMilestoneClaim | null;
  topics: TopicAssignment[];
  taggedMembersWithAge: Array<{ id: string; ageMonths: number | null }>;
  taggedMembersForBirthday: FamilyMemberForContext[];
  memoryDate: string;
}

/**
 * Builds the milestone rows to upsert for this memory. Two independent
 * sources, merged by `milestone_id` (the deterministic birthday computation
 * wins over a claim-based `birthday` row when both fire, since it carries
 * an exact age-turned and family_member_id rather than a paraphrase):
 *
 * 1. The model's explicit-text claim, if any, validated against the
 *    catalog and age-band-checked.
 * 2. The deterministic birthday match (plan brief): when a tagged child's
 *    birthday anniversary (ageTurned >= 1) is within +/-7 days of
 *    memory_date AND (the model tagged `birthday` OR the text explicitly
 *    says so -- satisfied here by the model's OWN milestone claim resolving
 *    to catalog_id `birthday`, which is itself explicit-text-only by
 *    construction), upsert a `birthday` row with detail = age turned and
 *    family_member_id = that child. This is a database fact lookup, not
 *    model inference, so it does not violate the explicit-text-only rule.
 */
export function computeMilestoneRows(input: ComputeMilestoneRowsInput): MemoryMilestoneWrite[] {
  const rows = new Map<string, MemoryMilestoneWrite>();

  if (input.textPresent && input.milestoneClaim?.catalogId) {
    const catalogEntry = getMilestoneById(input.milestoneClaim.catalogId);
    if (catalogEntry) {
      const { outOfBand, familyMemberId } = resolveMilestoneMembership(
        input.taggedMembersWithAge,
        catalogEntry.ageBandMonths,
      );
      rows.set(catalogEntry.id, {
        milestoneId: catalogEntry.id,
        detail: input.milestoneClaim.detail,
        outOfBand,
        familyMemberId,
      });
    }
  }

  const topicsIncludeBirthday = input.topics.some((topic) => topic.id === 'birthday');
  const textIndicatesBirthday = input.textPresent && input.milestoneClaim?.catalogId === 'birthday';

  if (topicsIncludeBirthday || textIndicatesBirthday) {
    const { birthdayMatch } = computeBirthdayMatch(input.taggedMembersForBirthday, input.memoryDate);
    if (birthdayMatch) {
      rows.set('birthday', {
        milestoneId: 'birthday',
        detail: String(birthdayMatch.ageTurned),
        outOfBand: false,
        familyMemberId: birthdayMatch.memberId,
      });
    }
  }

  return [...rows.values()];
}

// ── Prompt construction ───────────────────────────────────────────────────
//
// Ported from the validated V1c controlled-mode eval prompt
// (supabase/scripts/eval-memory-book-tagging.ts's buildSystemPrompt /
// buildTopicsInstruction) with one deliberate addition: the photo-alone
// calibration line below. Two hard-won lessons from that eval carry over
// unchanged: (a) the topic vocabulary list sits IMMEDIATELY after the topics
// instruction -- an earlier draft with the vocabulary at prompt end (after
// the milestone catalog) collapsed coverage from 30% to 2%; (b) the
// instruction is example-led ("topics": ["beach", "grandparents"], "most
// family memories match 1-2 topics"). This lives here rather than in
// prompts.ts because prompts.ts is also imported (extension-less) by the
// Cloudflare illustration worker's Node/tsc build, which cannot resolve a
// Deno-style `.ts`-suffixed relative import -- keeping every
// memory-topics.ts/memory-milestones.ts import inside this Deno-only module
// avoids coupling that unrelated build to this feature's dependency graph.

function formatTopicVocabularyForPrompt(topics: readonly TopicDefinition[]): string {
  return topics.map((topic) => `${topic.id} — ${topic.pageTitle}: ${topic.definition}`).join('\n');
}

function buildTopicsInstructionLines(topics: readonly TopicDefinition[]): string[] {
  const detailIds = [...TOPICS_REQUIRING_DETAIL].join(', ');

  return [
    `- \`topics\`: choose from the TOPIC VOCABULARY below -- output the matching ids as an array, e.g. "topics": ["beach", "grandparents"]. Most family memories match 1-2 topics; look for the place, activity, occasion, or people-context in the images and text. Use an empty list only when nothing in the vocabulary fits. Items may be bare id strings; use {"id": ..., "detail": ...} only for ${detailIds}, where \`detail\` (a canonical English name, e.g. "Passover", "July 4th") is required.`,
    // The one deliberate prompt change vs the eval (implementation brief):
    // a photo alone is sufficient evidence for place/activity topics --
    // captions are not required.
    '- A photo alone is sufficient evidence for a place or activity topic (e.g. a beach photo with no caption still supports `beach`). Do not withhold a clearly-depicted place/activity topic just because there is no caption confirming it.',
    '',
    'TOPIC VOCABULARY (choose ids from this list only):',
    formatTopicVocabularyForPrompt(topics),
    '',
    `Do not invent ids outside the list. Abstract concepts like ${NEGATIVE_EXAMPLES.join(', ')} are not in the vocabulary on purpose -- when a memory is only that, leave topics empty rather than forcing a bad fit.`,
  ];
}

/**
 * The single system prompt for `analyze-memory`'s one multimodal OpenAI
 * call: emotion + topics + labels + description + milestone claim, all in
 * one response. `milestoneCatalog` should already be filtered to the
 * tagged members' age bands (`milestonesInBand`, unioned across tagged
 * members via `buildRelevantMilestoneCatalog` below) before being passed in
 * here -- a smaller, more relevant catalog per call, per the plan brief.
 */
export function buildMemoryAnalysisSystemPrompt(input: {
  topics: readonly TopicDefinition[];
  milestoneCatalog: readonly MilestoneDefinition[];
}): string {
  const emotionList = Object.keys(EMOTION_PALETTES).join(', ');

  const lines = [
    "You are tagging entries from a family's private memory journal (a parent app). Entries may be in any language (often Spanish or English); always answer in lowercase English, except a topic or milestone `detail` naming a specific person, place, or proper noun. You receive: the entry date, the people tagged (with ages, child/adult, days to their birthday), nearby holidays, the parent's text (may be absent), and up to 4 photos or video frames (may be absent). Return strict JSON with these fields:",
    '',
    ...buildTopicsInstructionLines(input.topics),
    '- `labels`: 3-10 concrete descriptive labels for search (objects, setting, activities, weather, food items, animals...).',
    '- `description`: one dense, neutral factual sentence describing the entry; may use tagged first names. This is never shown to the parent -- write for future search, not for display.',
    `- \`emotion\`: exactly one of [${emotionList}], judged from text and images together; videos/photos without text still get an emotion. Parenting is not always joyful -- when the moment is genuinely hard, name it honestly (worry, weary, sad, bittersweet) rather than rounding up to a positive emotion.`,
    '- `milestone`: null, or {"claim": short paraphrase, "catalog_id": one of the provided catalog ids or null, "detail": string|null}. STRICT RULE: a milestone exists ONLY when the parent\'s TEXT explicitly records a first/milestone ("first steps", "dijo su primera palabra", "turned three"). Never infer a milestone from images, dates, or ages. If there is no text, milestone must be null.',
    '',
    'Milestone catalog (id — name (age band)):',
    formatMilestoneCatalogForPrompt(input.milestoneCatalog),
  ];

  return lines.join('\n');
}

// ── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Runs the full analysis pass for one memory: builds the per-type input,
 * fetches and prepares up to 4 images (best-effort per image -- a single
 * unfetchable or oversized/unsupported image is skipped rather than failing
 * the whole call, so 3 good photos still produce a full analysis when a 4th
 * is bad), makes the one multimodal OpenAI call, and post-processes every
 * axis in code (topic vocabulary + date gating, milestone explicit-text-only
 * + age-band + deterministic birthday). Returns `{skipped: true}` (no
 * OpenAI call made) when there is neither text nor a usable image --
 * success-shaped, mirroring the existing audio "both empty" contract, never
 * an error.
 */
export async function runMemoryAnalysis(input: RunMemoryAnalysisInput): Promise<MemoryAnalysisResult> {
  const { memory, taggedMembers, media } = input;
  const { text, imageCandidates } = buildAnalysisInput(
    memory.memoryType,
    memory.content,
    memory.audioTranscript,
    media,
  );

  const preparedImages: VisionImageInput[] = [];
  for (const candidate of imageCandidates) {
    if (!candidate.objectKey || !candidate.contentType) continue;
    try {
      const bytes = await getObjectBytes(candidate.objectKey);
      const prepared = await prepareVisionImageFromBytes(bytes, candidate.contentType);
      if ('code' in prepared) {
        // Unsupported format or too large -- skip this one image; others
        // (or the caption) may still carry the analysis.
        continue;
      }
      preparedImages.push(prepared);
    } catch (error) {
      console.error('analyze-memory image fetch failed', memory.id, error instanceof Error ? error.message : 'unknown');
    }
  }

  if (!text && preparedImages.length === 0) {
    return { skipped: true };
  }

  const memoryContext = buildMemoryContext(
    memory.memoryDate,
    taggedMembers.map((member) => ({ id: member.id, name: member.name, dateOfBirth: member.dateOfBirth })),
  );
  const taggedMembersWithAge = memoryContext.members.map((member) => ({
    id: member.memberId,
    ageMonths: member.ageMonths,
  }));
  const relevantMilestoneCatalog = buildRelevantMilestoneCatalog(taggedMembersWithAge);

  const systemPrompt = buildMemoryAnalysisSystemPrompt({ topics: TOPICS, milestoneCatalog: relevantMilestoneCatalog });
  const contextText = formatMemoryContextForPrompt(memoryContext);
  const userText = `${contextText}\n\nParent's text:\n${text ?? '(no text)'}`;

  const { data: raw, usage } = await chatJsonWithVisionMulti<Record<string, unknown>>(
    systemPrompt,
    userText,
    preparedImages,
  );
  const parsed = parseMemoryAnalysisModelOutput(raw);

  const textPresent = Boolean(text);
  // Explicit-text-only rule: no text -> no milestone, even if the model
  // claims one.
  const milestoneClaim = textPresent ? parsed.milestoneClaim : null;

  const { topics: dateGatedTopics } = gateTopicsByDate(parsed.topics, memory.memoryDate);

  const topicDetails: Record<string, string> = {};
  for (const topic of dateGatedTopics) {
    if (topic.detail) {
      topicDetails[topic.id] = topic.detail;
    }
  }

  const milestones = computeMilestoneRows({
    textPresent,
    milestoneClaim,
    topics: dateGatedTopics,
    taggedMembersWithAge,
    taggedMembersForBirthday: taggedMembers,
    memoryDate: memory.memoryDate,
  });

  return {
    skipped: false,
    emotion: parsed.emotion,
    colorPalette: parsed.colorPalette,
    topics: dateGatedTopics,
    topicDetails,
    labels: parsed.labels,
    description: parsed.description,
    milestones,
    usage,
  };
}

// ── Persistence helpers (shared by the Edge Function handlers and the
// archive backfill script -- supabase/scripts/backfill-memory-analysis.ts,
// docs/plans/memory-book.md V1 exit backfill) ───────────────────────────
//
// Typed against the plain `SupabaseClient` shape rather than
// `ReturnType<typeof createUserClient>`/`createServiceClient` so either
// caller's client (user-scoped for the Edge Function, service-role for the
// ops script) satisfies these signatures without an adapter.

/**
 * Tagged members for a memory's structured context + milestone resolution.
 * Read-only; caller supplies whichever client is appropriate for its
 * authorization model (RLS-scoped for the Edge Function, service-role for
 * the backfill script).
 */
export async function fetchTaggedMembers(
  supabase: SupabaseClient,
  memoryId: string,
): Promise<TaggedMemberForAnalysis[]> {
  const { data: tagRows, error: tagError } = await supabase
    .from('memory_family_members')
    .select('family_member_id')
    .eq('memory_id', memoryId);

  if (tagError) {
    console.error('analyze-memory tag lookup failed', memoryId, tagError.message);
    throw tagError;
  }

  const memberIds = (tagRows ?? []).map((row) => row.family_member_id as string);
  if (memberIds.length === 0) {
    return [];
  }

  const { data: memberRows, error: memberError } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth')
    .in('id', memberIds);

  if (memberError) {
    console.error('analyze-memory member lookup failed', memoryId, memberError.message);
    throw memberError;
  }

  return ((memberRows ?? []) as Array<{ id: string; name: string; date_of_birth: string | null }>).map((row) => ({
    id: row.id,
    name: row.name,
    dateOfBirth: row.date_of_birth,
  }));
}

export interface MemoryAnalysisWriteResult {
  emotion: string;
  topics: TopicAssignment[];
  topicDetails: Record<string, string>;
  labels: string[];
  description: string;
}

/**
 * Guarded compare-and-set write: `emotion`, `topics`, `topic_details`,
 * `labels`, `description`, `analysis_version` (= `TOPICS_VERSION`), and
 * `analyzed_at`, matched on `updated_at` so a concurrent content edit can
 * never be silently clobbered by an analysis pass that ran against
 * now-superseded content. Returns whether the write actually landed.
 */
export async function updateMemoryAnalysisIfSnapshotMatches(
  supabase: SupabaseClient,
  memoryId: string,
  result: MemoryAnalysisWriteResult,
  snapshot: { updated_at: string; content: string | null },
): Promise<boolean> {
  const query = supabase
    .from('memories')
    .update({
      emotion: result.emotion,
      topics: result.topics.map((topic) => topic.id),
      topic_details: result.topicDetails,
      labels: result.labels,
      description: result.description,
      analysis_version: TOPICS_VERSION,
      analyzed_at: new Date().toISOString(),
    })
    .eq('id', memoryId)
    .eq('updated_at', snapshot.updated_at);

  const { data, error } = await query.select('id').maybeSingle();

  if (error) {
    console.error('analyze-memory analysis update failed', memoryId, error.message);
    throw error;
  }

  return Boolean(data);
}

/**
 * Upserts candidate/confirmed milestone rows (unique on memory_id +
 * milestone_id -- re-analysis replaces a memory's prior milestone rows for
 * ids it still claims, and simply doesn't touch ids it no longer claims).
 * Callers should only invoke this after a snapshot-guarded write succeeds:
 * a discarded stale write means this analysis ran against superseded
 * content, so writing milestones derived from it would be writing derived
 * facts about text that no longer exists. Non-fatal on failure -- the
 * emotion/topics write already succeeded; milestone bookkeeping failing
 * must not fail the whole request/run.
 */
export async function upsertMemoryMilestones(
  serviceClient: SupabaseClient,
  memoryId: string,
  familyId: string,
  milestones: MemoryMilestoneWrite[],
): Promise<void> {
  if (milestones.length === 0) {
    return;
  }

  const { error } = await serviceClient.from('memory_milestones').upsert(
    milestones.map((milestone) => ({
      memory_id: memoryId,
      family_id: familyId,
      family_member_id: milestone.familyMemberId,
      milestone_id: milestone.milestoneId,
      detail: milestone.detail,
      out_of_band: milestone.outOfBand,
    })),
    { onConflict: 'memory_id,milestone_id' },
  );

  if (error) {
    console.error('analyze-memory milestone upsert failed', memoryId, error.message);
  }
}
