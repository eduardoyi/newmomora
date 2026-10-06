// Year Film Workflow stages (docs/plans/year-film-p1.md Step 5). Each stage
// is one `step.do`: it reloads what it needs (memory text never crosses a
// step boundary — stages return ids, counts and states only), persists every
// model verdict before moving on (retries never pay twice), and talks to
// the database only through the bridge. Dependencies are injected so the
// stages are unit-testable without Cloudflare, Fly or OpenAI.
import { resolvePortraitVersionAtDate } from '../../../supabase/functions/_shared/portrait-versions.ts';
import {
  applyPrepared,
  assetId,
  blockedSoundWindows,
  type FrameNeed,
  type FrameResolution,
  isPublicFilm,
  planPrepare,
  type PrepareManifest,
  resolveFrames,
  resolveSound,
  soundFrameNeeds,
  type SoundChoice,
  voiceRef,
  frameRef,
} from '../../../supabase/functions/_shared/year-film-assets.ts';
import { defaultBed, isYearFilmBed } from '../../../supabase/functions/_shared/year-film-beds.ts';
import { cachedFrame, cachedQuote, cachedVoice, checkCacheKey, type CheckCache, PUBLIC_CHECK_VARIANT, splitBatch } from '../../../supabase/functions/_shared/year-film-checks.ts';
import {
  type FamilyRows,
  firstName,
  type FilmPlan,
  mapFamilyRows,
  planFilm,
  type QuoteCandidate,
  scriptReferences,
  stickyQuotes,
  yearFilmTextHash,
} from '../../../supabase/functions/_shared/year-film-context.ts';
import { detectJournalLanguage, type FilmLanguage, resolveFilmLanguage } from '../../../supabase/functions/_shared/year-film-i18n.ts';
import {
  buildQuotePrompt,
  buildQuoteRequestBody,
  HOLIDAY_QUOTE_MODEL,
  parseQuoteResponse,
  QUOTE_MODEL,
  selectQuotePool,
} from '../../../supabase/functions/_shared/year-film-quotes.ts';
import {
  birthdayVisionCandidates,
  buildBirthdayScript,
  buildFamilyYearScript,
  buildHolidayScript,
  buildMonthlyScript,
  checkKey,
  familyYearVisionCandidates,
  type FilmScript,
  type FrameChecks,
  type FrameRef,
  holidayVisionCandidates,
  monthlyVisionCandidates,
  type VerifiedQuote,
} from '../../../supabase/functions/_shared/year-film-script.ts';
import {
  buildFrameCheckRequestBody,
  CLAIM_CHECK_MODEL,
  FRAME_CHECK_BATCH,
  HOLIDAY_CLAIM_CHECK_MODEL,
  FRAME_CHECK_MODEL,
  parseFrameCheckResponse,
  type VisionImage,
} from '../../../supabase/functions/_shared/year-film-vision.ts';
import { buildVoiceCheckRequestBody, parseVoiceCheck, VOICE_CHECK_MODEL } from '../../../supabase/functions/_shared/year-film-voice.ts';
import { AttemptStopped, type BridgeClient } from './bridge';
import type { FlyClient, MachineMode } from './fly';
import type { ChatFn } from './openai';
import { credentialEnv, type MintedCredentials } from './r2creds';
import { attemptPrefix, type Storage } from './storage';
import { uuidV5 } from './uuid';

export interface StageDeps {
  filmId: string;
  attemptId: string;
  bridge: BridgeClient;
  storage: Storage;
  chat: ChatFn;
  fly: FlyClient;
  mintCredentials: (input: { attemptPrefix: string; sourceKeys: string[]; ttlSeconds: number }) => Promise<MintedCredentials | null>;
}

