/**
 * Memory Book outline.json parsing + manifest.json shaping -- runtime-
 * agnostic shared logic (V5a slice, "part B": extracted verbatim out of
 * `supabase/scripts/eval-memory-book-assets.ts` so a Cloudflare Workflow
 * worker can eventually import it too, same precedent as
 * `cloudflare/memory-illustration-worker/src/workflow.ts` importing
 * `../../../supabase/functions/_shared/prompts.ts`).
 *
 * This module holds ONLY the pure shape-describing pieces: parsing/
 * validating `outline.json` (the outline run's own output --
 * `eval-memory-book-outline.ts`'s reading-order contract), merging its
 * top-level candidate id arrays, and assembling `manifest.json` -- the
 * verbatim consumer contract `book-renderer/src/model/types.ts`'s
 * `BookManifest` reads from disk (asset entries incl. `originalWidth`/
 * `originalHeight`, milestones, tagged members, illustrations, memories,
 * portraits, share tokens, and the top-level manifest itself). It
 * deliberately does NOT include: CLI argument parsing, Supabase/R2 data
 * loading, R2 downloads/retries, ffmpeg poster-frame extraction, or any
 * other IO -- those stay in the eval script (and will get their own
 * production home in the worker) since they differ per runtime. No
 * `Deno.*` globals here -- plain TS + `crypto.getRandomValues` (available
 * in every modern JS runtime, not Deno-specific) only, so Deno scripts,
 * Supabase Edge Functions, and Cloudflare Workers can all import this file
 * unchanged.
 *
 * `supabase/scripts/eval-memory-book-assets.ts` is the CLI wrapper around
 * this module (DB/R2 reads, media/illustration/portrait downloads, video
 * poster-frame extraction, download retries, and console output all stay
 * there) -- see that file's own header comment for the full pipeline this
 * is one stage of.
 */
import { classifyChildOrAdult } from './date-context.ts';
import { describeAgeAtDate, getAgeInYearsAtDate } from './age.ts';
import { getMilestoneById } from './memory-milestones.ts';

// ── outline.json parsing (fail loudly on a shape mismatch rather than
// guess) ─────────────────────────────────────────────────────────────────

export interface OutlineChild {
  id: string;
  name: string;
}

export interface OutlineScope {
  type: string;
}

export interface OutlineWindow {
  /** Inclusive. */
  start: string;
  /** Exclusive. */
  endExclusive: string;
  label: string;
}

export interface OutlineElementLike {
  id: string;
  kind: string;
  memoryIds: string[];
}

export interface ParsedOutline {
  runId: string;
  child: OutlineChild;
  scope: OutlineScope;
  window: OutlineWindow;
  elements: OutlineElementLike[];
  /** Top-level candidate id arrays (panorama/hero/cover treatment) -- may
   * not have made the backbone cut, so they don't necessarily appear in any
   * element's `memoryIds`. Absent on older outline runs -> `[]`. */
  panoramaCandidates: string[];
  heroCandidates: string[];
  /** Owner decision, 2026-08-31 (cover-safety fix). Absent on outline runs
   * that predate it -> `[]`, same tolerance as the other two. */
  coverCandidates: string[];
  /** The outline's own resolved BCP-47 journal language (see
   * `eval-memory-book-outline.ts`'s `ParsedOutlineResponse.language`).
   * `undefined` on outline runs that predate this field -- the CLI default
   * then falls back to `DEFAULT_LANGUAGE`, matching pre-round-18 behavior
   * exactly (see `resolveManifestLanguageDefault`). */
  language?: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`outline.json missing or invalid "${field}"`);
  }
  return value;
}

/** Reads an optional top-level string-id array, defaulting to `[]` when the
 * field is entirely absent (old outline runs predate `panoramaCandidates`/
 * `heroCandidates`) -- but still fails loudly if the field IS present with
 * the wrong shape, per this file's "report rather than guess" convention. */
function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`outline.json "${field}" must be an array when present`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

