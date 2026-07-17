import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';

import {
  buildContentReportAlertEmailHtml,
  handleSendContentReportAlert,
  parseSendContentReportAlertRequest,
  processContentReportAlert,
} from './index.ts';

const REPORT_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_TOKEN = '22222222-2222-4222-8222-222222222222';

interface AlertState {
  status: 'pending' | 'sending' | 'sent';
  attemptToken: string | null;
  attempts: number;
  report: {
    id: string;
    target_type: string;
    reason: string;
    created_at: string;
    note?: string;
    target_id?: string;
  } | null;
  failMark?: boolean;
  selectedColumns: string[];
}

function createFakeServiceClient(state: AlertState) {
  return {
    async rpc(name: string, params: Record<string, string>) {
      if (name === 'claim_content_report_email_alert') {
        if (state.status !== 'pending') {
          return { data: [], error: null };
        }
        state.status = 'sending';
        state.attemptToken = ATTEMPT_TOKEN;
        state.attempts += 1;
        return {
          data: [{ report_id: params.p_report_id, attempt_token: ATTEMPT_TOKEN }],
          error: null,
        };
      }

      if (name === 'mark_content_report_email_alert_sent') {
        if (state.failMark || state.attemptToken !== params.p_attempt_token) {
          return { data: false, error: null };
        }
        state.status = 'sent';
        state.attemptToken = null;
        return { data: true, error: null };
      }

      if (name === 'release_content_report_email_alert') {
        if (state.attemptToken === params.p_attempt_token) {
          state.status = 'pending';
          state.attemptToken = null;
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }

      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table: string) {
      return {
        select(columns: string) {
          state.selectedColumns.push(`${table}:${columns}`);
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (table === 'content_report_email_alerts') {
                    return { data: { status: state.status }, error: null };
                  }
                  if (table === 'content_reports') {
                    return { data: state.report, error: null };
                  }
                  throw new Error(`Unexpected table ${table}`);
                },
              };
            },
          };
        },
      };
    },
  };
}

function baseState(): AlertState {
  return {
    status: 'pending',
    attemptToken: null,
    attempts: 0,
    report: {
      id: REPORT_ID,
      target_type: 'memory_illustration',
      reason: 'misleading_ai_depiction',
      created_at: '2026-07-17T10:00:00.000Z',
      note: 'This must never appear in the email.',
      target_id: '33333333-3333-4333-8333-333333333333',
    },
    selectedColumns: [],
  };
}

async function withCronSecret<T>(callback: () => Promise<T>): Promise<T> {
  const original = Deno.env.get('CRON_SECRET');
  Deno.env.set('CRON_SECRET', 'test-cron-secret');
  try {
    return await callback();
  } finally {
    if (original === undefined) {
      Deno.env.delete('CRON_SECRET');
    } else {
      Deno.env.set('CRON_SECRET', original);
    }
  }
}

