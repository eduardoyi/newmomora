/**
 * The shop side of the app -> web sign-in handoff (docs/plans/holiday-cards-p2.md
 * Step 2b), as a dependency-injected state machine so the whole flow is unit
 * testable without a browser or a Supabase client. `handoffRuntime.ts` wires the
 * real deps; `useHandoff.ts` exposes the state to React.
 *
 * Flow for one code (the redeem is memoized per code, so StrictMode / a repeated
 * `hashchange` never sends two requests):
 *
 *   redeeming -> redeem (Edge Function: claims the single-use code, returns a
 *                token hash + masked email + user id; no session)
 *             -> read the current session
 *             -> ALWAYS `confirm` ("Continue as j•••@gmail.com?" / "Stay signed
 *                in as <current>" or "Use a different account") -- also with no
 *                session, otherwise an attacker's link would silently sign a
 *                victim in as the attacker (login CSRF). Only a session that is
 *                already for the SAME user skips the prompt.
 *             -> verifying: `verifyOtp({ token_hash, type: 'magiclink' })` in
 *                the browser (the new session replaces the stored one)
 *             -> revoke the PREVIOUS session (if any, same user included) via a
 *                throwaway client, best effort, so no refresh token is orphaned
 *             -> signedIn (the "Signed in as … · Not you?" chip)
 *
 * Any failure -> `failed` (the app falls back to the normal email-code login with
 * a banner). Nothing in here logs the code, token hash or emails.
 */

export interface RedeemResult {
  tokenHash: string;
  maskedEmail: string;
  userId: string;
}

export interface CurrentSession {
  userId: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
}

export interface HandoffDeps {
  redeem: (code: string) => Promise<RedeemResult>;
  getSession: () => Promise<CurrentSession | null>;
  verifyOtp: (tokenHash: string) => Promise<{ error: string | null }>;
  /** Revokes ONLY the given (old) session on the server. Must not touch the stored (new) session. */
  revokeSession: (session: CurrentSession) => Promise<void>;
  /** Replaceable in tests. */
  timeoutMs?: number;
}

export type HandoffState =
  | { phase: 'idle' }
  | { phase: 'redeeming' }
  | { phase: 'confirm'; maskedEmail: string; currentEmail: string | null; hasSession: boolean }
  | { phase: 'verifying' }
  | { phase: 'signedIn'; maskedEmail: string; userId: string }
  | { phase: 'stayed' }
  | { phase: 'failed' };

export type HandoffDecision = 'continue' | 'prompt';

/**
 * Only an existing session for the SAME user continues silently. No session or
 * a different user always asks first (login-CSRF defence: a link must never
 * sign someone in without a tap).
 */
export function decideHandoff(currentUserId: string | null, redeemedUserId: string): HandoffDecision {
  return currentUserId !== null && currentUserId === redeemedUserId ? 'continue' : 'prompt';
}

/** True while the app must show "Signing you in…" (or the confirm) instead of any route/login. */
export function isHandoffPending(state: HandoffState): boolean {
  return state.phase === 'redeeming' || state.phase === 'confirm' || state.phase === 'verifying';
}

export const HANDOFF_FAILED_NOTICE = 'That sign-in link expired — enter your email to get a code';

const DEFAULT_TIMEOUT_MS = 15_000;

class HandoffTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HandoffTimeoutError()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class HandoffController {
  private state: HandoffState = { phase: 'idle' };
  private readonly listeners = new Set<() => void>();
  private readonly redeems = new Map<string, Promise<RedeemResult>>();
  private pendingChoice: ((choice: 'continue' | 'stay') => void) | null = null;
  private runId = 0;

  constructor(private readonly deps: HandoffDeps) {}

  getState = (): HandoffState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: HandoffState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** One memoized redeem request per code. */
  redeemOnce(code: string): Promise<RedeemResult> {
    let pending = this.redeems.get(code);
    if (!pending) {
      pending = withTimeout(this.deps.redeem(code), this.timeoutMs);
      this.redeems.set(code, pending);
    }
    return pending;
  }

