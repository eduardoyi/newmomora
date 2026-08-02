import { buildExportSnapshot, assetEntryName } from './manifest';
import { authenticate, createExportJob, findExportJob, listRows, updateExportJob } from './supabase';
import { createStreamingZip, zipJson, type StreamZipEntry } from './zip';
import type { ExportFamily } from './types';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function unauthorized(): Response {
  return json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
}

async function listOwnedFamilies(env: Env, ownerUserId: string): Promise<ExportFamily[]> {
  return await listRows<ExportFamily>(env, 'families', 'id,owner_id,name,illustration_style,created_at', {
    owner_id: `eq.${ownerUserId}`,
    deleted_at: 'is.null',
    limit: '100',
  });
}

async function createExport(request: Request, env: Env, ownerUserId: string): Promise<Response> {
  const families = await listOwnedFamilies(env, ownerUserId);
  if (families.length === 0) {
    return json({ error: 'Only family owners can export an archive', code: 'not_owner' }, 403);
  }
  let job: Awaited<ReturnType<typeof createExportJob>>;
  try {
    job = await createExportJob(env, ownerUserId, families.length);
  } catch (error) {
    if (error instanceof Error && error.message.includes('export_rate_limited')) {
      return json({ error: 'Too many active exports', code: 'export_rate_limited' }, 429);
    }
    throw error;
  }
  const url = new URL(request.url);
  url.pathname = `/exports/${job.id}`;
  url.search = '';
  return json({ jobId: job.id, downloadUrl: url.toString(), expiresAt: job.expires_at }, 201);
}

async function streamExport(env: Env, jobId: string, ownerUserId: string): Promise<Response> {
  const job = await findExportJob(env, jobId);
  if (!job || job.owner_user_id !== ownerUserId || job.status !== 'ready') {
    return json({ error: 'Export not found', code: 'export_not_found' }, 404);
  }
  if (Date.parse(job.expires_at) <= Date.now()) {
    await updateExportJob(env, job.id, { status: 'expired' }).catch(() => undefined);
    return json({ error: 'Export expired', code: 'export_expired' }, 410);
  }

  const snapshot = await buildExportSnapshot(env, ownerUserId, env.MEDIA);
  await updateExportJob(env, job.id, {
    asset_count: snapshot.manifest.assets.length,
    last_accessed_at: new Date().toISOString(),
  });

  const entries: StreamZipEntry[] = [
    {
      name: 'manifest.json',
      getBody: async () => zipJson(snapshot.manifest),
    },
  ];
  const assetsByKey = new Map(snapshot.assets.map((asset) => [asset.objectKey, asset]));
  for (const candidate of snapshot.candidates) {
    const asset = assetsByKey.get(candidate.objectKey);
    if (!asset || !asset.exists) continue;
    entries.push({
      name: assetEntryName(asset),
      getBody: async () => {
        const object = await env.MEDIA.get(candidate.objectKey);
        if (!object?.body) throw new Error('export_asset_disappeared');
        return object.body;
      },
    });
  }
  return new Response(createStreamingZip(entries), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="momora-export-${job.id}.zip"`,
      'Cache-Control': 'no-store, private',
      'X-Export-Expires-At': job.expires_at,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/exports' && request.method === 'POST') {
      const userId = await authenticate(request, env);
      if (!userId) return unauthorized();
      try {
        return await createExport(request, env, userId);
      } catch (error) {
        console.error('export job creation failed', error instanceof Error ? error.message : 'unknown');
        return json({ error: 'Could not start export', code: 'export_unavailable' }, 503);
      }
    }

    const match = url.pathname.match(/^\/exports\/([0-9a-f-]{36})$/i);
    if (match && request.method === 'GET') {
      const userId = await authenticate(request, env);
      if (!userId) return unauthorized();
      try {
        return await streamExport(env, match[1], userId);
      } catch (error) {
        console.error('export stream failed', error instanceof Error ? error.message : 'unknown');
        if (error instanceof Error && error.message === 'export_too_large') {
          return json({ error: 'This archive is too large to download in one file', code: 'export_too_large' }, 413);
        }
        return json({ error: 'Could not create export', code: 'export_failed' }, 503);
      }
    }

    return json({ error: 'Not found', code: 'not_found' }, 404);
  },
};

export { buildExportSnapshot } from './manifest';
export { createStreamingZip } from './zip';
