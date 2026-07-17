import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  sendTransactionalEmailWithOutcome,
  type TransactionalEmailOutcome,
} from '../_shared/bento.ts';
import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const DEFAULT_ALERT_RECIPIENT = 'hello@usemomora.com';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SendContentReportAlertRequest {
  reportId: string;
}

export interface SendContentReportAlertResponse {
  success: true;
  sent: boolean;
  reason?: 'already_sent' | 'in_progress' | 'email_unavailable';
}

interface AlertClaim {
  report_id: string;
  attempt_token: string;
}

interface ContentReportAlertRow {
  id: string;
  target_type: string;
  reason: string;
  created_at: string;
}

type TransactionalEmailSender = typeof sendTransactionalEmailWithOutcome;
type ServiceClient = SupabaseClient;

interface AlertHandlerDependencies {
  serviceClient?: ServiceClient;
  sendEmail?: TransactionalEmailSender;
}

function getAlertRecipient(): string {
  const configuredRecipient = Deno.env.get('CONTENT_REPORT_ALERT_EMAIL')?.trim();
  return configuredRecipient || DEFAULT_ALERT_RECIPIENT;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function parseSendContentReportAlertRequest(value: unknown): SendContentReportAlertRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1) {
    return null;
  }

  const reportId = record.reportId;
  if (typeof reportId !== 'string' || !UUID_PATTERN.test(reportId)) {
    return null;
  }

  return { reportId };
}

/**
 * Intentionally includes only operational metadata. Do not add family/user or
 * target identifiers, a report note, names, journal text, or media references.
 */
export function buildContentReportAlertEmailHtml(report: ContentReportAlertRow): string {
  return [
    '<p>A new Momora content report needs review.</p>',
    '<ul>',
    `<li>Report ID: ${escapeHtml(report.id)}</li>`,
    `<li>Target type: ${escapeHtml(report.target_type)}</li>`,
    `<li>Reason: ${escapeHtml(report.reason)}</li>`,
    `<li>Received: ${escapeHtml(report.created_at)}</li>`,
    '</ul>',
    '<p>Open the private operator queue to review it.</p>',
  ].join('');
}

async function releaseAlert(
  serviceClient: ServiceClient,
  reportId: string,
  attemptToken: string,
): Promise<void> {
  const { error } = await serviceClient.rpc('release_content_report_email_alert', {
    p_report_id: reportId,
    p_attempt_token: attemptToken,
  });

  if (error) {
    console.error('content-report alert release failed', error.message);
  }
}

export async function processContentReportAlert(
  serviceClient: ServiceClient,
  reportId: string,
  sendEmail: TransactionalEmailSender = sendTransactionalEmailWithOutcome,
): Promise<Response> {
  const { data: claimData, error: claimError } = await serviceClient.rpc(
    'claim_content_report_email_alert',
    { p_report_id: reportId },
  );

  if (claimError) {
    console.error('content-report alert claim failed', claimError.message);
    return errorResponse('Failed to claim content report alert', 500, 'internal_error');
  }

  const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as AlertClaim | null;
  if (!claim) {
    const { data: alert, error: alertError } = await serviceClient
      .from('content_report_email_alerts')
      .select('status')
      .eq('report_id', reportId)
      .maybeSingle();

    if (alertError) {
      console.error('content-report alert state lookup failed', alertError.message);
      return errorResponse('Failed to load content report alert', 500, 'internal_error');
    }

    if (!alert) {
      return errorResponse('Content report alert not found', 404, 'not_found');
    }

    const response: SendContentReportAlertResponse = {
      success: true,
      sent: false,
      reason: alert.status === 'sent' ? 'already_sent' : 'in_progress',
    };
    return jsonResponse(response);
  }

  const { data: reportData, error: reportError } = await serviceClient
    .from('content_reports')
    .select('id, target_type, reason, created_at')
    .eq('id', reportId)
    .maybeSingle();

  if (reportError || !reportData) {
    await releaseAlert(serviceClient, reportId, claim.attempt_token);
    if (reportError) {
      console.error('content-report alert report lookup failed', reportError.message);
      return errorResponse('Failed to load content report', 500, 'internal_error');
    }
    return errorResponse('Content report not found', 404, 'not_found');
  }

  let emailOutcome: TransactionalEmailOutcome = 'unknown';
  try {
    emailOutcome = await sendEmail({
      to: getAlertRecipient(),
      subject: 'New Momora content report',
      htmlBody: buildContentReportAlertEmailHtml(reportData as ContentReportAlertRow),
    });
  } catch (error) {
    console.error(
      'content-report alert email failed',
      error instanceof Error ? error.message : 'unknown',
    );
  }

  if (emailOutcome === 'rejected') {
    await releaseAlert(serviceClient, reportId, claim.attempt_token);
    const response: SendContentReportAlertResponse = {
      success: true,
      sent: false,
      reason: 'email_unavailable',
    };
    return jsonResponse(response, 202);
  }

  if (emailOutcome === 'unknown') {
    // The provider may have accepted the message despite a timeout, network
    // failure, 5xx, or malformed response. Preserve the claim for manual
    // Bento reconciliation rather than turning an ambiguous outcome into a
    // duplicate automatic retry.
    console.error('content-report alert email outcome is unknown');
    const response: SendContentReportAlertResponse = {
      success: true,
      sent: false,
      reason: 'in_progress',
    };
    return jsonResponse(response, 202);
  }

  const { data: markedSent, error: markError } = await serviceClient.rpc(
    'mark_content_report_email_alert_sent',
    { p_report_id: reportId, p_attempt_token: claim.attempt_token },
  );

  if (markError || !markedSent) {
    // Do not release the claim here. Bento may already have delivered the
    // message, so retaining `sending` prevents an automatic duplicate. The
    // operator can reconcile Bento's delivery log before redriving it.
    console.error(
      'content-report alert completion failed',
      markError?.message ?? 'claim was no longer current',
    );
    return errorResponse('Failed to finalize content report alert', 500, 'internal_error');
  }

  const response: SendContentReportAlertResponse = { success: true, sent: true };
  return jsonResponse(response);
}

export async function handleSendContentReportAlert(
  req: Request,
  dependencies: AlertHandlerDependencies = {},
): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  if (!validateCronSecret(req)) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body', 400, 'validation_error');
  }

  const input = parseSendContentReportAlertRequest(body);
  if (!input) {
    return errorResponse('A valid reportId is required', 400, 'validation_error');
  }

  return processContentReportAlert(
    dependencies.serviceClient ?? createServiceClient(),
    input.reportId,
    dependencies.sendEmail ?? sendTransactionalEmailWithOutcome,
  );
}

if (import.meta.main) {
  Deno.serve((req) => handleSendContentReportAlert(req));
}