interface FilmContext {
  film: {
    id: string;
    kind: 'birthday' | 'family_month' | 'family_year' | 'family_holiday';
    familyId: string;
    ownerId: string;
    familyMemberId: string | null;
    ageYear: number | null;
    scopeStart: string;
    scopeEndExclusive: string;
    language: string | null;
    musicBedId: string | null;
    quoteCandidates: QuoteCandidate[] | null;
    edits: {
      removedMemoryIds?: string[];
      quote?: { memoryId: string; textHash: string } | null;
      musicBedId?: string;
      /** family_holiday (create_holiday_card_film): the card's greeting + the front's top picks. */
      greeting?: string;
      preferredCloseMedia?: string[];
    };
    editsVersion: number;
    /** Set at every publish (never cleared): has this film ever been ready. */
    readyAt?: string | null;
    poolCutoffAt: string | null;
    contentEpoch: number;
    aiChecks: CheckCache & Record<string, unknown>;
  };
  rows: FamilyRows & { memories: (FamilyRows['memories'][number] & { audio_transcript?: string | null; description?: string | null })[] };
}

interface Loaded {
  ctx: FilmContext;
  plan: FilmPlan | null;
  skipReason: string | null;
  prefix: string;
}

/** The first curate's pick, stored with the script (bed + edits version). */
interface ScriptEnvelope {
  bed: string;
  editsVersion: number;
  script: FilmScript;
}

const MACHINE_TTL_SECONDS: Record<MachineMode, number> = { thumbs: 15 * 60, prepare: 30 * 60, render: 45 * 60 };

async function load(deps: StageDeps): Promise<Loaded> {
  const ctx = await deps.bridge.call<FilmContext>('load_film_context');
  const data = mapFamilyRows(ctx.rows, {
    poolCutoffAt: ctx.film.poolCutoffAt,
    excludeMemoryIds: ctx.film.edits?.removedMemoryIds ?? [],
  });
  const result = planFilm(data, {
    kind: ctx.film.kind,
    familyMemberId: ctx.film.familyMemberId,
    ageYear: ctx.film.ageYear,
    scopeStart: ctx.film.scopeStart,
    scopeEndExclusive: ctx.film.scopeEndExclusive,
    // Read only for family_holiday (card films): greeting + preferred close
    // media, and the floor waiver once the film has published.
    edits: ctx.film.edits,
    hasPublished: ctx.film.readyAt != null,
  });
  return {
    ctx,
    plan: result.ok ? result.plan : null,
    skipReason: result.ok ? null : result.reason,
    prefix: attemptPrefix(ctx.film.ownerId, deps.filmId, deps.attemptId),
  };
}

function candidates(plan: FilmPlan): FrameRef[] {
  const base = { quotes: [] as VerifiedQuote[], language: 'en' as FilmLanguage };
  switch (plan.kind) {
    case 'birthday':
      return birthdayVisionCandidates({ ...plan.input, ...base });
    case 'family_month':
      return monthlyVisionCandidates({ ...plan.input, ...base });
    case 'family_year':
      return familyYearVisionCandidates({ ...plan.input, ...base });
    case 'family_holiday':
      return holidayVisionCandidates({ ...plan.input, ...base });
  }
}

/** The kids' real photos the claim checks compare against (the eval rule:
 * the portrait version's source photo at the scope's end). */
function claimReferences(plan: FilmPlan): { id: string; name: string; key: string }[] {
  return plan.subjects.flatMap((kid) => {
    const version = resolvePortraitVersionAtDate(kid.portraits, plan.scope.endExclusive);
    return version ? [{ id: kid.id, name: firstName(kid.name), key: version.profile_picture_key }] : [];
  });
}

async function recordUsage(deps: StageDeps, cacheKey: string, usageOperation: string, model: string, ok: boolean, usage: unknown, audioSeconds?: number) {
  await deps.bridge.call('record_usage', {
    aiCallId: await uuidV5(`${deps.attemptId}:${cacheKey}`),
    usageOperation,
    model,
    success: ok,
    usage,
    ...(audioSeconds !== undefined ? { audioSeconds } : {}),
  });
}

async function startMachine(
  deps: StageDeps,
  mode: MachineMode,
  prefix: string,
  job: Record<string, unknown>,
  sourceKeys: string[],
): Promise<string> {
  await deps.storage.putJson(`${prefix}${mode === 'render' ? '' : `${mode === 'thumbs' ? 'thumbs' : 'prep'}/`}job.json`, job);
  const creds = await deps.mintCredentials({ attemptPrefix: prefix, sourceKeys, ttlSeconds: MACHINE_TTL_SECONDS[mode] });
  const machine = await deps.fly.create({
    name: `yf-${deps.attemptId}-${mode}`,
    mode,
    env: { JOB_PREFIX: prefix, JOB_TIMEOUT_SECONDS: String(MACHINE_TTL_SECONDS[mode] - 5 * 60), ...credentialEnv(creds) },
  });
  await deps.bridge.call('record_machine', { mode, machineId: machine.id });
  return machine.id;
}

