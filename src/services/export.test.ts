import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { createAndShareDataExport } from './export';

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  downloadAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
  },
}));

const mockedSharing = Sharing as jest.Mocked<typeof Sharing>;
const mockedFileSystem = FileSystem as jest.Mocked<typeof FileSystem>;
const mockedSupabase = jest.requireMock('@/lib/supabase').supabase as {
  auth: { getSession: jest.Mock };
};

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('createAndShareDataExport', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_EXPORT_WORKER_URL = 'https://exports.example';
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedSharing.isAvailableAsync.mockResolvedValue(true);
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'token-1' } }, error: null });
    mockedFileSystem.downloadAsync.mockResolvedValue({ uri: 'file:///cache/momora-export-job-1.zip' } as never);
    mockedSharing.shareAsync.mockResolvedValue(undefined);
  });

  it('rejects cleanly when native sharing is unavailable', async () => {
    mockedSharing.isAvailableAsync.mockResolvedValue(false);

    const result = await createAndShareDataExport();

    expect(result).toEqual({
      data: null,
      error: { message: 'Sharing is not available on this device', code: 'sharing_unavailable' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an authenticated Supabase session', async () => {
    mockedSupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const result = await createAndShareDataExport();

    expect(result.error?.code).toBe('unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates, downloads, and shares the owner archive with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(response({
      jobId: 'job-1',
      downloadUrl: 'https://exports.example/exports/job-1',
      expiresAt: '2026-08-01T13:00:00.000Z',
    }, true, 201));

    const result = await createAndShareDataExport();

    expect(fetchMock).toHaveBeenCalledWith('https://exports.example/exports', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(mockedFileSystem.downloadAsync).toHaveBeenCalledWith(
      'https://exports.example/exports/job-1',
      'file:///cache/momora-export-job-1.zip',
      { headers: { Authorization: 'Bearer token-1' } },
    );
    expect(mockedSharing.shareAsync).toHaveBeenCalledWith('file:///cache/momora-export-job-1.zip', {
      dialogTitle: 'Share your Momora archive',
      mimeType: 'application/zip',
      UTI: 'com.pkware.zip-archive',
    });
    expect(result).toEqual({
    data: {
      shared: true,
      expiresAt: '2026-08-01T13:00:00.000Z',
      },
      error: null,
    });
  });

  it('surfaces worker errors without downloading an archive', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'Too many active exports', code: 'export_rate_limited' }, false, 429));

    const result = await createAndShareDataExport();

    expect(result).toEqual({
      data: null,
      error: { message: 'Too many active exports', code: 'export_rate_limited' },
    });
    expect(mockedFileSystem.downloadAsync).not.toHaveBeenCalled();
    expect(mockedSharing.shareAsync).not.toHaveBeenCalled();
  });
});
