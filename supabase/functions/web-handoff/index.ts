/**
 * App -> web sign-in handoff (docs/plans/holiday-cards-p2.md Step 2b), for the
 * shop (`shop.usemomora.com`: Memory Books and holiday cards). One function,
 * `POST { op }`, `verify_jwt = false` (own checks per op):
 *
 *   create  { }          JWT required, permanent accounts only (anonymous
 *                        sessions are refused). Mints a random 32-byte code
 *                        (base64url, 43 chars), stores only its sha256 hex with
 *                        the caller's user id (2-min expiry, 10 per user per
 *                        10 min, enforced by `create_web_handoff`), returns
 *                        `{ code, expiresAt }`.
 *   redeem  { code }     NO JWT. `claim_web_handoff` (single-use, DB clock) ->
 *                        `auth.admin.generateLink({ type: 'magiclink' })` and
 *                        returns ONLY `{ tokenHash, maskedEmail, userId }`
 *                        (`Cache-Control: no-store`). The BROWSER calls
 *                        `supabase.auth.verifyOtp({ token_hash, type:
 *                        'magiclink' })` itself: GoTrue's per-IP verify limit
 *                        then applies to the user's IP (not the shared Edge
 *                        egress), no tokens are in our response, and no session
 *                        ever exists on a server client. `verifyOtp` is NEVER
 *                        called here.
 *
 * No oracle: every `redeem` failure (bad shape, unknown / used / expired code,
 * missing / banned / deleted / anonymous user, generateLink failure) is the same
 * 400 `handoff_invalid`.
 *
 * Privacy: codes, hashes, token hashes and emails are never logged or put in
 * errors; only stable reason labels reach `console.error`.
 *
 * Side effect to know about: `generateLink` replaces a pending emailed
 * sign-in code for that user (GoTrue keeps one recovery/magiclink token per
 * user), which is why the shop's fallback login handles the "wait N seconds"
 * rate-limit message with friendly copy.
 */
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { errorResponse } from '../_shared/errors.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface WebHandoffDependencies {
  getAuthenticatedUser: typeof getAuthenticatedNonAnonymousUser;
  createServiceClient: typeof createServiceClient;
  now: () => number;
  /** 32 random bytes. Injectable for tests. */
  randomBytes: () => Uint8Array;
}

const DEFAULT_DEPENDENCIES: WebHandoffDependencies = {
  getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
  createServiceClient,
  now: () => Date.now(),
  randomBytes: () => crypto.getRandomValues(new Uint8Array(32)),
};

const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_MESSAGE = 'This sign-in link is no longer valid';

function invalid(): Response {
  return withNoStore(errorResponse(INVALID_MESSAGE, 400, 'handoff_invalid'));
}

function withNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function noStoreJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `j•••@gmail.com`: first character of the local part, then a fixed mask. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  const first = Array.from(email.slice(0, at))[0] ?? '';
  return `${first}•••${email.slice(at)}`;
}

interface DbError {
  code?: string;
  hint?: string;
  message?: string;
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { hint, message } = error as DbError;
  return hint === 'rate_limited' || message === 'rate_limited';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── create ───────────────────────────────────────────────────────────────

async function handleCreate(req: Request, dependencies: WebHandoffDependencies): Promise<Response> {
  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return withNoStore(errorResponse('Unauthorized', 401, 'unauthorized'));

  const code = base64Url(dependencies.randomBytes());
  const codeHash = await sha256Hex(code);

  const supabase = dependencies.createServiceClient();
  const { data, error } = await supabase.rpc('create_web_handoff', {
    p_user_id: user.id,
    p_code_hash: codeHash,
  });

  if (error) {
    if (isRateLimited(error)) {
      return withNoStore(errorResponse('Too many sign-in links requested. Please wait a few minutes.', 429, 'rate_limited'));
    }
    console.error('web-handoff create failed', (error as DbError).code ?? 'unknown');
    return withNoStore(errorResponse('Internal error', 500, 'internal_error'));
  }

  if (typeof data !== 'string') {
    console.error('web-handoff create returned no expiry');
    return withNoStore(errorResponse('Internal error', 500, 'internal_error'));
  }

  return noStoreJson({ code, expiresAt: data });
}

// ── redeem ───────────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
  banned_until?: string | null;
  deleted_at?: string | null;
}

async function handleRedeem(body: Record<string, unknown>, dependencies: WebHandoffDependencies): Promise<Response> {
  const code = body.code;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return invalid();

  try {
    const supabase = dependencies.createServiceClient();
    const codeHash = await sha256Hex(code);

    const { data: claimed, error: claimError } = await supabase.rpc('claim_web_handoff', { p_code_hash: codeHash });
    if (claimError) {
      console.error('web-handoff claim failed', (claimError as DbError).code ?? 'unknown');
      return invalid();
    }
    if (typeof claimed !== 'string' || claimed.length === 0) return invalid();

    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(claimed);
    const user = (userData?.user ?? null) as AdminUser | null;
    if (userError || !user) {
      console.error('web-handoff user lookup failed');
      return invalid();
    }

    const email = typeof user.email === 'string' ? user.email.trim() : '';
    const bannedUntil = user.banned_until ? Date.parse(user.banned_until) : Number.NaN;
    const isBanned = Number.isFinite(bannedUntil) && bannedUntil > dependencies.now();
    if (!email || isBanned || user.deleted_at || user.is_anonymous === true) return invalid();

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    const tokenHash = linkData?.properties?.hashed_token;
    if (linkError || typeof tokenHash !== 'string' || tokenHash.length === 0) {
      console.error('web-handoff generateLink failed');
      return invalid();
    }

    return noStoreJson({ tokenHash, maskedEmail: maskEmail(email), userId: user.id });
  } catch (error) {
    console.error('web-handoff redeem failed', error instanceof Error ? error.name : 'unknown');
    return invalid();
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function handleWebHandoff(
  req: Request,
  dependencyOverrides: Partial<WebHandoffDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!isPlainObject(body) || (body.op !== 'create' && body.op !== 'redeem')) {
    return errorResponse('op must be one of create, redeem', 400, 'validation_error');
  }

  try {
    if (body.op === 'create') return await handleCreate(req, dependencies);
    return await handleRedeem(body, dependencies);
  } catch (error) {
    console.error('web-handoff failed', error instanceof Error ? error.name : 'unknown');
    return withNoStore(errorResponse('Internal error', 500, 'internal_error'));
  }
}

if (import.meta.main) {
  serveWithSentry('web-handoff', (request) => handleWebHandoff(request));
}