// ── 1. Context + floors + thumbs ─────────────────────────────────────────

export async function startThumbs(deps: StageDeps): Promise<{ skipped: true; reason: string } | { skipped: false; prefix: string; machineId: string | null }> {
  const { plan, skipReason, prefix } = await load(deps);
  if (!plan) {
    await deps.bridge.call('end_cycle', { outcome: 'skipped', code: skipReason ?? 'BELOW_FLOORS' });
    return { skipped: true, reason: skipReason ?? 'BELOW_FLOORS' };
  }
  const keys = [...new Set([...candidates(plan).map(checkKey), ...claimReferences(plan).map((r) => r.key)])];
  if (keys.length === 0) return { skipped: false, prefix, machineId: null };
  const machineId = await startMachine(deps, 'thumbs', prefix, { version: 1, mode: 'thumbs', prefix, items: keys.map((key) => ({ key })) }, keys);
  return { skipped: false, prefix, machineId };
}

// ── Machine polling ──────────────────────────────────────────────────────

export type PollState = 'running' | 'done' | 'failed' | 'image_incomplete' | 'crashed';

/** A status.json `failed` with the job's startup-guard code: the machine saw
 * an incomplete image filesystem (Fly partial-rootfs quirk) and did no work. */
export const IMAGE_INCOMPLETE_CODE = 'IMAGE_INCOMPLETE';

/** The closed failure code a terminal poll state ends the cycle with. */
export function pollFailureCode(state: PollState): 'MACHINE_FAILED' | 'IMAGE_INCOMPLETE' | null {
  return state === 'image_incomplete' ? 'IMAGE_INCOMPLETE' : state === 'failed' || state === 'crashed' ? 'MACHINE_FAILED' : null;
}

export function failedPollState(status: { state?: string; code?: string } | null): 'failed' | 'image_incomplete' {
  return status?.code === IMAGE_INCOMPLETE_CODE ? 'image_incomplete' : 'failed';
}

export async function pollMachine(deps: StageDeps, statusKey: string, machineId: string, epoch: number | null): Promise<PollState> {
  const { state } = await deps.bridge.call<{ state: string }>('heartbeat', epoch === null ? {} : { epoch });
  if (state !== 'ok') throw new AttemptStopped(state);
  const status = await deps.storage.getJson<{ state?: string; code?: string }>(statusKey);
  if (status?.state === 'done') return 'done';
  if (status?.state === 'failed') return failedPollState(status);
  const machine = await deps.fly.get(machineId);
  if (!machine || machine.state === 'destroyed' || machine.state === 'stopped' || machine.state === 'failed') {
    // Gone without a status: re-read once (the status write may have just landed).
    const again = await deps.storage.getJson<{ state?: string }>(statusKey);
    if (again?.state === 'done') return 'done';
    return 'crashed';
  }
  return 'running';
}

// ── 2. Quote pick (sticky) ───────────────────────────────────────────────

/** The holiday card film runs its quote pick and claim checks on GPT-6.1 Sol. */
const quoteModelFor = (plan: FilmPlan) => (plan.kind === 'family_holiday' ? HOLIDAY_QUOTE_MODEL : QUOTE_MODEL);
const claimModelFor = (plan: FilmPlan) => (plan.kind === 'family_holiday' ? HOLIDAY_CLAIM_CHECK_MODEL : CLAIM_CHECK_MODEL);

async function quoteCacheKey(plan: FilmPlan): Promise<string> {
  const pool = selectQuotePool(plan.quotable, plan.quoteSubjects);
  return `quote:${(await checkCacheKey({
    kind: 'claim', model: quoteModelFor(plan), assetKey: pool.map((m) => m.id).join(','), referenceKeys: plan.quoteSubjects.map((s) => s.id),
  })).slice(6)}`;
}

