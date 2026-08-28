import type { BookManifest, BookPage } from '../model/types';
import { buildDigestEntrySlots } from '../model/fitter';

/**
 * DEMO-ONLY (owner round-11, option (b) exploration; round-12: migrated to
 * build the SAME slot shape — `digest-entry` — the real fitter now emits,
 * via the shared `buildDigestEntrySlots` builder, so the demo toggle and the
 * real fitter share one render path through `IllustratedDigest.tsx`; owner
 * round-12 correction + extension: even-only entry counts, plus the
 * SINGLE-page 2-entry variant): builds illustrated-digest pages client-side
 * from a loaded book's own short illustrated memories so the owner can
 * judge the composition with REAL content, independent of whether any
 * given book's outline actually engages the real digest sweep (see the
 * fitter's `ILLUSTRATED_DIGEST_ENGAGEMENT_MIN` gate). Chronological: as
 * many 4-entry SPREADS as possible, then a trailing remainder of 2 or 3
 * becomes ONE 2-entry SINGLE page (the 3rd of a remainder-3 is dropped —
 * the real fitter instead renders it as an ordinary illustrated page, which
 * this standalone demo has no other template to show); a remainder of
 * exactly 1 is dropped outright, same precedent. Never persisted, never
 * audited — these pages exist only while the preview's "Digest demo"
 * toggle is on.
 */
const DIGEST_MAX_CHARS = 240;
const DIGEST_ASPECT_MIN = 0.9;
const DIGEST_ASPECT_MAX = 1.1;
const PER_SPREAD = 4;

export function buildDigestDemoPages(manifest: BookManifest): BookPage[] {
  const entries = Object.entries(manifest.memories)
    .filter(([, m]) => {
      if (!m.illustration || !m.text) return false;
      if (m.text.length === 0 || m.text.length > DIGEST_MAX_CHARS) return false;
      const aspect = m.illustration.aspectRatio;
      if (aspect < DIGEST_ASPECT_MIN || aspect > DIGEST_ASPECT_MAX) return false;
      if ((m.milestones ?? []).length > 0) return false;
      return true;
    })
    .map(([id, memory]) => ({ id, memory }))
    .sort((a, b) => a.memory.date.localeCompare(b.memory.date));

  const pages: BookPage[] = [];
  // Page numbering starts at 2 (same convention `numberPages` in fitter.ts
  // uses) — tracked with a running counter here since a spread advances it
  // by 2 and a single page by only 1, unlike the old spread-only demo's
  // fixed `spreadIndex * 2 + 2` formula.
  let nextPageNumber = 2;
  let i = 0;
  while (i + PER_SPREAD <= entries.length) {
    const chunk = entries.slice(i, i + PER_SPREAD);
    pages.push({
      id: `digest-demo:${pages.length}`,
      sourceElementId: 'digest-demo',
      templateId: 'illustrated-digest',
      params: {},
      slots: buildDigestEntrySlots(chunk),
      variants: [],
      isSpread: true,
      isEvenPage: null,
      pageNumbers: [nextPageNumber, nextPageNumber + 1],
      blankReason: null,
    });
    nextPageNumber += 2;
    i += PER_SPREAD;
  }
  const remaining = entries.length - i;
  if (remaining === 2 || remaining === 3) {
    const chunk = entries.slice(i, i + 2); // remainder-3: only the first 2 — never a lonely 3rd row.
    pages.push({
      id: `digest-demo:${pages.length}`,
      sourceElementId: 'digest-demo',
      templateId: 'illustrated-digest',
      params: {},
      slots: buildDigestEntrySlots(chunk),
      variants: [],
      isSpread: false,
      isEvenPage: nextPageNumber % 2 === 0,
      pageNumbers: [nextPageNumber],
      blankReason: null,
    });
  }
  return pages;
}
