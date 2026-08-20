import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { ReactNode } from 'react';
import { Alert } from 'react-native';

import { familyMembershipsQueryKeyBase } from '@/hooks/queryKeys';
import { useIsOnline } from '@/lib/connectivity';
import { composeShareCard } from '@/services/share-card';

import { useShareMemoryCard } from './useShareMemoryCard';

jest.mock('@/services/share-card', () => ({ composeShareCard: jest.fn() }));
jest.mock('@/lib/connectivity', () => ({ useIsOnline: jest.fn(() => true) }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn(),
  deleteAsync: jest.fn(),
  EncodingType: { Base64: 'base64' },
}));

const mockedComposeShareCard = composeShareCard as jest.MockedFunction<typeof composeShareCard>;
const mockedUseIsOnline = useIsOnline as jest.MockedFunction<typeof useIsOnline>;
const mockedSharing = Sharing as jest.Mocked<typeof Sharing>;
const mockedFileSystem = FileSystem as jest.Mocked<typeof FileSystem>;

const memory = { id: 'memory-1', memory_date: '2026-06-08' };

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useShareMemoryCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient();
    jest.spyOn(queryClient, 'invalidateQueries');
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockedUseIsOnline.mockReturnValue(true);
    mockedSharing.isAvailableAsync.mockResolvedValue(true);
    mockedSharing.shareAsync.mockResolvedValue(undefined);
    mockedFileSystem.writeAsStringAsync.mockResolvedValue(undefined);
    mockedFileSystem.deleteAsync.mockResolvedValue(undefined);
  });

  it('composes, writes a uniquely-named temp file, and opens the share sheet', async () => {
    const bytes = new Uint8Array([77, 97, 110]).buffer; // "Man" -> base64 "TWFu"
    mockedComposeShareCard.mockResolvedValue({ ok: true, bytes });

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });

    await act(async () => {
      await result.current.shareMemoryCard(memory, 'asset-1');
    });

    expect(mockedComposeShareCard).toHaveBeenCalledWith({ memoryId: 'memory-1', mediaAssetId: 'asset-1' });
    // 'memory-1' -> 'memory1' -> sliced to 6 -> 'memory'.
    expect(mockedFileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///cache/momora-jun-8-2026-memory.png',
      'TWFu',
      { encoding: 'base64' },
    );
    expect(mockedSharing.shareAsync).toHaveBeenCalledWith(
      'file:///cache/momora-jun-8-2026-memory.png',
      { mimeType: 'image/png' },
    );
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///cache/momora-jun-8-2026-memory.png',
      { idempotent: true },
    );
  });

  it('omits mediaAssetId for text/illustrated memories (undefined, not null)', async () => {
    mockedComposeShareCard.mockResolvedValue({ ok: true, bytes: new ArrayBuffer(0) });
    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });

    await act(async () => {
      await result.current.shareMemoryCard(memory, null);
    });

    expect(mockedComposeShareCard).toHaveBeenCalledWith({ memoryId: 'memory-1', mediaAssetId: undefined });
  });

  it('exposes isSharing true only while a share is in flight', async () => {
    let resolveCompose: (value: Awaited<ReturnType<typeof composeShareCard>>) => void = () => {};
    mockedComposeShareCard.mockImplementation(
      () => new Promise((resolve) => { resolveCompose = resolve; }),
    );

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    expect(result.current.isSharing).toBe(false);

    let sharePromise!: Promise<void>;
    act(() => {
      sharePromise = result.current.shareMemoryCard(memory);
    });
    expect(result.current.isSharing).toBe(true);

    // Let the pending `Sharing.isAvailableAsync()` microtask resolve so the
    // mock's `composeShareCard` implementation actually runs (and captures
    // `resolveCompose`) before this test tries to call it -- `waitFor` polls
    // with real timers, which yields the event loop between checks.
    await waitFor(() => expect(mockedComposeShareCard).toHaveBeenCalled());

    await act(async () => {
      resolveCompose({ ok: false, error: { message: 'boom', status: 500 } });
      await sharePromise;
    });
    expect(result.current.isSharing).toBe(false);
  });

  it('never calls compose and shows a device message when native sharing is unavailable', async () => {
    mockedSharing.isAvailableAsync.mockResolvedValue(false);

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    await act(async () => {
      await result.current.shareMemoryCard(memory);
    });

    expect(mockedComposeShareCard).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Sharing unavailable', expect.any(String));
  });

  it('shows an offline message and never writes a file when offline', async () => {
    mockedUseIsOnline.mockReturnValue(false);
    mockedComposeShareCard.mockResolvedValue({
      ok: false,
      error: { message: 'Network request failed', code: 'network_error' },
    });

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    await act(async () => {
      await result.current.shareMemoryCard(memory);
    });

    expect(Alert.alert).toHaveBeenCalledWith("You're offline", expect.any(String));
    expect(mockedFileSystem.writeAsStringAsync).not.toHaveBeenCalled();
    expect(mockedSharing.shareAsync).not.toHaveBeenCalled();
  });

  it('shows the sharing-off message and invalidates family memberships on 403', async () => {
    mockedComposeShareCard.mockResolvedValue({
      ok: false,
      error: { message: 'Sharing is currently off for this family', code: 'sharing_disabled', status: 403 },
    });

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    await act(async () => {
      await result.current.shareMemoryCard(memory);
    });

    expect(Alert.alert).toHaveBeenCalledWith('Sharing is off', 'Sharing is currently off for this family');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: [familyMembershipsQueryKeyBase],
    });
  });

  it('shows a friendly rate-limit message on 429 without invalidating anything', async () => {
    mockedComposeShareCard.mockResolvedValue({
      ok: false,
      error: { message: 'Too many share requests', code: 'rate_limited', status: 429 },
    });

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    await act(async () => {
      await result.current.shareMemoryCard(memory);
    });

    expect(Alert.alert).toHaveBeenCalledWith("You're sharing a lot", expect.any(String));
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  // P0.1 forward-compat fallback (docs/plans/audio-memories-v1.md) -- the
  // share icon can be reached for a memory_type the server rejects (e.g.
  // `audio`, before an old installed client has updated). The server's own
  // message is written for this exact case and must reach the user instead
  // of the generic "Could not share memory / Please try again." fallback.
  it('surfaces the server message for a 400 unsupported_memory_type response', async () => {
    mockedComposeShareCard.mockResolvedValue({
      ok: false,
      error: {
        message: 'Audio memories cannot be shared yet',
        code: 'unsupported_memory_type',
        status: 400,
      },
    });

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    await act(async () => {
      await result.current.shareMemoryCard(memory);
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Could not share memory',
      'Audio memories cannot be shared yet',
    );
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('shows a generic message for other failures', async () => {
    mockedComposeShareCard.mockResolvedValue({ ok: false, error: { message: 'boom', status: 500 } });

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    await act(async () => {
      await result.current.shareMemoryCard(memory);
    });

    expect(Alert.alert).toHaveBeenCalledWith('Could not share memory', expect.any(String));
  });

  it('best-effort cleans up the temp file even when writing it fails', async () => {
    mockedComposeShareCard.mockResolvedValue({ ok: true, bytes: new Uint8Array([1]).buffer });
    mockedFileSystem.writeAsStringAsync.mockRejectedValue(new Error('disk full'));

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });
    await act(async () => {
      await result.current.shareMemoryCard(memory);
    });

    expect(Alert.alert).toHaveBeenCalledWith('Could not share memory', expect.any(String));
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalled();
    expect(mockedSharing.shareAsync).not.toHaveBeenCalled();
  });

  it('ignores a re-entrant call while a share is already in flight', async () => {
    let resolveCompose: (value: Awaited<ReturnType<typeof composeShareCard>>) => void = () => {};
    mockedComposeShareCard.mockImplementation(
      () => new Promise((resolve) => { resolveCompose = resolve; }),
    );

    const { result } = renderHook(() => useShareMemoryCard(), { wrapper });

    let firstPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.shareMemoryCard(memory);
    });

    await waitFor(() => expect(mockedComposeShareCard).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.shareMemoryCard(memory); // Re-entrant -- should no-op.
      resolveCompose({ ok: false, error: { message: 'boom', status: 500 } });
      await firstPromise;
    });

    expect(mockedComposeShareCard).toHaveBeenCalledTimes(1);
  });
});
