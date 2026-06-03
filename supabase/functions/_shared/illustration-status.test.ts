import {
  ILLUSTRATION_GENERATION_STALE_MS,
  isIllustrationGenerationStale,
} from './illustration-status.ts';

Deno.test('isIllustrationGenerationStale returns true after the stale window', () => {
  const now = Date.parse('2026-05-28T12:00:00Z');
  const staleUpdatedAt = new Date(now - ILLUSTRATION_GENERATION_STALE_MS - 1000).toISOString();

  expect(isIllustrationGenerationStale('generating', staleUpdatedAt, now)).toBe(true);
});

Deno.test('isIllustrationGenerationStale returns false for fresh generating status', () => {
  const now = Date.parse('2026-05-28T12:00:00Z');
  const freshUpdatedAt = new Date(now - 60_000).toISOString();

  expect(isIllustrationGenerationStale('generating', freshUpdatedAt, now)).toBe(false);
  expect(isIllustrationGenerationStale('pending', freshUpdatedAt, now)).toBe(false);
});
