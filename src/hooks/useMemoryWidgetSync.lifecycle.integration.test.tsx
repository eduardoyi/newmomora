import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import {
  MemoryWidgetSyncProvider,
  registerMemoryWidgetNativeAdapter,
  useMemoryWidgetSync,
} from './useMemoryWidgetSync';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useIsOnline } from '@/lib/connectivity';
import * as widgetCache from '@/services/widget-cache';
import * as widgetMemories from '@/services/widget-memories';
import type { WidgetManifest, WidgetNativeAdapter } from '@/widgets/types';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useUserProfile', () => ({ useUserProfile: jest.fn() }));
jest.mock('@/lib/connectivity', () => ({ useIsOnline: jest.fn() }));
jest.mock('@/services/content-safety', () => ({
  fetchMyBlockedFamilyAccounts: jest.fn(async () => ({ data: [], error: null })),
  fetchMyContentReports: jest.fn(async () => ({ data: [], error: null })),
}));
jest.mock('@/services/media', () => ({
  getMediaUrls: jest.fn(async (keys: string[]) => ({ data: { urls: Object.fromEntries(keys.map((key) => [key, `https://example.test/${key}`])) }, error: null })),
}));
jest.mock('@/services/widget-memories', () => ({
  fetchWidgetCandidateMemories: jest.fn(),
  fetchWidgetRetainedMemoriesByIds: jest.fn(async () => ({ data: [], error: null, failure: null })),
}));
jest.mock('@/services/widget-cache', () => {
  // Keep the real controller and manifest parser; only local housekeeping and
  // image transport are replaced so lifecycle tests never touch native files.
  const actual = jest.requireActual('@/services/widget-cache');
  return {
    ...actual,
    stageWidgetImage: jest.fn(),
    sweepWidgetCache: jest.fn(async () => undefined),
  };
});

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockedUseIsOnline = useIsOnline as jest.MockedFunction<typeof useIsOnline>;

const familyClock = {
  familyDate: '2026-09-15',
  timezoneName: 'UTC',
  nextDayBoundary: '2026-09-16T00:00:00.000Z',
};

function candidateResult(memoryId = 'memory-a', familyId = 'family-a') {
  return {
    data: {
      candidates: [{ id: memoryId, memoryDate: '2026-09-15', ageBand: 'recent' as const }],
      clock: familyClock,
      memories: [{
        id: memoryId,
        family_id: familyId,
        user_id: 'account-a',
        memory_date: '2026-09-15',
        updated_at: '2026-09-15T12:00:00.000Z',
        created_at: '2026-09-15T12:00:00.000Z',
        content: 'A memory',
        description: null,
        memory_type: 'media',
        illustration_key: null,
        illustration_status: null,
        illustration_generation_id: null,
        emotion: 'tender',
        media_key: null,
        media_content_type: null,
        taggedMembers: [],
        mediaAssets: [{
          id: `${memoryId}-asset`,
          memory_id: memoryId,
          object_key: 'private/a.jpg',
          preview_object_key: 'private/a-preview.jpg',
          content_type: 'image/jpeg',
          position: 0,
          duration_ms: null,
          aspect_ratio: 1,
          share_card_key: null,
          created_at: '2026-09-15T12:00:00.000Z',
          updated_at: '2026-09-15T12:00:00.000Z',
        }],
        likeCount: 0,
        commentCount: 0,
        likedByMe: false,
      }],
    },
    error: null,
    failure: null,
  } as never;
}

function makeAdapter(initial: WidgetManifest | null = null) {
  let current = initial;
  const adapter: WidgetNativeAdapter = {
    available: () => true,
    readManifest: jest.fn(async () => current),
    publishManifest: jest.fn(async (manifest) => {
      current = manifest;
    }),
    clearManifest: jest.fn(async () => {
      current = null;
    }),
    reload: jest.fn(async () => undefined),
  };
  return { adapter, getManifest: () => current };
}

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryWidgetSyncProvider>{children}</MemoryWidgetSyncProvider>
      </QueryClientProvider>
    );
  };
}

