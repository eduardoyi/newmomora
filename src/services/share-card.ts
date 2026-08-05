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
