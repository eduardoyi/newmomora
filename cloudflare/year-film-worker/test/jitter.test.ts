import { describe, expect, it } from 'vitest';
import { dispatchJitterSeconds, MAX_JITTER_SECONDS } from '../src/jitter';

describe('dispatchJitterSeconds', () => {
  it('is deterministic per attempt + mode (replay-safe)', () => {
    const a = '22222222-2222-4222-8222-222222222222';
    expect(dispatchJitterSeconds(a, 'render')).toBe(dispatchJitterSeconds(a, 'render'));
  });

  it('stays within 0..45 whole seconds', () => {
    for (let i = 0; i < 2000; i += 1) {
      const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      for (const mode of ['thumbs', 'prepare', 'render']) {
        const s = dispatchJitterSeconds(id, mode);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(MAX_JITTER_SECONDS);
      }
    }
  });

  it('spreads a batch of 20 attempts (not all in the same second) and varies by mode', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `${(i * 7919).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const render = new Set(ids.map((id) => dispatchJitterSeconds(id, 'render')));
    expect(render.size).toBeGreaterThan(10);
    const differs = ids.filter((id) => dispatchJitterSeconds(id, 'thumbs') !== dispatchJitterSeconds(id, 'prepare'));
    expect(differs.length).toBeGreaterThan(10);
  });
});