  /** A handoff parameter was present but unusable (malformed code). */
  fail(): void {
    this.cancelPendingChoice();
    this.runId += 1;
    this.set({ phase: 'failed' });
  }

  /** Begin (or restart, for a new code) a handoff. Safe to call twice with the same code. */
  start(code: string): Promise<void> {
    this.cancelPendingChoice();
    const runId = ++this.runId;
    this.set({ phase: 'redeeming' });
    return this.run(code, runId);
  }

  private cancelPendingChoice(): void {
    this.pendingChoice?.('stay');
    this.pendingChoice = null;
  }

  private isCurrent(runId: number): boolean {
    return runId === this.runId;
  }

  private async run(code: string, runId: number): Promise<void> {
    try {
      const redeemed = await this.redeemOnce(code);
      if (!this.isCurrent(runId)) return;

      const session = await withTimeout(this.deps.getSession(), this.timeoutMs);
      if (!this.isCurrent(runId)) return;

      if (decideHandoff(session?.userId ?? null, redeemed.userId) === 'prompt') {
        this.set({
          phase: 'confirm',
          maskedEmail: redeemed.maskedEmail,
          currentEmail: session?.email ?? null,
          hasSession: session !== null,
        });
        const choice = await new Promise<'continue' | 'stay'>((resolve) => {
          this.pendingChoice = resolve;
        });
        this.pendingChoice = null;
        if (!this.isCurrent(runId)) return;
        if (choice === 'stay') {
          this.set({ phase: 'stayed' });
          return;
        }
      }

      this.set({ phase: 'verifying' });
      const verifying = this.deps.verifyOtp(redeemed.tokenHash);
      let outcome: { error: string | null };
      try {
        outcome = await withTimeout(verifying, this.timeoutMs);
      } catch (error) {
        if (error instanceof HandoffTimeoutError) {
          // The verify may still succeed after we gave up: when it does, the new
          // session is stored, so retire the old one and report signed in.
          void verifying.then(
            (late) => {
              if (late.error) return;
              this.retire(session);
              if (this.isCurrent(runId)) this.set({ phase: 'signedIn', maskedEmail: redeemed.maskedEmail, userId: redeemed.userId });
            },
            () => undefined,
          );
        }
        throw error;
      }
      if (outcome.error) {
        if (this.isCurrent(runId)) this.set({ phase: 'failed' });
        return;
      }

      // The new session is now the stored one; retire the old one on the server
      // (even when this run was superseded in the meantime).
      this.retire(session);
      if (!this.isCurrent(runId)) return;
      this.set({ phase: 'signedIn', maskedEmail: redeemed.maskedEmail, userId: redeemed.userId });
    } catch {
      if (this.isCurrent(runId)) this.set({ phase: 'failed' });
    }
  }

  /** Best-effort revoke of the previous session; never fails the handoff. */
  private retire(session: CurrentSession | null): void {
    if (session) void this.deps.revokeSession(session).catch(() => undefined);
  }

  /**
   * The auth session was signed out (any tab). Clears a finished handoff's
   * chip / stale failed notice, but never disturbs one still in flight.
   */
  onSignedOut = (): void => {
    if (!isHandoffPending(this.state) && this.state.phase !== 'idle') this.reset();
  };

  /** "Continue as j•••@gmail.com". */
  confirmSwitch = (): void => {
    this.pendingChoice?.('continue');
  };

  /** "Stay signed in as <current>". */
  declineSwitch = (): void => {
    this.pendingChoice?.('stay');
  };

  /** Dismiss the chip / leave the handoff state (after "Not you?" or the × button). */
  reset = (): void => {
    this.cancelPendingChoice();
    this.runId += 1;
    this.set({ phase: 'idle' });
  };
}
