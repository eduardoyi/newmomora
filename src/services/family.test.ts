import { removeMember, updateMemberRole } from '@/services/family';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
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
});
