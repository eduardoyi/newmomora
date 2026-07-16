import { supabase } from '@/lib/supabase';
import {
  createContentReport,
  fetchMyBlockedFamilyAccounts,
  fetchMyContentReports,
  setFamilyAccountBlocked,
} from '@/services/content-safety';

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

function builder(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> & { then?: (resolve: (value: unknown) => void) => void } = {};
  for (const method of ['select', 'eq', 'order']) chain[method] = jest.fn(() => chain);
  chain.then = (resolve) => resolve(result);
  return chain;
}

describe('content safety service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads only the narrow reporter-safe RPC projection', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [{ id: 'report-1', family_id: 'family-1', target_type: 'memory', target_id: 'memory-1', target_version_id: null, status: 'open', created_at: 'now' }],
      error: null,
    });

    const result = await fetchMyContentReports('family-1');

    expect(supabase.rpc).toHaveBeenCalledWith('get_my_open_content_reports', { p_family_id: 'family-1' });
    expect(result.data?.[0]).not.toHaveProperty('note');
    expect(result.data?.[0]).not.toHaveProperty('resolved_by');
    expect(result.data?.[0]).not.toHaveProperty('target_user_id');
  });

  it('submits reports only through the validated RPC and trims optional notes', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: 'report-1', error: null });

    await createContentReport({
      targetType: 'comment',
      targetId: 'comment-1',
      reason: 'privacy',
      note: '  context only  ',
    });

    expect(supabase.rpc).toHaveBeenCalledWith('create_content_report', {
      p_target_type: 'comment',
      p_target_id: 'comment-1',
      p_reason: 'privacy',
      p_note: 'context only',
      p_target_version_id: undefined,
    });
  });

  it('sends the selected illustration generation so stale taps fail closed', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: 'report-1', error: null });

    await createContentReport({
      targetType: 'memory_illustration',
      targetId: 'memory-1',
      targetVersionId: 'generation-a',
      reason: 'misleading_ai_depiction',
    });

    expect(supabase.rpc).toHaveBeenCalledWith('create_content_report', expect.objectContaining({
      p_target_version_id: 'generation-a',
    }));
  });

  it('maps duplicate reports to an idempotent client outcome', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'You already reported this item' },
    });

    const result = await createContentReport({
      targetType: 'memory', targetId: 'memory-1', reason: 'privacy',
    });

    expect(result.error?.code).toBe('already_reported');
  });

  it('loads own blocks and uses membership/block ids for mutations', async () => {
    const block = { id: 'block-1', family_id: 'family-1', blocked_user_id: 'user-2' };
    (supabase.from as jest.Mock).mockReturnValue(builder({ data: [block], error: null }));
    expect((await fetchMyBlockedFamilyAccounts('family-1')).data).toEqual([block]);

    (supabase.rpc as jest.Mock).mockResolvedValue({ data: block, error: null });
    await setFamilyAccountBlocked({ shouldBlock: true, membershipId: 'membership-2' });
    expect(supabase.rpc).toHaveBeenLastCalledWith('set_family_account_block', {
      p_should_block: true,
      p_membership_id: 'membership-2',
      p_block_id: undefined,
    });

    await setFamilyAccountBlocked({ shouldBlock: false, blockId: 'block-1' });
    expect(supabase.rpc).toHaveBeenLastCalledWith('set_family_account_block', {
      p_should_block: false,
      p_membership_id: undefined,
      p_block_id: 'block-1',
    });
  });
});