/**
 * Validates + narrows the subset of outline.json's shape this script needs
 * (mirrors `eval-memory-book-outline.ts`'s own written shape -- `runId`,
 * `child.{id,name}`, `scope.type`, `window.{start,endExclusive,label}`,
 * `elements[].{id,kind,memoryIds}`). Throws with the specific missing field
 * rather than silently defaulting, per the brief's "report if something
 * needed is missing from outline.json rather than guessing."
 */
export function parseOutlineJson(raw: unknown): ParsedOutline {
  if (!raw || typeof raw !== 'object') {
    throw new Error('outline.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;

  const runId = requireString(o.runId, 'runId');

  const childRaw = o.child as Record<string, unknown> | undefined;
  if (!childRaw || typeof childRaw !== 'object') {
    throw new Error('outline.json missing "child"');
  }
  const child: OutlineChild = {
    id: requireString(childRaw.id, 'child.id'),
    name: requireString(childRaw.name, 'child.name'),
  };

  const scopeRaw = o.scope as Record<string, unknown> | undefined;
  if (!scopeRaw || typeof scopeRaw !== 'object') {
    throw new Error('outline.json missing "scope"');
  }
  const scope: OutlineScope = { type: requireString(scopeRaw.type, 'scope.type') };

  const windowRaw = o.window as Record<string, unknown> | undefined;
  if (!windowRaw || typeof windowRaw !== 'object') {
    throw new Error('outline.json missing "window"');
  }
  const window: OutlineWindow = {
    start: requireString(windowRaw.start, 'window.start'),
    endExclusive: requireString(windowRaw.endExclusive, 'window.endExclusive'),
    label: requireString(windowRaw.label, 'window.label'),
  };

  if (!Array.isArray(o.elements)) {
    throw new Error('outline.json missing "elements" array');
  }
  const elements: OutlineElementLike[] = o.elements.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`outline.json elements[${index}] is not an object`);
    }
    const el = raw as Record<string, unknown>;
    if (!Array.isArray(el.memoryIds)) {
      throw new Error(`outline.json elements[${index}] missing "memoryIds"`);
    }
    return {
      id: requireString(el.id, `elements[${index}].id`),
      kind: requireString(el.kind, `elements[${index}].kind`),
      memoryIds: el.memoryIds as string[],
    };
  });

  const panoramaCandidates = optionalStringArray(o.panoramaCandidates, 'panoramaCandidates');
  const heroCandidates = optionalStringArray(o.heroCandidates, 'heroCandidates');
  const coverCandidates = optionalStringArray(o.coverCandidates, 'coverCandidates');
  // Round-18: optional, present on every outline run from that point on --
  // same "absent on older runs" tolerance as panoramaCandidates/heroCandidates
  // above, but a STRING field rather than an array, so it gets its own
  // narrow check rather than reusing optionalStringArray.
  if (o.language !== undefined && typeof o.language !== 'string') {
    throw new Error('outline.json "language" must be a string when present');
  }
  const language = typeof o.language === 'string' ? o.language : undefined;

  return { runId, child, scope, window, elements, panoramaCandidates, heroCandidates, coverCandidates, language };
}

/** Union of every element's `memoryIds`, order-preserving + deduped -- the
 * plan brief's "every memory id referenced anywhere in it (spreads,
 * backbone, firsts, birthday elements)". cover/title/through-the-years/
 * closing elements always carry `memoryIds: []` (see
 * `buildReadingOrder` in eval-memory-book-outline.ts) so no kind filtering
 * is needed here. */
