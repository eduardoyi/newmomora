const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

export interface PortraitMemoryRetriggerRequest {
  memoryId: string;
  requestIntent: 'recovery';
  actorUserId: string;
  familyId: string;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  const decodeDigest = (value: string): Uint8Array => {
    const digest = new Uint8Array(32);
    if (!/^[0-9a-f]{64}$/i.test(value)) return digest;
    for (let index = 0; index < digest.length; index += 1) {
      digest[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return digest;
  };
  const leftDigest = decodeDigest(left);
  const rightDigest = decodeDigest(right);
  let mismatch = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    mismatch |= leftDigest[index] ^ rightDigest[index];
  }
  return mismatch === 0;
}

async function sign(timestamp: string, rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  ));
}

export function hasPortraitMemoryRetriggerHeaders(req: Request): boolean {
  return req.headers.has('x-portrait-retrigger-timestamp') ||
    req.headers.has('x-portrait-retrigger-signature');
}

export async function isSignedPortraitMemoryRetrigger(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  const timestamp = req.headers.get('x-portrait-retrigger-timestamp');
  const signature = req.headers.get('x-portrait-retrigger-signature');
  const secret = Deno.env.get('PORTRAIT_MEMORY_RETRIGGER_SECRET');
  if (!timestamp || !signature || !secret) return false;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_SIGNATURE_AGE_MS) {
    return false;
  }
  return constantTimeEqual(await sign(timestamp, rawBody, secret), signature.toLowerCase());
}

export async function signedPortraitMemoryRetriggerHeaders(rawBody: string): Promise<HeadersInit> {
  const secret = Deno.env.get('PORTRAIT_MEMORY_RETRIGGER_SECRET');
  if (!secret) throw new Error('Missing portrait memory retrigger secret');
  const timestamp = String(Date.now());
  return {
    'Content-Type': 'application/json',
    'x-portrait-retrigger-timestamp': timestamp,
    'x-portrait-retrigger-signature': await sign(timestamp, rawBody, secret),
  };
}

export function isPortraitMemoryRetriggerRequest(
  body: unknown,
): body is PortraitMemoryRetriggerRequest {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return candidate.requestIntent === 'recovery' &&
    typeof candidate.memoryId === 'string' && uuid.test(candidate.memoryId) &&
    typeof candidate.actorUserId === 'string' && uuid.test(candidate.actorUserId) &&
    typeof candidate.familyId === 'string' && uuid.test(candidate.familyId);
}
