import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { cleanupExports } from '../src/index';
import { ExportArchiveWorkflow } from '../src/workflow';
import type { ExportWorkflowParams } from '../src/types';
import { FakeBucket } from './helpers/fake-bucket';
import { BRIDGE_URL, FakeSupabase, SUPABASE_URL } from './helpers/fake-supabase';
import { readZip } from './helpers/zip-reader';

const ORIGIN = 'https://exports.example';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';

let supabase: FakeSupabase;
let bucket: FakeBucket;
let workflowCreate: ReturnType<typeof vi.fn>;
let env: Env;

function post(token?: string): Request {
  return new Request(`${ORIGIN}/exports`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function fakeStep() {
  return {
    do: async (_name: string, configOrFn: unknown, maybeFn?: () => Promise<unknown>) =>
      await (typeof configOrFn === 'function' ? configOrFn : maybeFn!)(),
    sleep: async () => undefined,
  };
}

async function runWorkflow(params: ExportWorkflowParams): Promise<void> {
  const workflow = new ExportArchiveWorkflow({} as never, env);
  await workflow.run({ payload: params, timestamp: new Date(), instanceId: params.jobId } as never, fakeStep() as never);
}

function seedFamily(): void {
  supabase.users.set('owner-token', { id: OWNER, email: 'owner@example.test' });
  supabase.tables.families.push({ id: 'fam-1', owner_id: OWNER, name: 'Los Yi', illustration_style: 'x', created_at: '2025-01-01T00:00:00Z', deleted_at: null });
  supabase.tables.user_profiles.push({ id: OWNER, name: 'Eduardo', timezone: 'UTC', created_at: '2025-01-01T00:00:00Z' });
  supabase.tables.family_members.push({ id: 'mem-1', family_id: 'fam-1', user_id: null, name: 'Enzo', nicknames: null, date_of_birth: null, gender: null, profile_picture_key: 'o/enzo.jpg', illustrated_profile_key: null, illustrated_profile_status: 'none', additional_info: null, is_user_profile: false, created_at: '2025-01-01T00:00:00Z' });
  supabase.tables.memories.push(
    { id: 'mem-a', family_id: 'fam-1', user_id: OWNER, memory_type: 'media', content: 'Beach day', audio_transcript: null, link_previews: null, memory_date: '2026-07-01', emotion: 'joy', illustration_key: null, illustration_status: 'none', media_key: 'o/beach.jpg', media_content_type: 'image/jpeg', created_at: '2026-07-01T00:00:00Z' },
    { id: 'mem-b', family_id: 'fam-1', user_id: OWNER, memory_type: 'text_only', content: 'First word', audio_transcript: null, link_previews: null, memory_date: '2025-02-01', emotion: null, illustration_key: 'o/gone.webp', illustration_status: 'completed', media_key: null, media_content_type: null, created_at: '2025-02-01T00:00:00Z' },
  );
  supabase.tables.memory_media.push({ id: 'mm-1', memory_id: 'mem-a', object_key: 'o/beach.jpg', content_type: 'image/jpeg', duration_ms: null, position: 0, created_at: '' });
  bucket.seed('o/beach.jpg', 'beach-bytes');
  bucket.seed('o/enzo.jpg', 'enzo-bytes');
  // o/gone.webp is deliberately absent: it must be reported, not fatal.
}

beforeEach(() => {
  supabase = new FakeSupabase();
  bucket = new FakeBucket();
  workflowCreate = vi.fn(async () => ({}));
  env = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    EXPORT_EMAIL_BRIDGE_URL: BRIDGE_URL,
    EXPORT_EMAIL_BRIDGE_SECRET: 'bridge-secret',
    MEDIA: bucket,
    EXPORT_WORKFLOW: { create: workflowCreate },
  } as unknown as Env;
  vi.stubGlobal('fetch', supabase.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /exports', () => {
  it('requires a signed-in user', async () => {
    expect((await worker.fetch(post(), env)).status).toBe(401);
  });

  it('only lets family owners export', async () => {
    supabase.users.set('viewer-token', { id: 'viewer', email: 'v@example.test' });
    const response = await worker.fetch(post('viewer-token'), env);
    expect(response.status).toBe(403);
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it('needs an email address to send the link to', async () => {
    seedFamily();
    supabase.users.set('owner-token', { id: OWNER, email: null });
    expect((await worker.fetch(post('owner-token'), env)).status).toBe(409);
  });

  it('queues a Workflow and tells the app where the link will go', async () => {
    seedFamily();
    const response = await worker.fetch(post('owner-token'), env);
    expect(response.status).toBe(202);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'queued', alreadyRunning: false, email: 'owner@example.test' });
    expect(workflowCreate).toHaveBeenCalledWith({
      id: body.jobId,
      params: { jobId: body.jobId, ownerUserId: OWNER, origin: ORIGIN },
    });
  });

  it('does not start a second build while one is running', async () => {
    seedFamily();
    await worker.fetch(post('owner-token'), env);
    const second = await worker.fetch(post('owner-token'), env);
    expect(await second.json()).toMatchObject({ alreadyRunning: true });
    expect(workflowCreate).toHaveBeenCalledTimes(1);
  });

  it('reports the daily limit', async () => {
    seedFamily();
    supabase.rateLimited = true;
    const response = await worker.fetch(post('owner-token'), env);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'export_rate_limited' });
  });
});

