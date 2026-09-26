import { supabase } from '@/lib/supabase';

export interface ServiceError {
  message: string;
  code?: string;
}

export interface DataExportRequestResult {
  jobId: string;
  /** True when an export was already being prepared -- no new one started. */
  alreadyRunning: boolean;
  /** Where the download link will be sent. */
  email: string | null;
}

interface RequestExportResponse {
  jobId?: unknown;
  alreadyRunning?: unknown;
  email?: unknown;
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

function getExportUrl(): string | null {
  const workerUrl = process.env.EXPO_PUBLIC_EXPORT_WORKER_URL;
  return workerUrl ? workerUrl.replace(/\/$/, '') : null;
}

/**
 * Asks the export Worker to prepare the owner's archive in the background.
 * Nothing is downloaded to the phone: when the archive is ready the Worker
 * emails the owner a 7-day download link (docs/features/data-export.md).
 */
export async function requestDataExport(): Promise<{
  data: DataExportRequestResult | null;
  error: ServiceError | null;
}> {
  const exportUrl = getExportUrl();
  if (!exportUrl) {
    return { data: null, error: { message: 'Memory export is not configured', code: 'not_configured' } };
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) {
    return { data: null, error: { message: sessionError?.message ?? 'You must be signed in to export your memories', code: 'unauthorized' } };
  }

  let response: Response;
  try {
    response = await fetch(`${exportUrl}/exports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { data: null, error: { message: 'Could not start the export. Check your connection and try again.', code: 'network_error' } };
  }

  if (!response.ok) {
    return { data: null, error: await readError(response, 'Could not start the export') };
  }

  let body: RequestExportResponse;
  try {
    body = await response.json() as RequestExportResponse;
  } catch {
    body = {};
  }
  if (typeof body.jobId !== 'string') {
    return { data: null, error: { message: 'The export service returned an invalid response', code: 'invalid_response' } };
  }
  return {
    data: {
      jobId: body.jobId,
      alreadyRunning: body.alreadyRunning === true,
      email: typeof body.email === 'string' ? body.email : null,
    },
    error: null,
  };
}
