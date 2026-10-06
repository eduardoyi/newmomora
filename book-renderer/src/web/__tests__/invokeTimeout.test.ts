import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVOKE_TIMEOUT_MS, raceInvokeTimeout, TIMED_OUT } from '../invokeTimeout';

afterEach(() => vi.useRealTimers());

describe('raceInvokeTimeout', () => {
  it('keeps the 45 s default (books are unchanged)', async () => {
    expect(INVOKE_TIMEOUT_MS).toBe(45_000);
    vi.useFakeTimers();
    const hung = new Promise<string>(() => {});
    const raced = raceInvokeTimeout(hung);
    await vi.advanceTimersByTimeAsync(44_999);
    let settled = false;
    void raced.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await raced).toBe(TIMED_OUT);
  });

  it('honours a custom cap (create_checkout uses 90 s)', async () => {
    vi.useFakeTimers();
    const raced = raceInvokeTimeout(new Promise<string>(() => {}), 90_000);
    await vi.advanceTimersByTimeAsync(89_999);
    let settled = false;
    void raced.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await raced).toBe(TIMED_OUT);
  });

  it('returns the value when the call settles first, and clears its timer', async () => {
    vi.useFakeTimers();
    expect(await raceInvokeTimeout(Promise.resolve('ok'), 1000)).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});
