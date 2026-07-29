jest.mock('@react-native-async-storage/async-storage', () => ({}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { usageLimitMessage, parseUsageLimitNotice } = require('./usage-limits') as typeof import('./usage-limits');

describe('usage-limit client copy', () => {
  it('keeps the capture-first promise and does not expose credits or counts', () => {
    const message = usageLimitMessage('memory', '2026-07-28T00:00:00.000Z');
    expect(message).toContain('memory is safely saved');
    expect(message).not.toMatch(/credit|remaining|quota/i);
  });
  it('parses the real RPC snake_case portrait row and rejects malformed rows', () => {
    expect(parseUsageLimitNotice({ id: 'n', family_id: 'f', target_kind: 'portrait_version', target_id: 'p', scope: 'daily', retry_after: '2026-07-28T00:00:00.000Z', quota_policy_epoch: 2 })).toMatchObject({ target_kind: 'portrait_version' });
    expect(parseUsageLimitNotice({ target_kind: 'portrait' })).toBeNull();
    expect(usageLimitMessage('portrait_version', 'bad')).toContain('portrait update');
  });
});
