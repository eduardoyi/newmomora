import { supabase } from '@/lib/supabase';
import { createFamilyMember } from '@/services/family-members';
import {
  ensureOwnerFamilyPerson,
  isAlreadyLinkedError,
  isLinkRejectedError,
  linkAccountErrorAlert,
  linkFamilyMemberAccount,
  shouldOfferWhosWhoAfterJoin,
} from '@/services/family-relationships';

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn(), auth: { getUser: jest.fn() } },
}));

jest.mock('@/services/family-members', () => ({
  createFamilyMember: jest.fn(),
}));

const mockedFrom = supabase.from as jest.Mock;
const mockedRpc = supabase.rpc as jest.Mock;

type Result = { data: unknown; error: unknown };

// fetchMembershipLinks reads family_memberships; familyHasLinkableMember reads family_members.
function mockTables({ links, members }: { links: Result; members: Result }) {
  mockedFrom.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => Promise.resolve(table === 'family_memberships' ? links : members),
    }),
  }));
}

const adult = { id: 'p1', name: 'Ana', relationship: 'grandparent', date_of_birth: null };
const child = { id: 'p2', name: 'Kid', relationship: 'child', date_of_birth: null };

describe('shouldOfferWhosWhoAfterJoin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns false when the account is already linked to a person', async () => {
    mockTables({
      links: {
        data: [{ user_id: 'u1', family_member_id: 'p1', not_in_list: false }],
        error: null,
      },
      members: { data: [adult], error: null },
    });

    expect(await shouldOfferWhosWhoAfterJoin('fam', 'u1')).toBe(false);
  });

  it('offers it when the account is unlinked and someone is linkable', async () => {
    mockTables({
      links: {
        data: [
          { user_id: 'u1', family_member_id: null, not_in_list: false },
          { user_id: 'u2', family_member_id: 'p1', not_in_list: false },
        ],
        error: null,
      },
      members: { data: [adult], error: null },
    });

    expect(await shouldOfferWhosWhoAfterJoin('fam', 'u1')).toBe(true);
  });

  it('does not offer it when nobody is linkable', async () => {
    mockTables({
      links: { data: [{ user_id: 'u1', family_member_id: null, not_in_list: false }], error: null },
      members: { data: [child], error: null },
    });

    expect(await shouldOfferWhosWhoAfterJoin('fam', 'u1')).toBe(false);
  });

  it('falls back to the linkable check when the links read fails', async () => {
    mockTables({
      links: { data: null, error: { message: 'boom' } },
      members: { data: [adult], error: null },
    });

    expect(await shouldOfferWhosWhoAfterJoin('fam', 'u1')).toBe(true);
  });

  it('falls back to the linkable check when there is no user id', async () => {
    mockTables({
      links: { data: [], error: null },
      members: { data: [adult], error: null },
    });

    expect(await shouldOfferWhosWhoAfterJoin('fam', undefined)).toBe(true);
  });
});

describe('linkFamilyMemberAccount', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls link_family_member_account with the family, account and person', async () => {
    mockedRpc.mockResolvedValue({ error: null });

    const result = await linkFamilyMemberAccount('fam-1', 'user-1', 'person-1');

    expect(mockedRpc).toHaveBeenCalledWith('link_family_member_account', {
      p_family_id: 'fam-1',
      p_user_id: 'user-1',
      p_member_id: 'person-1',
    });
    expect(result).toEqual({ error: null });
  });

  it('maps a server error to message + code', async () => {
    mockedRpc.mockResolvedValue({ error: { message: 'member_already_linked', code: '23505', hint: 'x' } });

    const result = await linkFamilyMemberAccount('fam-1', 'user-1', 'person-1');

    expect(result.error).toEqual({ message: 'member_already_linked', code: '23505' });
    expect(isAlreadyLinkedError(result.error)).toBe(true);
  });
});

describe('manager link error mapping', () => {
  it('recognises the rejection tokens by message', () => {
    expect(isLinkRejectedError({ message: 'member_not_linkable', code: '22023' })).toBe(true);
    expect(isLinkRejectedError({ message: 'member_not_in_family' })).toBe(true);
    expect(isLinkRejectedError({ message: 'account_not_in_family' })).toBe(true);
    expect(isLinkRejectedError({ message: 'Not authorized', code: '42501' })).toBe(false);
    expect(isLinkRejectedError(null)).toBe(false);
  });

  it('picks the alert copy per token', () => {
    expect(linkAccountErrorAlert({ message: 'member_already_linked', code: '23505' }).message).toBe(
      'Someone else already says this is them. Unlink them on that person’s page first.',
    );
    expect(linkAccountErrorAlert({ message: 'account_not_in_family' }).message).toBe(
      'That didn’t work. The list has been refreshed.',
    );
    expect(linkAccountErrorAlert(new Error('boom')).message).toBe('Please try again.');
  });
});

describe('ensureOwnerFamilyPerson', () => {
  const mockedGetUser = supabase.auth.getUser as jest.Mock;
  const mockedCreate = createFamilyMember as jest.MockedFunction<typeof createFamilyMember>;

  function mockOwner({ name = 'Eduardo', link }: { name?: string | null; link: Record<string, unknown> | null }) {
    mockedGetUser.mockResolvedValue({ data: { user: { id: 'user-1', is_anonymous: false } } });
    mockedFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name }, error: null }) }) }),
        };
      }
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: link ? [{ user_id: 'user-1', family_member_id: null, not_in_list: false, ...link }] : [],
              error: null,
            }),
        }),
      };
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRpc.mockResolvedValue({ error: null });
    mockedCreate.mockResolvedValue({ data: { id: 'person-owner' } as never, error: null });
  });

  it("creates the owner's parent person from their account name and links it as \"this is me\"", async () => {
    mockOwner({ link: {} });

    const result = await ensureOwnerFamilyPerson('family-1');

    expect(mockedCreate).toHaveBeenCalledWith({
      userId: 'user-1',
      familyId: 'family-1',
      name: 'Eduardo',
      dateOfBirth: null,
      relationship: 'parent',
    });
    expect(mockedRpc).toHaveBeenCalledWith('set_my_family_member', {
      p_family_id: 'family-1',
      p_member_id: 'person-owner',
      p_not_in_list: false,
    });
    expect(result).toEqual({ memberId: 'person-owner', skipped: null });
  });

  it('leaves an account that is already linked, or chose "not in the list", alone', async () => {
    mockOwner({ link: { family_member_id: 'person-existing' } });
    expect((await ensureOwnerFamilyPerson('family-1')).skipped).toBe('already_set');

    mockOwner({ link: { not_in_list: true } });
    expect((await ensureOwnerFamilyPerson('family-1')).skipped).toBe('already_set');

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('does nothing without a profile name', async () => {
    mockOwner({ name: '  ', link: {} });

    expect((await ensureOwnerFamilyPerson('family-1')).skipped).toBe('no_name');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('swallows a failed insert instead of throwing (never blocks onboarding)', async () => {
    mockOwner({ link: {} });
    mockedCreate.mockResolvedValue({ data: null, error: { message: 'denied' } });

    await expect(ensureOwnerFamilyPerson('family-1')).resolves.toEqual({ memberId: null, skipped: 'create_failed' });
    expect(mockedRpc).not.toHaveBeenCalled();
  });
});
