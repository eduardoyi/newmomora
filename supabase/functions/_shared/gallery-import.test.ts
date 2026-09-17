import { assertEquals, assertExists } from 'jsr:@std/assert@1';

import {
  clientRun,
  dispatchGalleryImportChunk,
  galleryUploadRequiredHeaders,
  galleryWorkflowInstanceId,
  isValidGalleryImportCandidateDraft,
  markAndDispatchGalleryChunk,
  parseGalleryImportManifest,
  redispatchStaleGalleryChunks,
  registerGalleryImportChunk,
} from './gallery-import.ts';

// Bug #1 (audit): `gallery_import_cluster_results` has no `id` column -- its
// primary key is the composite (chunk_id, cluster_signature), see the
// foundation migration. Selecting a non-existent column makes PostgREST
// reject the request (400), which was silently swallowed into `pendingClusters:
// null` in production. Assert against the real generated Row type shape so a
// future refactor can't silently reintroduce this by construction, not just
// by behavior.
type GalleryClusterResultRow = {
  chunk_id: string;
  cluster_signature: string;
  state: string;
  skip_reason: string | null;
  candidate_count: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

const token = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);

function validManifest() {
  return {
    clusters: [{
      signature: digest,
      assets: [{
        assetToken: token,
        captureDate: '2026-08-09',
        width: 2000,
        height: 1200,
        isFavorite: false,
        sourceContentType: 'image/jpeg',
      }],
    }],
  };
}

Deno.test('gallery manifest accepts only opaque token and local-calendar date', () => {
  const result = parseGalleryImportManifest(validManifest());
  assertExists(result);
  assertEquals(result.assets[0].captureDate, '2026-08-09');
  assertEquals(result.assets[0].opaqueToken, token);
});

Deno.test('gallery manifest refuses accidental OS identifiers and local URIs', () => {
  const fixture = validManifest();
  const leaked = { ...fixture.clusters[0].assets[0], id: 'ph://private-id', uri: 'file:///private.jpg' } as Record<string, unknown>;
  fixture.clusters[0].assets[0] = leaked as unknown as (typeof fixture.clusters)[number]['assets'][number];
  assertEquals(parseGalleryImportManifest(fixture), null);
});

Deno.test('gallery manifest requires a local calendar capture date', () => {
  const fixture = validManifest();
  const asset = fixture.clusters[0].assets[0] as Record<string, unknown>;
  delete asset.captureDate;
  asset.captureAtMs = Date.now();
  assertEquals(parseGalleryImportManifest(fixture), null);
});

Deno.test('gallery manifest rejects impossible calendar dates before SQL', () => {
  const fixture = validManifest();
  (fixture.clusters[0].assets[0] as Record<string, unknown>).captureDate = '2026-02-30';
  assertEquals(parseGalleryImportManifest(fixture), null);
});

Deno.test('gallery manifest rejects non-object assets without throwing', () => {
  const fixture = validManifest();
  fixture.clusters[0].assets = [null] as unknown as (typeof fixture.clusters)[number]['assets'];
  assertEquals(parseGalleryImportManifest(fixture), null);
});

