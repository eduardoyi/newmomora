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
