// Holiday card generation stages (docs/plans/holiday-cards-p1.md Step 4b).
// Same shape as stages.ts: each stage is ONE `step.do` (card-workflow.ts), is
// idempotent, reloads what it needs through the bridge (memory text never
// crosses a step boundary: stages return ids, numbers and states only -- the
// one exception, the prepared letters, goes through a private R2 object that
// the Workflow deletes at the end) and talks to the database only through the
// `card_*` bridge operations (each of which heartbeats the card lease and
// answers 409 when the attempt was superseded or the card deleted).
//
//   init -> front:plan -> front:probe:N -> front:select -> front:judge:N ->
//   front:store -> film:setup -> film:claim -> film:start ->
//   letters:prepare -> letters:write:N -> finish
//
// SUBREQUEST BUDGET (Cloudflare counts fetch AND R2 binding calls; the
// working assumption is the classic 1000 per invocation, shared by every
// call a step makes -- see memory-book-worker/src/dimensions.ts):
//   front:plan / select / film:* / letters:* load the context: 1 bridge call
//     + the step's own few bridge writes.
//   front:probe:N   <= PROBE_STEP_PHOTOS (150) photos x 2 ranged reads (256 KB,
//     then the 4 MB fallback) = <= 300 R2 reads + 2 bridge calls. Typical: 150.
//     At most MAX_PROBE_PHOTOS (900) photos are probed per card = 6 steps, the
//     most family-complete / newest first (the rest count as unreadable-size).
//   front:judge:N   one batch of FRONT_JUDGE_BATCH (8) candidates: <= 8 R2
//     preview reads + <= 2 judge calls (+1 retry each inside createChat) + <= 4
//     ledger writes = < 30. At most 4 batches (FRONT_MAX_CANDIDATES 30).
//   letters:prepare <= 1 quote + (<= 2 attempts x children) details + 1 voice
//     model calls, each + 1 ledger write (+1 createChat retry) -- < 50.
//   letters:write:N editor + 3 writers: 4 model calls + 4 ledger writes < 20.
// Every step stays under ~300 even in the worst case.
import {
  buildFrontPool,
  FRONT_PROBE_CONCURRENCY,
  type FrontPhoto,
  type FrontPickInput,
  type FrontPickResult,
  type FrontRun,
  fetchPreviewImages,
  frontMemoriesFromFilmSources,
  judgeFrontCandidates,
  probePhotoDimensions,
  summarizeFrontPicks,
} from '../../../supabase/functions/_shared/holiday-card-generate-front.ts';
import {
  type ChatPort,
  type ImageReaderPort,
  type ImageSizeParser,
  mapPool,
  type UsageSink,
} from '../../../supabase/functions/_shared/holiday-card-generate-ports.ts';
import {
  cardToneForAngle,
  type CardLettersData,
  type CardLettersInput,
  type PreparedLetters,
  prepareCardLetters,
  writeCardLetters,
} from '../../../supabase/functions/_shared/holiday-card-generate-letters.ts';
import { isCardGreeting } from '../../../supabase/functions/_shared/holiday-card-letter.ts';
import {
  coreFamilyMemberIds,
  type FrontCandidate,
  type FrontVerdict,
  rankFrontPicks,
  selectFrontCandidates,
} from '../../../supabase/functions/_shared/holiday-card-photos.ts';
import { type FamilyRows, mapFamilyRows, planFilm } from '../../../supabase/functions/_shared/year-film-context.ts';
import { holidayFilmScope } from '../../../supabase/functions/_shared/year-film-eligibility.ts';
import { AttemptStopped, type BridgeClient } from './bridge';
import type { ChatFn } from './openai';
import { cardAttemptPrefix, type Storage } from './storage';
import { uuidV5 } from './uuid';

// ── Numbers (documented above) ───────────────────────────────────────────

export const PROBE_STEP_PHOTOS = 150;
export const MAX_PROBE_PHOTOS = 900;
/** The card front's top picks the film closes on (preferredCloseMedia). */
export const FILM_CLOSE_PICKS = 6;
/** Letter writing runs again once when a run produced no usable letter. */
export const LETTER_ATTEMPTS = 2;

export interface CardStageDeps {
  cardId: string;
  attemptId: string;
  bridge: BridgeClient;
  /** Private R2 helper for the prepared letters. */
  storage: Storage;
  images: ImageReaderPort;
  imageSize: ImageSizeParser;
  chat: ChatFn;
  /** Starts YEAR_FILM_WORKFLOW for a claimed film attempt (duplicate = success). Throws on failure. */
  startFilm: (filmId: string, filmAttemptId: string) => Promise<void>;
  now: () => Date;
}

