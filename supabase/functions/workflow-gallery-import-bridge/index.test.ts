import { assertEquals } from 'jsr:@std/assert@1';

import {
  handleWorkflowGalleryImportBridge,
  isSignedGalleryWorkflowRequest,
  type WorkflowGalleryImportBridgeDependencies,
} from './index.ts';

const SECRET = 'test-gallery-bridge-secret';
const NONCE = '11111111-1111-4111-8111-111111111111';
const CHUNK = '22222222-2222-4222-8222-222222222222';

async function signedRequest(body: Record<string, unknown>, nonce = NONCE, timestamp = Date.now()): Promise<Request> {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${raw}`)))]
    .map((part) => part.toString(16).padStart(2, '0')).join('');
  return new Request('http://localhost', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-workflow-timestamp': String(timestamp), 'x-workflow-nonce': nonce, 'x-workflow-signature': signature,
  }, body: raw });
}

function dependencies(input: { replay?: boolean; rpcData?: unknown } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    from: () => ({ insert: async () => ({ error: input.replay ? { code: '23505' } : null }) }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: input.rpcData ?? true, error: null };
    },
  };
  return { calls, overrides: { createServiceClient: () => client as unknown as ReturnType<WorkflowGalleryImportBridgeDependencies['createServiceClient']>, now: () => 1_000_000, secret: () => SECRET } };
}

Deno.test('gallery bridge verifies HMAC and rejects timestamp skew', async () => {
  const request = await signedRequest({ operation: 'scrub_gallery_chunk', chunkId: CHUNK }, NONCE, 1_000_000);
  assertEquals(await isSignedGalleryWorkflowRequest(request, await request.clone().text(), { now: () => 1_000_000, secret: () => SECRET }), true);
  const stale = await signedRequest({ operation: 'scrub_gallery_chunk', chunkId: CHUNK }, NONCE, 1);
  assertEquals(await isSignedGalleryWorkflowRequest(stale, await stale.clone().text(), { now: () => 1_000_000, secret: () => SECRET }), false);
});

Deno.test('gallery bridge records nonce before service RPC and rejects a replay', async () => {
  const { calls, overrides } = dependencies({ replay: true });
  const response = await handleWorkflowGalleryImportBridge(await signedRequest({ operation: 'scrub_gallery_chunk', chunkId: CHUNK }, NONCE, 1_000_000), overrides);
  assertEquals(response.status, 409);
  assertEquals(calls.length, 0);
});

Deno.test('gallery bridge only accepts bounded, content-free usage schema', async () => {
  const { calls, overrides } = dependencies();
  const invalid = await handleWorkflowGalleryImportBridge(await signedRequest({
    operation: 'record_gallery_usage', chunkId: CHUNK, attemptId: CHUNK, reservationToken: NONCE,
    usage: { success: true, providerStatus: 'completed', inputTokens: 1, outputTokens: 2, totalTokens: 3, caption: 'never accepted' },
  }, NONCE, 1_000_000), overrides);
  assertEquals(invalid.status, 400);
  assertEquals(calls.length, 0);

  const unknown = await handleWorkflowGalleryImportBridge(await signedRequest({
    operation: 'record_gallery_usage', chunkId: CHUNK, attemptId: CHUNK, reservationToken: NONCE,
    usage: { success: true, providerStatus: 'completed', inputTokens: 1, outputTokens: 2, totalTokens: 3, message: 'never retained' },
  }, '33333333-3333-4333-8333-333333333333', 1_000_000), overrides);
  assertEquals(unknown.status, 400);
  assertEquals(calls.length, 0);
});

// S5: a single failed cluster inside an otherwise-healthy chunk gets its own
// terminal outcome, distinct from fail_gallery_chunk (whole-chunk failure).
Deno.test('gallery bridge maps fail_gallery_cluster to the matching RPC and validates the closed error code', async () => {
  const { calls, overrides } = dependencies({ rpcData: true });
  const response = await handleWorkflowGalleryImportBridge(await signedRequest({
    operation: 'fail_gallery_cluster', chunkId: CHUNK, clusterSignature: 'b'.repeat(64), errorCode: 'VISION_REJECTED',
  }, NONCE, 1_000_000), overrides);
  assertEquals(response.status, 200);
  assertEquals(calls, [{ name: 'fail_gallery_cluster', args: {
    p_chunk_id: CHUNK, p_cluster_signature: 'b'.repeat(64), p_closed_error_code: 'VISION_REJECTED',
  }}]);
  assertEquals(await response.json(), { ok: true });

  const invalid = await handleWorkflowGalleryImportBridge(await signedRequest({
    operation: 'fail_gallery_cluster', chunkId: CHUNK, clusterSignature: 'b'.repeat(64), errorCode: 'not upper case',
  }, '33333333-3333-4333-8333-333333333333', 1_000_000), overrides);
  assertEquals(invalid.status, 400);
});

// S6: only the small non-retryable business/validation allowlist maps to the
// original 409 bridge_rejected; every other Postgres error class (deadlock,
// statement timeout, connection/resource exhaustion, or anything unexpected)
// must map to a retryable 503 bridge_unavailable so the Worker's retry
// policy can tell the two apart.
Deno.test('gallery bridge maps only the non-retryable allowlist to 409, everything else to a retryable 503 (S6)', async () => {
  const nonRetryableCodes = ['P0001', '22023', '42501', '28000'];
  for (const [index, code] of nonRetryableCodes.entries()) {
    const { overrides } = dependencies();
    const nonce = `4444444${index}-4444-4444-8444-444444444444`;
    const response = await handleWorkflowGalleryImportBridge(await signedRequest({
      operation: 'scrub_gallery_chunk', chunkId: CHUNK,
    }, nonce, 1_000_000), { ...overrides, createServiceClient: () => ({
      from: () => ({ insert: async () => ({ error: null }) }),
      rpc: async () => ({ data: null, error: { code } }),
    }) as never });
    assertEquals(response.status, 409, `expected 409 for ${code}`);
    assertEquals((await response.json()).code, 'bridge_rejected');
  }

  const retryableCodes = ['40P01', '57014', '08006', '53300', 'P0002', 'unexpected'];
  for (const [index, code] of retryableCodes.entries()) {
    const { overrides } = dependencies();
    const nonce = `5555555${index}-5555-4555-8555-555555555555`;
    const response = await handleWorkflowGalleryImportBridge(await signedRequest({
      operation: 'scrub_gallery_chunk', chunkId: CHUNK,
    }, nonce, 1_000_000), { ...overrides, createServiceClient: () => ({
      from: () => ({ insert: async () => ({ error: null }) }),
      rpc: async () => ({ data: null, error: { code } }),
    }) as never });
    assertEquals(response.status, 503, `expected 503 for ${code}`);
    assertEquals((await response.json()).code, 'bridge_unavailable');
  }
});

Deno.test('gallery bridge maps per-cluster publication exactly', async () => {
  const { calls, overrides } = dependencies({ rpcData: 1 });
  const response = await handleWorkflowGalleryImportBridge(await signedRequest({
    operation: 'publish_gallery_cluster_result', chunkId: CHUNK, clusterSignature: 'a'.repeat(64), skipReason: null,
    candidates: [{ caption: 'A sunny afternoon together', memoryDate: '2026-08-09', confidence: 0.8, emotion: 'joy', selectedAssetTokens: [NONCE] }],
  }, NONCE, 1_000_000), overrides);
  assertEquals(response.status, 200);
  assertEquals(calls, [{ name: 'publish_gallery_cluster_result', args: {
    p_chunk_id: CHUNK, p_cluster_signature: 'a'.repeat(64),
    p_candidates: [{ caption: 'A sunny afternoon together', memoryDate: '2026-08-09', confidence: 0.8, emotion: 'joy', selectedAssetTokens: [NONCE] }], p_skip_reason: null,
  }}]);
  assertEquals(await response.json(), { published: true, publishedCount: 1 });
});
