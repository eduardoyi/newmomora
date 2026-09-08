import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitBookForPrint } from '../fitBookForPrint';
import { parseManifest, parseOutline } from '../../../src/model/loader';
import { makeElement, makeOutline } from '../../../src/model/__tests__/fixtures/build';
import type { MemoryBookEditsShape } from '../../../src/model/edits';

/**
 * memory-book-5c plan, Step 2c: `fitBookForPrint` is the Node-only ("no
 * Chrome") extraction of what `render-pdf.mts` used to compute inline —
 * these tests are the regression backstop for that extraction, plus the
 * page-count contract (Decision 2) it now owns.
 */

describe('fitBookForPrint — error paths (synthetic fixtures)', () => {
  it('throws when the outline has no cover element (no cover-wrap page in the fit)', () => {
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [] })]);
    const manifest = parseManifest({ child: { id: 'c', name: 'Test' }, scope: { kind: 'age-year', label: '', start: '', end: '' }, memories: {}, portraits: [], generatedAt: '', outlineRun: '' });
    expect(() => fitBookForPrint({ outline, manifest })).toThrow(/no cover-wrap page/);
  });
});

describe('fitBookForPrint — real books (skipped when book-data/ isn\'t present locally)', () => {
  const BOOK_DATA_DIR = resolve(process.cwd(), 'book-data');
  const REAL_BOOKS = ['enzo-year-one', 'enzo-year-two', 'enzo-year-three', 'mara-year-one', 'mara-year-two'];

  for (const slug of REAL_BOOKS) {
    const manifestPath = resolve(BOOK_DATA_DIR, slug, 'manifest.json');
    const outlinePath = resolve(BOOK_DATA_DIR, slug, 'book.outline.json');
    const available = existsSync(manifestPath) && existsSync(outlinePath);
    const runner = available ? it : it.skip;

    runner(`${slug}: THE page count (Decision 2) is even, contiguous, and matches jobs.length`, () => {
      const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      const outline = parseOutline(JSON.parse(readFileSync(outlinePath, 'utf8')));

      const result = fitBookForPrint({ outline, manifest, spineMm: 28 });

      expect(result.coverPage.templateId).toBe('cover-wrap');
      expect(result.frontMatterVersoPageId.length).toBeGreaterThan(0);
      expect(result.jobs).toHaveLength(result.pageCount);
      expect(result.pageCount % 2).toBe(0);
      // Contiguous, 1-based — same invariant render-pdf.mts always asserted.
      const numbers = result.jobs.map((j) => j.physicalPageNumber);
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
      // Neither the cover nor the front-matter-verso blank ever appears as an interior job.
      expect(result.jobs.some((j) => j.templateId === 'cover-wrap')).toBe(false);
      expect(result.document.pages.find((p) => p.id === result.frontMatterVersoPageId)).toBeDefined();
    });
  }

  // Pinned regression value — captured from a real CLI run (`npm run book:pdf
  // -- --slug enzo-year-three --spine-mm 28`) immediately before AND after
  // this extraction (memory-book-5c plan Step 2c's own CLI-equivalence
  // verification): both produced 122 interior pages. If this ever changes,
  // it means either the fixture book or the fitter's own output changed —
  // not something this extraction should ever silently drift.
  const enzoYearThreeManifestPath = resolve(BOOK_DATA_DIR, 'enzo-year-three', 'manifest.json');
  const enzoYearThreeOutlinePath = resolve(BOOK_DATA_DIR, 'enzo-year-three', 'book.outline.json');
  const enzoAvailable = existsSync(enzoYearThreeManifestPath) && existsSync(enzoYearThreeOutlinePath);
  (enzoAvailable ? it : it.skip)('enzo-year-three: pageCount is 122 (pinned CLI-equivalence regression value)', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(enzoYearThreeManifestPath, 'utf8')));
    const outline = parseOutline(JSON.parse(readFileSync(enzoYearThreeOutlinePath, 'utf8')));
    const result = fitBookForPrint({ outline, manifest, spineMm: 28 });
    expect(result.pageCount).toBe(122);
  });

  (enzoAvailable ? it : it.skip)('threads an image edit through applyPreFit into editedManifest (edits chain wiring, not edits.ts\'s own logic)', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(enzoYearThreeManifestPath, 'utf8')));
    const outline = parseOutline(JSON.parse(readFileSync(enzoYearThreeOutlinePath, 'utf8')));

    // Find any real photo asset already in the manifest to target — ids/keys
    // only, never memory text (project-wide "no memory content in logs/tests" rule).
    let targetMemoryId: string | null = null;
    let targetAssetFile: string | null = null;
    for (const [memoryId, memory] of Object.entries(manifest.memories)) {
      const photo = memory.assets.find((a) => a.kind === 'photo');
      if (photo) {
        targetMemoryId = memoryId;
        targetAssetFile = photo.file;
        break;
      }
    }
    expect(targetMemoryId).not.toBeNull();
    expect(targetAssetFile).not.toBeNull();

    const replacementFile = 'assets/fit-book-for-print-test-replacement.jpg';
    const edits: MemoryBookEditsShape = {
      images: {
        [`${targetMemoryId}:${targetAssetFile}`]: {
          slot: `${targetMemoryId}:${targetAssetFile}`,
          mediaId: 'test-media-id',
          file: replacementFile,
          originalFile: replacementFile,
          aspectRatio: 1,
        },
      },
    };

    const result = fitBookForPrint({ outline, manifest, edits, spineMm: 28 });
    const editedAsset = result.editedManifest.memories[targetMemoryId as string].assets.find((a) => a.file === replacementFile);
    expect(editedAsset).toBeDefined();
  });
});