interface CardContext {
  card: {
    id: string;
    familyId: string;
    ownerId: string;
    year: number;
    greeting: string;
    language: string;
    locale: string | null;
    filmId: string | null;
    shareToken: string | null;
  };
  today: string;
  captionInstructions: string | null;
  rows: FamilyRows;
}

export interface CardInit {
  /** The card's civil date (UTC), clamped into the card's year. */
  today: string;
}

async function loadContext(deps: CardStageDeps, init: CardInit): Promise<CardContext> {
  return deps.bridge.call<CardContext>('card_load_context', { today: init.today });
}

function usageSink(deps: CardStageDeps, prefix = ''): UsageSink {
  return async (event) => {
    await deps.bridge.call('card_record_usage', {
      aiCallId: await uuidV5(`${deps.attemptId}:${prefix}${event.key}`),
      usageOperation: event.operation,
      model: event.model,
      success: event.ok,
      usage: event.usage,
    });
  };
}

// ── init ─────────────────────────────────────────────────────────────────

/** Claims the card's generation lease (the callers only dispatch an attempt
 * id; a fresh lease held by another attempt, a deleted card or one that is no
 * longer generating = stop) and fixes the card's date once (a step result is
 * durable, so a replay never moves it). */
export async function cardInit(deps: CardStageDeps): Promise<CardInit> {
  const { state, card } = await deps.bridge.call<{ state: string; card?: { year: number } }>('card_start');
  if (state !== 'ok' || !card) throw new AttemptStopped(state === 'ok' ? 'superseded' : state);
  const utc = deps.now().toISOString().slice(0, 10);
  const first = `${card.year}-01-01`;
  const last = `${card.year}-12-31`;
  return { today: utc < first ? first : utc > last ? last : utc };
}

// ── front picks ──────────────────────────────────────────────────────────

function frontInput(ctx: CardContext): FrontPickInput {
  const data = mapFamilyRows(ctx.rows);
  return {
    today: ctx.today,
    members: data.members,
    // Legacy single-asset photos have no memory_media id: not referenceable.
    memories: frontMemoriesFromFilmSources(data.memories, { includeLegacy: false }),
    milestones: data.milestones,
  };
}

/** The photos whose original size is probed, best first: most core-family
 * members tagged, then newest, capped at MAX_PROBE_PHOTOS. */
export async function frontPlan(deps: CardStageDeps, init: CardInit): Promise<{ probeIds: string[]; poolPhotos: number }> {
  const input = frontInput(await loadContext(deps, init));
  const pool = buildFrontPool(input);
  const core = coreFamilyMemberIds(input.members, input.today);
  const covered = (taggedMemberIds: string[]) => new Set(taggedMemberIds.filter((id) => core.has(id))).size;
  const ordered = [...pool.pool].sort((a, b) =>
    covered(b.taggedMemberIds) - covered(a.taggedMemberIds) || b.date.localeCompare(a.date) || a.mediaId.localeCompare(b.mediaId)
  );
  return { probeIds: ordered.slice(0, MAX_PROBE_PHOTOS).map((p) => p.mediaId), poolPhotos: pool.pool.length };
}

/** One probe step: media id -> [width, height] (EXIF-corrected) for the ids
 * whose header could be read; unreadable ones are simply absent. */
export async function frontProbe(deps: CardStageDeps, mediaIds: string[]): Promise<Record<string, [number, number]>> {
  const { media } = await deps.bridge.call<{ media: { id: string; objectKey: string }[] }>('card_load_media', { mediaIds });
  const out: Record<string, [number, number]> = {};
  await mapPool(media, FRONT_PROBE_CONCURRENCY, async (m) => {
    const size = await probePhotoDimensions(m.objectKey, deps.images, deps.imageSize);
    if (size) out[m.id] = [size.width, size.height];
  });
  return out;
}

export interface FrontSelection {
  candidates: FrontCandidate[];
  eligible: number;
  dropped: Record<string, number>;
  poolPhotos: number;
  probed: number;
  /** Core family size: the ranking's expected people. */
  expectedPeople: number;
}

export async function frontSelect(
  deps: CardStageDeps,
  init: CardInit,
  probed: { count: number; dims: Record<string, [number, number]> },
): Promise<FrontSelection> {
  const input = frontInput(await loadContext(deps, init));
  const pool = buildFrontPool(input);
  const core = coreFamilyMemberIds(input.members, input.today);
  const measured = pool.pool.map((p) => {
    const dims = probed.dims[p.mediaId];
    return { ...p, dims: dims ? { width: dims[0], height: dims[1] } : null };
  });
  const selection = selectFrontCandidates(measured, { today: input.today, excludedMemoryIds: pool.excluded, coreMemberIds: core });
  return {
    candidates: selection.candidates,
    eligible: selection.eligible,
    dropped: selection.dropped,
    poolPhotos: pool.pool.length,
    probed: probed.count,
    expectedPeople: core.size,
  };
}

