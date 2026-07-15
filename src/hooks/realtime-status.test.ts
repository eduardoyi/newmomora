import { act, renderHook } from '@testing-library/react-native';

import {
  clearRealtimeStatus,
  resetRealtimeStatusForTests,
  setRealtimeLive,
  useIsRealtimeLive,
} from '@/hooks/realtime-status';

// D3 (docs/plans/performance-optimizations.md Workstream D): the
// useSyncExternalStore-backed suppression flag useGenerationStatusPolling
// reads. Exercises both directions explicitly per the plan -- a plain ref
// would pass a "goes live" test just as easily but silently fail the "comes
// back down" direction, since nothing would ever re-render to notice.

describe('realtime-status', () => {
  beforeEach(() => {
    resetRealtimeStatusForTests();
  });

  it('defaults to not live', () => {
    const { result } = renderHook(() => useIsRealtimeLive('family-1'));
    expect(result.current).toBe(false);
  });

  it('flips live on setRealtimeLive and back on clearRealtimeStatus', () => {
    const { result } = renderHook(() => useIsRealtimeLive('family-1'));

    act(() => setRealtimeLive('family-1', true));
    expect(result.current).toBe(true);

    act(() => clearRealtimeStatus('family-1'));
    expect(result.current).toBe(false);
  });

  it('does not report live for a familyId other than the one currently subscribed', () => {
    const { result } = renderHook(() => useIsRealtimeLive('family-2'));

    act(() => setRealtimeLive('family-1', true));

    expect(result.current).toBe(false);
  });

  it('ignores a clear for a familyId that is not the currently-live one', () => {
    const { result } = renderHook(() => useIsRealtimeLive('family-1'));
    act(() => setRealtimeLive('family-1', true));

    // A stale CLOSED event from an old, already-superseded channel (e.g.
    // arriving just after a family switch started a new subscription) must
    // not clear the new channel's live status.
    act(() => clearRealtimeStatus('family-0'));

    expect(result.current).toBe(true);
  });

  it('is false for a null/undefined familyId even while some family is live', () => {
    const { result } = renderHook(() => useIsRealtimeLive(undefined));
    act(() => setRealtimeLive('family-1', true));
    expect(result.current).toBe(false);
  });
});