Deno.test('send-content-report-alert validates the cron secret, method, and report id', async () => {
  const noSecret = await handleSendContentReportAlert(
    new Request('http://localhost/send-content-report-alert', { method: 'POST' }),
  );
  assertEquals(noSecret.status, 401);

  await withCronSecret(async () => {
    const wrongMethod = await handleSendContentReportAlert(
      new Request('http://localhost/send-content-report-alert', {
        method: 'GET',
        headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
    );
    assertEquals(wrongMethod.status, 405);

    const invalidBody = await handleSendContentReportAlert(
      new Request('http://localhost/send-content-report-alert', {
        method: 'POST',
        headers: { 'x-cron-secret': 'test-cron-secret' },
        body: JSON.stringify({ reportId: 'not-a-uuid' }),
      }),
    );
    assertEquals(invalidBody.status, 400);
  });
});

Deno.test('send-content-report-alert accepts only a UUID report id payload', () => {
  assertEquals(parseSendContentReportAlertRequest({ reportId: REPORT_ID }), { reportId: REPORT_ID });
  assertEquals(parseSendContentReportAlertRequest({}), null);
  assertEquals(parseSendContentReportAlertRequest({ reportId: REPORT_ID, note: 'ignored' }), null);
  assertEquals(parseSendContentReportAlertRequest(null), null);
});

Deno.test('send-content-report-alert sends metadata only to the default operator address', async () => {
  const state = baseState();
  const sent: Array<{ to: string; subject: string; htmlBody: string }> = [];

  const response = await processContentReportAlert(
    createFakeServiceClient(state) as never,
    REPORT_ID,
    async (email) => {
      sent.push(email);
      return 'sent';
    },
  );

  assertEquals(response.status, 200);
  assertEquals(state.status, 'sent');
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, 'hello@usemomora.com');
  assertEquals(sent[0].subject, 'New Momora content report');
  assertStringIncludes(sent[0].htmlBody, REPORT_ID);
  assertStringIncludes(sent[0].htmlBody, 'memory_illustration');
  assertStringIncludes(sent[0].htmlBody, 'misleading_ai_depiction');
  assertEquals(sent[0].htmlBody.includes('This must never appear'), false);
  assertEquals(sent[0].htmlBody.includes('33333333-3333-4333-8333-333333333333'), false);
  assertEquals(
    state.selectedColumns.includes('content_reports:id, target_type, reason, created_at'),
    true,
  );
});

Deno.test('send-content-report-alert deduplicates an endpoint retry after a successful send', async () => {
  const state = baseState();
  let sendCount = 0;
  const sender = async () => {
    sendCount += 1;
    return 'sent' as const;
  };

  const first = await processContentReportAlert(createFakeServiceClient(state) as never, REPORT_ID, sender);
  const retry = await processContentReportAlert(createFakeServiceClient(state) as never, REPORT_ID, sender);

  assertEquals(first.status, 200);
  assertEquals(retry.status, 200);
  assertEquals(await retry.json(), { success: true, sent: false, reason: 'already_sent' });
  assertEquals(sendCount, 1);
  assertEquals(state.attempts, 1);
});

Deno.test('send-content-report-alert releases a known Bento failure for a later retry', async () => {
  const state = baseState();
  const failed = await processContentReportAlert(
    createFakeServiceClient(state) as never,
    REPORT_ID,
    async () => 'rejected',
  );

  assertEquals(failed.status, 202);
  assertEquals(await failed.json(), { success: true, sent: false, reason: 'email_unavailable' });
  assertEquals(state.status, 'pending');

  const retried = await processContentReportAlert(
    createFakeServiceClient(state) as never,
    REPORT_ID,
    async () => 'sent',
  );

  assertEquals(retried.status, 200);
  assertEquals(state.status, 'sent');
  assertEquals(state.attempts, 2);
});

Deno.test('send-content-report-alert releases a claim when the report was deleted before lookup', async () => {
  const state = baseState();
  state.report = null;

  const response = await processContentReportAlert(
    createFakeServiceClient(state) as never,
    REPORT_ID,
    async () => 'sent',
  );

  assertEquals(response.status, 404);
  assertEquals(state.status, 'pending');
});

Deno.test('send-content-report-alert leaves an uncertain completion claimed to avoid a duplicate', async () => {
  const state = baseState();
  state.failMark = true;

  const response = await processContentReportAlert(
    createFakeServiceClient(state) as never,
    REPORT_ID,
    async () => 'sent',
  );

  assertEquals(response.status, 500);
  assertEquals(state.status, 'sending');
  assertEquals(state.attempts, 1);
});

Deno.test('send-content-report-alert keeps an ambiguous Bento outcome claimed for manual reconciliation', async () => {
  const state = baseState();

  const response = await processContentReportAlert(
    createFakeServiceClient(state) as never,
    REPORT_ID,
    async () => 'unknown',
  );

  assertEquals(response.status, 202);
  assertEquals(await response.json(), { success: true, sent: false, reason: 'in_progress' });
  assertEquals(state.status, 'sending');
  assertEquals(state.attempts, 1);
});

Deno.test('content report alert HTML escapes the four allowed metadata fields', () => {
  const html = buildContentReportAlertEmailHtml({
    id: REPORT_ID,
    target_type: '<memory>',
    reason: 'privacy & safety',
    created_at: '2026-07-17T10:00:00Z',
  });

  assertStringIncludes(html, '&lt;memory&gt;');
  assertStringIncludes(html, 'privacy &amp; safety');
});