export function collectMemoryIdsFromElements(elements: OutlineElementLike[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const element of elements) {
    for (const id of element.memoryIds) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/**
 * Unions the backbone-derived memory ids with outline.json's top-level
 * `panoramaCandidates`/`heroCandidates`/`coverCandidates` arrays. Candidates
 * that didn't make the backbone cut exist ONLY in those arrays -- without
 * this, they'd get neither DB data nor exported assets at all.
 * Order-preserving + deduped, same convention as
 * `collectMemoryIdsFromElements`. Tolerates old outlines with no candidate
 * arrays: `parseOutlineJson` already defaults all three to `[]`, so this is
 * a no-op union in that case. `coverCandidates` defaults to `[]` so every
 * pre-existing 3-arg call site keeps compiling unchanged.
 */
export function mergeCandidateMemoryIds(
  elementMemoryIds: string[],
  panoramaCandidates: string[],
  heroCandidates: string[],
  coverCandidates: string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...elementMemoryIds, ...panoramaCandidates, ...heroCandidates, ...coverCandidates]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ── Manifest scope shape ────────────────────────────────────────────────

export type ManifestScopeKind = 'age-year' | 'calendar-year' | 'custom';

export function mapScopeKind(outlineScopeType: string): ManifestScopeKind {
  if (outlineScopeType === 'age-year') return 'age-year';
  if (outlineScopeType === 'calendar-year') return 'calendar-year';
  return 'custom';
}

/** Calendar-day subtraction via UTC `Date` math (safe for plain YYYY-MM-DD
 * strings -- no time-of-day/timezone exposure). Used to turn the outline
 * window's exclusive end into the manifest's display-only inclusive end,
 * same idea as `scopeWindowLastInclusiveDay` in eval-memory-book-outline.ts. */
export function subtractOneDay(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMs = Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000;
  const dt = new Date(utcMs);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

export interface ManifestScope {
  kind: ManifestScopeKind;
  label: string;
  start: string;
  end: string;
}

export function buildManifestScope(outlineScopeType: string, window: OutlineWindow): ManifestScope {
  return {
    kind: mapScopeKind(outlineScopeType),
    label: window.label,
    start: window.start,
    end: subtractOneDay(window.endExclusive),
  };
}

// ── Manifest asset-entry shaping (brief step 4 -- book-renderer/src/model/
// types.ts's BookManifest is the verbatim consumer contract) ──────────────

export type ManifestAssetKind = 'photo' | 'video-poster';

export interface ManifestAsset {
  file: string;
  width: number;
  height: number;
  aspectRatio: number;
  kind: ManifestAssetKind;
  durationMs: number | null;
  /** Real dimensions of the ORIGINAL (not preview) photo bytes -- the
   * renderer's panorama (>=3500px source width) and full-bleed (300ppi)
   * gates need these, since `width`/`height` above come from the exported
   * PREVIEW file (capped at ~1280px) and can never clear either gate.
   * Measured for every `kind: 'photo'` asset (owner round-8 --
   * `shouldMeasureOriginalDimensions`; previously only a
   * `panoramaCandidates`/`heroCandidates` memory). Absent (not `null`) on
   * a `video-poster` asset (never measured -- its "original" is a video
   * file, not a still image) or when measurement failed/the original
   * turned out not to be an image -- "never measured", not "measured and
   * found missing". */
  originalWidth?: number;
  originalHeight?: number;
  /**
   * The ORIGINAL (not preview) R2 object key -- `memory_media.object_key`
   * (memory-book-5c plan, Design Decision 1: "Originals reach print via the
   * manifest"). Print needs full-resolution bytes; `file` above is the
   * app's ~1280px preview key. Absent (never `null`) exactly when `file`
   * already IS the original -- `selectMediaAsset`'s own fallback when no
   * preview exists (no `preview_object_key` on the row) -- so this field
   * never duplicates `file`'s own value; a caller can treat "absent" and
   * "equal to file" as the same fact. Absent on every manifest built before
   * this field existed, same backward-compatible-addition contract as
   * `originalWidth`/`originalHeight`.
   */
  originalFile?: string;
}

/**
 * Whether a media job of the given `kind` should have its ORIGINAL-file
 * dimensions measured for `ManifestAsset.originalWidth`/`originalHeight`
 * (owner round-8 -- see the header note "original dimensions for every
 * photo"). Every photo asset qualifies, unconditionally -- this used to
 * also require the memory to be in `panoramaCandidates`/`heroCandidates`,
 * which in practice never matched on either real book. A `video-poster`
 * job never qualifies: its `objectKey` is the ORIGINAL VIDEO file, and
 * measuring that as an image would just fail (or misinterpret) the read --
 * `measureOriginalDimensions`'s own image-content-type guard would also
 * reject it, but callers should never even attempt the fetch for a video.
 */
export function shouldMeasureOriginalDimensions(kind: ManifestAssetKind): boolean {
  return kind === 'photo';
}

export function buildManifestAsset(params: {
  file: string;
  width: number;
  height: number;
  kind: ManifestAssetKind;
  durationMs: number | null;
  dbAspectRatio: number | null;
  originalDimensions?: { width: number; height: number } | null;
  /**
   * `memory_media.object_key` -- see `ManifestAsset.originalFile`'s doc
   * comment. Omitted (or explicitly `null`) sets nothing, same "never
   * fabricated" contract as `originalDimensions`. When given AND equal to
   * `params.file` (the fallback case: no preview existed, so the selected
   * asset key already IS the original), this is a deliberate no-op -- the
   * field is left unset rather than duplicating `file`'s own value.
   */
  originalFile?: string | null;
}): ManifestAsset {
  const aspectRatio = params.dbAspectRatio ?? (params.height > 0 ? params.width / params.height : 1);
  const asset: ManifestAsset = {
    file: params.file,
    width: params.width,
    height: params.height,
    aspectRatio,
    kind: params.kind,
    durationMs: params.durationMs,
  };
  if (params.originalDimensions) {
    asset.originalWidth = params.originalDimensions.width;
    asset.originalHeight = params.originalDimensions.height;
  }
  if (params.originalFile && params.originalFile !== params.file) {
    asset.originalFile = params.originalFile;
  }
  return asset;
}

export interface ManifestMilestone {
  id: string;
  name: string;
  detail: string | null;
}

// ── Share tokens (Round-19 -- revocable QR links, docs/plans/memory-book.md
// §8). Replaces the earlier raw-memoryId QR URLs: the memory-viewer worker
// and book-renderer's scan marks now resolve/encode an opaque token from
// `media_share_tokens` instead of the memory id itself, so a lost/stolen
// printed book can be revoked without touching the underlying memory. ─────

/** Base62 alphabet for `generateShareToken` -- 62 distinct URL-safe
 * characters (digits, then uppercase, then lowercase; the ordering itself
 * has no significance). */
const SHARE_TOKEN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 22 base62 characters ~= 22 * log2(62) ~= 131 bits of entropy -- brief's
 * own suggestion ("22 chars base62"), comfortably unguessable for a public,
 * unauthenticated `GET /m/:token` route where the token itself is the only
 * access control (see workers/memory-viewer's "Privacy model" -- no PIN). */
export const SHARE_TOKEN_LENGTH = 22;

/**
 * Cryptographically random, URL-safe token generator (brief: "generate
 * URL-safe random, e.g. 22 chars base62 from crypto.getRandomValues").
 * Uses rejection sampling -- bytes >= 248 (the largest multiple of 62 that
 * fits in a byte) are discarded rather than reduced mod 62 -- so all 62
 * output characters have exactly equal probability; a plain `byte % 62`
 * would slightly bias the alphabet's first (256 mod 62 = 8) characters.
 * `randomBytes` is injectable for deterministic tests; production always
 * uses the real `crypto.getRandomValues` (available globally in Deno).
 */
export function generateShareToken(
  randomBytes: (count: number) => Uint8Array = (count) => crypto.getRandomValues(new Uint8Array(count)),
): string {
  const REJECTION_CEILING = SHARE_TOKEN_ALPHABET.length * Math.floor(256 / SHARE_TOKEN_ALPHABET.length); // 248
  let token = '';
  while (token.length < SHARE_TOKEN_LENGTH) {
    const batch = randomBytes(SHARE_TOKEN_LENGTH - token.length);
    for (const byte of batch) {
      if (token.length === SHARE_TOKEN_LENGTH) break;
      if (byte >= REJECTION_CEILING) continue; // discard -- would bias the low end of the alphabet.
      token += SHARE_TOKEN_ALPHABET[byte % SHARE_TOKEN_ALPHABET.length];
    }
  }
  return token;
}

/**
 * Whether a memory's book page carries a QR/scan mark, and therefore needs
 * a `media_share_tokens` row minted for it. Mirrors book-renderer's own
 * QR-eligibility exactly (`isVideoAsset`/`isAudioMemory` in
 * book-renderer/src/model/fitter.ts): an audio memory (the scan mark IS the
 * page -- see templates/AudioNote.tsx), or a `media` memory with at least
 * one video-poster asset (an inline "scan to watch" credit line on an
 * otherwise photo-shaped page -- see `PhotoSlotContent.qr` /
 * `templates/common/PhotoTile.tsx`). A photo-only memory needs no token --
 * it has no QR page at all.
 */
export function memoryNeedsShareToken(memoryType: string, assets: Array<{ kind: ManifestAssetKind }>): boolean {
  if (memoryType === 'audio') return true;
  return memoryType === 'media' && assets.some((asset) => asset.kind === 'video-poster');
}

export function buildManifestMilestone(milestoneId: string, detail: string | null): ManifestMilestone {
  return { id: milestoneId, name: getMilestoneById(milestoneId)?.name ?? milestoneId, detail };
}

export interface ManifestTaggedMember {
  name: string;
  isChild: boolean;
}

/** `isChild` is an age classification (<13 at the memory's own date), the
 * same `classifyChildOrAdult` split eval-memory-book-outline.ts uses as "the
 * ONLY sanctioned source of relationship words" -- not a check against the
 * book's own subject child, since a tagged sibling under 13 should read as
 * a child too. */
export function buildTaggedMember(input: {
  name: string;
  dateOfBirth: string | null;
  memoryDate: string;
}): ManifestTaggedMember {
  const ageYears = input.dateOfBirth ? getAgeInYearsAtDate(input.dateOfBirth, input.memoryDate) : null;
  return { name: input.name, isChild: classifyChildOrAdult(ageYears) === 'child' };
}

/** `memories.illustration_key` export (brief item 1) -- unlike
 * `ManifestAsset`, there is no DB-stored aspect ratio to prefer, so
 * `aspectRatio` always comes from the downloaded image's own dimensions. */
export interface ManifestIllustration {
  file: string;
  width: number;
  height: number;
  aspectRatio: number;
}

export function buildManifestIllustration(params: { file: string; width: number; height: number }): ManifestIllustration {
  return {
    file: params.file,
    width: params.width,
    height: params.height,
    aspectRatio: params.height > 0 ? params.width / params.height : 1,
  };
}

export interface ManifestMemory {
  date: string;
  type: string;
  text: string | null;
  emotion: string | null;
  topics: string[];
  milestones: ManifestMilestone[];
  engagement: number;
  taggedMembers: ManifestTaggedMember[];
  assets: ManifestAsset[];
  /** `null` when the memory has no `illustration_key` (most memories --
   * illustration is an opt-in AI feature, not every memory has one). */
  illustration: ManifestIllustration | null;
  /**
   * Round-19: the active `media_share_tokens.token` a QR-eligible memory's
   * scan mark encodes -- `null` for every memory that doesn't carry a QR
   * page (`memoryNeedsShareToken` false) AND, defensively, for a
   * QR-eligible one whose mint somehow still came back empty (shouldn't
   * happen -- `ensureShareTokens` throws rather than leaving a gap -- but
   * this field stays nullable rather than widening to `string` so a caller
   * can never accidentally treat "no token" as unreachable).
   */
  shareToken: string | null;
}

export interface ManifestMemorySourceRow {
  memory_date: string;
  memory_type: string;
  content: string | null;
  emotion: string | null;
  topics: string[];
}

export function buildManifestMemory(input: {
  memory: ManifestMemorySourceRow;
  assets: ManifestAsset[];
  milestones: ManifestMilestone[];
  taggedMembers: ManifestTaggedMember[];
  engagement: number;
  illustration: ManifestIllustration | null;
  shareToken: string | null;
}): ManifestMemory {
  return {
    date: input.memory.memory_date,
    type: input.memory.memory_type,
    text: input.memory.content?.trim() || null,
    emotion: input.memory.emotion,
    topics: input.memory.topics,
    milestones: input.milestones,
    engagement: input.engagement,
    taggedMembers: input.taggedMembers,
    assets: input.assets,
    illustration: input.illustration,
    shareToken: input.shareToken,
  };
}

export interface ManifestPortrait {
  file: string;
  /** `family_member_portrait_versions.profile_picture_key` -- the source
   * photo the AI portrait at `file` was generated from (brief item 3). */
  sourceFile: string;
  date: string;
  ageLabel: string;
}

export function buildManifestPortrait(params: {
  file: string;
  sourceFile: string;
  referenceDate: string;
  dateOfBirth: string | null;
}): ManifestPortrait {
  return {
    file: params.file,
    sourceFile: params.sourceFile,
    date: params.referenceDate,
    ageLabel: describeAgeAtDate(params.dateOfBirth ?? params.referenceDate, params.referenceDate),
  };
}

/** Which download path produced a `book-data/<slug>/` export -- `'preview'`
 * (default, fast iteration loop -- ~1280px `preview_object_key` photos) or
 * `'print'` (`--print-assets` -- original-resolution photos). Recorded
 * top-level rather than per-asset because the whole export runs in one mode
 * or the other; kept minimal so the renderer/audit tooling can distinguish
 * the two without having to infer it from file sizes. */
export type ManifestAssetMode = 'preview' | 'print';

/** One R2 fetch that failed even after retries. `objectKey` is ALWAYS the
 * basename (see the eval script's `objectKeyBasename`) -- never the full
 * key. */
export interface DownloadFailure {
  kind: string;
  objectKey: string;
}

/** The family's journal language -- book-renderer's furniture (section
 * labels, signatures, scan-mark microcopy) follows this, not the app UI
 * language. book-renderer currently only ships Spanish/English copy. */
export type ManifestLanguage = 'es' | 'en';

export interface BookManifest {
  child: { id: string; name: string };
  scope: ManifestScope;
  generatedAt: string;
  outlineRun: string;
  memories: Record<string, ManifestMemory>;
  portraits: ManifestPortrait[];
  /** The family's journal language -- see `ManifestLanguage`. */
  language: ManifestLanguage;
  /** R2 fetches that still failed after retries (reliability fix) -- the
   * affected asset/illustration/portrait is simply omitted elsewhere in the
   * manifest rather than pointing at a file that was never written; this is
   * how the renderer (and we) see the gap. Always `[]` on a clean run. */
  downloadFailures: DownloadFailure[];
  /** See `ManifestAssetMode`. */
  assetMode: ManifestAssetMode;
}

// ── originalFile backfill (memory-book-5c plan, Design Decision 1) ────────
//
// An existing `ready` `memory_books.book_document` was frozen before
// `ManifestAsset.originalFile` existed, so its assets never carry it. This
// is a NARROW, DETERMINISTIC patch -- no LLM, no re-curation, never
// touches curation/ordering/content -- that fills the gap by looking up
// each asset's `file` (the exported preview key, or the original itself in
// the fallback case) against a `memory_media` map the caller builds
// (`file -> object_key`, keyed by BOTH `preview_object_key` and
// `object_key` so the fallback case resolves too -- see
// `_shared/memory-book-backfill.ts`'s service-role helper, which is the
// only intended caller of `originalFileByFile` construction). Pure and
// runtime-agnostic like the rest of this module; the DB read lives in that
// separate Deno-only helper.

/** One asset the backfill could not resolve -- its `file` had no matching
 * `memory_media` row in the caller's lookup map (deleted media, a stale/
 * orphaned manifest entry, or a lookup scoped to the wrong family). Never
 * silently dropped -- the caller (the future quote op, plan step 5) decides
 * how to react, e.g. refusing to freeze a paid snapshot with any unresolved
 * asset. */
export interface UnresolvedManifestAsset {
  memoryId: string;
  file: string;
  kind: ManifestAssetKind;
}

export interface ManifestOriginalFileBackfillResult {
  /** A patched COPY of the input manifest -- the input is never mutated. */
  manifest: BookManifest;
  /** Count of assets that actually gained an `originalFile` (excludes
   * already-backfilled and fallback-key no-op assets). */
  patchedCount: number;
  unresolved: UnresolvedManifestAsset[];
}

/**
 * Patches `originalFile` onto every asset of every memory in `manifest`,
 * looking each asset's `file` up in `originalFileByFile`. Idempotent (an
 * asset that already carries `originalFile` -- e.g. a manifest built after
 * this field existed, or a book this already ran against -- is left
 * untouched and never re-counted or reported unresolved) and a deliberate
 * no-op for the fallback-key case: when the lookup resolves `file` to
 * itself (no preview existed, so `file` already IS the original --
 * `selectMediaAsset`'s own fallback), `originalFile` is correctly left
 * unset, mirroring `buildManifestAsset`'s own no-duplication contract.
 */
export function backfillManifestOriginalFiles(
  manifest: BookManifest,
  originalFileByFile: Record<string, string>,
): ManifestOriginalFileBackfillResult {
  const patched = JSON.parse(JSON.stringify(manifest)) as BookManifest;
  let patchedCount = 0;
  const unresolved: UnresolvedManifestAsset[] = [];

  for (const [memoryId, memory] of Object.entries(patched.memories)) {
    for (const asset of memory.assets) {
      if (asset.originalFile) continue; // already backfilled -- idempotent no-op.
      const original = originalFileByFile[asset.file];
      if (!original) {
        unresolved.push({ memoryId, file: asset.file, kind: asset.kind });
        continue;
      }
      if (original === asset.file) continue; // fallback case: file already IS the original.
      asset.originalFile = original;
      patchedCount += 1;
    }
  }

  return { manifest: patched, patchedCount, unresolved };
}

export interface BackfillBookDocumentResult {
  /** Same `{ outline, manifest }` shape `book_document` is stored as
   * (`outline` passed through byte-for-byte -- this step never touches
   * curation); `manifest` is the patched copy. */
  bookDocument: { outline: unknown; manifest: BookManifest };
  patchedCount: number;
  unresolved: UnresolvedManifestAsset[];
}

/**
 * `book_document`-shaped wrapper around `backfillManifestOriginalFiles` --
 * `memory_books.book_document` is stored (and read back) as untyped jsonb,
 * so this validates just enough shape to fail loudly on a mismatch, same
 * "report rather than guess" posture as book-renderer's own `loader.ts`.
 */
export function backfillBookDocumentOriginalFiles(
  bookDocument: unknown,
  originalFileByFile: Record<string, string>,
): BackfillBookDocumentResult {
  if (!bookDocument || typeof bookDocument !== 'object') {
    throw new Error('book_document is not an object');
  }
  const doc = bookDocument as { outline?: unknown; manifest?: unknown };
  if (!doc.manifest || typeof doc.manifest !== 'object') {
    throw new Error('book_document.manifest is missing or not an object');
  }

  const { manifest, patchedCount, unresolved } = backfillManifestOriginalFiles(
    doc.manifest as BookManifest,
    originalFileByFile,
  );
  return { bookDocument: { outline: doc.outline, manifest }, patchedCount, unresolved };
}

export function buildManifest(input: {
  child: { id: string; name: string };
  scope: ManifestScope;
  outlineRun: string;
  memories: Record<string, ManifestMemory>;
  portraits: ManifestPortrait[];
  language: ManifestLanguage;
  downloadFailures: DownloadFailure[];
  /** Defaults to `'preview'` -- every caller that predates round-20 (incl.
   * this file's own pre-existing tests) gets the same behavior as before
   * this field existed. */
  assetMode?: ManifestAssetMode;
  now?: Date;
}): BookManifest {
  return {
    child: input.child,
    scope: input.scope,
    generatedAt: (input.now ?? new Date()).toISOString(),
    outlineRun: input.outlineRun,
    memories: input.memories,
    portraits: input.portraits,
    language: input.language,
    downloadFailures: input.downloadFailures,
    assetMode: input.assetMode ?? 'preview',
  };
}