describe('export workflow + download link', () => {
  async function exportAndGetLink(): Promise<{ jobId: string; url: URL }> {
    seedFamily();
    const { jobId } = await (await worker.fetch(post('owner-token'), env)).json() as { jobId: string };
    await runWorkflow({ jobId, ownerUserId: OWNER, origin: ORIGIN });
    const email = supabase.emails[0] as { kind: string; downloadUrl: string };
    expect(email.kind).toBe('ready');
    return { jobId, url: new URL(email.downloadUrl) };
  }

  it('builds per-year archives plus Family & portraits, then emails a working link', async () => {
    const { jobId, url } = await exportAndGetLink();
    const job = supabase.job(jobId);
    expect(job.status).toBe('ready');
    expect(job.email_sent_at).toBeTruthy();
    expect(job.archives.map((archive) => archive.fileName)).toEqual([
      'Momora - Los Yi - Family & portraits.zip',
      'Momora - Los Yi - 2025.zip',
      'Momora - Los Yi - 2026.zip',
    ]);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(`/download/${jobId}`);
    expect(supabase.emails[0]).toMatchObject({ archiveCount: 3, jobId });

    const page = await worker.fetch(new Request(url), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Momora - Los Yi - 2026.zip');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');

    const familyZip = await worker.fetch(new Request(`${ORIGIN}/download/${jobId}/1${url.search}`), env);
    expect(familyZip.headers.get('content-disposition')).toContain("filename*=UTF-8''Momora%20-%20Los%20Yi");
    const entries = readZip(new Uint8Array(await familyZip.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual([
      'Momora - Los Yi/README.txt',
      'Momora - Los Yi/Family/Enzo/profile-photo.jpg',
      'Momora - Los Yi/manifest.json',
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(entries[2].data));
    expect(manifest.missingFiles).toEqual(['Momora - Los Yi/2025/2025-02-01 - First word/illustration.webp']);
    expect(manifest.memories.map((memory: { folder: string }) => memory.folder)).toEqual([
      'Momora - Los Yi/2025/2025-02-01 - First word',
      'Momora - Los Yi/2026/2026-07-01 - Beach day',
    ]);
    expect(new TextDecoder().decode(entries[0].data)).toContain('Momora - Los Yi - 2026.zip');
  });

  it('serves byte ranges so interrupted downloads can resume', async () => {
    const { jobId, url } = await exportAndGetLink();
    const whole = new Uint8Array(await (await worker.fetch(new Request(`${ORIGIN}/download/${jobId}/3${url.search}`), env)).arrayBuffer());
    const ranged = await worker.fetch(new Request(`${ORIGIN}/download/${jobId}/3${url.search}`, { headers: { Range: 'bytes=10-19' } }), env);
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 10-19/${whole.length}`);
    expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([...whole.slice(10, 20)]);
  });

  it('rejects a wrong token and an expired link', async () => {
    const { jobId, url } = await exportAndGetLink();
    const wrong = await worker.fetch(new Request(`${ORIGIN}/download/${jobId}?t=${'0'.repeat(64)}`), env);
    expect(wrong.status).toBe(404);
    supabase.job(jobId).expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await worker.fetch(new Request(url), env)).status).toBe(410);
  });

  it('marks the job failed and emails the owner when the build cannot finish', async () => {
    seedFamily();
    const { jobId } = await (await worker.fetch(post('owner-token'), env)).json() as { jobId: string };
    supabase.failTable = 'memories';
    await expect(runWorkflow({ jobId, ownerUserId: OWNER, origin: ORIGIN })).rejects.toThrow();
    expect(supabase.job(jobId).status).toBe('failed');
    expect(supabase.emails).toEqual([{ kind: 'failed', jobId }]);
  });

  it('cleanup deletes expired archives and retires the link', async () => {
    const { jobId } = await exportAndGetLink();
    expect([...bucket.objects.keys()].some((key) => key.startsWith(`exports/${jobId}/`))).toBe(true);
    supabase.job(jobId).expires_at = new Date(Date.now() - 1000).toISOString();

    expect(await cleanupExports(env)).toBe(1);
    expect([...bucket.objects.keys()].some((key) => key.startsWith(`exports/${jobId}/`))).toBe(false);
    expect(supabase.job(jobId)).toMatchObject({ status: 'expired', download_token_hash: null });
    expect(supabase.job(jobId).files_deleted_at).toBeTruthy();
  });
});
