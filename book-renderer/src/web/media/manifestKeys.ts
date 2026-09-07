import type { BookManifest } from '../../model/types';

/**
 * Every R2 object key any template's `assetUrl(bookSlug, file)` call could
 * possibly resolve for this manifest — memory photo/video-poster assets,
 * memory AI illustrations, and portrait photos (both the illustrated
 * portrait file and its real source photo). Design Decision 3's "provider
 * map assembled from get-media-url batches over manifest keys ∪
 * edit-referenced keys" collapses to just this, run against the manifest
 * RETURNED BY `applyPreFit` (not the pristine one): `applyPreFit` already
 * substitutes an `imageReplace`/`coverPhoto` edit's chosen `file` directly
 * into the manifest (including injecting the synthetic cover-edit memory —
 * see `edits.ts`'s `COVER_EDIT_MEMORY_ID`), so collecting keys from that
 * POST-preFit manifest already covers every edit-chosen file too, with no
 * separate "edit-referenced keys" pass needed.
 */
export function collectManifestAssetKeys(manifest: BookManifest): string[] {
  const keys = new Set<string>();

  for (const memory of Object.values(manifest.memories)) {
    for (const asset of memory.assets) {
      keys.add(asset.file);
    }
    if (memory.illustration?.file) {
      keys.add(memory.illustration.file);
    }
  }

  for (const portrait of manifest.portraits) {
    keys.add(portrait.file);
    if (portrait.sourceFile) {
      keys.add(portrait.sourceFile);
    }
  }

  return Array.from(keys);
}