// Keyed by table name so a test can override just the pieces it cares about
// (pending-clusters count, chunk summaries, live candidate tokens, fair use)
// while everything else keeps a simple default.
function galleryServiceClientStub(options: {
  pendingClustersCount?: number | null;
  chunkRows?: Array<{ ordinal: number; status: string }>;
  candidateRows?: Array<{ selected_asset_tokens: string[] }>;
  fairUse?: { used: number; limit: number; resets_at: string | null } | null;
} = {}) {
  // Deliberately not `??`: `{ pendingClustersCount: null }` means "simulate
  // the count query failing" and must stay null, not fall back to 0.
  const pendingClustersCount = options.pendingClustersCount === undefined ? 0 : options.pendingClustersCount;
  const chunkRows = options.chunkRows ?? [];
  const candidateRows = options.candidateRows ?? [];
  const fairUse = options.fairUse === undefined ? { used: 0, limit: 300, resets_at: null } : options.fairUse;
  return {
    from: (table: string) => {
      if (table === 'gallery_import_cluster_results') {
        return {
          select: (columns: string) => {
            // Locks in the fix for bug #1: the real column selected for the
            // count must be one that exists on the generated Row type
            // (`chunk_id`), never the non-existent `id`.
            const selected = columns.split(',')[0].trim() as keyof GalleryClusterResultRow;
            assertEquals(selected, 'chunk_id' as keyof GalleryClusterResultRow);
            return {
              eq: () => ({
                eq: async () => (pendingClustersCount === null
                  ? { count: null, error: new Error('boom') }
                  : { count: pendingClustersCount, error: null }),
              }),
            };
          },
        };
      }
      if (table === 'gallery_import_chunks') {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: chunkRows, error: null }) }) }) };
      }
      if (table === 'gallery_import_candidates') {
        return { select: () => ({ eq: () => ({ in: async () => ({ data: candidateRows, error: null }) }) }) };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { limit_snapshot: {} } }) }) }) };
    },
    rpc: async () => (fairUse === null ? { data: null, error: new Error('boom') } : { data: fairUse, error: null }),
  };
}

Deno.test('gallery run DTO exposes the SQL aggregate as chunkCount, and S1 chunks as a separate array', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub({ chunkRows: [{ ordinal: 0, status: 'dispatched' }] }) } as never, {
    id: token, familyId: token, status: 'reviewing', chunks: 3,
  });
  assertEquals(result.chunkCount, 3);
  assertEquals(result.chunks, [{ ordinal: 0, status: 'dispatched' }]);
});

// Round 4: "+N coming" must be server truth (pending gallery_import_cluster_
// results rows), never the client's own local upload plan, which goes stale
// across a resume -- a real production run showed a phantom "+51 coming"
// all day. See countPendingGalleryClusters's doc comment.
Deno.test('gallery run DTO carries the server-computed pendingClusters count', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub({ pendingClustersCount: 4 }) } as never, {
    id: token, familyId: token, status: 'reviewing', chunks: 3,
  });
  assertEquals(result.pendingClusters, 4);
});

Deno.test('gallery run DTO reports pendingClusters as null (not 0) when the count could not be computed', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub({ pendingClustersCount: null }) } as never, {
    id: token, familyId: token, status: 'reviewing', chunks: 3,
  });
  assertEquals(result.pendingClusters, null);
});

// S1: opaque tokens selected by every still-live (staged/skipped) candidate,
// deduplicated -- used by the client to know which locally-cached previews
// remain relevant across a resume.
Deno.test('gallery run DTO exposes deduplicated live candidate asset tokens', async () => {
  const tokenTwo = '22222222-2222-4222-8222-222222222222';
  const result = await clientRun({ serviceClient: galleryServiceClientStub({
    candidateRows: [{ selected_asset_tokens: [token, tokenTwo] }, { selected_asset_tokens: [token] }],
  }) } as never, { id: token, familyId: token, status: 'reviewing', chunks: 0 });
  assertEquals(result.liveCandidateAssetTokens, [token, tokenTwo]);
});

// S1: fairUse.pausedUntil is null unless the family is actually at/over the
// daily cap, in which case it carries the server's reset timestamp.
Deno.test('gallery run DTO fairUse.pausedUntil is null under the daily cap', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub({
    fairUse: { used: 10, limit: 300, resets_at: null },
  }) } as never, { id: token, familyId: token, status: 'reviewing', chunks: 0 });
  assertEquals(result.fairUse, { pausedUntil: null });
});

Deno.test('gallery run DTO fairUse.pausedUntil carries the reset time once the family is at the daily cap', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub({
    fairUse: { used: 300, limit: 300, resets_at: '2026-08-24T10:00:00Z' },
  }) } as never, { id: token, familyId: token, status: 'reviewing', chunks: 0 });
  assertEquals(result.fairUse, { pausedUntil: '2026-08-24T10:00:00Z' });
});

