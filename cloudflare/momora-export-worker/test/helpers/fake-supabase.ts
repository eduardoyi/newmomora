import { expect } from 'vitest';

import type { ExportJob } from '../../src/types';

export const SUPABASE_URL = 'https://example.supabase.co';
export const BRIDGE_URL = 'https://example.supabase.co/functions/v1/send-export-email';

type Row = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Applies the PostgREST filters the Worker uses (eq, in, is.null) to rows. */
function matches(row: Row, params: URLSearchParams): boolean {
  const filters: Array<[string, string]> = [];
  params.forEach((filter, column) => filters.push([column, filter]));
  for (const [column, filter] of filters) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(column)) continue;
    const value = row[column];
    if (filter.startsWith('eq.')) {
      if (String(value) !== filter.slice(3)) return false;
    } else if (filter.startsWith('in.(')) {
      if (!filter.slice(4, -1).split(',').includes(String(value))) return false;
    } else if (filter === 'is.null') {
      if (value !== null && value !== undefined) return false;
    }
  }
  return true;
}

/**
 * Stand-in for the Supabase endpoints the export Worker calls: auth, a few
 * PostgREST tables, start_export_job, and the send-export-email bridge.
 */
export class FakeSupabase {
  users = new Map<string, { id: string; email: string | null }>();
  tables: Record<string, Row[]> = {
    families: [], family_members: [], memories: [], memory_family_members: [], memory_media: [],
    memory_comments: [], family_member_portrait_versions: [], user_profiles: [], export_jobs: [],
  };
  emails: Array<Record<string, unknown>> = [];
  failTable: string | null = null;
  rateLimited = false;

  job(id: string): ExportJob {
    return this.tables.export_jobs.find((row) => row.id === id) as unknown as ExportJob;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);

    if (url.href.startsWith(BRIDGE_URL)) {
      this.emails.push(JSON.parse(String(init.body)));
      expect(headers.get('x-export-signature')).toMatch(/^[0-9a-f]{64}$/);
      return jsonResponse({ success: true });
    }
    if (url.pathname === '/auth/v1/user') {
      const token = headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const user = this.users.get(token);
      return user ? jsonResponse(user) : jsonResponse({ msg: 'bad jwt' }, 401);
    }
    if (url.pathname === '/rest/v1/rpc/start_export_job') {
      if (this.rateLimited) return jsonResponse({ code: 'P0001', message: 'export_rate_limited' }, 400);
      const body = JSON.parse(String(init.body)) as { p_owner_user_id: string };
      const running = this.tables.export_jobs.find((row) => row.owner_user_id === body.p_owner_user_id && ['queued', 'building'].includes(String(row.status)));
      if (running) return jsonResponse([{ job_id: running.id, status: running.status, already_running: true }]);
      const id = crypto.randomUUID();
      this.tables.export_jobs.push({
        id, owner_user_id: body.p_owner_user_id, status: 'queued', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        archives: [], total_bytes: 0, download_token_hash: null, files_deleted_at: null, family_count: 1, asset_count: 0,
      });
      return jsonResponse([{ job_id: id, status: 'queued', already_running: false }]);
    }

    const table = url.pathname.replace('/rest/v1/', '');
    if (table === this.failTable) return jsonResponse({ code: 'XX000', message: 'boom' }, 500);
    const rows = this.tables[table];
    if (!rows) return jsonResponse({ message: `unknown table ${table}` }, 404);

    if (method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as Row;
      const updated = rows.filter((row) => matches(row, url.searchParams));
      for (const row of updated) Object.assign(row, patch);
      return jsonResponse(updated.map((row) => ({ id: row.id })));
    }
    let result = rows.filter((row) => matches(row, url.searchParams));
    const or = url.searchParams.get('or');
    if (or) {
      const cutoff = /expires_at\.lt\.([^)]+)\)/.exec(or)?.[1] ?? '';
      result = result.filter((row) => (row.status === 'ready' && String(row.expires_at) < cutoff) || ['failed', 'expired'].includes(String(row.status)));
    }
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    return jsonResponse(result.slice(offset, offset + limit));
  };
}
