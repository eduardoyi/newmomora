import type { ExportJob } from './types';

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

function restUrl(env: Env, resource: string, query: Record<string, string> = {}): string {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${resource}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

async function supabaseRequest<T>(
  env: Env,
  resource: string,
  options: RequestInit = {},
  query: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(restUrl(env, resource, query), {
    ...options,
    headers: {
      ...JSON_HEADERS,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string; code?: string } | null;
    throw new Error(`supabase_${response.status}:${body?.code ?? ''}:${body?.message ?? ''}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

export async function authenticate(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;

  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
  });
  if (!response.ok) {
    await response.text().catch(() => '');
    return null;
  }
  const user = await response.json() as { id?: unknown; email?: unknown; is_anonymous?: unknown };
  if (typeof user.id !== 'string' || user.is_anonymous === true) return null;
  return { id: user.id, email: typeof user.email === 'string' && user.email ? user.email : null };
}

export async function listRows<T>(env: Env, resource: string, select: string, filters: Record<string, string>): Promise<T[]> {
  const requestedLimit = filters.limit ? Number(filters.limit) : null;
  const pageSize = requestedLimit != null && Number.isFinite(requestedLimit)
    ? Math.min(1000, Math.max(0, requestedLimit))
    : 1000;
  if (pageSize === 0) return [];

  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const page = await supabaseRequest<T[]>(env, resource, {}, {
      select,
      ...filters,
      limit: String(pageSize),
      offset: String(offset),
    });
    rows.push(...page);
    if (page.length < pageSize || (requestedLimit != null && rows.length >= requestedLimit)) break;
    offset += page.length;
    if (rows.length >= 50_000) throw new Error('supabase_result_limit');
  }
  return requestedLimit != null ? rows.slice(0, requestedLimit) : rows;
}

export interface StartedExportJob {
  job_id: string;
  status: ExportJob['status'];
  already_running: boolean;
}

export async function startExportJob(
  env: Env,
  ownerUserId: string,
  familyCount: number,
): Promise<StartedExportJob> {
  const rows = await supabaseRequest<StartedExportJob[]>(env, 'rpc/start_export_job', {
    method: 'POST',
    body: JSON.stringify({ p_owner_user_id: ownerUserId, p_family_count: familyCount }),
  });
  if (!rows[0]) throw new Error('export_job_not_created');
  return rows[0];
}

export async function findExportJob(env: Env, jobId: string): Promise<ExportJob | null> {
  const rows = await listRows<ExportJob>(env, 'export_jobs', '*', { id: `eq.${jobId}`, limit: '1' });
  return rows[0] ?? null;
}

export type ExportJobUpdate = Partial<Pick<ExportJob,
  | 'status'
  | 'expires_at'
  | 'asset_count'
  | 'archives'
  | 'total_bytes'
  | 'download_token_hash'
  | 'started_at'
  | 'completed_at'
  | 'failure_code'
  | 'email_sent_at'
  | 'files_deleted_at'
  | 'last_accessed_at'>>;

/**
 * Patches a job. `onlyIfStatus` makes it a compare-and-set so a late
 * Workflow retry can never resurrect a job the cron already expired.
 * Returns whether a row was updated.
 */
export async function updateExportJob(
  env: Env,
  jobId: string,
  values: ExportJobUpdate,
  onlyIfStatus?: ExportJob['status'][],
): Promise<boolean> {
  const filters: Record<string, string> = { id: `eq.${jobId}` };
  if (onlyIfStatus) filters.status = `in.(${onlyIfStatus.join(',')})`;
  const rows = await supabaseRequest<Array<{ id: string }>>(env, 'export_jobs', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(values),
  }, { ...filters, select: 'id' });
  return rows.length > 0;
}

/** Jobs whose R2 files should be deleted: expired downloads, and failed builds. */
export async function listJobsNeedingCleanup(env: Env, now: Date, limit = 50): Promise<ExportJob[]> {
  return await listRows<ExportJob>(env, 'export_jobs', 'id,status,expires_at', {
    files_deleted_at: 'is.null',
    or: `(and(status.eq.ready,expires_at.lt.${now.toISOString()}),status.eq.failed,status.eq.expired)`,
    order: 'expires_at.asc',
    limit: String(limit),
  });
}
