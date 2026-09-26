import { serveArchive, serveDownloadPage } from './download';
import { deleteExportPrefix } from './storage';
import { authenticate, listJobsNeedingCleanup, listRows, startExportJob, updateExportJob } from './supabase';
import type { ExportFamily, ExportWorkflowParams } from './types';

export { ExportArchiveWorkflow } from './workflow';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function unauthorized(): Response {
  return json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DOWNLOAD_PAGE = new RegExp(`^/download/(${UUID})$`, 'i');
const DOWNLOAD_FILE = new RegExp(`^/download/(${UUID})/(\\d{1,4})$`, 'i');

async function listOwnedFamilies(env: Env, ownerUserId: string): Promise<ExportFamily[]> {
  return await listRows<ExportFamily>(env, 'families', 'id,owner_id,name,illustration_style,created_at', {
    owner_id: `eq.${ownerUserId}`,
    deleted_at: 'is.null',
    limit: '100',
  });
}

/**
 * POST /exports -- queue a background export for the signed-in owner. The
 * archive is emailed as a download link when ready; nothing is returned to
 * the phone but a confirmation.
 */
async function requestExport(request: Request, env: Env, owner: { id: string; email: string | null }): Promise<Response> {
  const families = await listOwnedFamilies(env, owner.id);
  if (families.length === 0) {
    return json({ error: 'Only family owners can export an archive', code: 'not_owner' }, 403);
  }
  if (!owner.email) {
    return json({ error: 'Add an email address to your account to receive your archive', code: 'email_required' }, 409);
  }

  let started: Awaited<ReturnType<typeof startExportJob>>;
  try {
    started = await startExportJob(env, owner.id, families.length);
  } catch (error) {
    if (error instanceof Error && error.message.includes('export_rate_limited')) {
      return json({ error: 'You\'ve already exported a few times today. Please try again tomorrow.', code: 'export_rate_limited' }, 429);
    }
    throw error;
  }

  if (!started.already_running) {
    const params: ExportWorkflowParams = {
      jobId: started.job_id,
      ownerUserId: owner.id,
      origin: new URL(request.url).origin,
    };
    try {
      await env.EXPORT_WORKFLOW.create({ id: started.job_id, params });
    } catch (error) {
      await updateExportJob(env, started.job_id, { status: 'failed', failure_code: 'workflow_create_failed' }).catch(() => undefined);
      throw error;
    }
  }

  return json({
    jobId: started.job_id,
    status: started.status,
    alreadyRunning: started.already_running,
    email: owner.email,
  }, 202);
}

/** Daily: delete archives of expired downloads and failed builds, then record it. */
export async function cleanupExports(env: Env, now = new Date()): Promise<number> {
  const jobs = await listJobsNeedingCleanup(env, now);
  let cleaned = 0;
  for (const job of jobs) {
    try {
      await deleteExportPrefix(env.MEDIA, job.id);
      await updateExportJob(env, job.id, {
        files_deleted_at: now.toISOString(),
        ...(job.status === 'ready' ? { status: 'expired' as const, download_token_hash: null } : {}),
      });
      cleaned += 1;
    } catch (error) {
      console.error('export cleanup failed', error instanceof Error ? error.message : 'unknown');
    }
  }
  return cleaned;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/exports' && request.method === 'POST') {
      const user = await authenticate(request, env);
      if (!user) return unauthorized();
      try {
        return await requestExport(request, env, user);
      } catch (error) {
        console.error('export request failed', error instanceof Error ? error.message : 'unknown');
        return json({ error: 'Could not start export', code: 'export_unavailable' }, 503);
      }
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      try {
        const pageMatch = url.pathname.match(DOWNLOAD_PAGE);
        if (pageMatch) return await serveDownloadPage(env, pageMatch[1], url);
        const fileMatch = url.pathname.match(DOWNLOAD_FILE);
        if (fileMatch) return await serveArchive(env, request, fileMatch[1], Number(fileMatch[2]), url);
      } catch (error) {
        console.error('export download failed', error instanceof Error ? error.message : 'unknown');
        return new Response('Something went wrong. Please try again in a moment.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    }

    return json({ error: 'Not found', code: 'not_found' }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExports(env).then((count) => {
      if (count > 0) console.log('export cleanup', count);
    }));
  },
} satisfies ExportedHandler<Env>;
