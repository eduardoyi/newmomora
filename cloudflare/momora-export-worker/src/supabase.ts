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

export async function authenticate(request: Request, env: Env): Promise<string | null> {
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
  const user = await response.json() as { id?: unknown };
  return typeof user.id === 'string' ? user.id : null;
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

export async function createExportJob(
  env: Env,
  ownerUserId: string,
  familyCount: number,
): Promise<ExportJob> {
  const rows = await supabaseRequest<ExportJob[]>(env, 'rpc/create_export_job', {
    method: 'POST',
    body: JSON.stringify({ p_owner_user_id: ownerUserId, p_family_count: familyCount, p_max_active: 3 }),
  });
  if (!rows[0]) throw new Error('export_job_not_created');
  return rows[0];
}

export async function findExportJob(env: Env, jobId: string): Promise<ExportJob | null> {
  const rows = await listRows<ExportJob>(env, 'export_jobs', '*', { id: `eq.${jobId}`, limit: '1' });
  return rows[0] ?? null;
}

export async function updateExportJob(
  env: Env,
  jobId: string,
  values: Partial<Pick<ExportJob, 'status' | 'asset_count' | 'last_accessed_at'>>,
): Promise<void> {
  await supabaseRequest(env, 'export_jobs', {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(values),
  }, { id: `eq.${jobId}` });
}
