import { describe, expect, it, vi } from 'vitest';
import { AUTO_RELOAD_MIN_GAP_MS, isChunkLoadError, reloadOnce, shouldAutoReload } from '../chunkError';

describe('isChunkLoadError', () => {
  it('recognizes a failed dynamic import in each browser', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://shop.example.test/assets/CardRoute-abc.js',
      'error loading dynamically imported module: https://shop.example.test/assets/CardRoute-abc.js',
      'Importing a module script failed.',
      'Loading chunk 12 failed.',
      'Unable to preload CSS for /assets/CardRoute-abc.css',
    ]) {
      expect(isChunkLoadError(new TypeError(message)), message).toBe(true);
    }
    const named = new Error('x');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });
  it('does not treat an ordinary error as a stale tab', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });
});

describe('reload rate limit', () => {
  it('allows one automatic reload per minute', () => {
    expect(shouldAutoReload(null, 1000)).toBe(true);
    expect(shouldAutoReload(1000, 1000 + AUTO_RELOAD_MIN_GAP_MS - 1)).toBe(false);
    expect(shouldAutoReload(1000, 1000 + AUTO_RELOAD_MIN_GAP_MS)).toBe(true);
  });
  it('reloads and records the time; refuses a second reload right after (no loop on a broken deploy)', () => {
    let stored: string | null = null;
    let now = 5_000;
    const reload = vi.fn();
    const deps = { read: () => stored, write: (v: string) => (stored = v), reload, now: () => now };
    expect(reloadOnce(deps)).toBe(true);
    expect(stored).toBe('5000');
    now = 6_000;
    expect(reloadOnce(deps)).toBe(false);
    now = 5_000 + AUTO_RELOAD_MIN_GAP_MS;
    expect(reloadOnce(deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it('survives storage that throws', () => {
    const reload = vi.fn();
    expect(
      reloadOnce({
        read: () => {
          throw new Error('denied');
        },
        write: () => {
          throw new Error('denied');
        },
        reload,
        now: () => 1,
      }),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
