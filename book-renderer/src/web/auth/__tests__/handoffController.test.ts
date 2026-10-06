import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideHandoff,
  HandoffController,
  isHandoffPending,
  type CurrentSession,
  type HandoffDeps,
  type HandoffState,
  type RedeemResult,
} from '../handoffController';

const CODE = 'A'.repeat(43);
const REDEEMED: RedeemResult = { tokenHash: 'th_1', maskedEmail: 'j•••@example.test', userId: 'user-a' };

function session(userId: string): CurrentSession {
  return { userId, email: `${userId}@example.test`, accessToken: `at-${userId}`, refreshToken: `rt-${userId}` };
}

function makeDeps(overrides: Partial<HandoffDeps> = {}) {
  const calls = { redeem: 0, verify: [] as string[], revoked: [] as CurrentSession[] };
  const deps: HandoffDeps = {
    redeem: async () => {
      calls.redeem += 1;
      return REDEEMED;
    },
    getSession: async () => null,
    verifyOtp: async (tokenHash) => {
      calls.verify.push(tokenHash);
      return { error: null };
    },
    revokeSession: async (old) => {
      calls.revoked.push(old);
    },
    ...overrides,
  };
  return { deps, calls };
}

function record(controller: HandoffController): HandoffState['phase'][] {
  const phases: HandoffState['phase'][] = [controller.getState().phase];
  controller.subscribe(() => phases.push(controller.getState().phase));
  return phases;
}

afterEach(() => vi.useRealTimers());

describe('decideHandoff', () => {
  it('only the same user continues silently; no session or a different user always prompts (login CSRF)', () => {
    expect(decideHandoff('user-a', 'user-a')).toBe('continue');
    expect(decideHandoff(null, 'user-a')).toBe('prompt');
    expect(decideHandoff('user-b', 'user-a')).toBe('prompt');
  });
});

describe('isHandoffPending', () => {
  it('blocks routes/login only while redeeming, confirming or verifying', () => {
    expect(isHandoffPending({ phase: 'idle' })).toBe(false);
    expect(isHandoffPending({ phase: 'redeeming' })).toBe(true);
    expect(isHandoffPending({ phase: 'confirm', maskedEmail: 'x', currentEmail: null, hasSession: false })).toBe(true);
    expect(isHandoffPending({ phase: 'verifying' })).toBe(true);
    expect(isHandoffPending({ phase: 'signedIn', maskedEmail: 'x', userId: 'u' })).toBe(false);
    expect(isHandoffPending({ phase: 'stayed' })).toBe(false);
    expect(isHandoffPending({ phase: 'failed' })).toBe(false);
  });
});

