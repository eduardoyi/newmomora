import { assertEquals, assertExists } from 'jsr:@std/assert@1';

import {
  clientRun,
  galleryUploadRequiredHeaders,
  isValidGalleryImportCandidateDraft,
  markAndDispatchGalleryChunk,
  parseGalleryImportManifest,
} from './gallery-import.ts';

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

// Keyed by table name so a test can override just the pending-clusters count
// while the run-limits lookup keeps its own simple default.
function galleryServiceClientStub(pendingClustersCount: number | null = 0) {
  return {
    from: (table: string) => {
      if (table === 'gallery_import_cluster_results') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => (pendingClustersCount === null
                ? { count: null, error: new Error('boom') }
                : { count: pendingClustersCount, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { limit_snapshot: {} } }) }) }) };
    },
  };
}

Deno.test('gallery run DTO exposes the SQL aggregate as chunkCount, never a polymorphic chunks field', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub() } as never, {
    id: token, familyId: token, status: 'reviewing', chunks: 3,
  });
  assertEquals(result.chunkCount, 3);
  assertEquals('chunks' in result, false);
});

// Round 4: "+N coming" must be server truth (pending gallery_import_cluster_
// results rows), never the client's own local upload plan, which goes stale
// across a resume -- a real production run showed a phantom "+51 coming"
// all day. See countPendingGalleryClusters's doc comment.
Deno.test('gallery run DTO carries the server-computed pendingClusters count', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub(4) } as never, {
    id: token, familyId: token, status: 'reviewing', chunks: 3,
  });
  assertEquals(result.pendingClusters, 4);
});

Deno.test('gallery run DTO reports pendingClusters as null (not 0) when the count could not be computed', async () => {
  const result = await clientRun({ serviceClient: galleryServiceClientStub(null) } as never, {
    id: token, familyId: token, status: 'reviewing', chunks: 3,
  });
  assertEquals(result.pendingClusters, null);
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
