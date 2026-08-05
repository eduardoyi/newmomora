import { supabase } from '@/lib/supabase';

export interface ShareCardServiceError {
  message: string;
  code?: string;
  /** HTTP status from the function response, when the failure got that far
   * (absent for pre-request failures like a missing session or a network
   * error). */
  status?: number;
}

export interface ComposeShareCardParams {
  memoryId: string;
  mediaAssetId?: string;
}

export type ComposeShareCardResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; error: ShareCardServiceError };

/**
 * Supabase Edge Functions' platform-level resource-exhaustion status
 * (`WORKER_RESOURCE_LIMIT`) -- NOT a code this repo's `compose-share-card`
 * function returns itself (see its `index.ts` header). The S0 spike
 * (docs/plans/offline-awareness-and-share-cards.md) measured ~98%+
 * effective success retrying exactly once on this status, which
 * `composeShareCard` below does transparently.
 */
export const SHARE_CARD_RETRYABLE_STATUS = 546;

function getComposeShareCardUrl(): string {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL');
  }
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/compose-share-card`;
}

async function readErrorBody(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      return {
        message: body.error,
        code: typeof body.code === 'string' ? body.code : undefined,
      };
    }
  } catch {
    // Fall through to the generic fallback below.
  }
  return { message: 'Could not compose the share card' };
}

/**
 * A single attempt against the function. Not exported -- `composeShareCard`
 * below is the public entry point and owns the S0/S3-mandated single retry
 * on HTTP 546.
 */
async function requestShareCardOnce(params: ComposeShareCardParams): Promise<ComposeShareCardResult> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (sessionError || !token || !anonKey) {
    return {
      ok: false,
      error: {
        message: sessionError?.message ?? 'You must be signed in to share memories',
        code: 'unauthorized',
      },
    };
  }

  let response: Response;
  try {
    // Raw fetch, NOT `supabase.functions.invoke` -- the installed
    // `@supabase/functions-js` has no binary branch for `image/png` and
    // falls through to `response.text()`, corrupting the bytes (verified in
    // its FunctionsClient source; see the S4 plan note). Both the bearer
    // token and the `apikey` header are required by the function gateway.
    response = await fetch(getComposeShareCardUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
      },
      body: JSON.stringify(params),
    });
  } catch {
    return { ok: false, error: { message: 'Network request failed', code: 'network_error' } };
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    return { ok: false, error: { ...body, status: response.status } };
  }

  const bytes = await response.arrayBuffer();
  return { ok: true, bytes };
}

/**
 * Composes a shareable memory-card PNG via the `compose-share-card` Edge
 * Function. Retries ONCE, transparently, on HTTP 546 (see
 * `SHARE_CARD_RETRYABLE_STATUS`) per the S0 spike's mitigation -- a second
 * 546 (or any other failure) is returned as-is, no further retries.
 */
export async function composeShareCard(params: ComposeShareCardParams): Promise<ComposeShareCardResult> {
  const first = await requestShareCardOnce(params);
  if (first.ok || first.error.status !== SHARE_CARD_RETRYABLE_STATUS) {
    return first;
  }
  return requestShareCardOnce(params);
}

// ── Store-through cache warm (docs/plans/share-card-store-through.md, W3) ──
// A single best-effort request against the SAME function, in `warm: true`
// mode (compose-share-card/index.ts's ComposeShareCardRequest doc comment):
// composes (if needed) + stores the card server-side and responds 204 with
// no body -- never streams the PNG. Callers fire this after a memory
// create/edit/media-post succeeds so the *next* real share is a cache hit
// (near-instant, immune to the WORKER_RESOURCE_LIMIT policing that made the
// store-through cache necessary in the first place -- see that plan's
// diagnosis).

/** A single warm attempt's outcome -- not exported, an internal seam so
 * `performWarmShareCardWithRetries` below can decide whether a given
 * failure is worth retrying without re-parsing an Error's message. */
type WarmAttemptResult =
  | { ok: true }
  | { ok: false; status?: number };

async function requestWarmShareCardOnce(params: ComposeShareCardParams): Promise<WarmAttemptResult> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (sessionError || !token || !anonKey) {
    // Same "not signed in" guard as requestShareCardOnce -- warm has no
    // return value for a caller to check, so this just skips the request
    // rather than throwing (the outer fire-and-forget wrapper would swallow
    // a throw here anyway, but returning early avoids a pointless fetch).
    // No `status` -- performWarmShareCardWithRetries treats this exactly
    // like any other non-retryable outcome and stops immediately.
    return { ok: false };
  }

  // Raw fetch, NOT `supabase.functions.invoke` -- same rationale as
  // requestShareCardOnce (the installed functions-js client has no binary
  // branch, though a warm response has no body to corrupt; kept consistent
  // with the cold-path client for one less code path to reason about).
  const response = await fetch(getComposeShareCardUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ ...params, warm: true }),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  return { ok: true };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Total attempts (the initial try + up to 2 retries) `performWarmShareCardWithRetries`
 * will make on repeated HTTP 546 (`SHARE_CARD_RETRYABLE_STATUS`).
 */
export const SHARE_CARD_WARM_MAX_ATTEMPTS = 3;

/** Backoff BEFORE each retry -- index 0 is the wait before attempt 2, index
 * 1 the wait before attempt 3. 4s/8s per the four-part production fix's
 * design (docs/plans/share-card-store-through.md): long enough that a
 * short-lived WORKER_RESOURCE_LIMIT policing window (the S0 spike's
 * diagnosis -- stochastic, ~45-55% success per attempt, no correlation with
 * memory shape) has a real chance to clear, short enough that the warm
 * still lands well before a human is likely to tap share on the same
 * memory. */
export const SHARE_CARD_WARM_RETRY_BACKOFF_MS: readonly number[] = [4000, 8000];

/**
 * Self-healing warm: retries internally on HTTP 546 (the same platform
 * resource-exhaustion status the cold path retries once on) up to
 * `SHARE_CARD_WARM_MAX_ATTEMPTS` total attempts, backing off
 * `SHARE_CARD_WARM_RETRY_BACKOFF_MS` between each. Stops immediately --
 * no further attempts -- on ANY other outcome: a 429 (rate_limited) would
 * only burn the warm bucket further (the exact production failure mode
 * this whole fix targets on the COLD path -- see composeShareCard's
 * SHARE_CARD_RETRYABLE_STATUS-only retry above), and every other failure
 * (403/404/415/500/no-session/network) won't be fixed by retrying either.
 *
 * Resolves silently on success OR once attempts are exhausted/stopped --
 * `warmShareCardFireAndForget` below is the only caller, and it never
 * awaits this; a thrown Error here only exists so that wrapper's existing
 * `console.warn` swallow has something to log.
 */
async function performWarmShareCardWithRetries(params: ComposeShareCardParams): Promise<void> {
  for (let attempt = 1; attempt <= SHARE_CARD_WARM_MAX_ATTEMPTS; attempt++) {
    const result = await requestWarmShareCardOnce(params);
    if (result.ok) {
      return;
    }

    if (result.status !== SHARE_CARD_RETRYABLE_STATUS) {
      // No session, network error already thrown separately (see the catch
      // in warmShareCardFireAndForget), a real 4xx/5xx, or -- critically --
      // 429: none of these are worth retrying. Stop immediately.
      if (result.status === undefined) {
        return;
      }
      throw new Error(`compose-share-card warm request failed (${result.status})`);
    }

    if (attempt < SHARE_CARD_WARM_MAX_ATTEMPTS) {
      await delay(SHARE_CARD_WARM_RETRY_BACKOFF_MS[attempt - 1]);
    }
  }

  throw new Error(
    `compose-share-card warm request failed after ${SHARE_CARD_WARM_MAX_ATTEMPTS} attempts (${SHARE_CARD_RETRYABLE_STATUS})`,
  );
}

/**
 * Fire-and-forget cache warm. Mirrors `notifyFamilyActivityFireAndForget`
 * (src/services/memory-posting.ts): NEVER awaited by callers on a save
 * path, and every failure is ultimately swallowed down to a
 * `console.warn` -- never surfaced to the user. Internally self-healing
 * (docs/plans/share-card-store-through.md's four-part production fix,
 * Part 3): retries on 546 up to `SHARE_CARD_WARM_MAX_ATTEMPTS` total
 * attempts with 4s/8s backoff (`performWarmShareCardWithRetries` above),
 * stopping immediately on 429 or any other non-546 outcome. Still
 * best-effort by design -- if every attempt fails, the store-through
 * cache's cold-path compose (or a later warm/share attempt) is the real
 * safety net.
 */
export function warmShareCardFireAndForget(memoryId: string, mediaAssetId?: string): void {
  void performWarmShareCardWithRetries({ memoryId, mediaAssetId }).catch((error) => {
    console.warn(
      'Failed to warm share card cache',
      memoryId,
      error instanceof Error ? error.message : 'unknown',
    );
  });
}

/** Minimal duck-typed shape `warmShareCardForMemoryFireAndForget` needs --
 * deliberately NOT `MemoryWithTags` (services/memories.ts) to avoid this
 * service importing that module's full surface for a fire-and-forget
 * side-effect helper. `mediaAssets` must already be ordered by `position`
 * ascending (fetchMediaForMemories, services/memories.ts, orders this way;
 * every caller today gets its `memory`/`mediaAssets` from that same
 * pipeline) -- this helper does not re-sort. */
export interface ShareCardWarmableMemory {
  id: string;
  memory_type: string;
  mediaAssets: { id: string }[];
}

/**
 * Resolves which id(s) to warm for a just-created/edited/posted memory and
 * fires it: the per-ASSET cover card (position 0 -- `mediaAssets[0]`, see
 * the interface doc comment above) for a `media` memory, the per-MEMORY
 * card otherwise (`text_only`/`text_illustration` -- the only other
 * shareable types; see compose-share-card's SHAREABLE_MEMORY_TYPES). Only
 * the cover asset is warmed for a media memory -- warming every carousel
 * page per post is wasteful (plan's own call: non-cover pages stay
 * cold-path, rare shares, the retry still exists). A media memory with zero
 * mediaAssets (defensive-only -- validateMemoryMediaAssets requires at
 * least one) skips warming entirely rather than warming a memory-level card
 * that compose-share-card would reject for a `media` type.
 */
export function warmShareCardForMemoryFireAndForget(memory: ShareCardWarmableMemory): void {
  if (memory.memory_type === 'media') {
    const coverAssetId = memory.mediaAssets[0]?.id;
    if (!coverAssetId) {
      return;
    }
    warmShareCardFireAndForget(memory.id, coverAssetId);
    return;
  }
  warmShareCardFireAndForget(memory.id);
}