Deno.test('gallery run DTO fairUse fails closed (not paused) when the server RPC errors', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub({ fairUse: null }) } as never, {
    id: token, familyId: token, status: 'reviewing', chunks: 0,
  });
  assertEquals(result.fairUse, { pausedUntil: null });
});

Deno.test('gallery uploads return the exact metadata headers required by the R2 signature', () => {
  assertEquals(galleryUploadRequiredHeaders('image/jpeg', { bytes: '42', sha256: digest }), {
    'Content-Type': 'image/jpeg',
    'x-amz-meta-bytes': '42',
    'x-amz-meta-sha256': digest,
  });
});

Deno.test('gallery candidate drafts reject captions over the durable 1,000-character limit', () => {
  const draft = {
    caption: 'x'.repeat(1_001), memoryDate: '2026-08-09', assetTokens: [token], familyMemberIds: [],
  };
  assertEquals(isValidGalleryImportCandidateDraft(draft), false);
  assertEquals(isValidGalleryImportCandidateDraft({ ...draft, caption: 'x'.repeat(1_000) }), true);
});

Deno.test('gallery candidate drafts allow a caption the user has cleared, saving as a media-only memory', () => {
  const draft = {
    caption: '', memoryDate: '2026-08-09', assetTokens: [token], familyMemberIds: [],
  };
  assertEquals(isValidGalleryImportCandidateDraft(draft), true);
  assertEquals(isValidGalleryImportCandidateDraft({ ...draft, caption: '   ' }), true);
});

Deno.test('gallery manifest bounds per-cluster selection before preview creation', () => {
  const tooMany = validManifest();
  tooMany.clusters[0].assets = Array.from({ length: 11 }, (_, index) => ({
    ...tooMany.clusters[0].assets[0],
    assetToken: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
  }));
  assertEquals(parseGalleryImportManifest(tooMany), null);
});

Deno.test('gallery chunk is marked dispatched before Worker creation and a failed dispatch is retryable', async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(`rpc:${name}`);
      return { data: true, error: null };
    },
  };
  const common = {
    chunkId: '22222222-2222-4222-8222-222222222222',
    workerUrl: 'https://worker.example',
    signingSecret: 'test-secret',
  };
  const failed = await markAndDispatchGalleryChunk(client as never, {
    ...common,
    fetch: async () => {
      calls.push('fetch');
      return new Response('busy', { status: 503 });
    },
  });
  assertEquals(failed, 'dispatch_unavailable');
  assertEquals(calls, ['rpc:mark_gallery_chunk_dispatched', 'fetch']);

  const retried = await markAndDispatchGalleryChunk(client as never, {
    ...common,
    fetch: async () => {
      calls.push('fetch-retry');
      return new Response(null, { status: 202 });
    },
  });
  assertEquals(retried, 'accepted');
  assertEquals(calls, ['rpc:mark_gallery_chunk_dispatched', 'fetch', 'rpc:mark_gallery_chunk_dispatched', 'fetch-retry']);
});

Deno.test('gallery dispatch fails closed without creating a Workflow when fencing does not mark', async () => {
  let fetched = false;
  const result = await markAndDispatchGalleryChunk({
    rpc: async () => ({ data: false, error: null }),
  } as never, {
    chunkId: '22222222-2222-4222-8222-222222222222', workerUrl: 'https://worker.example', signingSecret: 'test-secret',
    fetch: async () => { fetched = true; return new Response(null, { status: 202 }); },
  });
  assertEquals(result, 'mark_failed');
  assertEquals(fetched, false);
});

