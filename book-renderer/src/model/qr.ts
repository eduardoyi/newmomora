/**
 * Scan-mark URL scheme (phase 2 — real QR codes, see `templates/common/QrCode.tsx`
 * and `templates/common/ScanMark.tsx`). Every scan mark printed in a book
 * encodes a link to this same memory-viewer worker, keyed by memory id —
 * never a fabricated/placeholder id.
 *
 * `MEMORY_VIEWER_BASE_URL` is a placeholder domain, owner-configurable: a
 * parallel agent is building the Cloudflare Worker that will actually serve
 * `/m/<memoryId>` (auth-gated family viewer + redirect). Swap this one
 * constant when that worker's real domain is assigned — every scan mark in
 * every rendered book follows automatically.
 */
export const MEMORY_VIEWER_BASE_URL = 'https://m.momora.app/m';

/** The URL a scan mark for `memoryId` encodes. Pure, no fabrication — throws on an empty id rather than silently encoding a broken link. */
export function memoryViewerUrl(memoryId: string): string {
  if (!memoryId) {
    throw new Error('memoryViewerUrl requires a non-empty memoryId');
  }
  return `${MEMORY_VIEWER_BASE_URL}/${encodeURIComponent(memoryId)}`;
}
