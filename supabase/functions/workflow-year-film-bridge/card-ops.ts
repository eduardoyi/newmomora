/**
 * Holiday card generation operations of the bridge (docs/plans/
 * holiday-cards-p1.md Step 4b). The HolidayCardWorkflow in
 * cloudflare/year-film-worker reads family data and writes the card row only
 * through these `card_*` operations.
 *
 * Lease: the holiday-cards Edge Function and the stuck-generation sweep only
 * dispatch `{ cardId, attemptId }` (a fresh random attempt id; they do not
 * write the lease). The Workflow's first operation, `card_start`, CLAIMS it:
 * holiday_cards.attempt_id / workflow_instance_id / heartbeat_at are set to this
 * attempt when the card is live and `generating` and nobody else holds a fresh
 * lease (no attempt, no heartbeat, or a heartbeat older than LEASE_STALE_MS =
 * the 20 minutes claim_family_deletion_fence and the sweep also use). A replay
 * of the same attempt re-claims idempotently. Every later operation
 * (a) refreshes heartbeat_at only when the card is live, `generating` and still
 * on THIS attempt, and answers 409 `{ state: 'deleted' | 'superseded' }`
 * otherwise, and (b) every write below repeats that predicate in its own
 * UPDATE, so a card deleted or re-dispatched between the check and the write
 * is never touched. A superseded Workflow stops quietly.
 *
 * Writes are whitelisted and shape-checked here: front candidates hold ids,
 * numbers and enums only; letter / fact text is length-capped. Logs carry
 * operation names, ids and codes only -- never memory text, letters or names.
 */
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { addYears } from '../_shared/date-context.ts';
import { addDays } from '../_shared/year-film-eligibility.ts';
import { CARD_MEMBER_COLUMNS, CARD_MEMORY_COLUMNS, type Client, loadFamilyRows } from './rows.ts';
import { isValidUsageBody, recordAiUsage } from './usage.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const CARD_WORK_OPERATIONS = new Set([
  'card_load_context', 'card_load_media', 'card_save_front', 'card_create_film', 'card_claim_film',
  'card_end_film_cycle', 'card_save_letters', 'card_record_usage', 'card_finish',
]);
export const CARD_OPERATIONS = new Set([...CARD_WORK_OPERATIONS, 'card_start', 'card_heartbeat']);

/** A lease whose last heartbeat is older than this is dead (same 20 minutes as
 * the family-deletion fence and the stuck-generation sweep). */
export const LEASE_STALE_MS = 20 * 60_000;

const CARD_USAGE_OPERATIONS = new Set([
  'holiday_card_front_judge', 'holiday_card_voice', 'holiday_card_details',
  'holiday_card_editor', 'holiday_card_writer', 'holiday_card_quote_check',
]);

/** Media rows one `card_load_media` call may resolve (URL-length bound, like CHUNK_SIZE). */
export const CARD_MEDIA_BATCH_MAX = 200;
const FRONT_CANDIDATES_MAX = 12;
const LETTERS_MAX = 3;
const LETTER_TEXT_MAX = 4000;
const SHORT_TEXT_MAX = 300;
const EDITOR_FACTS_MAX = 12;
const CLOSE_MEDIA_MAX = 12;

const LETTER_TONES = new Set(['classic', 'playful', 'reflective']);
const CARD_ORIENTATIONS = new Set(['portrait', 'landscape']);
const PRINT_CLASSES = new Set(['full-bleed', 'bordered']);
const LOOKING = new Set(['most', 'some', 'none']);
const LIGHT = new Set(['good', 'ok', 'poor']);
const COUNT_KEYS = ['poolPhotos', 'probed', 'eligible', 'candidates', 'previews', 'judged', 'picks', 'nearMisses', 'unjudged'];
const DROP_KEYS = new Set([
  'outside-window', 'too-few-tagged', 'share-sensitive', 'reported', 'low-mood', 'unreadable-size', 'low-print',
]);

interface CardRow {
  id: string;
  family_id: string;
  created_by: string | null;
  year: number;
  greeting: string;
  language: string;
  locale: string | null;
  film_id: string | null;
  share_token: string | null;
}

