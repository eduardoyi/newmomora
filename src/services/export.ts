import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { supabase } from '@/lib/supabase';

export interface ServiceError {
  message: string;
  code?: string;
}

export interface DataExportResult {
  shared: boolean;
  expiresAt: string;
}

interface CreateExportResponse {
  jobId: string;
  downloadUrl: string;
  expiresAt: string;
}

async function readError(response: Response, fallback: string): Promise<ServiceError> {
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    return {
      message: typeof body.error === 'string' ? body.error : fallback,
      code: typeof body.code === 'string' ? body.code : String(response.status),
    };
  } catch {
    return { message: fallback, code: String(response.status) };
  }
}

function getExportUrl(): string {
  const workerUrl = process.env.EXPO_PUBLIC_EXPORT_WORKER_URL;
  if (!workerUrl) throw new Error('Memory export is not configured');
  return workerUrl.replace(/\/$/, '');
}

/** Starts an owner-only streamed ZIP export and opens the native share sheet. */
export async function createAndShareDataExport(): Promise<{
  data: DataExportResult | null;
  error: ServiceError | null;
}> {
  if (!(await Sharing.isAvailableAsync())) {
    return { data: null, error: { message: 'Sharing is not available on this device', code: 'sharing_unavailable' } };
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) {
    return { data: null, error: { message: sessionError?.message ?? 'You must be signed in to export your memories', code: 'unauthorized' } };
  }

  let response: Response;
  try {
    response = await fetch(`${getExportUrl()}/exports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { data: null, error: { message: 'Could not start the export. Check your connection and try again.', code: 'network_error' } };
  }

  if (!response.ok) {
    return { data: null, error: await readError(response, 'Could not start the export') };
  }

  const created = await response.json() as Partial<CreateExportResponse>;
  if (!created.downloadUrl || !created.jobId || !created.expiresAt) {
    return { data: null, error: { message: 'The export service returned an invalid response', code: 'invalid_response' } };
  }

  const targetUri = `${FileSystem.cacheDirectory ?? ''}momora-export-${created.jobId}.zip`;
  let downloadedUri: string | null = null;
  try {
    const download = await FileSystem.downloadAsync(created.downloadUrl, targetUri, {
      headers: { Authorization: `Bearer ${token}` },
    });
    downloadedUri = download.uri;
    await Sharing.shareAsync(download.uri, {
      dialogTitle: 'Share your Momora archive',
      mimeType: 'application/zip',
      UTI: 'com.pkware.zip-archive',
    });
    return {
      data: { shared: true, expiresAt: created.expiresAt },
      error: null,
    };
  } catch {
    return { data: null, error: { message: 'Could not download or share your archive. Please try again.', code: 'export_download_failed' } };
  } finally {
    if (downloadedUri) {
      await Promise.resolve(FileSystem.deleteAsync(downloadedUri, { idempotent: true })).catch(() => undefined);
    }
  }
}