describe('MemoryWidgetSyncProvider lifecycle fences', () => {
  let authValue: any;
  let familyValue: any;
  let profileValue: any;
  let fetchCandidates: jest.Mock;
  let adapter: WidgetNativeAdapter;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    authValue = {
      session: { user: { id: 'account-a' } },
      user: { id: 'account-a', is_anonymous: false },
      isLoading: false,
    };
    familyValue = {
      familyId: 'family-a',
      memberships: [{ familyId: 'family-a' }],
      isLoading: false,
    };
    profileValue = { profile: null, isLoading: false };
    mockedUseAuth.mockImplementation(() => authValue);
    mockedUseFamily.mockImplementation(() => familyValue);
    mockedUseUserProfile.mockImplementation(() => profileValue);
    mockedUseIsOnline.mockReturnValue(true);
    fetchCandidates = widgetMemories.fetchWidgetCandidateMemories as jest.Mock;
    fetchCandidates.mockResolvedValue(candidateResult());
    const stageImage = widgetCache.stageWidgetImage as jest.Mock;
    stageImage.mockImplementation(async (_generationId, image) => ({
      filename: image.filename,
      uri: `file://${image.filename}`,
      sizeBytes: 10,
    }));
    const created = makeAdapter();
    adapter = created.adapter;
    registerMemoryWidgetNativeAdapter(adapter);
  });

  afterEach(() => {
    act(() => registerMemoryWidgetNativeAdapter(null));
  });

  it('automatically prepares an eligible photo without opening widget settings', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(rendered.result.current.isSupported).toBe(true));
    await waitFor(() => expect(fetchCandidates).toHaveBeenCalledWith('family-a'));
    await waitFor(() => expect(adapter.publishManifest).toHaveBeenCalled());
    expect(rendered.result.current.isSupported).toBe(true);
    await waitFor(() => expect(rendered.result.current.manifest?.entries[0]?.imageFilename).toBe('memory-memory-a-0.jpg'));
    expect(rendered.result.current).not.toHaveProperty('isEnabled');
    expect(rendered.result.current).not.toHaveProperty('setEnabled');
  });

  it('ignores a legacy disabled preference and still prepares the active family', async () => {
    await widgetCache.writeWidgetPreference({ accountId: 'account-a', familyId: 'family-a' }, false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(fetchCandidates).toHaveBeenCalledWith('family-a'));
    await waitFor(() => expect(adapter.publishManifest).toHaveBeenCalled());
  });

  it('clears the old scope and drops a queued automatic publish after logout', async () => {
    let finishCandidates!: (value: unknown) => void;
    fetchCandidates.mockImplementation(() => new Promise((resolve) => { finishCandidates = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(fetchCandidates).toHaveBeenCalled());
    authValue = { ...authValue, session: null, user: null };
    familyValue = { ...familyValue, familyId: null, memberships: [] };
    await act(async () => {
      rendered.rerender();
    });
    await act(async () => {
      finishCandidates(candidateResult());
      await Promise.resolve();
    });

    expect(adapter.publishManifest).not.toHaveBeenCalled();
    expect(adapter.clearManifest).toHaveBeenCalledWith({ accountId: 'account-a', familyId: 'family-a' });
  });

  it('fences an in-flight automatic sync when the family changes before staging finishes', async () => {
    let releaseStage!: () => void;
    const stageImage = widgetCache.stageWidgetImage as jest.Mock;
    stageImage.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStage = () => resolve({ filename: 'memory-memory-a-0.jpg', uri: 'file://memory-memory-a-0.jpg', sizeBytes: 10 });
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(rendered.result.current.isSupported).toBe(true));
    await waitFor(() => expect(stageImage).toHaveBeenCalled());

    fetchCandidates.mockResolvedValue(candidateResult('memory-b', 'family-b'));
    familyValue = { ...familyValue, familyId: 'family-b', memberships: [{ familyId: 'family-b' }] };
    await act(async () => {
      rendered.rerender();
      await Promise.resolve();
    });
    await act(async () => { releaseStage(); });
    await waitFor(() => expect(adapter.clearManifest).toHaveBeenCalledWith({
      accountId: 'account-a',
      familyId: 'family-a',
    }));
    await waitFor(() => expect(adapter.publishManifest).toHaveBeenCalled());
    for (const [manifest] of (adapter.publishManifest as jest.Mock).mock.calls) {
      expect(manifest.familyId).toBe('family-b');
      expect(manifest.entries.every((entry: { memoryId: string }) => entry.memoryId === 'memory-b')).toBe(true);
    }
  });

  it('clears a deleted profile without waiting for a later sync', async () => {
    profileValue = { profile: { deleted_at: '2026-09-15T12:00:00.000Z' }, isLoading: false };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(adapter.clearManifest).toHaveBeenCalledWith({
      accountId: 'account-a',
      familyId: 'family-a',
    }));
    await act(async () => {
      await rendered.result.current.syncNow();
    });
    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(adapter.publishManifest).not.toHaveBeenCalled();
  });

  it('does not auto-publish for an anonymous session', async () => {
    authValue = {
      session: { user: { id: 'anonymous' } },
      user: { id: 'anonymous', is_anonymous: true },
      isLoading: false,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
    await act(async () => { await Promise.resolve(); });
    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(adapter.publishManifest).not.toHaveBeenCalled();
  });

  it('does not clear a cached snapshot while auth is still restoring', async () => {
    (adapter.readManifest as jest.Mock).mockResolvedValue({ accountId: 'account-a', familyId: 'family-a' });
    authValue = { ...authValue, user: null, session: null, isLoading: true };
    familyValue = { ...familyValue, familyId: null, memberships: [], isLoading: true };
    mockedUseIsOnline.mockReturnValue(false);
    const queryClient = new QueryClient();
    renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });
    await act(async () => { await Promise.resolve(); });
    expect(adapter.clearManifest).not.toHaveBeenCalled();
  });

  it('preserves the current family cache on a settled offline startup', async () => {
    mockedUseIsOnline.mockReturnValue(false);
    (adapter.readManifest as jest.Mock).mockResolvedValue({ accountId: 'account-a', familyId: 'family-a' });
    const view = renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(new QueryClient()) });
    await waitFor(() => expect(view.result.current.isSupported).toBe(true));
    await act(async () => { await Promise.resolve(); });
    expect(adapter.clearManifest).not.toHaveBeenCalled();
    expect(fetchCandidates).not.toHaveBeenCalled();
  });

  it('clears another account persisted on disk on a cold offline start', async () => {
    mockedUseIsOnline.mockReturnValue(false);
    (adapter.readManifest as jest.Mock).mockResolvedValue({ accountId: 'old-account', familyId: 'old-family' });
    const queryClient = new QueryClient();
    const view = renderHook(() => useMemoryWidgetSync(), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    await waitFor(() => expect(adapter.clearManifest).toHaveBeenCalledWith({ accountId: 'old-account', familyId: 'old-family' }));
    expect(fetchCandidates).not.toHaveBeenCalled();
  });
});