export async function pickQuote(deps: StageDeps): Promise<{ quotes: number }> {
  const { ctx, plan } = await load(deps);
  if (!plan) return { quotes: 0 };
  if (ctx.film.quoteCandidates?.length) return { quotes: ctx.film.quoteCandidates.length };
  const key = await quoteCacheKey(plan);
  const cached = cachedQuote(ctx.film.aiChecks, key);
  if (cached) return { quotes: cached.accepted.length };

  const pool = selectQuotePool(plan.quotable, plan.quoteSubjects);
  let value: { accepted: VerifiedQuote[]; language: string | null } = { accepted: [], language: null };
  if (pool.length > 0) {
    const { system, user } = buildQuotePrompt(plan.quoteSubjects, pool);
    const result = await deps.chat(buildQuoteRequestBody(system, user, quoteModelFor(plan)));
    await recordUsage(deps, key, 'year_film_quote', quoteModelFor(plan), result.ok, result.usage);
    if (result.content !== null) {
      const parsed = parseQuoteResponse(result.content, plan.quoteSubjects, new Map(pool.map((m) => [m.id, m.text])));
      value = { accepted: parsed.accepted, language: parsed.language };
    }
  }
  await deps.bridge.call('save_checks', { checks: { [key]: { kind: 'quote', value } } });
  return { quotes: value.accepted.length };
}

// ── 3. Claim checks ──────────────────────────────────────────────────────

/** The holiday card film runs the strict public-audience prompt (owner,
 * 2026-10-05); its verdicts are cached under their own key variant. */
const publicVariant = (isPublic: boolean) => (isPublic ? { variant: PUBLIC_CHECK_VARIANT as typeof PUBLIC_CHECK_VARIANT } : {});
const visionOptions = (isPublic: boolean) => ({ publicAudience: isPublic });

async function claimKeys(plan: FilmPlan): Promise<{ frame: FrameRef; key: string }[]> {
  const refs = claimReferences(plan).map((r) => r.key);
  const isPublic = plan.kind === 'family_holiday';
  const seen = new Set<string>();
  const out: { frame: FrameRef; key: string }[] = [];
  for (const frame of candidates(plan)) {
    if (seen.has(checkKey(frame))) continue;
    seen.add(checkKey(frame));
    out.push({ frame, key: await checkCacheKey({ kind: 'claim', model: claimModelFor(plan), assetKey: checkKey(frame), referenceKeys: refs, ...publicVariant(isPublic) }) });
  }
  return out;
}

async function thumb(deps: StageDeps, prefix: string, manifest: Record<string, string | null> | null, key: string): Promise<VisionImage | null> {
  const path = manifest?.[key];
  if (!path) return null;
  const b64 = await deps.storage.getBase64(`${prefix}${path}`);
  return b64 ? { base64: b64, contentType: 'image/jpeg' } : null;
}

export async function runClaimChecks(deps: StageDeps): Promise<{ checked: number }> {
  const { ctx, plan, prefix } = await load(deps);
  if (!plan) return { checked: 0 };
  const manifest = (await deps.storage.getJson<{ images: Record<string, string | null> }>(`${prefix}thumbs/manifest.json`))?.images ?? null;
  const refs = claimReferences(plan);
  const references: (VisionImage & { name: string })[] = [];
  for (const r of refs) {
    const image = await thumb(deps, prefix, manifest, r.key);
    if (image) references.push({ ...image, name: r.name });
  }
  if (references.length === 0) return { checked: 0 };
  const idByName = new Map(plan.subjects.map((k) => [firstName(k.name).toLowerCase(), k.id]));
  const todo = (await claimKeys(plan)).filter((c) => ctx.film.aiChecks[c.key] === undefined);
  let checked = 0;
  for (let i = 0; i < todo.length; i += FRAME_CHECK_BATCH) {
    const batch = todo.slice(i, i + FRAME_CHECK_BATCH);
    const images: VisionImage[] = [];
    const keys: string[] = [];
    const skipped: string[] = [];
    for (const c of batch) {
      const image = await thumb(deps, prefix, manifest, checkKey(c.frame));
      if (image) {
        images.push(image);
        keys.push(c.key);
      } else skipped.push(c.key);
    }
    let checks: CheckCache = Object.fromEntries(skipped.map((k) => [k, { kind: 'claim', value: null }]));
    if (images.length > 0) {
      const isPublic = plan.kind === 'family_holiday';
      const result = await deps.chat(buildFrameCheckRequestBody(references.map((r) => r.name), references, images, claimModelFor(plan), visionOptions(isPublic)));
      await recordUsage(deps, keys[0], 'year_film_vision', claimModelFor(plan), result.ok, result.usage);
      const parsed = result.content !== null ? parseFrameCheckResponse(result.content, images.length, idByName, visionOptions(isPublic)) : new Map();
      checks = { ...checks, ...splitBatch('claim', keys, parsed) };
      checked += images.length;
    }
    await deps.bridge.call('save_checks', { checks });
  }
  return { checked };
}

