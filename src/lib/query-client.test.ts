import { queryClient } from '@/lib/query-client';

describe('queryClient', () => {
  it('pins mutations to networkMode "always" (load-bearing once onlineManager is wired -- see the comment in query-client.ts)', () => {
    expect(queryClient.getDefaultOptions().mutations?.networkMode).toBe('always');
  });

  it('leaves queries on the default "online" networkMode (pausing queries offline is intended)', () => {
    expect(queryClient.getDefaultOptions().queries?.networkMode).toBeUndefined();
  });
});
