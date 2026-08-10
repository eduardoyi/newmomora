import { assertEquals } from 'jsr:@std/assert@1';

import { handleCleanupGalleryImports, type CleanupGalleryImportsDependencies } from './index.ts';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';

function dependencies(input: { failKey?: string } = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'claim_gallery_import_cleanup') return { data: [
        { run_id: RUN_A, claim_token: 'claim-a' }, { run_id: RUN_B, claim_token: 'claim-b' },
      ], error: null };
      if (name === 'get_gallery_import_cleanup_objects') {
        return { data: args.p_run_id === RUN_A
          ? [{ object_key: 'owner/gallery-import/a/previews/one.jpg' }, { object_key: 'owner/gallery-import/a/previews/two.jpg' }]
          : [{ object_key: 'owner/gallery-import/b/previews/three.jpg' }], error: null };
      }
      if (name === 'finish_gallery_import_cleanup') return { data: true, error: null };
      if (name === 'cleanup_gallery_import_workflow_bridge_nonces') return { data: 2, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const overrides: Partial<CleanupGalleryImportsDependencies> = {
    createServiceClient: () => client as never,
    validateCronSecret: () => true,
    deleteObject: async (key) => {
      deleted.push(key);
      if (key === input.failKey) throw new Error('R2 unavailable');
    },
  };
  return { rpcCalls, deleted, overrides };
}

Deno.test('gallery cleanup rejects non-cron requests', async () => {
  const { overrides } = dependencies();
  assertEquals((await handleCleanupGalleryImports(new Request('http://localhost', { method: 'GET' }), overrides)).status, 405);
  assertEquals((await handleCleanupGalleryImports(new Request('http://localhost', { method: 'POST' }), {
    ...overrides, validateCronSecret: () => false,
  })).status, 401);
});

Deno.test('gallery cleanup deletes only claimed keys and finishes only fully successful fenced claims', async () => {
  const { rpcCalls, deleted, overrides } = dependencies({ failKey: 'owner/gallery-import/b/previews/three.jpg' });
  const response = await handleCleanupGalleryImports(new Request('http://localhost', { method: 'POST' }), overrides);

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, completed: 1 });
  assertEquals(deleted, [
    'owner/gallery-import/a/previews/one.jpg', 'owner/gallery-import/a/previews/two.jpg', 'owner/gallery-import/b/previews/three.jpg',
  ]);
  assertEquals(rpcCalls, [
    { name: 'claim_gallery_import_cleanup', args: { p_limit: 50 } },
    { name: 'get_gallery_import_cleanup_objects', args: { p_run_id: RUN_A, p_claim_token: 'claim-a' } },
    { name: 'finish_gallery_import_cleanup', args: { p_run_id: RUN_A, p_claim_token: 'claim-a' } },
    { name: 'get_gallery_import_cleanup_objects', args: { p_run_id: RUN_B, p_claim_token: 'claim-b' } },
    { name: 'cleanup_gallery_import_workflow_bridge_nonces', args: { p_limit: 500 } },
  ]);
});