// ── 4. Build ─────────────────────────────────────────────────────────────

export async function buildAndSave(deps: StageDeps): Promise<{ saved: boolean }> {
  const { ctx, plan, prefix } = await load(deps);
  if (!plan) {
    await deps.bridge.call('end_cycle', { outcome: 'skipped', code: 'BELOW_FLOORS' });
    return { saved: false };
  }
  const hashes = new Map<string, string>();
  for (const m of ctx.rows.memories) hashes.set(m.id, await yearFilmTextHash(m.content, m.audio_transcript ?? null, m.description ?? null));

  // Quotes: sticky candidates from the first curate, else this attempt's pick.
  let candidatesToStore: QuoteCandidate[] | null = null;
  let quotes: VerifiedQuote[];
  let quoteLanguage: string | null = null;
  if (ctx.film.quoteCandidates?.length) {
    quotes = stickyQuotes(ctx.film.quoteCandidates, hashes, ctx.film.edits?.quote ?? null);
  } else {
    const cached = cachedQuote(ctx.film.aiChecks, await quoteCacheKey(plan));
    quotes = cached?.accepted ?? [];
    quoteLanguage = cached?.language ?? null;
    candidatesToStore = quotes.map((q) => ({ ...q, textHash: hashes.get(q.memoryId) ?? '' }));
  }
  const language: FilmLanguage = (ctx.film.language as FilmLanguage | null) ??
    resolveFilmLanguage(quoteLanguage, detectJournalLanguage(plan.pool.map((m) => m.text)), ctx.rows.family.gallery_caption_language);

  const checks: FrameChecks = new Map();
  for (const c of await claimKeys(plan)) {
    const verdict = cachedFrame(ctx.film.aiChecks, c.key);
    if (verdict) checks.set(checkKey(c.frame), verdict);
  }

  const common = { quotes, language, checks };
  const script: FilmScript = plan.kind === 'birthday'
    ? buildBirthdayScript({ ...plan.input, ...common })
    : plan.kind === 'family_month'
    ? buildMonthlyScript({ ...plan.input, ...common })
    : plan.kind === 'family_holiday'
    ? buildHolidayScript({ ...plan.input, ...common })
    : buildFamilyYearScript({ ...plan.input, ...common });

  const refs = scriptReferences(script, ctx.rows.portraits);
  const editsBed = ctx.film.edits?.musicBedId;
  const bed = isYearFilmBed(editsBed) ? editsBed
    : isYearFilmBed(ctx.film.musicBedId) ? ctx.film.musicBedId
    : defaultBed(ctx.film.kind, deps.filmId, script.span.from);

  await deps.bridge.call('save_curation', {
    payload: {
      epoch: ctx.film.contentEpoch,
      language,
      scope_label: script.title,
      music_bed_id: bed,
      ...(candidatesToStore ? { quote_candidates: candidatesToStore } : {}),
      film_script: script,
      referenced_memory_ids: refs.memoryIds,
      referenced_asset_keys: refs.assetKeys,
      referenced_member_ids: refs.memberIds,
      referenced_portrait_version_ids: refs.portraitVersionIds,
      quoted_memory_text_hashes: Object.fromEntries(refs.textMemoryIds.map((id) => [id, hashes.get(id) ?? ''])),
    },
  });
  await deps.storage.putJson(`${prefix}script.json`, { bed, editsVersion: ctx.film.editsVersion, script } satisfies ScriptEnvelope);
  await deps.bridge.call('set_status', { status: 'preparing' });
  return { saved: true };
}

// ── 5. Prepare ───────────────────────────────────────────────────────────

