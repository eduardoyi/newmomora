import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';

import { handleSendExportEmail, parseExportEmailRequest, signExportEmailBody } from './index.ts';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'bridge-secret';
const NOW = 1_800_000_000_000;

function readyBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ready',
    jobId: JOB_ID,
    downloadUrl: `https://exports.example/download/${JOB_ID}?t=${'a'.repeat(64)}`,
    expiresAt: '2026-10-03T12:00:00.000Z',
    archiveCount: 3,
    totalBytes: 3 * 1024 ** 3,
    ...overrides,
  };
}

async function signedRequest(body: unknown, options: { secret?: string; timestamp?: number } = {}): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? NOW);
  const nonce = crypto.randomUUID();
  return new Request('https://fn.example/send-export-email', {
    method: 'POST',
    headers: {
      'x-export-timestamp': timestamp,
      'x-export-nonce': nonce,
      'x-export-signature': await signExportEmailBody(options.secret ?? SECRET, timestamp, nonce, raw),
    },
    body: raw,
  });
}

function fakeClient(job: { status: string } | null, email: string | null = 'owner@example.test') {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: job ? { id: JOB_ID, owner_user_id: OWNER_ID, ...job } : null, error: null }),
        }),
      }),
    }),
    auth: { admin: { getUserById: async () => ({ data: { user: email ? { email } : null }, error: null }) } },
  } as never;
}

Deno.test('sends the ready email with the link to the owner looked up server-side', async () => {
  const sent: Array<{ to: string; subject: string; htmlBody: string }> = [];
  const response = await handleSendExportEmail(await signedRequest(readyBody()), {
    secret: SECRET,
    now: () => NOW,
    serviceClient: fakeClient({ status: 'ready' }),
    sendEmail: async (input) => { sent.push(input); return 'sent'; },
  });
  assertEquals(response.status, 200);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, 'owner@example.test');
  assertEquals(sent[0].subject, 'Your Momora archive is ready');
  assertStringIncludes(sent[0].htmlBody, `/download/${JOB_ID}?t=`);
  assertStringIncludes(sent[0].htmlBody, '3 files (3.0 GB in total)');
  assertStringIncludes(sent[0].htmlBody, 'October 3, 2026');
});

Deno.test('rejects unsigned, wrongly signed and stale requests', async () => {
  const deps = { secret: SECRET, now: () => NOW, serviceClient: fakeClient({ status: 'ready' }), sendEmail: async () => 'sent' as const };
  const unsigned = new Request('https://fn.example', { method: 'POST', body: JSON.stringify(readyBody()) });
  assertEquals((await handleSendExportEmail(unsigned, deps)).status, 401);
  assertEquals((await handleSendExportEmail(await signedRequest(readyBody(), { secret: 'other' }), deps)).status, 401);
  assertEquals((await handleSendExportEmail(await signedRequest(readyBody(), { timestamp: NOW - 10 * 60_000 }), deps)).status, 401);
  assertEquals((await handleSendExportEmail(await signedRequest(readyBody()), { ...deps, secret: null })).status, 401);
});

Deno.test('refuses to email a link for a job that is not ready', async () => {
  let sends = 0;
  const response = await handleSendExportEmail(await signedRequest(readyBody()), {
    secret: SECRET,
    now: () => NOW,
    serviceClient: fakeClient({ status: 'expired' }),
    sendEmail: async () => { sends += 1; return 'sent'; },
  });
  assertEquals(response.status, 409);
  assertEquals(sends, 0);
});

Deno.test('sends the failure email for a failed job', async () => {
  const sent: string[] = [];
  const response = await handleSendExportEmail(await signedRequest({ kind: 'failed', jobId: JOB_ID }), {
    secret: SECRET,
    now: () => NOW,
    serviceClient: fakeClient({ status: 'failed' }),
    sendEmail: async (input) => { sent.push(input.subject); return 'sent'; },
  });
  assertEquals(response.status, 200);
  assertEquals(sent, ["We couldn't prepare your Momora archive"]);
});

Deno.test('a definite Bento rejection fails (so the Workflow retries); an unknown outcome does not', async () => {
  const base = { secret: SECRET, now: () => NOW, serviceClient: fakeClient({ status: 'ready' }) };
  assertEquals((await handleSendExportEmail(await signedRequest(readyBody()), { ...base, sendEmail: async () => 'rejected' as const })).status, 502);
  assertEquals((await handleSendExportEmail(await signedRequest(readyBody()), { ...base, sendEmail: async () => 'unknown' as const })).status, 202);
});

Deno.test('only accepts https download links for the same job', () => {
  assertEquals(parseExportEmailRequest(readyBody({ downloadUrl: `http://exports.example/download/${JOB_ID}?t=x` })), null);
  assertEquals(parseExportEmailRequest(readyBody({ downloadUrl: 'https://exports.example/download/33333333-3333-4333-8333-333333333333?t=x' })), null);
  assertEquals(parseExportEmailRequest(readyBody({ downloadUrl: 'https://evil.example/phish' })), null);
  assertEquals(parseExportEmailRequest({ kind: 'ready', jobId: 'not-a-uuid' }), null);
});
