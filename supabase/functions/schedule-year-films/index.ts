/**
 * Hourly Year Film scheduler (docs/plans/year-film-p1.md Step 3). Invoked by
 * pg_cron with x-cron-secret. Each run:
 *   1. inserts films that are due (year_film_due: owner-local 00:30,
 *      3-day catch-up, launch cutoff, rollout flag, billing),
 *   2. promotes debounced invalidations / spaced retries / skipped re-checks,
 *   3. claims queued films and dispatches each to the Worker (ids only,
 *      HMAC-signed); a failed dispatch returns the film to the queue,
 *   4. recovers attempts whose heartbeat stopped,
 *   5. sweeps attempt directories that are no longer current,
 *   6. sends the "your film is here" push at surface_at, once.
 * Logs are counts and ids only.
 */
import { validateCronSecret } from '../_shared/cron.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { type PushRouteData, sendExpoPushNotification } from '../_shared/expo-push.ts';
import { deleteObject, listObjectKeys } from '../_shared/r2.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

// Films started per hourly run. Every family's recap is due at 00:30 local on
// the 1st and surfaces at 19:00, so this caps the monthly rush at ~60/hour
// (~1,000 films before delivery). Machine starts are spread by the Worker's
// 0–45 s jitter; renders are capped separately by
// year_film_settings.max_concurrent_renders.
const DISPATCH_BATCH = 60;
const CLEANUP_BATCH = 20;

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface SchedulerDeps {
  rpc: Rpc;
  now: () => Date;
  dispatch: (filmId: string, attemptId: string) => Promise<boolean>;
  listKeys: (prefix: string) => Promise<string[]>;
  deleteKey: (key: string) => Promise<void>;
  /** Recipients for a family: push tokens of members who allow memory pushes. */
  recipients: (familyId: string) => Promise<string[]>;
  memberName: (memberId: string) => Promise<string | null>;
  sendPush: (token: string, title: string, body: string, data: PushRouteData) => Promise<boolean>;
}

const ORDINAL_EN = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const ORDINAL_ES = ['', 'primer', 'segundo', 'tercer', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo', 'undécimo', 'duodécimo'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Push copy (year-film.md §8), in the film's language. */
export function filmPushCopy(film: {
  kind: string;
  language: string | null;
  ageYear: number | null;
  scopeStart: string;
  childName: string | null;
}): { title: string; body: string } {
  const es = film.language === 'es';
  const name = film.childName?.trim().split(/\s+/)[0] ?? null;
  if (film.kind === 'birthday' && film.ageYear) {
    return es
      ? { title: 'Momora', body: name ? `El ${ORDINAL_ES[film.ageYear]} año de ${name}, en una pequeña película 🎂` : 'Su año, en una pequeña película 🎂' }
      : { title: 'Momora', body: name ? `${name}'s ${ORDINAL_EN[film.ageYear]} year, in one little film 🎂` : 'Their year, in one little film 🎂' };
  }
  if (film.kind === 'family_month') {
    const month = Number(film.scopeStart.slice(5, 7)) - 1;
    return es
      ? { title: 'Momora', body: `Su ${MONTHS_ES[month]}, en una pequeña película` }
      : { title: 'Momora', body: `Your ${MONTHS_EN[month]}, in one little film` };
  }
  const year = film.scopeStart.slice(0, 4);
  return es
    ? { title: 'Momora', body: `El ${year} de su familia, en una pequeña película` }
    : { title: 'Momora', body: `Your family's ${year}, in one little film` };
}

async function rpcOrThrow(deps: SchedulerDeps, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await deps.rpc(name, args);
  if (error) throw new Error(`${name}_failed`);
  return data;
}

async function deleteKeys(deps: SchedulerDeps, keys: unknown): Promise<number> {
  let deleted = 0;
  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key !== 'string' || !key.includes('/year-films/')) continue;
    await deps.deleteKey(key);
    deleted += 1;
  }
  return deleted;
}

