import { supabase } from '@/lib/supabase';
import { shouldOfferWhosWhoAfterJoin } from '@/services/family-relationships';

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn() },
}));

const mockedFrom = supabase.from as jest.Mock;

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
