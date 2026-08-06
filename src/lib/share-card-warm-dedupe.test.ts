import { shouldWarmShareCardForReadyTransition } from '@/lib/share-card-warm-dedupe';

// The seen-set is a module-level singleton (by design -- useMemory,
// useGenerationStatusPolling, and useMemoriesRealtime must share it via
// handleIllustrationReadyTransition), so each test below uses its own
// unique memory id to stay isolated from the others. Mirrors
// illustration-outcome-dedupe.test.ts's shape.
describe('shouldWarmShareCardForReadyTransition', () => {
  it('returns true the first time a memory + illustration_generation_id pair is seen', () => {
    expect(shouldWarmShareCardForReadyTransition('memory-1', 'gen-1')).toBe(true);
  });

  it('returns false on a repeated call for the same pair', () => {
    expect(shouldWarmShareCardForReadyTransition('memory-2', 'gen-1')).toBe(true);
    expect(shouldWarmShareCardForReadyTransition('memory-2', 'gen-1')).toBe(false);
    expect(shouldWarmShareCardForReadyTransition('memory-2', 'gen-1')).toBe(false);
  });

  it('treats a different illustration_generation_id on the same memory as a distinct key (a regeneration warms again)', () => {
    expect(shouldWarmShareCardForReadyTransition('memory-3', 'gen-1')).toBe(true);
    expect(shouldWarmShareCardForReadyTransition('memory-3', 'gen-2')).toBe(true);
  });

  it('treats the same illustration_generation_id on different memories as distinct keys', () => {
    expect(shouldWarmShareCardForReadyTransition('memory-4', 'gen-1')).toBe(true);
    expect(shouldWarmShareCardForReadyTransition('memory-5', 'gen-1')).toBe(true);
  });

  it('models the detail-hook + poll + realtime triple-observation case: only the first observer warms', () => {
    const detailHookObserves = shouldWarmShareCardForReadyTransition('memory-6', 'gen-1');
    const pollObserves = shouldWarmShareCardForReadyTransition('memory-6', 'gen-1');
    const realtimeObserves = shouldWarmShareCardForReadyTransition('memory-6', 'gen-1');

    expect(detailHookObserves).toBe(true);
    expect(pollObserves).toBe(false);
    expect(realtimeObserves).toBe(false);
  });

  it('collapses a null illustration_generation_id to a single shared bucket per memory', () => {
    expect(shouldWarmShareCardForReadyTransition('memory-7', null)).toBe(true);
    expect(shouldWarmShareCardForReadyTransition('memory-7', null)).toBe(false);
  });
});
