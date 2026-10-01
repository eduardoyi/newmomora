import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import { familyMembershipLinksQueryKey } from '@/hooks/queryKeys';
import { fetchMembershipLinks, linkFamilyMemberAccount } from '@/services/family-relationships';

jest.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-me' } }) }));
jest.mock('@/hooks/use-family', () => ({ useFamily: () => ({ familyId: 'fam-1', role: 'manager' }) }));
jest.mock('@/services/family-relationships', () => ({
  fetchMembershipLinks: jest.fn(),
  fetchPendingSuggestions: jest.fn().mockResolvedValue({ data: [], error: null }),
  linkFamilyMemberAccount: jest.fn(),
  requestRelationshipSuggestions: jest.fn(),
  resolveSuggestions: jest.fn(),
  setMyFamilyMember: jest.fn(),
  unlinkFamilyMemberAccount: jest.fn(),
}));

const mockedFetchLinks = fetchMembershipLinks as jest.Mock;
const mockedLink = linkFamilyMemberAccount as jest.Mock;

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useFamilyRelationships -- linkAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchLinks.mockResolvedValue({ data: [], error: null });
  });

  it('links another account to a person and refreshes the links', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    mockedLink.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useFamilyRelationships([]), { wrapper: wrapper(queryClient) });

    await act(async () => {
      await result.current.linkAccount({ userId: 'user-3', memberId: 'person-1' });
    });

    expect(mockedLink).toHaveBeenCalledWith('fam-1', 'user-3', 'person-1');
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify([familyMembershipLinksQueryKey('fam-1')[0]]));
  });

  it('throws the service error and still refreshes the links', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    mockedLink.mockResolvedValue({ error: { message: 'member_already_linked', code: '23505' } });
    const { result } = renderHook(() => useFamilyRelationships([]), { wrapper: wrapper(queryClient) });

    await act(async () => {
      await expect(result.current.linkAccount({ userId: 'user-3', memberId: 'person-1' })).rejects.toEqual({
        message: 'member_already_linked',
        code: '23505',
      });
    });

    expect(invalidate).toHaveBeenCalled();
  });
});
