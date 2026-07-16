import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';
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
    mockedUseFamily.mockReturnValue({ familyId: 'family-1' } as never);
    mockedGenerate.mockResolvedValue({ error: null });
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
});
