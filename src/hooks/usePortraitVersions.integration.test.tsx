import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyPortraitVersions, usePortraitVersions } from '@/hooks/usePortraitVersions';
import {
  createPortraitVersion,
  fetchFamilyPortraitVersions,
  generatePortraitVersion,
  updatePortraitVersionDate,
} from '@/services/portrait-versions';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/services/portrait-versions', () => ({
  createPortraitVersion: jest.fn(),
  deletePortraitVersion: jest.fn(),
  fetchFamilyPortraitVersions: jest.fn(),
  generatePortraitVersion: jest.fn(),
  updatePortraitVersionDate: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedFetch = fetchFamilyPortraitVersions as jest.MockedFunction<
  typeof fetchFamilyPortraitVersions
>;
const mockedCreate = createPortraitVersion as jest.MockedFunction<typeof createPortraitVersion>;
const mockedGenerate = generatePortraitVersion as jest.MockedFunction<typeof generatePortraitVersion>;
const mockedUpdate = updatePortraitVersionDate as jest.MockedFunction<typeof updatePortraitVersionDate>;

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });
}

function createWrapper(queryClient = createQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('usePortraitVersions integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedGenerate.mockResolvedValue({ data: null, error: null });
  });

  it('loads the family batch and filters versions for the requested member', async () => {
    mockedFetch.mockResolvedValue({
      data: [
        { id: 'v1', family_member_id: 'member-1', reference_date: '2024-01-01', created_at: '2024-01-01' },
        { id: 'v2', family_member_id: 'member-2', reference_date: '2024-01-01', created_at: '2024-01-01' },
      ] as never,
      error: null,
    });

    const { result } = renderHook(() => usePortraitVersions('member-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockedFetch).toHaveBeenCalledWith('family-1');
    expect(result.current.versions.map((version) => version.id)).toEqual(['v1']);
  });

  it('saves the source/version first and then starts asynchronous generation', async () => {
    mockedFetch.mockResolvedValue({ data: [], error: null });
    mockedCreate.mockResolvedValue({ data: { id: 'v3' } as never, error: null });

    const { result } = renderHook(() => usePortraitVersions('member-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await result.current.createVersion({
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
      referenceDate: '2024-02-03',
      dateSource: 'manual',
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        familyId: 'family-1',
        familyMemberId: 'member-1',
      }),
    );
    await waitFor(() => expect(mockedGenerate).toHaveBeenCalledWith('v3'));
  });

  it('does not invalidate immutable media URLs after a date-only edit', async () => {
    mockedFetch.mockResolvedValue({ data: [], error: null });
    mockedUpdate.mockResolvedValue({ data: { id: 'v1' } as never, error: null });
    const queryClient = createQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => usePortraitVersions('member-1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.editVersionDate({
        portraitVersionId: 'v1',
        referenceDate: '2024-02-03',
      });
    });

    expect(mockedUpdate).toHaveBeenCalledWith('v1', '2024-02-03', { dateOfBirth: undefined });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['media-urls'] });
  });

  it('automatically recovers a stale pending version once for each server attempt', async () => {
    const startedAt = new Date(Date.now() - 3 * 60 * 1000 - 1_000).toISOString();
    let versions = [{
      id: 'pending-1',
      family_member_id: 'member-1',
      illustrated_profile_status: 'pending',
      generation_token: null,
      generation_started_at: null,
      created_at: startedAt,
      updated_at: new Date().toISOString(),
      deletion_token: null,
    }];
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as never);
    mockedFetch.mockImplementation(async () => ({ data: versions as never, error: null }));

    const { result } = renderHook(() => useFamilyPortraitVersions(), { wrapper: createWrapper() });
    await waitFor(() => expect(mockedGenerate).toHaveBeenCalledWith('pending-1'));

    await act(async () => {
      await result.current.refetch();
    });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);

    versions = [{
      ...versions[0],
      illustrated_profile_status: 'generating',
      generation_token: 'attempt-2',
      generation_started_at: new Date(Date.now() - 5.5 * 60 * 1000 - 1_000).toISOString(),
    }];
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(mockedGenerate).toHaveBeenCalledTimes(2));
    expect(mockedGenerate).toHaveBeenLastCalledWith('pending-1');
  });

  it('backs off a failed automatic dispatch before retrying the same recoverable attempt', async () => {
    jest.useFakeTimers();
    const staleCreatedAt = new Date(Date.now() - 3 * 60 * 1000 - 1_000).toISOString();
    mockedFetch.mockResolvedValue({
      data: [{
        id: 'dispatch-error-1',
        family_member_id: 'member-1',
        illustrated_profile_status: 'pending',
        generation_token: null,
        generation_started_at: null,
        created_at: staleCreatedAt,
        updated_at: new Date().toISOString(),
        deletion_token: null,
      }] as never,
      error: null,
    });
    mockedGenerate
      .mockResolvedValueOnce({ data: null, error: { message: 'Temporary dispatch error' } })
      .mockResolvedValue({ data: { success: true, queued: true }, error: null });

    const { unmount } = renderHook(() => useFamilyPortraitVersions(), { wrapper: createWrapper() });
    await waitFor(() => expect(mockedGenerate).toHaveBeenCalledTimes(1));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    await waitFor(() => expect(mockedGenerate).toHaveBeenCalledTimes(2));

    // A successful retry remains suppressed even though it invalidates and
    // refetches the still-stale public row.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedGenerate).toHaveBeenCalledTimes(2);

    unmount();
    jest.useRealTimers();
  });

  it('never auto-recovers failed work or work observed by a viewer, but preserves manager-only manual retry', async () => {
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    mockedFetch.mockResolvedValue({
      data: [{
        id: 'failed-1',
        family_member_id: 'member-1',
        illustrated_profile_status: 'failed',
        generation_token: null,
        generation_started_at: null,
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
        deletion_token: null,
      }] as never,
      error: null,
    });

    const { result, rerender } = renderHook(() => usePortraitVersions('member-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedGenerate).not.toHaveBeenCalled();

    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as never);
    rerender();

    await act(async () => {
      await result.current.retryVersion('failed-1');
    });
    expect(mockedGenerate).toHaveBeenCalledWith('failed-1');
  });

  it('does not submit an explicit regeneration while a fresh server attempt is active', async () => {
    mockedFetch.mockResolvedValue({
      data: [{
        id: 'generating-1',
        family_member_id: 'member-1',
        illustrated_profile_status: 'generating',
        generation_token: 'attempt-1',
        generation_started_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deletion_token: null,
      }] as never,
      error: null,
    });

    const { result } = renderHook(() => usePortraitVersions('member-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.regenerateVersion('generating-1');
    });
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('rechecks pending work on app foreground so a never-dispatched row can recover', async () => {
    let versions = [{
      id: 'foreground-pending-1',
      family_member_id: 'member-1',
      illustrated_profile_status: 'pending',
      generation_token: null,
      generation_started_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deletion_token: null,
    }];
    mockedFetch.mockImplementation(async () => ({ data: versions as never, error: null }));

    const { result, unmount } = renderHook(() => useFamilyPortraitVersions(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedGenerate).not.toHaveBeenCalled();

    versions = [{
      ...versions[0],
      created_at: new Date(Date.now() - 3 * 60 * 1000 - 1_000).toISOString(),
    }];
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => expect(mockedGenerate).toHaveBeenCalledWith('foreground-pending-1'));
    unmount();
    focusManager.setFocused(undefined);
  });
});
