import { deleteFamily, friendlyFamilyLimitError, removeMember, updateMemberRole } from '@/services/family';
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
