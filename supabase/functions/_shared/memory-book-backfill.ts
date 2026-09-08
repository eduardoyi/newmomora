/**
 * Service-role DB helper for the `originalFile` backfill (memory-book-5c
 * plan, Design Decision 1, step 1). `memory-book-manifest.ts` deliberately
 * stays Deno-free so book-renderer and the Cloudflare worker can import it
 * too (see that file's own header comment) -- this module is the one place
 * that actually reads `memory_media` to build the `file -> object_key` map
 * the pure `backfillBookDocumentOriginalFiles` needs, so it is Deno/
 * service-role-only by design and is NOT imported by book-renderer or
 * cloudflare/memory-book-worker.
 *
 * NO LLM, NO re-curation -- this only ever patches `originalFile` onto
 * existing asset entries; see `backfillManifestOriginalFiles`'s own doc
 * comment for the full contract (idempotent, fallback-key no-op, never
 * silently drops an unresolved asset). The caller (the future
 * `memory-book-orders` quote op, plan step 5) owns whether/how to persist
 * the patched `book_document` and how to react to a non-empty `unresolved`
 * list -- this helper only reads `memory_media` and reports back.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  backfillBookDocumentOriginalFiles,
  type BackfillBookDocumentResult,
} from './memory-book-manifest.ts';

interface MemoryMediaKeyRow {
  object_key: string;
  preview_object_key: string | null;
}

/**
 * Builds the `file -> object_key` lookup `backfillManifestOriginalFiles`
 * consumes, scoped to one family (never cross-family -- mirrors
 * `memory-book-edits/index.ts`'s own `memories!inner(family_id)` pattern).
 * Keyed by BOTH `preview_object_key` (the common case -- a manifest asset's
 * `file` is the exported preview) AND `object_key` itself (so the fallback
 * case -- no preview existed, `selectMediaAsset` used `object_key` directly
 * as `file` -- also resolves, to itself; `backfillManifestOriginalFiles`
 * recognizes that as the no-op case and leaves `originalFile` unset).
 */
export async function buildOriginalFileMapForFamily(
  supabase: SupabaseClient,
  familyId: string,
): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from('memory_media')
    .select('object_key, preview_object_key, memories!inner(family_id)')
    .eq('memories.family_id', familyId);

  if (error) {
    throw new Error(`memory_media lookup failed: ${error.message}`);
  }

  const originalFileByFile: Record<string, string> = {};
  for (const row of (data ?? []) as MemoryMediaKeyRow[]) {
    if (!row.object_key) continue;
    originalFileByFile[row.object_key] = row.object_key;
    if (row.preview_object_key) {
      originalFileByFile[row.preview_object_key] = row.object_key;
    }
  }
  return originalFileByFile;
}

/**
 * One-call entry point the future quote op/workflow calls (plan step 1's
 * own note: "this lands where the plan's quote op will call it"): builds
 * the family's `memory_media` lookup, then patches `bookDocument` through
 * the pure module. Never writes anything back to the DB itself -- the
 * caller decides whether/how to persist `bookDocument` (e.g. only after
 * confirming `unresolved` is empty).
 */
export async function backfillOriginalFilesForBook(
  supabase: SupabaseClient,
  familyId: string,
  bookDocument: unknown,
): Promise<BackfillBookDocumentResult> {
  const originalFileByFile = await buildOriginalFileMapForFamily(supabase, familyId);
  return backfillBookDocumentOriginalFiles(bookDocument, originalFileByFile);
}
