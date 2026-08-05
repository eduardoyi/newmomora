import {
  deleteFamily,
  fetchMyFamilyMemberships,
  friendlyFamilyLimitError,
  removeMember,
  updateFamilyViewerSharing,
  updateMemberRole,
} from '@/services/family';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
    rpc: jest.fn(),
  },
}));

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;

describe('family service member management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('updateMemberRole', () => {
    it('updates the role scoped to family_id + user_id and returns the affected row', async () => {
      const select = jest.fn().mockResolvedValue({
        data: [{ id: 'membership-2', role: 'manager' }],
        error: null,
      });
      const eqUser = jest.fn().mockReturnValue({ select });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqUser });
      const update = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ update } as never);

      const result = await updateMemberRole('family-1', 'user-2', 'manager');

      expect(mockedSupabase.from).toHaveBeenCalledWith('family_memberships');
      expect(update).toHaveBeenCalledWith({ role: 'manager' });
      expect(eqFamily).toHaveBeenCalledWith('family_id', 'family-1');
      expect(eqUser).toHaveBeenCalledWith('user_id', 'user-2');
      expect(select).toHaveBeenCalledWith('id, role');
      expect(result).toEqual({ data: [{ id: 'membership-2', role: 'manager' }], error: null });
    });

    it('returns an empty array (not an error) when no row matched -- already changed elsewhere', async () => {
      const select = jest.fn().mockResolvedValue({ data: [], error: null });
      const eqUser = jest.fn().mockReturnValue({ select });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqUser });
      const update = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ update } as never);

      const result = await updateMemberRole('family-1', 'user-2', 'viewer');

      expect(result).toEqual({ data: [], error: null });
    });

    it('maps a supabase error (e.g. RLS denial for a non-manager caller)', async () => {
      const select = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'permission denied', code: '42501' },
      });
      const eqUser = jest.fn().mockReturnValue({ select });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqUser });
      const update = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ update } as never);

      const result = await updateMemberRole('family-1', 'user-2', 'manager');

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: 'permission denied', code: '42501' });
    });
  });

  describe('removeMember', () => {
    it('deletes the membership scoped to family_id + user_id and returns the affected row', async () => {
      const select = jest.fn().mockResolvedValue({ data: [{ id: 'membership-2' }], error: null });
      const eqUser = jest.fn().mockReturnValue({ select });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqUser });
      const del = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ delete: del } as never);

      const result = await removeMember('family-1', 'user-2');

      expect(mockedSupabase.from).toHaveBeenCalledWith('family_memberships');
      expect(del).toHaveBeenCalled();
      expect(eqFamily).toHaveBeenCalledWith('family_id', 'family-1');
      expect(eqUser).toHaveBeenCalledWith('user_id', 'user-2');
      expect(select).toHaveBeenCalledWith('id');
      expect(result).toEqual({ data: [{ id: 'membership-2' }], error: null });
    });

    it('returns an empty array (not an error) when no row matched -- already removed elsewhere', async () => {
      const select = jest.fn().mockResolvedValue({ data: [], error: null });
      const eqUser = jest.fn().mockReturnValue({ select });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqUser });
      const del = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ delete: del } as never);

      const result = await removeMember('family-1', 'user-2');

      expect(result).toEqual({ data: [], error: null });
    });

    it('maps a supabase error', async () => {
      const select = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'permission denied', code: '42501' },
      });
      const eqUser = jest.fn().mockReturnValue({ select });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqUser });
      const del = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ delete: del } as never);

      const result = await removeMember('family-1', 'user-2');

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: 'permission denied', code: '42501' });
    });
  });

  describe('fetchMyFamilyMemberships', () => {
    it('selects viewer_sharing_enabled alongside the other family fields', async () => {
      const order = jest.fn().mockResolvedValue({
        data: [
          {
            id: 'membership-1',
            family_id: 'family-1',
            role: 'owner',
            family: {
              id: 'family-1',
              name: "Rosa's family",
              illustration_style: 'default',
              deleted_at: null,
              viewer_sharing_enabled: false,
            },
          },
        ],
        error: null,
      });
      const eq = jest.fn().mockReturnValue({ order });
      const select = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ select } as never);

      const result = await fetchMyFamilyMemberships('user-1');

      expect(mockedSupabase.from).toHaveBeenCalledWith('family_memberships');
      expect(select).toHaveBeenCalledWith(
        expect.stringContaining('viewer_sharing_enabled'),
      );
      expect(eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(result.data?.[0].family?.viewer_sharing_enabled).toBe(false);
    });
  });

  describe('updateFamilyViewerSharing', () => {
    it('updates the column scoped to family id and returns the updated row', async () => {
      const updatedFamily = {
        id: 'family-1',
        owner_id: 'user-0',
        name: "Rosa's family",
        illustration_style: 'default',
        deleted_at: null,
        viewer_sharing_enabled: false,
        created_at: '2026-05-28T00:00:00Z',
        updated_at: '2026-08-05T00:00:00Z',
      };
      const maybeSingle = jest.fn().mockResolvedValue({ data: updatedFamily, error: null });
      const select = jest.fn().mockReturnValue({ maybeSingle });
      const eq = jest.fn().mockReturnValue({ select });
      const update = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ update } as never);

      const result = await updateFamilyViewerSharing('family-1', false);

      expect(mockedSupabase.from).toHaveBeenCalledWith('families');
      expect(update).toHaveBeenCalledWith({ viewer_sharing_enabled: false });
      expect(eq).toHaveBeenCalledWith('id', 'family-1');
      expect(result).toEqual({ data: updatedFamily, error: null });
    });

    it('returns null data (not an error) when RLS/billing-lockout matches zero rows', async () => {
      const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
      const select = jest.fn().mockReturnValue({ maybeSingle });
      const eq = jest.fn().mockReturnValue({ select });
      const update = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ update } as never);

      const result = await updateFamilyViewerSharing('family-1', false);

      expect(result).toEqual({ data: null, error: null });
    });

    it('maps a supabase error', async () => {
      const maybeSingle = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'permission denied', code: '42501' },
      });
      const select = jest.fn().mockReturnValue({ maybeSingle });
      const eq = jest.fn().mockReturnValue({ select });
      const update = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ update } as never);

      const result = await updateFamilyViewerSharing('family-1', true);

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: 'permission denied', code: '42501' });
    });
  });

  describe('deleteFamily', () => {
    it('calls the delete_family RPC with the family id and returns the soft-deleted row', async () => {
      const softDeletedFamily = {
        id: 'family-1',
        owner_id: 'user-1',
        name: 'The Rivera family',
        illustration_style: 'default',
        deleted_at: '2026-07-20T00:00:00Z',
        created_at: '2026-05-28T00:00:00Z',
        updated_at: '2026-07-20T00:00:00Z',
      };
      mockedSupabase.rpc.mockResolvedValue({ data: softDeletedFamily, error: null } as never);

      const result = await deleteFamily('family-1');

      expect(mockedSupabase.rpc).toHaveBeenCalledWith('delete_family', { fam: 'family-1' });
      expect(result).toEqual({ data: softDeletedFamily, error: null });
    });

    it('maps a supabase error (e.g. a non-owner caller rejected by the RPC)', async () => {
      mockedSupabase.rpc.mockResolvedValue({
        data: null,
        error: { message: 'Only the family owner can delete this family', code: '42501' },
      } as never);

      const result = await deleteFamily('family-1');

      expect(result.data).toBeNull();
      expect(result.error).toEqual({
        message: 'Only the family owner can delete this family',
        code: '42501',
      });
    });
  });

  describe('friendlyFamilyLimitError', () => {
    it('rewrites the 5-owned-families cap error into parent-facing copy', () => {
      const message = friendlyFamilyLimitError('Maximum 5 owned families', 'P0001');

      expect(message).toBe("You've reached the limit of 5 family journals for one account.");
    });

    it('passes through unrelated errors unchanged', () => {
      const message = friendlyFamilyLimitError('Family name is required', '22023');

      expect(message).toBe('Family name is required');
    });

    it('passes through the same message text under a different error code', () => {
      const message = friendlyFamilyLimitError('Maximum 5 owned families', '42501');

      expect(message).toBe('Maximum 5 owned families');
    });
  });
});