Deno.test('gallery dispatch maps a Worker transport failure to a safe retry', async () => {
  const result = await markAndDispatchGalleryChunk({
    rpc: async () => ({ data: true, error: null }),
  } as never, {
    chunkId: '22222222-2222-4222-8222-222222222222', workerUrl: 'https://worker.example', signingSecret: 'test-secret',
    fetch: async () => { throw new Error('network unavailable'); },
  });
  assertEquals(result, 'dispatch_unavailable');
});

// S4: first dispatch (attempt absent/<=1) keeps the original instance id so a
// duplicate first-dispatch request is still deduplicated by Cloudflare;
// every re-dispatch gets its own suffixed id so a stuck/ambiguous prior
// instance can never collide with the retry.
Deno.test('gallery workflow instance id is attempt-suffixed only on redispatch (S4)', () => {
  const chunkId = '22222222-2222-4222-8222-222222222222';
  assertEquals(galleryWorkflowInstanceId(chunkId, 1), `gallery-${chunkId}`);
  assertEquals(galleryWorkflowInstanceId(chunkId, 2), `gallery-${chunkId}-2`);
  assertEquals(galleryWorkflowInstanceId(chunkId, 3), `gallery-${chunkId}-3`);
});

Deno.test('gallery dispatch sends the attempt number to the Worker and stores the matching instance id (S4)', async () => {
  const rpcArgs: Array<Record<string, unknown>> = [];
  let sentBody = '';
  const result = await markAndDispatchGalleryChunk({
    rpc: async (_name: string, args: Record<string, unknown>) => { rpcArgs.push(args); return { data: true, error: null }; },
  } as never, {
    chunkId: '22222222-2222-4222-8222-222222222222', workerUrl: 'https://worker.example', signingSecret: 'test-secret', attempt: 3,
    fetch: async (_url: unknown, init?: RequestInit) => { sentBody = String(init?.body ?? ''); return new Response(null, { status: 202 }); },
  });
  assertEquals(result, 'accepted');
  assertEquals(rpcArgs[0].p_workflow_id, 'gallery-22222222-2222-4222-8222-222222222222-3');
  assertEquals(JSON.parse(sentBody), { chunkId: '22222222-2222-4222-8222-222222222222', attempt: 3 });
});

Deno.test('gallery chunk registration maps the daily fair-use limit to a 429 pause, never a bare error (S2)', async () => {
  const runId = token;
  const context = {
    userId: 'user-1',
    userClient: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'get_gallery_import_run') {
          return { data: { id: args.p_run_id, familyId: 'family-1', status: 'processing', readyCandidates: 0, chunks: 0, expiresAt: '2026-09-01T00:00:00Z' }, error: null };
        }
        if (name === 'register_gallery_import_chunk') {
          return { data: null, error: { code: 'P0002', message: 'Gallery import daily limit reached', hint: '2026-08-24T10:00:00.000Z' } };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
    serviceClient: {},
    body: {
      runId, runCapability: '1'.repeat(40), ordinal: 0,
      clusters: [{ clusterSignature: digest, assets: [{ opaqueToken: token, captureDate: '2026-08-09', width: null, height: null, isFavorite: false }] }],
    },
  };
  const response = await registerGalleryImportChunk(context as never);
  assertEquals(response.status, 429);
  const payload = await response.json();
  assertEquals(payload.code, 'fair_use');
  assertEquals(typeof payload.retryAfterSeconds, 'number');
  assertEquals(payload.retryAfterSeconds > 0, true);
});

Deno.test('gallery chunk registration does not treat an ordinary "not found" P0002 as fair-use', async () => {
  const context = {
    userId: 'user-1',
    userClient: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'get_gallery_import_run') {
          return { data: { id: args.p_run_id, familyId: 'family-1', status: 'processing', readyCandidates: 0, chunks: 0, expiresAt: '2026-09-01T00:00:00Z' }, error: null };
        }
        if (name === 'register_gallery_import_chunk') {
          return { data: null, error: { code: 'P0002', message: 'Candidate not found' } };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
    serviceClient: {},
    body: {
      runId: token, runCapability: '1'.repeat(40), ordinal: 0,
      clusters: [{ clusterSignature: digest, assets: [{ opaqueToken: token, captureDate: '2026-08-09', width: null, height: null, isFavorite: false }] }],
    },
  };
  const response = await registerGalleryImportChunk(context as never);
  assertEquals(response.status, 404);
});