export async function startPrepare(deps: StageDeps, prefix: string): Promise<{ machineId: string }> {
  const envelope = await deps.storage.getJson<ScriptEnvelope>(`${prefix}script.json`);
  if (!envelope) throw new Error('script_missing');
  const items = planPrepare(envelope.script);
  const machineId = await startMachine(deps, 'prepare', prefix, { version: 1, mode: 'prepare', prefix, items }, [...new Set(items.map((i) => i.key))]);
  return { machineId };
}

// ── 6. Voice + frame checks ──────────────────────────────────────────────

async function prepared(deps: StageDeps, prefix: string): Promise<{ envelope: ScriptEnvelope; prep: PrepareManifest }> {
  const envelope = await deps.storage.getJson<ScriptEnvelope>(`${prefix}script.json`);
  const prep = await deps.storage.getJson<PrepareManifest>(`${prefix}prep/prep.json`);
  if (!envelope || !prep) throw new Error('prep_missing');
  return { envelope, prep };
}

async function aiChecks(deps: StageDeps): Promise<CheckCache & Record<string, unknown>> {
  return (await deps.bridge.call<FilmContext>('load_film_context')).film.aiChecks;
}

async function voiceKey(prep: PrepareManifest, id: string, index: number): Promise<string> {
  const p = prep.assets[id];
  return await checkCacheKey({ kind: 'voice', model: VOICE_CHECK_MODEL, assetKey: p.key, window: p.windows[index] });
}

async function soundVerdicts(prep: PrepareManifest, cache: CheckCache): Promise<Record<string, ReturnType<typeof cachedVoice> & object | null>> {
  const out: Record<string, NonNullable<ReturnType<typeof cachedVoice>> | null> = {};
  for (const [id, p] of Object.entries(prep.assets)) {
    if (p.mode !== 'voice') continue;
    for (let i = 0; i < p.windows.length; i += 1) {
      const v = cachedVoice(cache, await voiceKey(prep, id, i));
      if (v !== undefined) out[voiceRef(id, i)] = v;
    }
  }
  return out;
}

/** The reference photos and name map the frame checks compare against. */
async function frameReferences(deps: StageDeps, prefix: string, script: FilmScript, prep: PrepareManifest) {
  const { people, ctx } = frameContext(script, prep);
  const referenceKeys = people.map((p) => p.referenceKey!).sort();
  const references: (VisionImage & { name: string })[] = [];
  for (const p of people) {
    const b64 = await deps.storage.getBase64(`${prefix}${prep.assets[assetId('reference', p.referenceKey!)].checkImage}`);
    if (b64) references.push({ base64: b64, contentType: 'image/jpeg', name: p.name });
  }
  const idByName = new Map(people.map((p) => [p.name.toLowerCase(), p.id]));
  return { ctx, referenceKeys, references, idByName };
}

/** Runs the frame checks `needs` asks for, in batches, persisting each batch;
 * returns the cache with the new verdicts. */
async function runFrameNeeds(
  deps: StageDeps,
  prefix: string,
  prep: PrepareManifest,
  needs: FrameNeed[],
  refs: { referenceKeys: string[]; references: (VisionImage & { name: string })[]; idByName: Map<string, string> },
  isPublic: boolean,
  cache: CheckCache & Record<string, unknown>,
): Promise<CheckCache & Record<string, unknown>> {
  for (let i = 0; i < needs.length; i += FRAME_CHECK_BATCH) {
    const batch = needs.slice(i, i + FRAME_CHECK_BATCH);
    const keys = await Promise.all(batch.map((n) => frameKey(prep, n, refs.referenceKeys, isPublic)));
    const images: VisionImage[] = [];
    const sentKeys: string[] = [];
    const missing: string[] = [];
    for (let j = 0; j < batch.length; j += 1) {
      const b64 = await deps.storage.getBase64(`${prefix}${batch[j].checkImage}`);
      if (b64) {
        images.push({ base64: b64, contentType: 'image/jpeg' });
        sentKeys.push(keys[j]);
      } else missing.push(keys[j]);
    }
    let checks: CheckCache = Object.fromEntries(missing.map((k) => [k, { kind: 'frame', value: null }]));
    if (images.length > 0) {
      const result = await deps.chat(buildFrameCheckRequestBody(refs.references.map((x) => x.name), refs.references, images, FRAME_CHECK_MODEL, visionOptions(isPublic)));
      await recordUsage(deps, sentKeys[0], 'year_film_vision', FRAME_CHECK_MODEL, result.ok, result.usage);
      const parsed = result.content !== null ? parseFrameCheckResponse(result.content, images.length, refs.idByName, visionOptions(isPublic)) : new Map();
      checks = { ...checks, ...splitBatch('frame', sentKeys, parsed) };
    }
    await deps.bridge.call('save_checks', { checks });
    cache = { ...cache, ...checks } as typeof cache;
  }
  return cache;
}

