import { renderHook } from '@testing-library/react-native';

import { useArtworkUrlRecovery } from '@/components/artwork/artwork-piece-image';

describe('useArtworkUrlRecovery', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('re-signs once per key and ignores repeat failures (bounded, not a loop)', () => {
    const refetch = jest.fn().mockResolvedValue({});
    const { result } = renderHook(() => useArtworkUrlRecovery(refetch));

    result.current.onError('a.jpg');
    result.current.onError('a.jpg');
    result.current.onError('a.jpg');

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it('gives every piece its own attempt', () => {
    const refetch = jest.fn().mockResolvedValue({});
    const { result } = renderHook(() => useArtworkUrlRecovery(refetch));

    result.current.onError('a.jpg');
    result.current.onError('b.jpg');
    result.current.onError('b.jpg');

    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('hands the budget back when the piece loads, so a later expiry still recovers', () => {
    const refetch = jest.fn().mockResolvedValue({});
    const { result } = renderHook(() => useArtworkUrlRecovery(refetch));

    result.current.onError('a.jpg');
    result.current.onLoad('a.jpg');
    result.current.onError('a.jpg');

    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('keeps one stable handler pair and always calls the latest refetch', () => {
    const first = jest.fn().mockResolvedValue({});
    const second = jest.fn().mockResolvedValue({});
    const { result, rerender } = renderHook(
      ({ refetch }: { refetch: () => unknown }) => useArtworkUrlRecovery(refetch),
      { initialProps: { refetch: first } },
    );
    const { onError } = result.current;

    rerender({ refetch: second });
    expect(result.current.onError).toBe(onError);
    onError('a.jpg');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing refetch without logging (a dropped connection is expected)', async () => {
    const refetch = jest.fn().mockRejectedValue(new Error('fetch failed: network connection was lost'));
    const { result } = renderHook(() => useArtworkUrlRecovery(refetch));

    expect(() => result.current.onError('a.jpg')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('swallows a refetch that throws synchronously', () => {
    const refetch = jest.fn(() => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useArtworkUrlRecovery(refetch));
    expect(() => result.current.onError(null)).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