export async function runScheduler(deps: SchedulerDeps): Promise<Record<string, number>> {
  const now = deps.now().toISOString();
  const summary: Record<string, number> = {};

  summary.inserted = Number(await rpcOrThrow(deps, 'year_film_due', { p_now: now }) ?? 0);
  summary.requeued = Number(await rpcOrThrow(deps, 'year_film_promote_requeues', { p_now: now }) ?? 0);
  summary.rechecked = Number(await rpcOrThrow(deps, 'year_film_recheck_skipped', { p_now: now }) ?? 0);

  const claimed = (await rpcOrThrow(deps, 'claim_year_film_dispatch', { p_limit: DISPATCH_BATCH, p_now: now }) ?? []) as {
    film_id: string;
    attempt_id: string;
  }[];
  summary.dispatched = 0;
  for (const row of claimed) {
    let ok = false;
    try {
      ok = await deps.dispatch(row.film_id, row.attempt_id);
    } catch {
      ok = false;
    }
    if (ok) summary.dispatched += 1;
    else {
      // Back to the queue without burning an attempt.
      await rpcOrThrow(deps, 'year_film_end_cycle', {
        p_film_id: row.film_id, p_attempt_id: row.attempt_id, p_outcome: 'aborted', p_code: 'DISPATCH_FAILED',
      });
    }
  }

  const recovered = (await rpcOrThrow(deps, 'year_film_recover', { p_now: now }) ?? {}) as {
    retried?: number;
    ended?: number;
    delete_keys?: unknown;
  };
  summary.recovered = (recovered.retried ?? 0) + (recovered.ended ?? 0);
  summary.deleted = await deleteKeys(deps, recovered.delete_keys);

  // Sweep attempt directories that are no longer the published one.
  const cleanup = (await rpcOrThrow(deps, 'year_films_needing_cleanup', { p_limit: CLEANUP_BATCH }) ?? []) as {
    film_id: string;
    owner_id: string;
    video_key: string | null;
  }[];
  summary.cleaned = 0;
  for (const row of cleanup) {
    const prefix = `${row.owner_id}/year-films/${row.film_id}/`;
    const keep = row.video_key ? row.video_key.slice(0, row.video_key.lastIndexOf('/') + 1) : null;
    for (const key of await deps.listKeys(prefix)) {
      if (keep && key.startsWith(keep)) continue;
      await deps.deleteKey(key);
      summary.deleted += 1;
    }
    await rpcOrThrow(deps, 'mark_year_film_cleaned', { p_film_id: row.film_id, p_video_key: row.video_key });
    summary.cleaned += 1;
  }

  const due = (await rpcOrThrow(deps, 'year_film_notifications_due', { p_now: now }) ?? []) as {
    film_id: string;
    family_id: string;
    kind: string;
    family_member_id: string | null;
    age_year: number | null;
    language: string | null;
    scope_start_date: string;
  }[];
  summary.notified = 0;
  for (const film of due) {
    const childName = film.family_member_id ? await deps.memberName(film.family_member_id) : null;
    const copy = filmPushCopy({
      kind: film.kind, language: film.language, ageYear: film.age_year, scopeStart: film.scope_start_date, childName,
    });
    for (const token of await deps.recipients(film.family_id)) {
      if (await deps.sendPush(token, copy.title, copy.body, { route: 'year-film', familyId: film.family_id, filmId: film.film_id })) {
        summary.notified += 1;
      }
    }
  }

  return summary;
}

async function signedDispatch(filmId: string, attemptId: string): Promise<boolean> {
  const endpoint = Deno.env.get('CLOUDFLARE_YEAR_FILM_WORKFLOW_URL');
  const secret = Deno.env.get('CLOUDFLARE_YEAR_FILM_WORKFLOW_SECRET');
  if (!endpoint || !secret) return false;
  const body = JSON.stringify({ filmId, attemptId });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`));
  const signature = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/dispatch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dispatch-timestamp': timestamp,
      'x-dispatch-nonce': nonce,
      'x-dispatch-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok;
}

export async function handleScheduleYearFilms(req: Request): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');
  const supabase = createServiceClient();
  try {
    const summary = await runScheduler({
      rpc: (name, args) => supabase.rpc(name, args),
      now: () => new Date(),
      dispatch: signedDispatch,
      listKeys: listObjectKeys,
      deleteKey: deleteObject,
      recipients: async (familyId) => {
        const { data: memberships } = await supabase.from('family_memberships').select('user_id').eq('family_id', familyId);
        const ids = (memberships ?? []).map((m) => m.user_id as string);
        if (ids.length === 0) return [];
        const { data: profiles } = await supabase
          .from('user_profiles').select('expo_push_token, notify_new_memories').in('id', ids);
        return (profiles ?? [])
          .filter((p) => p.notify_new_memories && typeof p.expo_push_token === 'string' && p.expo_push_token)
          .map((p) => p.expo_push_token as string);
      },
      memberName: async (memberId) => {
        const { data } = await supabase.from('family_members').select('name').eq('id', memberId).maybeSingle();
        return (data?.name as string | undefined) ?? null;
      },
      sendPush: sendExpoPushNotification,
    });
    console.log('schedule-year-films', summary);
    return jsonResponse(summary);
  } catch (error) {
    console.error('schedule-year-films failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Scheduler failed', 500, 'internal_error');
  }
}

if (import.meta.main) serveWithSentry('schedule-year-films', handleScheduleYearFilms);
