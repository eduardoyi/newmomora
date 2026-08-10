import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { deleteObject } from '../_shared/r2.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

interface CleanupClaim { run_id: string; claim_token: string; }

export interface CleanupGalleryImportsDependencies {
  createServiceClient: typeof createServiceClient;
  deleteObject: typeof deleteObject;
  validateCronSecret: typeof validateCronSecret;
}

const DEFAULT_DEPENDENCIES: CleanupGalleryImportsDependencies = {
  createServiceClient,
  deleteObject,
  validateCronSecret,
};

/**
 * Deletes only keys returned by the fenced service RPC. A failed delete never
 * advances the DB fence, so the next cron pass safely retries the same
 * (idempotent) object set instead of declaring it clean prematurely.
 */
export async function handleCleanupGalleryImports(
  req: Request,
  overrides: Partial<CleanupGalleryImportsDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!dependencies.validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');
  const client = dependencies.createServiceClient();
  const { data: claims, error: claimError } = await client.rpc('claim_gallery_import_cleanup', { p_limit: 50 });
  if (claimError) {
    console.error('cleanup-gallery-imports claim failed', claimError.code ?? 'unknown');
    return errorResponse('Unable to claim gallery cleanup', 500, 'internal_error');
  }
  let completed = 0;
  for (const claim of (claims ?? []) as CleanupClaim[]) {
    const { data: objects, error: objectsError } = await client.rpc('get_gallery_import_cleanup_objects', {
      p_run_id: claim.run_id, p_claim_token: claim.claim_token,
    });
    if (objectsError) {
      console.error('cleanup-gallery-imports object lookup failed', claim.run_id);
      continue;
    }
    try {
      await Promise.all(((objects ?? []) as Array<{ object_key: string }>).map((object) => dependencies.deleteObject(object.object_key)));
    } catch {
      console.error('cleanup-gallery-imports storage cleanup failed', claim.run_id);
      continue;
    }
    const { data: finalized, error: finalizeError } = await client.rpc('finish_gallery_import_cleanup', {
      p_run_id: claim.run_id, p_claim_token: claim.claim_token,
    });
    if (finalizeError || !finalized) {
      console.error('cleanup-gallery-imports finalize fence failed', claim.run_id);
      continue;
    }
    completed += 1;
  }
  // Replay nonces contain no gallery content, but expire them under the same
  // authenticated scheduler so the bridge guard stays bounded over time.
  const { error: nonceCleanupError } = await client.rpc('cleanup_gallery_import_workflow_bridge_nonces', { p_limit: 500 });
  if (nonceCleanupError) console.error('cleanup-gallery-imports nonce cleanup failed', nonceCleanupError.code ?? 'unknown');
  return jsonResponse({ success: true, completed });
}

if (import.meta.main) Deno.serve((req) => handleCleanupGalleryImports(req));
