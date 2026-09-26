import { requestDataExport } from './export';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
  },
}));

const mockedSupabase = jest.requireMock('@/lib/supabase').supabase as {
  auth: { getSession: jest.Mock };
};

function response(body: unknown, ok = true, status = ok ? 202 : 500): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('requestDataExport', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_EXPORT_WORKER_URL = 'https://exports.example/';
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'token-1' } }, error: null });
  });

  it('queues the export with the owner JWT and returns where the link will be emailed', async () => {
    fetchMock.mockResolvedValue(response({ jobId: 'job-1', status: 'queued', alreadyRunning: false, email: 'rosa@example.test' }));

    const result = await requestDataExport();

    expect(fetchMock).toHaveBeenCalledWith('https://exports.example/exports', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(result).toEqual({
      data: { jobId: 'job-1', alreadyRunning: false, email: 'rosa@example.test' },
      error: null,
    });
  });

  it('reports an export that is already being prepared', async () => {
    fetchMock.mockResolvedValue(response({ jobId: 'job-1', alreadyRunning: true, email: 'rosa@example.test' }));

    const result = await requestDataExport();

    expect(result.data?.alreadyRunning).toBe(true);
  });

  it('passes the Worker error message through (e.g. the daily limit)', async () => {
    fetchMock.mockResolvedValue(response({ error: 'Please try again tomorrow.', code: 'export_rate_limited' }, false, 429));

    const result = await requestDataExport();

    expect(result).toEqual({ data: null, error: { message: 'Please try again tomorrow.', code: 'export_rate_limited' } });
  });

  it('requires a session', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const result = await requestDataExport();

    expect(result.error?.code).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports network failures', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    const result = await requestDataExport();

    expect(result.error?.code).toBe('network_error');
  });

  it('rejects a response without a job id', async () => {
    fetchMock.mockResolvedValue(response({ status: 'queued' }));

    const result = await requestDataExport();

    expect(result.error?.code).toBe('invalid_response');
  });

  it('fails cleanly when the Worker URL is not configured', async () => {
    delete process.env.EXPO_PUBLIC_EXPORT_WORKER_URL;

    const result = await requestDataExport();

    expect(result.error?.code).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
