import { supabase } from '@/lib/supabase';
import { createFamilyInvite } from '@/services/invites';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('@/services/ai', () => ({ invokeEdgeFunction: jest.fn() }));

const mockedRpc = supabase.rpc as unknown as jest.Mock;

describe('createFamilyInvite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRpc.mockResolvedValue({ data: { id: 'invite-1' }, error: null });
  });

  it('sends only fam + invite_role when no options are set (old two-arg shape)', async () => {
    await createFamilyInvite('family-1', 'viewer');
    await createFamilyInvite('family-1', 'viewer', { inviteeName: '', inviteeMemberId: undefined });

    expect(mockedRpc).toHaveBeenNthCalledWith(1, 'create_family_invite', { fam: 'family-1', invite_role: 'viewer' });
    expect(mockedRpc).toHaveBeenNthCalledWith(2, 'create_family_invite', { fam: 'family-1', invite_role: 'viewer' });
  });

  it('passes p_invitee_name and p_invitee_member_id when set', async () => {
    await createFamilyInvite('family-1', 'manager', { inviteeName: 'Grandma Ana', inviteeMemberId: 'm-ana' });

    expect(mockedRpc).toHaveBeenCalledWith('create_family_invite', {
      fam: 'family-1',
      invite_role: 'manager',
      p_invitee_name: 'Grandma Ana',
      p_invitee_member_id: 'm-ana',
    });
  });

  it('keeps only message and code from an RPC error', async () => {
    mockedRpc.mockResolvedValue({
      data: null,
      error: { message: 'member_already_linked', code: '23505', hint: 'ignored', details: 'ignored' },
    });

    const result = await createFamilyInvite('family-1', 'viewer', { inviteeMemberId: 'm-ana' });

    expect(result).toEqual({ data: null, error: { message: 'member_already_linked', code: '23505' } });
  });
});
