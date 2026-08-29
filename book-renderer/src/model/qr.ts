/**
 * Scan-mark URL scheme (phase 2 — real QR codes, see `templates/common/QrCode.tsx`
 * and `templates/common/ScanMark.tsx`). Every scan mark printed in a book
 * encodes a link to the public memory-viewer worker (`workers/memory-viewer`),
 * keyed by a REVOCABLE SHARE TOKEN — never the raw memory id.
 *
 * Round-19 (owner decision): the earlier raw-memoryId URL scheme
 * (`memoryViewerUrl(memoryId)`) had no revocation lever short of deleting
 * the memory itself (see `workers/memory-viewer/README.md`'s old "Privacy
 * model" section). It's replaced here by an opaque `media_share_tokens.token`
 * — minted per-memory by the export pipeline
 * (`supabase/scripts/eval-memory-book-assets.ts`'s `generateShareToken` /
 * `ensureShareTokens`) and resolved by the worker's `GET /m/:token` route —
 * so a lost/stolen printed book's QR pages can be revoked (set
 * `revoked_at`) without touching the underlying memory.
 *
 * `MEMORY_VIEWER_BASE_URL` is the worker's real assigned domain (owner
 * decision: `m.usemomora.com`, matching every other public-facing Momora
 * link — see `m.usemomora.com` DNS note in `workers/memory-viewer/README.md`),
 * not a placeholder.
 */
export const MEMORY_VIEWER_BASE_URL = 'https://m.usemomora.com/m';

/** The URL a scan mark for a minted `shareToken` encodes. Pure, no
 * fabrication — throws on an empty token rather than silently encoding a
 * broken link. Callers (`ScanMark.tsx`) must never pass a raw memory id
 * here — only a `media_share_tokens.token` resolved from the manifest's own
 * `ManifestMemory.shareToken`. */
export function shareViewerUrl(shareToken: string): string {
  if (!shareToken) {
    throw new Error('shareViewerUrl requires a non-empty shareToken');
  }
  return `${MEMORY_VIEWER_BASE_URL}/${encodeURIComponent(shareToken)}`;
}
