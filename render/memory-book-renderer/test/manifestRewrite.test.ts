import { describe, expect, it } from 'vitest';
import { planPresign } from '../src/manifestRewrite';
import { makeAsset, makeManifest, makeMemory } from '../../../book-renderer/src/model/__tests__/fixtures/build';
import type { MemoryBookEditsShape } from '../../../book-renderer/src/model/edits';

/**
 * `planPresign` (memory-book-5c plan, Step 3) — the `originalFile ?? file`
 * precedence rule (Design Decision 1), its video-poster exception (task
 * brief: "video-poster assets print their poster `file`"), and the
 * edits.images rewrite (needed because `applyPreFit` substitutes
 * `edits.images[key].file`/`.originalFile` onto the manifest asset AFTER
 * this module runs — see manifestRewrite.ts's own header comment).
 */
describe('planPresign — manifest URL rewrite with originalFile precedence', () => {
  it('presigns originalFile (not file) for a photo asset that has one', () => {
    const memories = {
      'memory-1': makeMemory({
        assets: [makeAsset({ file: 'assets/preview-1.jpg', originalFile: 'originals/full-res-1.jpg', kind: 'photo' })],
      }),
    };
    const manifest = makeManifest(memories);
    const plan = planPresign(manifest, {});

    expect(plan.objectKeys).toContain('originals/full-res-1.jpg');
    expect(plan.objectKeys).not.toContain('assets/preview-1.jpg');

    const rewritten = plan.rewrite({ 'originals/full-res-1.jpg': 'https://r2.example.com/originals/full-res-1.jpg?sig=abc' });
    expect(rewritten.manifest.memories['memory-1'].assets[0].file).toBe('https://r2.example.com/originals/full-res-1.jpg?sig=abc');
  });

  it('falls back to file when a photo asset has no originalFile (the "file already IS the original" case)', () => {
    const memories = {
      'memory-1': makeMemory({ assets: [makeAsset({ file: 'assets/only-copy.jpg', kind: 'photo' })] }),
    };
    const manifest = makeManifest(memories);
    const plan = planPresign(manifest, {});

    expect(plan.objectKeys).toEqual(['assets/only-copy.jpg']);
    const rewritten = plan.rewrite({ 'assets/only-copy.jpg': 'https://r2.example.com/assets/only-copy.jpg?sig=xyz' });
    expect(rewritten.manifest.memories['memory-1'].assets[0].file).toBe('https://r2.example.com/assets/only-copy.jpg?sig=xyz');
  });

  it('a video-poster asset ALWAYS presigns its own file, never originalFile (which points at the raw video, not the poster image)', () => {
    const memories = {
      'memory-1': makeMemory({
        assets: [
          makeAsset({
            file: 'assets/poster.jpg',
            // Per cloudflare/memory-book-worker/src/manifest.ts's own comment:
            // originalFile is populated uniformly regardless of kind, so a
            // video-poster asset CAN have one — pointing at the original
            // VIDEO file. Using it here would hand Puppeteer a video where
            // an <img> src is expected.
            originalFile: 'originals/raw-video.mp4',
            kind: 'video-poster',
          }),
        ],
      }),
    };
    const manifest = makeManifest(memories);
    const plan = planPresign(manifest, {});

    expect(plan.objectKeys).toEqual(['assets/poster.jpg']);
    expect(plan.objectKeys).not.toContain('originals/raw-video.mp4');

    const rewritten = plan.rewrite({ 'assets/poster.jpg': 'https://r2.example.com/assets/poster.jpg?sig=poster' });
    expect(rewritten.manifest.memories['memory-1'].assets[0].file).toBe('https://r2.example.com/assets/poster.jpg?sig=poster');
  });

  it('presigns illustration.file and portrait.file using their own file (no originalFile field exists on those shapes)', () => {
    const manifest = makeManifest(
      { 'memory-1': makeMemory({ illustration: { file: 'illustrations/illo-1.webp', width: 800, height: 800, aspectRatio: 1 } }) },
      { portraits: [{ file: 'portraits/p1.jpg', sourceFile: 'portraits/p1-source.jpg', date: '2024-01-01', ageLabel: '1 year old' }] },
    );
    const plan = planPresign(manifest, {});

    expect(plan.objectKeys).toEqual(expect.arrayContaining(['illustrations/illo-1.webp', 'portraits/p1.jpg']));
    // sourceFile is never rendered as an <img src> by any template — see
    // loader.ts's assetUrl() call sites — so it must not be presigned.
    expect(plan.objectKeys).not.toContain('portraits/p1-source.jpg');

    const rewritten = plan.rewrite({
      'illustrations/illo-1.webp': 'https://r2.example.com/illo-1.webp',
      'portraits/p1.jpg': 'https://r2.example.com/p1.jpg',
    });
    expect(rewritten.manifest.memories['memory-1'].illustration?.file).toBe('https://r2.example.com/illo-1.webp');
    expect(rewritten.manifest.portraits[0].file).toBe('https://r2.example.com/p1.jpg');
    expect(rewritten.manifest.portraits[0].sourceFile).toBe('portraits/p1-source.jpg');
  });

  it('presigns edits.images (imageReplace + coverPhoto) using originalFile precedence, rewriting BOTH file and originalFile to the resolved URL', () => {
    const manifest = makeManifest({ 'memory-1': makeMemory({ assets: [makeAsset({ file: 'assets/a.jpg', kind: 'photo' })] }) });
    const edits: MemoryBookEditsShape = {
      images: {
        'memory-1:assets/a.jpg': {
          slot: 'memory-1:assets/a.jpg',
          mediaId: 'media-1',
          file: 'assets/replacement-preview.jpg',
          originalFile: 'originals/replacement-full-res.jpg',
          aspectRatio: 1.5,
        },
        cover: {
          slot: 'cover',
          mediaId: 'media-2',
          file: 'assets/cover-preview.jpg',
          originalFile: 'originals/cover-full-res.jpg',
          aspectRatio: 1,
        },
      },
    };
    const plan = planPresign(manifest, edits);

    expect(plan.objectKeys).toEqual(
      expect.arrayContaining(['assets/a.jpg', 'originals/replacement-full-res.jpg', 'originals/cover-full-res.jpg']),
    );
    // The preview keys behind the edit records are never fetched directly —
    // only their originalFile (Decision 1's whole point).
    expect(plan.objectKeys).not.toContain('assets/replacement-preview.jpg');
    expect(plan.objectKeys).not.toContain('assets/cover-preview.jpg');

    const rewritten = plan.rewrite({
      'assets/a.jpg': 'https://r2.example.com/a.jpg',
      'originals/replacement-full-res.jpg': 'https://r2.example.com/replacement.jpg?sig=1',
      'originals/cover-full-res.jpg': 'https://r2.example.com/cover.jpg?sig=2',
    });

    const imageEdit = rewritten.edits.images!['memory-1:assets/a.jpg'];
    expect(imageEdit.file).toBe('https://r2.example.com/replacement.jpg?sig=1');
    expect(imageEdit.originalFile).toBe('https://r2.example.com/replacement.jpg?sig=1');

    const coverEdit = rewritten.edits.images!.cover;
    expect(coverEdit.file).toBe('https://r2.example.com/cover.jpg?sig=2');
    expect(coverEdit.originalFile).toBe('https://r2.example.com/cover.jpg?sig=2');
  });

  it('throws if rewrite() is called with a presign map missing a required key (fail loudly, never silently blank an image)', () => {
    const manifest = makeManifest({ 'memory-1': makeMemory({ assets: [makeAsset({ file: 'assets/a.jpg', kind: 'photo' })] }) });
    const plan = planPresign(manifest, {});
    expect(() => plan.rewrite({})).toThrow(/no presigned URL/);
  });

  it('deduplicates a key referenced by multiple assets (only presigned once)', () => {
    const sharedKey = 'assets/shared.jpg';
    const manifest = makeManifest({
      'memory-1': makeMemory({ assets: [makeAsset({ file: sharedKey, kind: 'photo' })] }),
      'memory-2': makeMemory({ assets: [makeAsset({ file: sharedKey, kind: 'photo' })] }),
    });
    const plan = planPresign(manifest, {});
    expect(plan.objectKeys.filter((k) => k === sharedKey)).toHaveLength(1);
  });
});
