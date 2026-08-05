import { assertEquals } from 'jsr:@std/assert@1';
import { getObjectBytesBatch, readObjectBodyToBytes } from './r2.ts';

Deno.test('readObjectBodyToBytes merges web stream chunks', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });

  const bytes = await readObjectBodyToBytes({
    transformToWebStream: () => stream,
  });

  assertEquals(Array.from(bytes), [1, 2, 3]);
});

// ── getObjectBytesBatch (perf-audit fix, compose-share-card's implementation
// report -- batches presigning for multiple keys into ONE
// createPresignedGetUrls call instead of one per key, then fetches every
// key concurrently) ─────────────────────────────────────────────────────
const R2_ENV_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET'];

Deno.test('getObjectBytesBatch returns an empty Map for an empty key list without touching R2 config', async () => {
  // Deliberately do NOT set any R2 env vars -- if this function tried to
  // presign/fetch anything, getR2Config() would throw. An empty Map with no
  // thrown error proves the empty-input short-circuit runs before any R2
  // config/network work.
  const saved = R2_ENV_VARS.map((key) => [key, Deno.env.get(key)] as const);
  for (const key of R2_ENV_VARS) Deno.env.delete(key);
  try {
    const result = await getObjectBytesBatch([]);
    assertEquals(result.size, 0);
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) Deno.env.set(key, value);
    }
  }
});

Deno.test('getObjectBytesBatch marks every key ok:false uniformly when presigning fails entirely (e.g. missing R2 config) -- never throws for the caller', async () => {
  const saved = R2_ENV_VARS.map((key) => [key, Deno.env.get(key)] as const);
  for (const key of R2_ENV_VARS) Deno.env.delete(key);
  try {
    const result = await getObjectBytesBatch(['portrait-a.jpg', 'portrait-b.jpg']);
    assertEquals(result.size, 2);
    assertEquals(result.get('portrait-a.jpg')?.ok, false);
    assertEquals(result.get('portrait-b.jpg')?.ok, false);
    // Every failed entry carries its error for the caller to inspect/log by
    // code, not swallow silently -- but the BATCH call itself never throws
    // (this is what lets a caller with fail-open semantics, like tagged
    // member portraits, just check `.ok` per key instead of wrapping the
    // whole batch in try/catch).
    assertEquals(result.get('portrait-a.jpg')?.error !== undefined, true);
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) Deno.env.set(key, value);
    }
  }
});

Deno.test('getObjectBytesBatch de-dupes repeated keys (one entry per unique key, not one per input occurrence)', async () => {
  const saved = R2_ENV_VARS.map((key) => [key, Deno.env.get(key)] as const);
  for (const key of R2_ENV_VARS) Deno.env.delete(key);
  try {
    const result = await getObjectBytesBatch(['same-key.jpg', 'same-key.jpg', 'same-key.jpg']);
    assertEquals(result.size, 1);
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) Deno.env.set(key, value);
    }
  }
});