describe('HandoffController', () => {
  it('memoizes the redeem: started twice (StrictMode / hashchange) -> one request', async () => {
    const { deps, calls } = makeDeps();
    const controller = new HandoffController(deps);
    const both = Promise.all([controller.start(CODE), controller.start(CODE)]);
    await vi.waitFor(() => expect(controller.getState().phase).toBe('confirm'));
    controller.confirmSwitch();
    await both;
    expect(calls.redeem).toBe(1);
    expect(calls.verify).toEqual(['th_1']);
    expect(controller.getState()).toEqual({ phase: 'signedIn', maskedEmail: REDEEMED.maskedEmail, userId: REDEEMED.userId });
  });

  it('no session: ALWAYS confirms first (login CSRF); Continue verifies, nothing to revoke', async () => {
    const { deps, calls } = makeDeps();
    const controller = new HandoffController(deps);
    const phases = record(controller);
    const done = controller.start(CODE);
    await vi.waitFor(() => expect(controller.getState().phase).toBe('confirm'));
    expect(controller.getState()).toEqual({
      phase: 'confirm',
      maskedEmail: REDEEMED.maskedEmail,
      currentEmail: null,
      hasSession: false,
    });
    expect(calls.verify).toEqual([]); // nothing signed in without the tap
    controller.confirmSwitch();
    await done;
    expect(phases).toEqual(['idle', 'redeeming', 'confirm', 'verifying', 'signedIn']);
    expect(calls.revoked).toEqual([]);
  });

  it('no session: "Use a different account" never calls verifyOtp (normal login follows)', async () => {
    const { deps, calls } = makeDeps();
    const controller = new HandoffController(deps);
    const done = controller.start(CODE);
    await vi.waitFor(() => expect(controller.getState().phase).toBe('confirm'));
    controller.declineSwitch();
    await done;
    expect(calls.verify).toEqual([]);
    expect(controller.getState().phase).toBe('stayed');
  });

  it('same user: continues without a prompt and revokes the previous session', async () => {
    const old = session('user-a');
    const { deps, calls } = makeDeps({ getSession: async () => old });
    const controller = new HandoffController(deps);
    const phases = record(controller);
    await controller.start(CODE);
    expect(phases).not.toContain('confirm');
    expect(calls.verify).toEqual(['th_1']);
    expect(calls.revoked).toEqual([old]);
    expect(controller.getState().phase).toBe('signedIn');
  });

  it('different user: asks first; Continue verifies and revokes the old session', async () => {
    const old = session('user-b');
    const { deps, calls } = makeDeps({ getSession: async () => old });
    const controller = new HandoffController(deps);
    const done = controller.start(CODE);
    await vi.waitFor(() => expect(controller.getState().phase).toBe('confirm'));
    expect(controller.getState()).toEqual({
      phase: 'confirm',
      maskedEmail: REDEEMED.maskedEmail,
      currentEmail: 'user-b@example.test',
      hasSession: true,
    });
    expect(calls.verify).toEqual([]); // nothing switched yet
    controller.confirmSwitch();
    await done;
    expect(calls.verify).toEqual(['th_1']);
    expect(calls.revoked).toEqual([old]);
    expect(controller.getState().phase).toBe('signedIn');
  });

  it('different user: "Stay signed in" never calls verifyOtp or revokes', async () => {
    const { deps, calls } = makeDeps({ getSession: async () => session('user-b') });
    const controller = new HandoffController(deps);
    const done = controller.start(CODE);
    await vi.waitFor(() => expect(controller.getState().phase).toBe('confirm'));
    controller.declineSwitch();
    await done;
    expect(calls.verify).toEqual([]);
    expect(calls.revoked).toEqual([]);
    expect(controller.getState().phase).toBe('stayed');
  });

  it('redeem failure -> failed (fallback login), verify never called', async () => {
    const { deps, calls } = makeDeps({
      redeem: async () => {
        throw new Error('handoff_invalid');
      },
    });
    const controller = new HandoffController(deps);
    await controller.start(CODE);
    expect(controller.getState()).toEqual({ phase: 'failed' });
    expect(calls.verify).toEqual([]);
  });

  it('verifyOtp error -> failed, the old session is NOT revoked', async () => {
    const { deps, calls } = makeDeps({
      getSession: async () => session('user-a'),
      verifyOtp: async () => ({ error: 'Token has expired or is invalid' }),
    });
    const controller = new HandoffController(deps);
    await controller.start(CODE);
    expect(controller.getState()).toEqual({ phase: 'failed' });
    expect(calls.revoked).toEqual([]);
  });

  it('a revoke failure does not fail the handoff', async () => {
    const { deps } = makeDeps({
      getSession: async () => session('user-a'),
      revokeSession: async () => {
        throw new Error('offline');
      },
    });
    const controller = new HandoffController(deps);
    await controller.start(CODE);
    expect(controller.getState().phase).toBe('signedIn');
  });

  it('a hung redeem times out into failed', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps({ redeem: () => new Promise<RedeemResult>(() => {}), timeoutMs: 1000 });
    const controller = new HandoffController(deps);
    const done = controller.start(CODE);
    await vi.advanceTimersByTimeAsync(1001);
    await done;
    expect(controller.getState()).toEqual({ phase: 'failed' });
  });

  it('a verifyOtp that succeeds AFTER the timeout still revokes the old session and ends signed in', async () => {
    vi.useFakeTimers();
    const old = session('user-a');
    let finishVerify: (value: { error: string | null }) => void = () => {};
    const { deps, calls } = makeDeps({
      getSession: async () => old,
      verifyOtp: () => new Promise((resolve) => (finishVerify = resolve)),
      timeoutMs: 1000,
    });
    const controller = new HandoffController(deps);
    const done = controller.start(CODE);
    await vi.advanceTimersByTimeAsync(1001);
    await done;
    expect(controller.getState()).toEqual({ phase: 'failed' });
    expect(calls.revoked).toEqual([]);
    finishVerify({ error: null });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.revoked).toEqual([old]);
    expect(controller.getState()).toEqual({ phase: 'signedIn', maskedEmail: REDEEMED.maskedEmail, userId: REDEEMED.userId });
  });

  it('a late verifyOtp ERROR after the timeout revokes nothing', async () => {
    vi.useFakeTimers();
    let finishVerify: (value: { error: string | null }) => void = () => {};
    const { deps, calls } = makeDeps({
      getSession: async () => session('user-a'),
      verifyOtp: () => new Promise((resolve) => (finishVerify = resolve)),
      timeoutMs: 1000,
    });
    const controller = new HandoffController(deps);
    const done = controller.start(CODE);
    await vi.advanceTimersByTimeAsync(1001);
    await done;
    finishVerify({ error: 'invalid' });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.revoked).toEqual([]);
    expect(controller.getState()).toEqual({ phase: 'failed' });
  });

  it('onSignedOut clears a finished handoff (chip / stale failed notice) but not one in flight', async () => {
    const { deps } = makeDeps({ getSession: async () => session('user-a') });
    const controller = new HandoffController(deps);
    await controller.start(CODE);
    expect(controller.getState().phase).toBe('signedIn');
    controller.onSignedOut();
    expect(controller.getState()).toEqual({ phase: 'idle' });

    controller.fail();
    controller.onSignedOut();
    expect(controller.getState()).toEqual({ phase: 'idle' });

    const pending = makeDeps({ getSession: async () => null });
    const inFlight = new HandoffController(pending.deps);
    const run = inFlight.start(CODE);
    await vi.waitFor(() => expect(inFlight.getState().phase).toBe('confirm'));
    inFlight.onSignedOut();
    expect(inFlight.getState().phase).toBe('confirm');
    inFlight.confirmSwitch();
    await run;
    expect(inFlight.getState().phase).toBe('signedIn');
  });

  it('fail() (malformed code) and reset() set failed / idle', () => {
    const { deps } = makeDeps();
    const controller = new HandoffController(deps);
    controller.fail();
    expect(controller.getState()).toEqual({ phase: 'failed' });
    controller.reset();
    expect(controller.getState()).toEqual({ phase: 'idle' });
  });

  it('a new code supersedes a pending confirm for the old one', async () => {
    const { deps, calls } = makeDeps({ getSession: async () => session('user-b') });
    const controller = new HandoffController(deps);
    const first = controller.start(CODE);
    await vi.waitFor(() => expect(controller.getState().phase).toBe('confirm'));
    const second = controller.start('B'.repeat(43));
    await first;
    await vi.waitFor(() => expect(controller.getState().phase).toBe('confirm'));
    expect(calls.redeem).toBe(2);
    controller.confirmSwitch();
    await second;
    expect(calls.verify).toEqual(['th_1']);
  });
});