/** Walks the sound candidates, one voice check at a time, persisting each.
 * A public film (holiday card) first strict-checks the frames of its video
 * sound windows, so a window the check removes is skipped like a failed voice
 * check. */
export async function runVoiceChecks(deps: StageDeps, prefix: string, maxChecks = 12): Promise<{ done: boolean }> {
  const { envelope, prep } = await prepared(deps, prefix);
  const isPublic = isPublicFilm(envelope.script);
  let cache = await aiChecks(deps);
  let blocked = new Set<string>();
  if (isPublic) {
    const refs = await frameReferences(deps, prefix, envelope.script, prep);
    const verdicts = () => frameVerdicts(prep, cache, refs.referenceKeys, true);
    const needs = soundFrameNeeds(envelope.script, prep, await verdicts());
    if (needs.length > 0) cache = await runFrameNeeds(deps, prefix, prep, needs, refs, true, cache);
    blocked = blockedSoundWindows(envelope.script, prep, await verdicts());
  }
  for (let i = 0; i < maxChecks; i += 1) {
    const r = resolveSound(envelope.script, prep, await soundVerdicts(prep, cache), blocked);
    if ('done' in r) return { done: true };
    const key = await voiceKey(prep, r.need.assetId, r.need.windowIndex);
    const wav = await deps.storage.getBase64(`${prefix}${r.need.wav}`);
    let value = null;
    if (wav) {
      const result = await deps.chat(buildVoiceCheckRequestBody(wav, 'the child'));
      const w = prep.assets[r.need.assetId].windows[r.need.windowIndex];
      await recordUsage(deps, key, 'year_film_audio', VOICE_CHECK_MODEL, result.ok, result.usage, w.end - w.start);
      value = parseVoiceCheck(result.content);
    }
    const entry = { [key]: { kind: 'voice', value } };
    await deps.bridge.call('save_checks', { checks: entry });
    cache = { ...cache, ...entry } as typeof cache;
  }
  return { done: false };
}

function frameContext(script: FilmScript, prep: PrepareManifest) {
  const people = script.references?.length ? script.references : script.subjects ?? [];
  const withImages = people.filter((p) => p.referenceKey && prep.assets[assetId('reference', p.referenceKey)]?.checkImage);
  return {
    people: withImages,
    ctx: {
      requiredChildId: script.kind === 'birthday' ? script.subjects?.[0]?.id ?? null : null,
      ownChildIds: new Set(people.map((p) => p.id)),
      hasReferences: withImages.length > 0,
    },
  };
}

async function frameKey(prep: PrepareManifest, ref: { assetId: string; windowIndex: number | null }, referenceKeys: string[], isPublic: boolean): Promise<string> {
  const p = prep.assets[ref.assetId];
  return await checkCacheKey({
    kind: 'frame', model: FRAME_CHECK_MODEL, assetKey: p.key,
    window: ref.windowIndex === null ? null : p.windows[ref.windowIndex], referenceKeys, ...publicVariant(isPublic),
  });
}

async function frameVerdicts(prep: PrepareManifest, cache: CheckCache, referenceKeys: string[], isPublic: boolean) {
  const out: Record<string, NonNullable<ReturnType<typeof cachedFrame>> | null> = {};
  for (const [id, p] of Object.entries(prep.assets)) {
    // A public film also checks each video sound window (the scene shows it).
    const windowed = p.mode === 'clip' || p.mode === 'verified' || (isPublic && p.mode === 'voice');
    const refs: (number | null)[] = windowed ? p.windows.map((_, i) => i) : [null];
    for (const w of refs) {
      const v = cachedFrame(cache, await frameKey(prep, { assetId: id, windowIndex: w }, referenceKeys, isPublic));
      if (v !== undefined) out[frameRef(id, w)] = v;
    }
  }
  return out;
}

