import { createClient } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient';
import { HandoffController, type CurrentSession, type HandoffDeps, type RedeemResult } from './handoffController';
import { hasHandoffParam, parseHandoffCode, stripHandoffParam } from './handoffHash';

/**
 * Real wiring of the sign-in handoff (see `handoffController.ts` for the flow).
 * Imported by `main.tsx`, which calls `captureHandoffFromLocation()` at module
 * top level BEFORE `createRoot`, so no screen ever mounts for the old account
 * while a handoff is pending.
 */

function isRedeemResult(value: unknown): value is RedeemResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tokenHash === 'string' &&
    v.tokenHash.length > 0 &&
    typeof v.maskedEmail === 'string' &&
    typeof v.userId === 'string'
  );
}

/** An in-memory `storage` so the throwaway client can never read or write the real session. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const deps: HandoffDeps = {
  async redeem(code) {
    const { data, error } = await supabase.functions.invoke<unknown>('web-handoff', {
      body: { op: 'redeem', code },
    });
    if (error || !isRedeemResult(data)) throw new Error('handoff_invalid');
    return data;
  },

  async getSession(): Promise<CurrentSession | null> {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return null;
    return {
      userId: session.user.id,
      email: session.user.email ?? null,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };
  },

  async verifyOtp(tokenHash) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    return { error: error?.message ?? null };
  },

  /**
   * Revoke the OLD session after the new one was stored. The main client now
   * holds the new session, so a plain `signOut({ scope: 'local' })` on it would
   * revoke the new one. Instead a throwaway client (in-memory storage, its own
   * storage key, no refresh timer, no cross-tab broadcast) adopts the old
   * tokens and signs out with scope 'local', which GoTrue maps to "this one
   * session only". Best effort: failures are swallowed by the controller.
   */
  async revokeSession(old) {
    const ephemeral = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        storage: memoryStorage(),
        storageKey: 'momora-handoff-revoke',
      },
    });
    const { error } = await ephemeral.auth.setSession({
      access_token: old.accessToken,
      refresh_token: old.refreshToken,
    });
    if (error) return;
    await ephemeral.auth.signOut({ scope: 'local' });
  },
};

export const handoffController = new HandoffController(deps);

/**
 * Reads `#h=<code>` from the address bar, strips it IMMEDIATELY (path and query
 * are kept; other fragment parameters are kept) and starts the memoized redeem.
 * A present-but-malformed `h` is stripped too and counts as a failed handoff.
 */
export function captureHandoffFromLocation(): void {
  const { hash, pathname, search } = window.location;
  if (!hasHandoffParam(hash)) return;
  const code = parseHandoffCode(hash);
  window.history.replaceState(window.history.state, '', `${pathname}${search}${stripHandoffParam(hash)}`);
  if (code) void handoffController.start(code);
  else handoffController.fail();
}

let listening = false;

/**
 * Call once, before `createRoot`: captures the initial hash and any later
 * `hashchange`, and clears a finished handoff's chip / stale "failed" notice
 * when the session signs out (any tab). A handoff still in flight is untouched.
 */
export function initHandoff(): void {
  captureHandoffFromLocation();
  if (listening) return;
  listening = true;
  window.addEventListener('hashchange', captureHandoffFromLocation);
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') handoffController.onSignedOut();
  });
}
