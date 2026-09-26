import { findExportJob, updateExportJob } from './supabase';
import { tokenMatches } from './token';
import type { ExportJob } from './types';

// Pages served to whoever holds the emailed link -- usually the owner on a
// computer, not signed in. No cookies, no third-party assets, nothing
// cacheable, and no referrer leaking the token to anything linked from here.
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, private',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { --paper: #FAFAFD; --ink: #2C2418; --ink2: #6B5E4F; --ink3: #9A8B79; --line: #EBE7F2; --primary: #D63E78; --card: #FFFFFF; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 48px 20px 64px; }
  .brand { font: 600 13px/1 -apple-system, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--ink3); margin: 0 0 20px; }
  h1 { font: 500 34px/1.15 Georgia, "Times New Roman", serif; margin: 0 0 12px; }
  p { color: var(--ink2); margin: 0 0 16px; }
  ul { list-style: none; padding: 0; margin: 28px 0; border: 1px solid var(--line); border-radius: 16px; background: var(--card); overflow: hidden; }
  li { display: flex; align-items: center; gap: 16px; padding: 16px 18px; border-top: 1px solid var(--line); }
  li:first-child { border-top: 0; }
  .name { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
  .size { display: block; font-weight: 400; color: var(--ink3); font-size: 14px; }
  a.button { flex-shrink: 0; background: var(--primary); color: #fff; text-decoration: none; font-weight: 600; font-size: 15px; padding: 10px 18px; border-radius: 999px; }
  a.button:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
  .note { font-size: 14px; color: var(--ink3); }
</style>
</head>
<body><main><p class="brand">Momora</p>${body}</main></body>
</html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

function unavailablePage(reason: 'expired' | 'invalid'): Response {
  return page('Link unavailable', reason === 'expired'
    ? '<h1>This link has expired</h1><p>Download links last 7 days. Open Momora and go to Settings → Export your memories to get a fresh one.</p>'
    : '<h1>This link doesn\'t work</h1><p>It may have been copied incompletely, or replaced by a newer export. Open Momora and go to Settings → Export your memories to get a fresh one.</p>',
  reason === 'expired' ? 410 : 404);
}

type Authorized = { ok: true; job: ExportJob; token: string } | { ok: false; response: Response };

async function authorize(env: Env, jobId: string, url: URL): Promise<Authorized> {
  const token = url.searchParams.get('t');
  const job = await findExportJob(env, jobId);
  // Same response for "no such job" and "wrong token" -- don't confirm
  // which job ids exist.
  if (!job || !(await tokenMatches(token, job.download_token_hash))) {
    return { ok: false, response: unavailablePage('invalid') };
  }
  if (job.status !== 'ready' || Date.parse(job.expires_at) <= Date.now()) {
    return { ok: false, response: unavailablePage(job.status === 'failed' ? 'invalid' : 'expired') };
  }
  return { ok: true, job, token: token as string };
}

export async function serveDownloadPage(env: Env, jobId: string, url: URL): Promise<Response> {
  const auth = await authorize(env, jobId, url);
  if (!auth.ok) return auth.response;
  const { job, token } = auth;
  await updateExportJob(env, job.id, { last_accessed_at: new Date().toISOString() }).catch(() => undefined);

  const items = job.archives.map((archive) => `
    <li>
      <span class="name">${escapeHtml(archive.fileName)}<span class="size">${formatBytes(archive.bytes)}</span></span>
      <a class="button" href="/download/${job.id}/${archive.index}?t=${token}" download>Download</a>
    </li>`).join('');
  const many = job.archives.length > 1;
  return page('Your Momora archive', `
    <h1>Your memories are ready</h1>
    <p>${many ? `Your archive is in ${job.archives.length} files (${formatBytes(job.total_bytes)} in total), one for your family's portraits and one for each year.` : `Your archive is ${formatBytes(job.total_bytes)}.`} Download ${many ? 'them all and unzip them into the same folder — they combine' : 'it and unzip it'} into one folder of memories, organised by year.</p>
    <ul>${items}</ul>
    <p class="note">We recommend downloading on a computer. This link works until ${escapeHtml(formatDate(job.expires_at))}, after which the files are deleted — you can always export again from the app.</p>`);
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').replace(/\s+/g, ' ').trim() || 'momora-export.zip';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Streams one archive from R2, with Range support so browsers can resume. */
export async function serveArchive(env: Env, request: Request, jobId: string, archiveIndex: number, url: URL): Promise<Response> {
  const auth = await authorize(env, jobId, url);
  if (!auth.ok) return auth.response;
  const archive = auth.job.archives.find((candidate) => candidate.index === archiveIndex);
  if (!archive) return unavailablePage('invalid');

  // Archives never change once written, so an If-Range resume can always
  // be honoured -- just pass the Range through.
  const object = await env.MEDIA.get(archive.key, { range: request.headers });
  if (!object) return unavailablePage('expired');

  const headers = new Headers({
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(archive.fileName),
    'Cache-Control': 'no-store, private',
    'Referrer-Policy': 'no-referrer',
    'Accept-Ranges': 'bytes',
    ETag: object.httpEtag,
  });
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has('range')) {
    const offset = range.offset ?? (range.suffix !== undefined ? object.size - range.suffix : 0);
    const length = range.length ?? (object.size - offset);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
