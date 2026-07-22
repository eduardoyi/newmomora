import { describe, expect, it } from 'vitest';

import { canStartProviderAttempt, providerAttemptTimeoutMs } from '../src/workflow';

describe('provider deadline policy', () => {
  const now = 1_000_000;

  it('allows a three-minute primary while preserving fallback and publication headroom', () => {
    const deadline = now + 300_000;
    expect(providerAttemptTimeoutMs('primary', deadline, now)).toBe(180_000);
    expect(providerAttemptTimeoutMs('fallback', deadline, now)).toBe(60_000);
  });

  it('only starts a fallback when its full minute and publication reserve fit', () => {
    expect(canStartProviderAttempt('fallback', now + 90_000, now)).toBe(true);
    expect(canStartProviderAttempt('fallback', now + 89_999, now)).toBe(false);
  });

  it('does not start another primary unless fallback and finalization headroom remain', () => {
    const deadlineAfterFullFirstAttempt = now + 120_000;
    expect(canStartProviderAttempt('primary', deadlineAfterFullFirstAttempt, now)).toBe(false);
    expect(canStartProviderAttempt('fallback', deadlineAfterFullFirstAttempt, now)).toBe(true);
  });

  it('keeps all persisted step output metadata-sized, never image bytes', () => {
    const output = { outputKey: 'user/memories/id/illustration.webp', model: 'gpt-image-2' };
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThan(1024 * 1024);
    expect(Object.keys(output)).not.toContain('bytes');
  });
});
