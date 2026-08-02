import { shouldReportIllustrationOutcome } from '@/lib/illustration-outcome-dedupe';

// The seen-set is a module-level singleton (by design -- both
// useGenerationStatusPolling and useMemoriesRealtime must share it), so each
// test below uses its own unique memory id to stay isolated from the others.
describe('shouldReportIllustrationOutcome', () => {
  it('returns true the first time a memory+outcome pair is seen', () => {
    expect(shouldReportIllustrationOutcome('memory-1', 'ready')).toBe(true);
  });

  it('returns false on a repeated call for the same memory+outcome pair', () => {
    expect(shouldReportIllustrationOutcome('memory-2', 'failed')).toBe(true);
    expect(shouldReportIllustrationOutcome('memory-2', 'failed')).toBe(false);
    expect(shouldReportIllustrationOutcome('memory-2', 'failed')).toBe(false);
  });

  it('treats different outcomes for the same memory as distinct keys', () => {
    expect(shouldReportIllustrationOutcome('memory-3', 'ready')).toBe(true);
    expect(shouldReportIllustrationOutcome('memory-3', 'failed')).toBe(true);
  });

  it('treats the same outcome on different memories as distinct keys', () => {
    expect(shouldReportIllustrationOutcome('memory-4', 'ready')).toBe(true);
    expect(shouldReportIllustrationOutcome('memory-5', 'ready')).toBe(true);
  });

  it('models the poll + realtime double-observation case: only the first observer reports', () => {
    // Simulates useGenerationStatusPolling and useMemoriesRealtime both
    // observing the same ready transition for one memory.
    const pollObserves = shouldReportIllustrationOutcome('memory-6', 'ready');
    const realtimeObserves = shouldReportIllustrationOutcome('memory-6', 'ready');

    expect(pollObserves).toBe(true);
    expect(realtimeObserves).toBe(false);
  });
});
