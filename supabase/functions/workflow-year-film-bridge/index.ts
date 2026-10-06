/**
 * Year Film Workflow bridge (docs/plans/year-film-p1.md Step 4). The only
 * way cloudflare/year-film-worker reads family data or changes a film row.
 *
 * Security (durable-ai-generation-workflows.md "two signed hops"): the raw
 * body is HMAC-verified (timestamp + UUID nonce + body) before parsing, the
 * nonce is recorded in a private replay ledger, JWT verification is off in
 * config.toml because Cloudflare has no Supabase JWT, and every operation is
 * validated and bound to the film's current attempt.
 *
 * Every work operation first runs the attempt heartbeat: a superseded
 * attempt, a changed content epoch, or rollout mode `off` answers 409 with
 * `{ state }` so the Workflow stops at its next call.
 *
 * Holiday card generation (cloudflare/year-film-worker HolidayCardWorkflow)
 * uses the same signature + nonce hop through `card_*` operations bound to a
 * card + attempt lease instead of a film: see card-ops.ts.
 *
 * Logs carry ids, operation names and codes only — never memory text,
 * names, keys or model output.
 */
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { type Client, FILM_MEMBER_COLUMNS, FILM_MEMORY_COLUMNS, loadFamilyRows } from './rows.ts';
import { isValidUsageBody, recordAiUsage } from './usage.ts';
import { CARD_OPERATIONS, handleCardOperation } from './card-ops.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  const toDigest = (value: string): Uint8Array => {
    const digest = new Uint8Array(32);
    if (!/^[0-9a-f]{64}$/i.test(value)) return digest;
    for (let i = 0; i < 32; i += 1) digest[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return digest;
  };
  const a = toDigest(left);
  const b = toDigest(right);
  let mismatch = /^[0-9a-f]{64}$/i.test(left) && /^[0-9a-f]{64}$/i.test(right) ? 0 : 1;
  for (let i = 0; i < 32; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

/** Verifies the signature; returns the nonce when valid. */
export async function verifySignedRequest(req: Request, rawBody: string, secret: string | undefined): Promise<string | null> {
  const timestamp = req.headers.get('x-workflow-timestamp');
  const signature = req.headers.get('x-workflow-signature');
  const nonce = req.headers.get('x-workflow-nonce');
  if (!timestamp || !signature || !nonce || !secret || !UUID.test(nonce)) return null;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_SIGNATURE_AGE_MS) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`));
  return constantTimeEqual(hex(digest), signature.toLowerCase()) ? nonce : null;
}

interface BridgeBody {
  operation?: unknown;
  filmId?: unknown;
  cardId?: unknown;
  attemptId?: unknown;
  [key: string]: unknown;
}

const WORK_OPERATIONS = new Set([
  'load_film_context', 'save_curation', 'save_checks', 'record_usage', 'set_status',
  'record_machine', 'claim_render_slot', 'publish',
]);
const OPERATIONS = new Set([...WORK_OPERATIONS, 'heartbeat', 'end_cycle', 'reconcile']);
const USAGE_OPERATIONS = new Set(['year_film_quote', 'year_film_vision', 'year_film_audio']);
const END_OUTCOMES = new Set(['failed', 'skipped', 'aborted']);
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

interface FilmRow {
  id: string;
  family_id: string;
  kind: string;
  family_member_id: string | null;
  age_year: number | null;
  scope_start_date: string;
  scope_end_exclusive: string;
  language: string | null;
  music_bed_id: string | null;
  quote_candidates: unknown;
  edits: Record<string, unknown>;
  edits_version: number;
  pool_cutoff_at: string | null;
  content_epoch: number;
  ai_checks: Record<string, unknown>;
  generation_started_at: string | null;
  ready_at: string | null;
  attempt_id: string | null;
  status: string;
  video_key: string | null;
}

async function loadFilmContext(supabase: Client, film: FilmRow): Promise<Response> {
  const { data: family, error: familyError } = await supabase
    .from('families')
    .select('id, name, gallery_caption_language, owner_id')
    .eq('id', film.family_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (familyError || !family) return errorResponse('Family not found', 404, 'not_found');

  const loaded = await loadFamilyRows(supabase, film.family_id, {
    from: film.scope_start_date,
    toExclusive: film.scope_end_exclusive,
    memberColumns: FILM_MEMBER_COLUMNS,
    memoryColumns: FILM_MEMORY_COLUMNS,
    portraits: true,
  });

  return jsonResponse({
    film: {
      id: film.id,
      kind: film.kind,
      familyId: film.family_id,
      ownerId: family.owner_id,
      familyMemberId: film.family_member_id,
      ageYear: film.age_year,
      scopeStart: film.scope_start_date,
      scopeEndExclusive: film.scope_end_exclusive,
      language: film.language,
      musicBedId: film.music_bed_id,
      quoteCandidates: film.quote_candidates,
      edits: film.edits,
      editsVersion: film.edits_version,
      readyAt: film.ready_at,
      poolCutoffAt: film.pool_cutoff_at ?? film.generation_started_at,
      contentEpoch: film.content_epoch,
      aiChecks: film.ai_checks,
    },
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

export async function handleWorkflowYearFilmBridge(
  req: Request,
  overrides: { createServiceClient?: () => Client; secret?: string } = {},
): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  const rawBody = await req.text();
  const nonce = await verifySignedRequest(req, rawBody, overrides.secret ?? Deno.env.get('CLOUDFLARE_YEAR_FILM_BRIDGE_SECRET'));
  if (!nonce) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: BridgeBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  const operation = body.operation;
  // Holiday card operations (card-ops.ts) are bound to a card + its attempt;
  // film operations to a film + its attempt.
  const isCardOperation = typeof operation === 'string' && CARD_OPERATIONS.has(operation);
  if (typeof operation !== 'string' || (!isCardOperation && !OPERATIONS.has(operation)) ||
    typeof body.attemptId !== 'string' || !UUID.test(body.attemptId) ||
    (isCardOperation
      ? typeof body.cardId !== 'string' || !UUID.test(body.cardId)
      : typeof body.filmId !== 'string' || !UUID.test(body.filmId))) {
    return errorResponse('Invalid workflow operation', 400, 'validation_error');
  }
  const filmId = body.filmId as string;
  const attemptId = body.attemptId;
  const supabase = (overrides.createServiceClient ?? createServiceClient)();

  const { data: fresh, error: nonceError } = await supabase.rpc('record_year_film_bridge_nonce', { p_nonce: nonce });
  if (nonceError) return errorResponse('Bridge unavailable', 500, 'internal_error');
  if (fresh !== true) return errorResponse('Replayed request', 409, 'replayed');

  if (isCardOperation) {
    const cardId = body.cardId as string;
    try {
      return await handleCardOperation(supabase, operation, cardId, attemptId, body);
    } catch {
      console.error('workflow year film bridge failed', { operation, cardId });
      return errorResponse('Workflow bridge operation failed', 500, 'internal_error');
    }
  }

  try {
    if (WORK_OPERATIONS.has(operation) || operation === 'heartbeat') {
      const epoch = typeof body.epoch === 'number' ? body.epoch : null;
      const { data: state, error } = await supabase.rpc('year_film_heartbeat', {
        p_film_id: filmId, p_attempt_id: attemptId, p_epoch: epoch,
      });
      if (error) throw error;
      if (operation === 'heartbeat') return jsonResponse({ state });
      if (state !== 'ok') return jsonResponse({ state }, 409);
    }

    switch (operation) {
      case 'load_film_context': {
        const { data: film, error } = await supabase.from('year_films').select('*').eq('id', filmId).maybeSingle();
        if (error) throw error;
        if (!film || film.attempt_id !== attemptId) return jsonResponse({ state: 'superseded' }, 409);
        return await loadFilmContext(supabase, film as FilmRow);
      }
      case 'save_curation': {
        const payload = body.payload;
        if (!payload || typeof payload !== 'object' || typeof (payload as { epoch?: unknown }).epoch !== 'number') {
          return errorResponse('Invalid curation', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('year_film_save_curation', { p_film_id: filmId, p_attempt_id: attemptId, p_payload: payload });
        if (error) throw error;
        return data === 'ok' ? jsonResponse({ state: 'ok' }) : jsonResponse({ state: data }, 409);
      }
      case 'save_checks': {
        const checks = body.checks;
        if (!checks || typeof checks !== 'object' || Array.isArray(checks) || Object.keys(checks).length > 200) {
          return errorResponse('Invalid checks', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('year_film_save_checks', { p_film_id: filmId, p_attempt_id: attemptId, p_checks: checks });
        if (error) throw error;
        return data === 'ok' ? jsonResponse({ state: 'ok' }) : jsonResponse({ state: data }, 409);
      }
      case 'record_usage': {
        if (!isValidUsageBody(body, USAGE_OPERATIONS)) return errorResponse('Invalid usage', 400, 'validation_error');
        const { data: film, error: filmError } = await supabase
          .from('year_films').select('family_id').eq('id', filmId).maybeSingle();
        if (filmError || !film) throw filmError ?? new Error('film_missing');
        const { data: family } = await supabase.from('families').select('owner_id').eq('id', film.family_id).maybeSingle();
        await recordAiUsage(supabase, film.family_id, family?.owner_id ?? null, body);
        return jsonResponse({ recorded: true });
      }
      case 'set_status': {
        if (body.status !== 'preparing') return errorResponse('Invalid status', 400, 'validation_error');
        const { data, error } = await supabase.rpc('year_film_set_status', { p_film_id: filmId, p_attempt_id: attemptId, p_status: body.status });
        if (error) throw error;
        return data === 'ok' ? jsonResponse({ state: 'ok' }) : jsonResponse({ state: data }, 409);
      }
      case 'record_machine': {
        if (typeof body.mode !== 'string' || typeof body.machineId !== 'string' || !/^[0-9a-z]{6,32}$/i.test(body.machineId)) {
          return errorResponse('Invalid machine', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('year_film_record_machine', {
          p_film_id: filmId, p_attempt_id: attemptId, p_mode: body.mode, p_machine_id: body.machineId,
        });
        if (error) throw error;
        return data === 'ok' ? jsonResponse({ state: 'ok' }) : jsonResponse({ state: data }, 409);
      }
      case 'claim_render_slot': {
        const { data, error } = await supabase.rpc('year_film_claim_render_slot', { p_film_id: filmId, p_attempt_id: attemptId });
        if (error) throw error;
        return jsonResponse({ state: data });
      }
      case 'publish': {
        const { data: film } = await supabase.from('year_films').select('family_id').eq('id', filmId).maybeSingle();
        const { data: family } = film
          ? await supabase.from('families').select('owner_id').eq('id', film.family_id).maybeSingle()
          : { data: null };
        const prefix = family ? `${family.owner_id}/year-films/${filmId}/${attemptId}/` : null;
        const keys = [body.videoKey, body.posterKey, body.scenesKey];
        if (!prefix || !keys.every((k) => typeof k === 'string' && k.startsWith(prefix) && !k.includes('..')) ||
          typeof body.durationMs !== 'number' || typeof body.editsVersion !== 'number') {
          return errorResponse('Invalid publish', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('publish_year_film', {
          p_film_id: filmId, p_attempt_id: attemptId, p_edits_version: body.editsVersion,
          p_video_key: body.videoKey, p_poster_key: body.posterKey, p_scenes_key: body.scenesKey,
          p_duration_ms: Math.round(body.durationMs),
        });
        if (error) throw error;
        return jsonResponse(data);
      }
      case 'end_cycle': {
        if (typeof body.outcome !== 'string' || !END_OUTCOMES.has(body.outcome) ||
          typeof body.code !== 'string' || !FAILURE_CODE.test(body.code)) {
          return errorResponse('Invalid outcome', 400, 'validation_error');
        }
        const { data, error } = await supabase.rpc('year_film_end_cycle', {
          p_film_id: filmId, p_attempt_id: attemptId, p_outcome: body.outcome, p_code: body.code,
        });
        if (error) throw error;
        if (body.outcome === 'failed' && (data as { status?: string })?.status === 'failed') {
          console.error('year film failed', { filmId, code: body.code });
        }
        return jsonResponse(data);
      }
      case 'reconcile': {
        const { data: film, error } = await supabase
          .from('year_films').select('status, attempt_id, video_key').eq('id', filmId).maybeSingle();
        if (error) throw error;
        if (!film) return jsonResponse({ outcome: 'failed' });
        if (film.status === 'ready' && typeof film.video_key === 'string' && film.video_key.includes(`/${attemptId}/`)) {
          return jsonResponse({ outcome: 'succeeded' });
        }
        if (film.attempt_id === attemptId && ['rendering', 'preparing', 'curating'].includes(film.status)) {
          return jsonResponse({ outcome: 'retry' });
        }
        return jsonResponse({ outcome: 'superseded' });
      }
    }
    return errorResponse('Invalid workflow operation', 400, 'validation_error');
  } catch {
    console.error('workflow year film bridge failed', { operation, filmId });
    return errorResponse('Workflow bridge operation failed', 500, 'internal_error');
  }
}

if (import.meta.main) serveWithSentry('workflow-year-film-bridge', (request) => handleWorkflowYearFilmBridge(request));