const CARD_COLUMNS = 'id, family_id, created_by, year, greeting, language, locale, film_id, share_token';

type Lease = { state: 'ok'; card: CardRow } | { state: 'deleted' | 'superseded' };

/** Refreshes the heartbeat and returns the card when the attempt still owns it. */
export async function touchCardLease(supabase: Client, cardId: string, attemptId: string): Promise<Lease> {
  const { data, error } = await supabase
    .from('holiday_cards')
    .update({ heartbeat_at: new Date().toISOString() })
    .eq('id', cardId)
    .eq('attempt_id', attemptId)
    .eq('status', 'generating')
    .is('deleted_at', null)
    .select(CARD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (data) return { state: 'ok', card: data as CardRow };
  const { data: row, error: rowError } = await supabase
    .from('holiday_cards').select('id, deleted_at').eq('id', cardId).maybeSingle();
  if (rowError) throw rowError;
  return { state: !row || row.deleted_at ? 'deleted' : 'superseded' };
}

/** Claims the generation lease for this attempt (see the header). */
export async function claimCardLease(supabase: Client, cardId: string, attemptId: string, now = new Date()): Promise<Lease> {
  const staleBefore = new Date(now.getTime() - LEASE_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('holiday_cards')
    .update({ attempt_id: attemptId, workflow_instance_id: attemptId, heartbeat_at: now.toISOString() })
    .eq('id', cardId)
    .eq('status', 'generating')
    .is('deleted_at', null)
    .or(`attempt_id.eq.${attemptId},attempt_id.is.null,heartbeat_at.is.null,heartbeat_at.lt.${staleBefore}`)
    .select(CARD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (data) return { state: 'ok', card: data as CardRow };
  const { data: row, error: rowError } = await supabase
    .from('holiday_cards').select('id, deleted_at').eq('id', cardId).maybeSingle();
  if (rowError) throw rowError;
  return { state: !row || row.deleted_at ? 'deleted' : 'superseded' };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && Array.from(v).length <= max ? v : null;

/** The stored front summary, rebuilt field by field (no free text can ride along). */
export function sanitizeFront(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw) || !Array.isArray(raw.candidates) || raw.candidates.length > FRONT_CANDIDATES_MAX) return null;
  const candidates: Record<string, unknown>[] = [];
  for (const c of raw.candidates) {
    if (!isObject(c) || !isObject(c.verdict)) return null;
    const v = c.verdict;
    if (
      typeof c.mediaId !== 'string' || !UUID.test(c.mediaId) || typeof c.memoryId !== 'string' || !UUID.test(c.memoryId) ||
      !isInt(c.rank, 1, 1000) || !isNum(c.score, -100, 100) ||
      typeof c.cardOrientation !== 'string' || !CARD_ORIENTATIONS.has(c.cardOrientation) ||
      typeof c.printClass !== 'string' || !PRINT_CLASSES.has(c.printClass) ||
      !isInt(c.width, 1, 200_000) || !isInt(c.height, 1, 200_000) ||
      !isNum(v.cardScore, 0, 10) || !isInt(v.peopleVisible, 0, 1000) ||
      typeof v.allFacesVisible !== 'boolean' || typeof v.eyesOpenMostly !== 'boolean' ||
      typeof v.sharp !== 'boolean' || typeof v.cropRisk !== 'boolean' ||
      typeof v.lookingAtCamera !== 'string' || !LOOKING.has(v.lookingAtCamera) ||
      typeof v.light !== 'string' || !LIGHT.has(v.light)
    ) return null;
    candidates.push({
      mediaId: c.mediaId, memoryId: c.memoryId, rank: c.rank, score: c.score,
      cardOrientation: c.cardOrientation, printClass: c.printClass, width: c.width, height: c.height,
      verdict: {
        cardScore: v.cardScore, peopleVisible: v.peopleVisible, allFacesVisible: v.allFacesVisible,
        eyesOpenMostly: v.eyesOpenMostly, lookingAtCamera: v.lookingAtCamera, light: v.light,
        sharp: v.sharp, cropRisk: v.cropRisk,
      },
    });
  }
  const counts: Record<string, number> = {};
  if (isObject(raw.counts)) for (const key of COUNT_KEYS) if (isInt(raw.counts[key], 0, 10_000_000)) counts[key] = raw.counts[key] as number;
  const dropped: Record<string, number> = {};
  if (isObject(raw.dropped)) for (const [key, value] of Object.entries(raw.dropped)) if (DROP_KEYS.has(key) && isInt(value, 0, 10_000_000)) dropped[key] = value;
  return { candidates, counts, dropped };
}

/** Letters + QR caption + signature + editor facts (text, length-capped). */
export function sanitizeLetters(body: Record<string, unknown>): {
  letters: Record<string, unknown>[];
  qrCaption: string | null;
  signature: string;
  editorFacts: Record<string, unknown>;
} | null {
  if (!Array.isArray(body.letters) || body.letters.length > LETTERS_MAX) return null;
  const letters: Record<string, unknown>[] = [];
  const tones = new Set<string>();
  for (const l of body.letters) {
    if (!isObject(l) || typeof l.tone !== 'string' || !LETTER_TONES.has(l.tone) || tones.has(l.tone)) return null;
    const letterText = text(l.text, LETTER_TEXT_MAX);
    if (!letterText || !Array.isArray(l.softFlags) || l.softFlags.length > 20) return null;
    const softFlags: Record<string, string>[] = [];
    for (const f of l.softFlags) {
      if (!isObject(f) || typeof f.code !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(f.code)) return null;
      softFlags.push({ code: f.code, ...(typeof f.detail === 'string' ? { detail: Array.from(f.detail).slice(0, 80).join('') } : {}) });
    }
    tones.add(l.tone);
    letters.push({ tone: l.tone, text: letterText, chars: Array.from(letterText).length, softFlags });
  }
  const signature = text(body.signature, SHORT_TEXT_MAX);
  if (!signature) return null;
  let qrCaption: string | null = null;
  if (body.qrCaption !== null && body.qrCaption !== undefined) {
    qrCaption = text(body.qrCaption, SHORT_TEXT_MAX);
    if (!qrCaption) return null;
  }
  const rawFacts = isObject(body.editorFacts) ? body.editorFacts : null;
  if (!rawFacts || !Array.isArray(rawFacts.facts) || rawFacts.facts.length > EDITOR_FACTS_MAX) return null;
  const facts: Record<string, unknown>[] = [];
  for (const f of rawFacts.facts) {
    if (!isObject(f) || typeof f.kind !== 'string' || !/^[a-z_]{2,20}$/.test(f.kind)) return null;
    const fact = text(f.fact, SHORT_TEXT_MAX);
    if (!fact || !Array.isArray(f.evidence) || f.evidence.length > 20 || !f.evidence.every((e) => typeof e === 'string' && e.length <= 64)) return null;
    facts.push({
      about: typeof f.about === 'string' ? Array.from(f.about).slice(0, 80).join('') : null,
      kind: f.kind, fact, evidence: f.evidence,
    });
  }
  const broadStrokes = rawFacts.broadStrokes === null || rawFacts.broadStrokes === undefined ? null : text(rawFacts.broadStrokes, SHORT_TEXT_MAX);
  const line = isObject(rawFacts.lineOfYear) ? rawFacts.lineOfYear : null;
  const lineOfYear = line && text(line.quote, SHORT_TEXT_MAX) && text(line.speaker, 80) && typeof line.memoryId === 'string' && UUID.test(line.memoryId)
    ? { quote: line.quote, speaker: line.speaker, memoryId: line.memoryId }
    : null;
  return { letters, qrCaption, signature, editorFacts: { facts, broadStrokes, lineOfYear } };
}

/** Same predicate as the lease: a write only lands while this attempt owns a live, generating card. */
async function writeCard(supabase: Client, cardId: string, attemptId: string, patch: Record<string, unknown>): Promise<Response> {
  const { data, error } = await supabase
    .from('holiday_cards')
    .update(patch)
    .eq('id', cardId)
    .eq('attempt_id', attemptId)
    .eq('status', 'generating')
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const lease = await touchCardLease(supabase, cardId, attemptId);
    return jsonResponse({ state: lease.state === 'ok' ? 'superseded' : lease.state }, 409);
  }
  return jsonResponse({ state: 'ok' });
}

export async function handleCardOperation(
  supabase: Client,
  operation: string,
  cardId: string,
  attemptId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  // card_start claims the lease; card_heartbeat only refreshes it. Both answer
  // 200 { state } so the Workflow reads the state itself.
  const lease = operation === 'card_start'
    ? await claimCardLease(supabase, cardId, attemptId)
    : await touchCardLease(supabase, cardId, attemptId);
  if (operation === 'card_start' || operation === 'card_heartbeat') {
    if (lease.state !== 'ok') return jsonResponse({ state: lease.state });
    const { card } = lease;
    return jsonResponse({
      state: 'ok',
      card: { year: card.year, greeting: card.greeting, language: card.language, locale: card.locale, filmId: card.film_id },
    });
  }
  if (lease.state !== 'ok') return jsonResponse({ state: lease.state }, 409);
  const { card } = lease;

  switch (operation) {
    case 'card_load_context': {
      if (!isDate(body.today)) return errorResponse('Invalid date', 400, 'validation_error');
      const { data: family, error: familyError } = await supabase
        .from('families')
        .select('id, name, gallery_caption_language, gallery_caption_instructions, owner_id')
        .eq('id', card.family_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (familyError || !family) return errorResponse('Family not found', 404, 'not_found');
      // Front pool: Dec 1 of the previous year -> today; the parents' voice:
      // the 12 months before today; the letters/film: Jan 1 -> today.
      const from = [`${card.year - 1}-12-01`, addYears(body.today, -1)].sort()[0];
      const loaded = await loadFamilyRows(supabase, card.family_id, {
        from,
        toExclusive: addDays(body.today, 1),
        memberColumns: CARD_MEMBER_COLUMNS,
        memoryColumns: CARD_MEMORY_COLUMNS,
        portraits: false,
      });
      return jsonResponse({
        card: {
          id: card.id, familyId: card.family_id, ownerId: family.owner_id, year: card.year, greeting: card.greeting,
          language: card.language, locale: card.locale, filmId: card.film_id, shareToken: card.share_token,
        },
        today: body.today,
        captionInstructions: family.gallery_caption_instructions ?? null,
        rows: {
          family: { id: family.id, name: family.name, gallery_caption_language: family.gallery_caption_language },
          members: loaded.members,
          memories: loaded.memories,
          media: loaded.media,
          tags: loaded.tags,
          milestones: loaded.milestones,
          portraits: loaded.portraits,
          reports: loaded.reports,
          blockedAuthorIds: loaded.blockedAuthorIds,
        },
      });
    }
    case 'card_load_media': {
      const ids = body.mediaIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > CARD_MEDIA_BATCH_MAX ||
        !ids.every((id) => typeof id === 'string' && UUID.test(id))) {
        return errorResponse('Invalid media ids', 400, 'validation_error');
      }
      const { data: media, error } = await supabase
        .from('memory_media')
        .select('id, memory_id, object_key, preview_object_key, aspect_ratio, content_type')
        .in('id', ids);
      if (error) throw error;
      const memoryIds = [...new Set((media ?? []).map((m: { memory_id: string }) => m.memory_id))];
      const { data: memories, error: memoriesError } = memoryIds.length === 0
        ? { data: [], error: null }
        : await supabase.from('memories').select('id').eq('family_id', card.family_id).in('id', memoryIds);
      if (memoriesError) throw memoriesError;
      const ours = new Set((memories ?? []).map((m: { id: string }) => m.id));
      return jsonResponse({
        media: (media ?? [])
          .filter((m: { memory_id: string }) => ours.has(m.memory_id))
          .map((m: { id: string; memory_id: string; object_key: string; preview_object_key: string | null; aspect_ratio: number | null; content_type: string | null }) => ({
            id: m.id, memoryId: m.memory_id, objectKey: m.object_key, previewKey: m.preview_object_key, aspectRatio: m.aspect_ratio,
            contentType: m.content_type,
          })),
      });
    }
    case 'card_save_front': {
      const front = sanitizeFront(body.front);
      if (!front) return errorResponse('Invalid front candidates', 400, 'validation_error');
      return await writeCard(supabase, cardId, attemptId, { front_candidates: front });
    }
    case 'card_create_film': {
      const closeMedia = body.closeMedia;
      if (!isDate(body.scopeStart) || !isDate(body.scopeEnd) || body.scopeStart >= body.scopeEnd ||
        !Array.isArray(closeMedia) || closeMedia.length > CLOSE_MEDIA_MAX ||
        !closeMedia.every((id) => typeof id === 'string' && UUID.test(id))) {
        return errorResponse('Invalid film scope', 400, 'validation_error');
      }
      // The card row is the single source of the greeting.
      const { data, error } = await supabase.rpc('create_holiday_card_film', {
        p_card_id: cardId, p_scope_start: body.scopeStart, p_scope_end: body.scopeEnd,
        p_greeting: card.greeting, p_close_media: closeMedia,
      });
      if (error) {
        if (error.code === 'P0002') return jsonResponse({ state: 'deleted' }, 409);
        throw error;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.film_id) throw new Error('film_missing');
      return jsonResponse({ filmId: row.film_id });
    }
    case 'card_claim_film': {
      // Only the card's own film: the Workflow never names a film id.
      if (!card.film_id) return errorResponse('Card has no film', 400, 'validation_error');
      const { data, error } = await supabase.rpc('claim_year_film_by_id', { p_film_id: card.film_id });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      // Zero rows = the hourly cron (or a retry of this step) already claimed it.
      return jsonResponse(row?.attempt_id
        ? { claimed: true, filmId: card.film_id, filmAttemptId: row.attempt_id }
        : { claimed: false, filmId: card.film_id });
    }
    case 'card_end_film_cycle': {
      if (!card.film_id || typeof body.filmAttemptId !== 'string' || !UUID.test(body.filmAttemptId)) {
        return errorResponse('Invalid film attempt', 400, 'validation_error');
      }
      // Exactly the cron's dispatch-failure path: back to the queue, no attempt burned.
      const { data, error } = await supabase.rpc('year_film_end_cycle', {
        p_film_id: card.film_id, p_attempt_id: body.filmAttemptId, p_outcome: 'aborted', p_code: 'DISPATCH_FAILED',
      });
      if (error) throw error;
      return jsonResponse(data ?? {});
    }
    case 'card_save_letters': {
      const letters = sanitizeLetters(body);
      if (!letters) return errorResponse('Invalid letters', 400, 'validation_error');
      return await writeCard(supabase, cardId, attemptId, {
        letters: letters.letters,
        // Only a card with a film has a QR (and so a caption).
        qr_caption: card.film_id ? letters.qrCaption : null,
        signature: letters.signature,
        editor_facts: letters.editorFacts,
      });
    }
    case 'card_record_usage': {
      if (!isValidUsageBody(body, CARD_USAGE_OPERATIONS)) return errorResponse('Invalid usage', 400, 'validation_error');
      await recordAiUsage(supabase, card.family_id, card.created_by, body);
      return jsonResponse({ recorded: true });
    }
    case 'card_finish': {
      if (body.outcome === 'ready') {
        return await writeCard(supabase, cardId, attemptId, {
          status: 'ready', last_failure_code: null, attempt_id: null, workflow_instance_id: null, heartbeat_at: null,
        });
      }
      if (body.outcome === 'failed' && typeof body.code === 'string' && FAILURE_CODE.test(body.code)) {
        const response = await writeCard(supabase, cardId, attemptId, {
          status: 'failed', last_failure_code: body.code, attempt_id: null, workflow_instance_id: null, heartbeat_at: null,
        });
        if (response.status === 200) console.error('holiday card failed', { cardId, code: body.code });
        return response;
      }
      return errorResponse('Invalid outcome', 400, 'validation_error');
    }
  }
  return errorResponse('Invalid workflow operation', 400, 'validation_error');
}