/** One vision-judge batch (<= FRONT_JUDGE_BATCH candidates). The verdicts
 * come back WITHOUT the model's free text (`setting`, `why`): ids and enums
 * only cross the step boundary. */
export async function frontJudge(
  deps: CardStageDeps,
  candidates: FrontCandidate[],
  batchIndex: number,
): Promise<{ verdicts: [string, FrontVerdict][]; previews: number }> {
  const { media } = await deps.bridge.call<{ media: { id: string; objectKey: string; previewKey: string | null; aspectRatio: number | null; contentType?: string | null }[] }>(
    'card_load_media',
    { mediaIds: candidates.map((c) => c.mediaId) },
  );
  const photos = new Map<string, FrontPhoto>(media.map((m) => [m.id, { mediaId: m.id, objectKey: m.objectKey, previewKey: m.previewKey, aspectRatio: m.aspectRatio, contentType: m.contentType ?? null }]));
  // No downscaler in the Worker: a photo without a stored preview is skipped
  // (left unjudged), never read in full.
  const previews = await fetchPreviewImages(photos, { images: deps.images });
  const verdicts = await judgeFrontCandidates(candidates, previews, {
    chat: deps.chat as ChatPort,
    usage: usageSink(deps, `b${batchIndex}:`),
  });
  return {
    verdicts: [...verdicts].map(([id, v]) => [id, { ...v, setting: '', why: '' }]),
    previews: previews.size,
  };
}

/** Ranks the judged candidates, stores the summary (ids + scores + verdict
 * numbers/enums, no free text) and returns the top picks' media ids. */
export async function frontStore(
  deps: CardStageDeps,
  init: CardInit,
  selection: FrontSelection,
  verdicts: [string, FrontVerdict][],
  keep?: number,
): Promise<{ pickIds: string[]; picks: number }> {
  const judged = new Map(verdicts);
  const ranking = rankFrontPicks(selection.candidates, judged, { today: init.today, expectedPeople: selection.expectedPeople });
  // summarizeFrontPicks reads only these fields of a run (pinned by a test).
  const run = {
    ranking,
    pool: { pool: { length: selection.poolPhotos } },
    probedKeys: selection.probed,
    selection: { eligible: selection.eligible, candidates: selection.candidates, dropped: selection.dropped },
    previews: { size: judged.size },
    verdicts: judged,
  } as unknown as FrontRun;
  const summary: FrontPickResult = summarizeFrontPicks(run, keep);
  await deps.bridge.call('card_save_front', { front: summary });
  return { pickIds: summary.candidates.map((c) => c.mediaId), picks: summary.candidates.length };
}

// ── film ─────────────────────────────────────────────────────────────────

/** Plans the card's film on the card's own data and, when it clears the
 * floors, creates the film row (create_holiday_card_film: idempotent -- a
 * retry or the sweep gets the same film and token). A card that already has a
 * film keeps it whatever the pool says now. Below the floors: no film row. */
export async function filmSetup(
  deps: CardStageDeps,
  init: CardInit,
  closeMediaIds: string[],
): Promise<{ filmId: string | null; reason: string | null }> {
  const ctx = await loadContext(deps, init);
  if (ctx.card.filmId) return { filmId: ctx.card.filmId, reason: null };
  const scope = holidayFilmScope(ctx.card.year, ctx.today);
  const planned = planFilm(mapFamilyRows(ctx.rows), {
    kind: 'family_holiday',
    familyMemberId: null,
    ageYear: null,
    scopeStart: scope.start,
    scopeEndExclusive: scope.endExclusive,
    edits: { greeting: ctx.card.greeting },
    hasPublished: false,
  });
  if (!planned.ok) return { filmId: null, reason: planned.reason };
  const { filmId } = await deps.bridge.call<{ filmId: string }>('card_create_film', {
    scopeStart: scope.start,
    scopeEnd: scope.endExclusive,
    closeMedia: closeMediaIds,
  });
  return { filmId, reason: null };
}

/** claim_year_film_by_id for the card's own film. `filmAttemptId` null = zero
 * rows = the hourly cron (or an earlier try of this step) already claimed it:
 * success, nothing to start. */
export async function filmClaim(deps: CardStageDeps): Promise<{ filmId: string; filmAttemptId: string | null }> {
  const result = await deps.bridge.call<{ claimed: boolean; filmId: string; filmAttemptId?: string }>('card_claim_film');
  return { filmId: result.filmId, filmAttemptId: result.claimed ? result.filmAttemptId ?? null : null };
}

/** Starts the claimed film's Workflow. On failure the cycle ends `aborted`
 * with DISPATCH_FAILED (back to the queue without burning an attempt, exactly
 * like schedule-year-films), and the hourly cron claims + dispatches it. The
 * card itself is unaffected. */