/** Frame-check rounds (first windows batched, then re-cut windows). */
export async function runFrameChecks(deps: StageDeps, prefix: string, maxRounds = 6): Promise<{ done: boolean }> {
  const { envelope, prep } = await prepared(deps, prefix);
  const isPublic = isPublicFilm(envelope.script);
  const refs = await frameReferences(deps, prefix, envelope.script, prep);
  let cache = await aiChecks(deps);
  for (let round = 0; round < maxRounds; round += 1) {
    const r = resolveFrames(envelope.script, prep, await frameVerdicts(prep, cache, refs.referenceKeys, isPublic), { ...refs.ctx, hasReferences: refs.references.length > 0 });
    if ('done' in r) return { done: true };
    cache = await runFrameNeeds(deps, prefix, prep, r.needs, refs, isPublic, cache);
  }
  return { done: false };
}

/** film.json from the verdicts (no new calls). */
export async function writeFilmJson(deps: StageDeps, prefix: string): Promise<{ written: true }> {
  const { envelope, prep } = await prepared(deps, prefix);
  const cache = await aiChecks(deps);
  const { people, ctx } = frameContext(envelope.script, prep);
  const referenceKeys = people.map((p) => p.referenceKey!).sort();
  const isPublic = isPublicFilm(envelope.script);
  const verdicts = await frameVerdicts(prep, cache, referenceKeys, isPublic);
  const sound = resolveSound(envelope.script, prep, await soundVerdicts(prep, cache), blockedSoundWindows(envelope.script, prep, verdicts));
  const frames = resolveFrames(envelope.script, prep, verdicts, ctx);
  if (!('done' in sound) || !('done' in frames)) throw new Error('checks_incomplete');
  const film = applyPrepared(envelope.script, prep, sound.done as SoundChoice | null, frames.done as FrameResolution, envelope.bed);
  await deps.storage.putJson(`${prefix}film.json`, film);
  return { written: true };
}

// ── 7. Render ────────────────────────────────────────────────────────────

export async function claimRenderSlot(deps: StageDeps): Promise<'ok' | 'full'> {
  const { state } = await deps.bridge.call<{ state: string }>('claim_render_slot');
  if (state === 'ok' || state === 'full') return state;
  throw new AttemptStopped(state);
}

export async function startRender(deps: StageDeps, prefix: string): Promise<{ machineId: string }> {
  const machineId = await startMachine(deps, 'render', prefix, { version: 1, mode: 'render', prefix, film: 'film.json' }, []);
  return { machineId };
}

// ── 8. Publish ───────────────────────────────────────────────────────────

export async function publish(deps: StageDeps, prefix: string): Promise<{ ok: boolean; reason?: string }> {
  const status = await deps.storage.getJson<{ state: string; durationMs?: number }>(`${prefix}status.json`);
  const envelope = await deps.storage.getJson<ScriptEnvelope>(`${prefix}script.json`);
  if (status?.state !== 'done' || !status.durationMs || !envelope) throw new Error('render_output_missing');
  const result = await deps.bridge.call<{ ok: boolean; reason?: string; delete_keys?: string[] }>('publish', {
    editsVersion: envelope.editsVersion,
    videoKey: `${prefix}film.mp4`,
    posterKey: `${prefix}poster.jpg`,
    scenesKey: `${prefix}scenes.json`,
    durationMs: status.durationMs,
  });
  const oldKeys = (result.delete_keys ?? []).filter((k) => typeof k === 'string' && k.includes('/year-films/') && !k.startsWith(prefix));
  if (result.ok) {
    await deps.storage.deleteKeys(oldKeys);
    await deps.storage.deletePrefix(`${prefix}prep/`);
    await deps.storage.deletePrefix(`${prefix}thumbs/`);
    return { ok: true };
  }
  // Lost the CAS: this attempt's output must never be served.
  await deps.storage.deleteKeys(oldKeys);
  await deps.storage.deletePrefix(prefix);
  return { ok: false, reason: result.reason };
}
