import type { BookManifest } from '../../../book-renderer/src/model/types';
import type { MemoryBookEditsShape } from '../../../book-renderer/src/model/edits';

/**
 * Rewrites a book_document's manifest AND edits `file`/`originalFile`
 * fields to absolute, presigned R2 GET URLs before handing both to
 * `renderBookPdfs()`'s ATTEMPT mode (memory-book-5c plan, Step 3's
 * "Per-request data injection" / Decision 3's "Asset access").
 * `PrintApp.tsx`'s `attemptAssetUrl` already passes an absolute
 * `http(s)://` URL through unchanged (wave 1) — this module is what
 * PRODUCES that absolute URL for every asset the print entry will fetch.
 *
 * Precedence (Design Decision 1, this module's whole reason to exist):
 * `originalFile ?? file` — print needs the original, full-resolution
 * bytes; `file` is only the app's ~1280px preview key.
 *
 * Video-poster assets are the ONE deliberate exception (task brief, verified
 * against `cloudflare/memory-book-worker/src/manifest.ts`'s own comment):
 * `originalFile` on a `video-poster` asset points at the ORIGINAL VIDEO
 * object (`row.object_key` — populated uniformly regardless of kind, "a
 * video's own original video file is never printed -- only its poster
 * `file` is -- but this field is populated uniformly regardless of kind").
 * Using it here would hand Puppeteer a video file where an `<img>` src is
 * expected. A video-poster asset therefore ALWAYS presigns its own `file`
 * (the poster image), never `originalFile`.
 *
 * Portraits and illustrations have no `originalFile` field at all (they are
 * AI-generated at a fixed, already-print-appropriate resolution, not
 * sourced from a user's original photo) — their own `file` is always what
 * gets presigned. Every `edits.images[*]` record (image-replace + cover
 * photo) is always a photo (`applyPreFit` rejects a video-poster edit
 * target as an orphan before this ever matters — see edits.ts) so it always
 * follows the plain `originalFile ?? file` rule.
 *
 * WHY edits need rewriting too, not just the manifest: `renderBookPdfs()`
 * hands `manifest` and `edits` to `fitBookForPrint()` as SEPARATE inputs —
 * `applyPreFit` (called INSIDE that library, not by this worker) is what
 * actually substitutes `edits.images[key].file`/`.originalFile` onto the
 * manifest asset for an edited slot (`substituteAsset`/
 * `applyCoverImageEdit` in book-renderer/src/model/edits.ts). If this
 * module only rewrote the manifest's OWN (pre-edit) asset keys, every
 * EDITED slot — exactly the ones a customer actually touched — would end
 * up with a raw R2 object key sitting in `asset.file` post-substitution,
 * which `attemptAssetUrl` would then treat as a RELATIVE path (not
 * `http(s)://`) and resolve against this worker's own loopback-only
 * `/attempt/<id>/<file>` static routes — which serve only outline/
 * manifest/edits.json, not asset bytes — a silent 404 on exactly the
 * highest-stakes images in the book. So both sources of asset keys are
 * collected into ONE presign batch and both are rewritten together.
 */

export interface BookDocumentLike {
  outline: unknown;
  manifest: BookManifest;
}

export interface PresignPlan {
  /** Every distinct R2 object key this render needs fetched, in first-seen order (manifest assets/illustrations/portraits, then edits.images). */
  objectKeys: string[];
  /** Applies a `objectKey -> presigned URL` map (covering every key in `objectKeys`) to produce the rewritten manifest + edits. */
  rewrite: (presignedUrlByKey: Record<string, string>) => { manifest: BookManifest; edits: MemoryBookEditsShape };
}

function sourceKeyForAsset(asset: { file: string; originalFile?: string; kind: string }): string {
  if (asset.kind === 'video-poster') return asset.file;
  return asset.originalFile ?? asset.file;
}

function sourceKeyForImageEdit(edit: { file: string; originalFile: string }): string {
  return edit.originalFile ?? edit.file;
}

/**
 * Builds the presign plan without doing any I/O itself — the caller (Step
 * 3's `/render` handler) presigns `objectKeys` in one batch (see `r2.ts`'s
 * `createPresignedGetUrls`) and calls `rewrite()` with the result. Kept as a
 * pure plan/apply split (rather than an async function that presigns
 * inline) so this module stays trivially unit-testable with a fake
 * presigned-URL map — no R2 client, no network, in its own test suite.
 */
export function planPresign(manifest: BookManifest, edits: MemoryBookEditsShape): PresignPlan {
  const seen = new Set<string>();
  const objectKeys: string[] = [];
  function note(key: string): void {
    if (seen.has(key)) return;
    seen.add(key);
    objectKeys.push(key);
  }

  for (const memory of Object.values(manifest.memories)) {
    for (const asset of memory.assets) {
      note(sourceKeyForAsset(asset));
    }
    if (memory.illustration) note(memory.illustration.file);
  }
  for (const portrait of manifest.portraits) {
    note(portrait.file);
  }
  for (const edit of Object.values(edits.images ?? {})) {
    note(sourceKeyForImageEdit(edit));
  }

  function rewrite(presignedUrlByKey: Record<string, string>): { manifest: BookManifest; edits: MemoryBookEditsShape } {
    function resolve(key: string): string {
      const url = presignedUrlByKey[key];
      if (!url) {
        throw new Error('manifestRewrite: no presigned URL for object key (missing from the presign batch)');
      }
      return url;
    }

    const nextManifest: BookManifest = JSON.parse(JSON.stringify(manifest));
    for (const memory of Object.values(nextManifest.memories)) {
      for (const asset of memory.assets) {
        asset.file = resolve(sourceKeyForAsset(asset));
      }
      if (memory.illustration) {
        memory.illustration.file = resolve(memory.illustration.file);
      }
    }
    for (const portrait of nextManifest.portraits) {
      portrait.file = resolve(portrait.file);
    }

    const nextEdits: MemoryBookEditsShape = JSON.parse(JSON.stringify(edits));
    for (const edit of Object.values(nextEdits.images ?? {})) {
      // Both `file` and `originalFile` are rewritten to the SAME presigned
      // URL (the resolved original) — `substituteAsset` copies both fields
      // verbatim onto the manifest asset, and neither should end up as a
      // bare object key post-substitution.
      const url = resolve(sourceKeyForImageEdit(edit));
      edit.file = url;
      edit.originalFile = url;
    }

    return { manifest: nextManifest, edits: nextEdits };
  }

  return { objectKeys, rewrite };
}
