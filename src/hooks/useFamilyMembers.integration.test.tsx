import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useAuth } from '@/hooks/use-auth';
import { useUserProfile } from '@/hooks/useUserProfile';
import {
  fetchFamilyMembers,
  createFamilyMemberWithPhoto,
  updateFamilyMemberWithPhoto,
} from '@/services/family-members';
import { generatePortraitIllustration } from '@/services/ai';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: jest.fn(),
}));

jest.mock('@/services/family-members', () => ({
  fetchFamilyMembers: jest.fn(),
  createFamilyMemberWithPhoto: jest.fn(),
  updateFamilyMemberWithPhoto: jest.fn(),
  deleteFamilyMember: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  generatePortraitIllustration: jest.fn().mockResolvedValue({ error: null }),
}));

const mockedFetchFamilyMembers = fetchFamilyMembers as jest.MockedFunction<
  typeof fetchFamilyMembers
>;
const mockedCreateFamilyMemberWithPhoto = createFamilyMemberWithPhoto as jest.MockedFunction<
  typeof createFamilyMemberWithPhoto
>;
const mockedUpdateFamilyMemberWithPhoto = updateFamilyMemberWithPhoto as jest.MockedFunction<
  typeof updateFamilyMemberWithPhoto
>;
const mockedGeneratePortraitIllustration = generatePortraitIllustration as jest.MockedFunction<
  typeof generatePortraitIllustration
>;
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useFamilyMembers integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseAuth.mockReturnValue({
      session: { user: { id: 'user-1' } } as never,
      user: { id: 'user-1' } as never,
      isLoading: false,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
      resetPassword: jest.fn(),
    });

    mockedUseUserProfile.mockReturnValue({
      profile: { active_family_id: 'family-1' } as never,
    } as never);
  });

  it('loads family members for the signed-in user', async () => {
    mockedFetchFamilyMembers.mockResolvedValue({
      data: [
        {
          id: 'member-1',
          name: 'Maya',
        } as never,
      ],
      error: null,
    });

    const { result } = renderHook(() => useFamilyMembers(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.members).toHaveLength(1);
    expect(result.current.hasMembers).toBe(true);
  });

  it('creates a member and refreshes the list', async () => {
    mockedFetchFamilyMembers.mockResolvedValue({ data: [], error: null });
    mockedCreateFamilyMemberWithPhoto.mockResolvedValue({
      data: {
        id: 'member-1',
        name: 'Maya',
      } as never,
      error: null,
    });

    const { result } = renderHook(() => useFamilyMembers(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.createMember({
      name: 'Maya',
      dateOfBirth: '2020-05-24',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
    });

    expect(mockedCreateFamilyMemberWithPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        name: 'Maya',
      }),
    );
  });

  it('updates a member without triggering portrait generation by default', async () => {
    mockedFetchFamilyMembers.mockResolvedValue({ data: [], error: null });
    mockedUpdateFamilyMemberWithPhoto.mockResolvedValue({
      data: { id: 'member-1', name: 'Maya' } as never,
      error: null,
    });

    const { result } = renderHook(() => useFamilyMembers(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.updateMember({
      memberId: 'member-1',
      name: 'Maya',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
      regeneratePortrait: false,
    });

    expect(mockedUpdateFamilyMemberWithPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ regeneratePortrait: false }),
    );
    expect(mockedGeneratePortraitIllustration).not.toHaveBeenCalled();
  });

  it('triggers portrait generation when regeneratePortrait is true', async () => {
    mockedFetchFamilyMembers.mockResolvedValue({ data: [], error: null });
    mockedUpdateFamilyMemberWithPhoto.mockResolvedValue({
      data: { id: 'member-1', name: 'Maya' } as never,
      error: null,
    });

    const { result } = renderHook(() => useFamilyMembers(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await result.current.updateMember({
      memberId: 'member-1',
      photoUri: 'file:///photo.jpg',
      photoContentType: 'image/jpeg',
      regeneratePortrait: true,
    });

    expect(mockedGeneratePortraitIllustration).toHaveBeenCalledWith('member-1');
  });
});
