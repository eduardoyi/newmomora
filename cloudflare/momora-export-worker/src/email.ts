// The Worker never holds Bento credentials or looks up the owner's email:
// it asks the send-export-email Edge Function, over a request signed with
// EXPORT_EMAIL_BRIDGE_SECRET (same HMAC shape as the memory-book bridges:
// HMAC-SHA256 of `${timestamp}.${nonce}.${body}`).

export type ExportEmailRequest =
  | { kind: 'ready'; jobId: string; downloadUrl: string; expiresAt: string; archiveCount: number; totalBytes: number }
  | { kind: 'failed'; jobId: string };

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sendExportEmail(env: Env, request: ExportEmailRequest): Promise<void> {
  const body = JSON.stringify(request);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const response = await fetch(env.EXPORT_EMAIL_BRIDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-export-timestamp': timestamp,
      'x-export-nonce': nonce,
      'x-export-signature': await hmacSha256Hex(env.EXPORT_EMAIL_BRIDGE_SECRET, `${timestamp}.${nonce}.${body}`),
    },
    body,
  });
  if (!response.ok) {
    await response.text().catch(() => '');
    throw new Error(`export_email_failed:${response.status}`);
  }
}
