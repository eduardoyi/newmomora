/**
 * Emails the owner about their data export (docs/features/data-export.md).
 *
 * Called only by the export Worker's ExportArchiveWorkflow
 * (cloudflare/momora-export-worker/src/email.ts), over a request signed
 * with EXPORT_EMAIL_BRIDGE_SECRET: HMAC-SHA256 of
 * `${timestamp}.${nonce}.${rawBody}`, 5-minute window -- the same shape as
 * the memory-book workflow bridges. Kept here rather than in the Worker so
 * Bento credentials live in one runtime, and so the owner's email address
 * is looked up server-side from the job rather than trusted from the body.
 *
 *   kind 'ready'  -> "Your Momora archive is ready" with the download link
 *   kind 'failed' -> "We couldn't prepare your archive"
 *
 * The job's own status must agree with the kind, so a replayed or stale
 * request can't email a link for a job that is no longer ready.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  sendTransactionalEmailWithOutcome,
  type SendTransactionalEmailInput,
  type TransactionalEmailOutcome,
} from '../_shared/bento.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExportEmailRequest =
  | { kind: 'ready'; jobId: string; downloadUrl: string; expiresAt: string; archiveCount: number; totalBytes: number }
  | { kind: 'failed'; jobId: string };

interface Dependencies {
  serviceClient?: SupabaseClient;
  sendEmail?: (input: SendTransactionalEmailInput) => Promise<TransactionalEmailOutcome>;
  secret?: string | null;
  now?: () => number;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  let mismatch = 0;
  for (let index = 0; index < 64; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function signExportEmailBody(secret: string, timestamp: string, nonce: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`)));
}

async function isSigned(req: Request, rawBody: string, secret: string | null | undefined, now: number): Promise<boolean> {
  const timestamp = req.headers.get('x-export-timestamp');
  const nonce = req.headers.get('x-export-nonce');
  const signature = req.headers.get('x-export-signature')?.toLowerCase();
  if (!secret || !timestamp || !nonce || !signature || !UUID_PATTERN.test(nonce)) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > MAX_SIGNATURE_AGE_MS) return false;
  return constantTimeEqualHex(await signExportEmailBody(secret, timestamp, nonce, rawBody), signature);
}

export function parseExportEmailRequest(value: unknown): ExportEmailRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.jobId !== 'string' || !UUID_PATTERN.test(body.jobId)) return null;
  if (body.kind === 'failed') return { kind: 'failed', jobId: body.jobId };
  if (body.kind !== 'ready') return null;
  if (typeof body.downloadUrl !== 'string' || typeof body.expiresAt !== 'string') return null;
  if (typeof body.archiveCount !== 'number' || typeof body.totalBytes !== 'number') return null;
  let url: URL;
  try {
    url = new URL(body.downloadUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.pathname !== `/download/${body.jobId}`) return null;
  if (Number.isNaN(Date.parse(body.expiresAt))) return null;
  return {
    kind: 'ready',
    jobId: body.jobId,
    downloadUrl: url.toString(),
    expiresAt: body.expiresAt,
    archiveCount: body.archiveCount,
    totalBytes: body.totalBytes,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function buildReadyEmailHtml(request: Extract<ExportEmailRequest, { kind: 'ready' }>): string {
  const files = request.archiveCount === 1
    ? `one file (${formatBytes(request.totalBytes)})`
    : `${request.archiveCount} files (${formatBytes(request.totalBytes)} in total), one for your family's portraits and one for each year`;
  return `
    <p>Your Momora archive is ready to download.</p>
    <p>It's in ${escapeHtml(files)}: every memory with its words, photos, videos, voice recordings and illustrations, organised into a folder per year.</p>
    <p><a href="${escapeHtml(request.downloadUrl)}" style="display:inline-block;background:#D63E78;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Download your archive</a></p>
    <p>The files are large, so we recommend opening this link on a computer. It works until ${escapeHtml(formatDate(request.expiresAt))}, then the files are deleted. You can always export again from Momora's Settings.</p>
    <p>Didn't ask for this? You can ignore this email, and nobody else can use this link unless you share it.</p>
    <p>-- The Momora team</p>
  `.trim();
}

export function buildFailedEmailHtml(): string {
  return `
    <p>We're sorry: something went wrong while preparing your Momora archive, and it couldn't be finished.</p>
    <p>Your memories are safe and nothing was changed. Please try again from Settings → Export your memories in the app. If it keeps happening, just reply to this email and we'll help.</p>
    <p>-- The Momora team</p>
  `.trim();
}

export async function handleSendExportEmail(req: Request, deps: Dependencies = {}): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const rawBody = await req.text();
  const secret = deps.secret !== undefined ? deps.secret : Deno.env.get('EXPORT_EMAIL_BRIDGE_SECRET');
  if (!(await isSigned(req, rawBody, secret, (deps.now ?? Date.now)()))) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return errorResponse('Invalid request body', 400, 'validation_error');
  }
  const request = parseExportEmailRequest(parsed);
  if (!request) return errorResponse('Invalid export email request', 400, 'validation_error');

  const supabase = deps.serviceClient ?? createServiceClient();
  const { data: job, error: jobError } = await supabase
    .from('export_jobs')
    .select('id, owner_user_id, status')
    .eq('id', request.jobId)
    .maybeSingle();
  if (jobError) {
    console.error('send-export-email job lookup failed', jobError.message);
    return errorResponse('Failed to load export job', 500, 'internal_error');
  }
  const expectedStatus = request.kind === 'ready' ? 'ready' : 'failed';
  if (!job || job.status !== expectedStatus) {
    return errorResponse('Export job is not in the expected state', 409, 'job_state_mismatch');
  }

  const { data: authUser, error: userError } = await supabase.auth.admin.getUserById(job.owner_user_id);
  const email = authUser?.user?.email;
  if (userError || !email) {
    console.error('send-export-email owner email unavailable');
    return errorResponse('Owner email unavailable', 422, 'email_unavailable');
  }

  const outcome = await (deps.sendEmail ?? sendTransactionalEmailWithOutcome)({
    to: email,
    subject: request.kind === 'ready' ? 'Your Momora archive is ready' : "We couldn't prepare your Momora archive",
    htmlBody: request.kind === 'ready' ? buildReadyEmailHtml(request) : buildFailedEmailHtml(),
  });

  // 'rejected' is a definite non-delivery: fail so the Workflow retries
  // (with a fresh link). 'unknown' may have been delivered -- report
  // success rather than risk a duplicate email.
  if (outcome === 'rejected') return errorResponse('Email was not accepted', 502, 'email_rejected');
  return jsonResponse({ success: true, sent: outcome === 'sent' }, outcome === 'sent' ? 200 : 202);
}

if (import.meta.main) {
  Deno.serve((req) => handleSendExportEmail(req));
}