// S3: an asset the device can no longer produce a preview for is reported as
// unavailable; if that empties the chunk entirely the server closes it and
// dispatch becomes a no-op success rather than a "not available" error.
Deno.test('gallery dispatch marks assets unavailable and short-circuits once the chunk closes with nothing left (S3)', async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const context = {
    userId: 'user-1',
    userClient: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'get_gallery_import_run') {
          return { data: { id: args.p_run_id, familyId: 'family-1', status: 'processing', readyCandidates: 0, chunks: 1, expiresAt: '2026-09-01T00:00:00Z' }, error: null };
        }
        if (name === 'mark_gallery_import_assets_unavailable') {
          return { data: { markedAssetTokens: [token], emptiedClusterSignatures: [digest] }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
    serviceClient: {
      from: (table: string) => {
        if (table === 'gallery_import_chunks') {
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: 'completed' } }) }) }) }) };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    },
    body: { runId: token, runCapability: '1'.repeat(40), chunkId: token, unavailableAssetTokens: [token] },
  };
  const response = await dispatchGalleryImportChunk(context as never);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { accepted: true });
  assertEquals(rpcCalls.some((call) => call.name === 'mark_gallery_import_assets_unavailable'), true);
});

Deno.test('gallery dispatch rejects a malformed unavailableAssetTokens payload before touching the RPC', async () => {
  const context = {
    userId: 'user-1',
    userClient: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'get_gallery_import_run') {
          return { data: { id: args.p_run_id, familyId: 'family-1', status: 'processing', readyCandidates: 0, chunks: 1, expiresAt: '2026-09-01T00:00:00Z' }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
    serviceClient: {},
    body: { runId: token, runCapability: '1'.repeat(40), chunkId: token, unavailableAssetTokens: ['not-a-uuid'] },
  };
  const response = await dispatchGalleryImportChunk(context as never);
  assertEquals(response.status, 400);
});

// Reconciliation (S4, S6, S7): the redispatch loop claims stale chunks and
// re-dispatches each with attempt = its current dispatch_attempts + 1.
Deno.test('gallery reconciliation redispatches every claimed stale chunk with the next attempt number', async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const dispatched: string[] = [];
  const serviceClient = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'claim_stale_gallery_chunks') {
        return {
          data: [
            { chunk_id: '22222222-2222-4222-8222-222222222222', dispatch_attempts: 1 },
            { chunk_id: '33333333-3333-4333-8333-333333333333', dispatch_attempts: 0 },
          ],
          error: null,
        };
      }
      if (name === 'mark_gallery_chunk_dispatched') return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const result = await redispatchStaleGalleryChunks({
    serviceClient: serviceClient as never,
    workerUrl: 'https://worker.example',
    signingSecret: 'test-secret',
    fetch: async (url: unknown) => { dispatched.push(String(url)); return new Response(null, { status: 202 }); },
  });
  assertEquals(result, { claimed: 2, redispatched: 2 });
  const workflowIds = rpcCalls.filter((call) => call.name === 'mark_gallery_chunk_dispatched').map((call) => call.args.p_workflow_id);
  assertEquals(workflowIds, [
    'gallery-22222222-2222-4222-8222-222222222222-2',
    'gallery-33333333-3333-4333-8333-333333333333',
  ]);
});

Deno.test('gallery reconciliation is a no-op when nothing is claimable', async () => {
  const result = await redispatchStaleGalleryChunks({
    serviceClient: { rpc: async () => ({ data: [], error: null }) } as never,
    workerUrl: 'https://worker.example',
    signingSecret: 'test-secret',
  });
  assertEquals(result, { claimed: 0, redispatched: 0 });
});
