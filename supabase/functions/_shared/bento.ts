// Bento transactional email helper (docs/plans/family-sharing.md §10).
//
// Shape verified against https://bentonow.com/docs/emails_api and the
// official bento-node-sdk client (github.com/bentonow/bento-node-sdk):
// - POST https://app.bentonow.com/api/v1/batch/emails
// - Basic auth: username = publishable key, password = secret key
// - `site_uuid` goes in the JSON BODY for POST requests (the SDK only uses
//   a query parameter for GETs)
// - Body: { site_uuid, emails: [{ to, from, subject, html_body,
//   transactional }] }, 1-60 emails per batch (we always send exactly one)
// - `from` must be a registered/verified author on the Bento site (plan
//   §4 Phase 0: "register From address as an author")
// NOT independently verified against a live account (no API access from
// this environment): the exact required-header list beyond Content-Type
// and Authorization, and whether a User-Agent header is mandatory as some
// community reports suggest. We send one defensively -- Bento's docs
// don't say it's harmful, and omitting a plausible identifying header
// isn't worth the risk of a 4xx we can't observe from here.
export interface SendTransactionalEmailInput {
  to: string;
  subject: string;
  htmlBody: string;
}

const BENTO_BATCH_EMAILS_URL = 'https://app.bentonow.com/api/v1/batch/emails';

/**
 * Sends a single transactional email via Bento's batch emails endpoint.
 * Never throws -- missing env config or a failed request are logged and
 * resolve to `false` so callers can treat this as best-effort (matching
 * the push-notification failure convention used elsewhere in the Edge
 * Functions).
 */
export async function sendTransactionalEmail(
  input: SendTransactionalEmailInput,
): Promise<boolean> {
  const siteUuid = Deno.env.get('BENTO_SITE_UUID');
  const publishableKey = Deno.env.get('BENTO_PUBLISHABLE_KEY');
  const secretKey = Deno.env.get('BENTO_SECRET_KEY');
  const fromEmail = Deno.env.get('BENTO_FROM_EMAIL');

  if (!siteUuid || !publishableKey || !secretKey || !fromEmail) {
    console.error('bento: missing BENTO_* env vars, skipping transactional email');
    return false;
  }

  const credentials = btoa(`${publishableKey}:${secretKey}`);

  try {
    const response = await fetch(BENTO_BATCH_EMAILS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Momora Edge Functions (transactional email)',
      },
      body: JSON.stringify({
        site_uuid: siteUuid,
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
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        'bento: transactional email send failed',
        response.status,
        detail.slice(0, 300),
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      'bento: transactional email request failed',
      error instanceof Error ? error.message : 'unknown',
    );
    return false;
  }
}
