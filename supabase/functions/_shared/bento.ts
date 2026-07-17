// Bento transactional email helper (docs/plans/family-sharing.md §10).
//
// Shape verified against https://bentonow.com/docs/emails_api:
// - POST https://app.bentonow.com/api/v1/batch/emails
// - Basic auth: username = publishable key, password = secret key
// - `site_uuid` is a query parameter
// - Body: { emails: [{ to, from, subject, html_body, transactional }] },
//   1-60 emails per batch (we always send exactly one)
// - Success body: { results: 1 } (number accepted/queued)
// - `from` must be a registered/verified author on the Bento site (plan
//   §4 Phase 0: "register From address as an author")
export interface SendTransactionalEmailInput {
  to: string;
  subject: string;
  htmlBody: string;
}

const BENTO_BATCH_EMAILS_URL = 'https://app.bentonow.com/api/v1/batch/emails';
const BENTO_REQUEST_TIMEOUT_MS = 10_000;

export type TransactionalEmailOutcome = 'sent' | 'rejected' | 'unknown';

interface BentoBatchResponse {
  results?: unknown;
}

/**
 * Sends a single transactional email via Bento's batch emails endpoint.
 * Never throws. It returns `sent` only for Bento's exact one-email acceptance,
 * `rejected` only when delivery was definitely not accepted, and `unknown`
 * whenever retrying could duplicate a message.
 */
export async function sendTransactionalEmailWithOutcome(
  input: SendTransactionalEmailInput,
): Promise<TransactionalEmailOutcome> {
  const siteUuid = Deno.env.get('BENTO_SITE_UUID');
  const publishableKey = Deno.env.get('BENTO_PUBLISHABLE_KEY');
  const secretKey = Deno.env.get('BENTO_SECRET_KEY');
  const fromEmail = Deno.env.get('BENTO_FROM_EMAIL');

  if (!siteUuid || !publishableKey || !secretKey || !fromEmail) {
    console.error('bento: missing BENTO_* env vars, skipping transactional email');
    return 'rejected';
  }

  const credentials = btoa(`${publishableKey}:${secretKey}`);
  const url = `${BENTO_BATCH_EMAILS_URL}?site_uuid=${encodeURIComponent(siteUuid)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Momora Edge Functions (transactional email)',
      },
      body: JSON.stringify({
        emails: [
          {
            to: input.to,
            from: fromEmail,
            subject: input.subject,
            html_body: input.htmlBody,
            transactional: true,
          },
        ],
      }),
      signal: AbortSignal.timeout(BENTO_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // A 4xx is a definite provider rejection. A 5xx might have accepted
      // the request before the response path failed, so callers must not
      // automatically retry it.
      console.error('bento: transactional email send failed', response.status);
      return response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown';
    }

    let body: BentoBatchResponse;
    try {
      body = await response.json() as BentoBatchResponse;
    } catch {
      console.error('bento: transactional email response was not valid JSON');
      return 'unknown';
    }

    if (body.results === 1) {
      return 'sent';
    }

    if (body.results === 0) {
      console.error('bento: transactional email was not accepted', body.results);
      return 'rejected';
    }

    console.error('bento: transactional email response had an unexpected results count');
    return 'unknown';
  } catch (error) {
    console.error(
      'bento: transactional email request failed',
      error instanceof Error ? error.message : 'unknown',
    );
    return 'unknown';
  }
}

/** Backward-compatible best-effort API for existing invite-email callers. */
export async function sendTransactionalEmail(
  input: SendTransactionalEmailInput,
): Promise<boolean> {
  return (await sendTransactionalEmailWithOutcome(input)) === 'sent';
}
