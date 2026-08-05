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
async function requestWarmShareCardOnce(params: ComposeShareCardParams): Promise<void> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (sessionError || !token || !anonKey) {
    // Same "not signed in" guard as requestShareCardOnce -- warm has no
    // return value for a caller to check, so this just skips the request
    // rather than throwing (the outer fire-and-forget wrapper would swallow
    // a throw here anyway, but returning early avoids a pointless fetch).
    return;
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
    throw new Error(`compose-share-card warm request failed (${response.status})`);
  }
}

/**
 * Fire-and-forget cache warm. Mirrors `notifyFamilyActivityFireAndForget`
 * (src/services/memory-posting.ts) exactly: NEVER awaited by callers on a
 * save path, and every failure (no session, network error, non-2xx
 * response, thrown exception) is swallowed down to a `console.warn` --
 * never surfaced to the user. A failed warm is invisible; the store-through
 * cache's cold-path compose (or a later warm/share attempt) is the safety
 * net. Deliberately NOT retried -- `composeShareCard`'s single 546-retry is
 * a cold-path guarantee for a human waiting on a share sheet; a warm is
 * speculative and best-effort by design (docs/plans/
 * share-card-store-through.md, W3).
 */
export function warmShareCardFireAndForget(memoryId: string, mediaAssetId?: string): void {
  void requestWarmShareCardOnce({ memoryId, mediaAssetId }).catch((error) => {
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