export async function filmStart(deps: CardStageDeps, filmId: string, filmAttemptId: string): Promise<{ started: boolean }> {
  try {
    await deps.startFilm(filmId, filmAttemptId);
    return { started: true };
  } catch (error) {
    if (error instanceof AttemptStopped) throw error;
    await deps.bridge.call('card_end_film_cycle', { filmAttemptId });
    console.error('holiday card film dispatch failed', { cardId: deps.cardId, filmId });
    return { started: false };
  }
}

// ── letters ──────────────────────────────────────────────────────────────

function lettersInput(ctx: CardContext, filmPresent: boolean): Omit<CardLettersInput, 'prepared'> {
  const data = mapFamilyRows(ctx.rows);
  const letters: CardLettersData = {
    familyName: data.familyName,
    language: data.language,
    members: data.members,
    memories: data.memories,
    milestones: data.milestones,
    captionInstructions: ctx.captionInstructions,
  };
  return { today: ctx.today, data: letters, greeting: isCardGreeting(ctx.card.greeting) ? ctx.card.greeting : null, filmPresent };
}

const preparedKey = (prefix: string) => `${prefix}prepared.json`;

/** The paid preparation (line-of-the-year check, per-child details, the
 * parents' style card). The result holds short phrases of memory text, so it
 * goes to a private R2 object (deleted at the end), not into the step result. */
export async function lettersPrepare(deps: CardStageDeps, init: CardInit, filmPresent: boolean): Promise<{ prefix: string; quotes: number }> {
  const ctx = await loadContext(deps, init);
  const prefix = cardAttemptPrefix(ctx.card.ownerId, deps.cardId, deps.attemptId);
  // A replayed step reuses the stored preparation instead of paying again.
  const existing = await deps.storage.getJson<PreparedLetters>(preparedKey(prefix));
  if (existing) return { prefix, quotes: existing.quotes.length };
  const prepared = await prepareCardLetters(lettersInput(ctx, filmPresent), { chat: deps.chat as ChatPort, usage: usageSink(deps) });
  await deps.storage.putJson(preparedKey(prefix), prepared);
  return { prefix, quotes: prepared.quotes.length };
}

export interface LettersWritten {
  saved: boolean;
  letters: number;
  /** Whether another attempt could help (false for a deterministic "nothing to write about"). */
  retryable: boolean;
}

/** Editor + one writer per angle, then stores letters, QR caption (only with
 * a film), signature and editor facts. Nothing is stored when no letter
 * passed the checks. */
export async function lettersWrite(
  deps: CardStageDeps,
  init: CardInit,
  filmPresent: boolean,
  prefix: string,
  attempt: number,
): Promise<LettersWritten> {
  const ctx = await loadContext(deps, init);
  const prepared = await deps.storage.getJson<PreparedLetters>(preparedKey(prefix));
  const result = await writeCardLetters(
    { ...lettersInput(ctx, filmPresent), ...(prepared ? { prepared } : {}) },
    { chat: deps.chat as ChatPort, usage: usageSink(deps, `w${attempt}:`) },
  );
  if (result.letters.length === 0) {
    return { saved: false, letters: 0, retryable: result.skipped !== 'no_highlights' };
  }
  await deps.bridge.call('card_save_letters', {
    letters: result.letters.map((l) => ({
      // The card renderer's tone ('warm' angle = 'reflective').
      tone: cardToneForAngle(l.tone),
      text: l.text,
      chars: l.chars,
      softFlags: l.softFlags.map((f) => ({ code: f.code, ...(f.detail ? { detail: f.detail } : {}) })),
    })),
    qrCaption: filmPresent ? result.qrCaption : null,
    signature: result.signature,
    editorFacts: { facts: result.editorFacts, broadStrokes: result.broadStrokes, lineOfYear: result.lineOfYear },
  });
  return { saved: true, letters: result.letters.length, retryable: false };
}

// ── finish ───────────────────────────────────────────────────────────────

/** status = ready + the lease cleared; the attempt's R2 files go first. */
export async function cardReady(deps: CardStageDeps, prefix: string | null): Promise<{ ready: true }> {
  if (prefix) await deps.storage.deletePrefix(prefix);
  await deps.bridge.call('card_finish', { outcome: 'ready' });
  return { ready: true };
}

/** status = failed + a closed code (never raw error text); R2 files removed. */
export async function cardFailed(deps: CardStageDeps, prefix: string | null, code: string): Promise<{ cleaned: true }> {
  if (prefix) await deps.storage.deletePrefix(prefix);
  try {
    await deps.bridge.call('card_finish', { outcome: 'failed', code });
  } catch (error) {
    if (!(error instanceof AttemptStopped)) throw error;
  }
  return { cleaned: true };
}
