import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  backfillBookDocumentOriginalFiles,
  backfillManifestOriginalFiles,
  buildManifestAsset,
  type BookManifest,
} from './memory-book-manifest.ts';

// --- buildManifestAsset originalFile (memory-book-5c plan, Design Decision 1) --

Deno.test('buildManifestAsset sets originalFile when given and different from file', () => {
  const result = buildManifestAsset({
    file: 'assets/preview.jpg',
    width: 1280,
    height: 960,
    kind: 'photo',
    durationMs: null,
    dbAspectRatio: null,
    originalFile: 'assets/original.jpg',
  });
  assertEquals(result.originalFile, 'assets/original.jpg');
});

Deno.test('buildManifestAsset omits originalFile entirely when not given', () => {
  const result = buildManifestAsset({
    file: 'assets/preview.jpg',
    width: 1280,
    height: 960,
    kind: 'photo',
    durationMs: null,
    dbAspectRatio: null,
  });
  assertEquals('originalFile' in result, false);
});

Deno.test('buildManifestAsset is a no-op for the fallback-key case -- originalFile equal to file is never duplicated', () => {
  const result = buildManifestAsset({
    file: 'assets/raw-only.jpg',
    width: 1280,
    height: 960,
    kind: 'photo',
    durationMs: null,
    dbAspectRatio: null,
    originalFile: 'assets/raw-only.jpg',
  });
  assertEquals('originalFile' in result, false);
});

Deno.test('buildManifestAsset omits originalFile when explicitly null', () => {
  const result = buildManifestAsset({
    file: 'assets/preview.jpg',
    width: 1280,
    height: 960,
    kind: 'video-poster',
    durationMs: 4000,
    dbAspectRatio: null,
    originalFile: null,
  });
  assertEquals('originalFile' in result, false);
});

Deno.test('buildManifestAsset sets originalFile on a video-poster asset too (uniform per Design Decision 1)', () => {
  const result = buildManifestAsset({
    file: 'assets/poster.webp',
    width: 1280,
    height: 720,
    kind: 'video-poster',
    durationMs: 4000,
    dbAspectRatio: null,
    originalFile: 'assets/clip.mp4',
  });
  assertEquals(result.originalFile, 'assets/clip.mp4');
});

// --- backfillManifestOriginalFiles (pure logic) ----------------------------

function manifest(memories: BookManifest['memories']): BookManifest {
  return {
    child: { id: 'child-1', name: 'Test Child' },
    scope: { kind: 'age-year', label: 'Year One', start: '2024-01-01', end: '2024-12-31' },
    generatedAt: '2026-01-01T00:00:00.000Z',
    outlineRun: 'run-1',
    memories,
    portraits: [],
    language: 'en',
    downloadFailures: [],
    assetMode: 'preview',
  };
}

Deno.test('backfillManifestOriginalFiles patches an asset resolved by preview key', () => {
  const input = manifest({
    'mem-1': {
      date: '2024-06-01',
      type: 'photo',
      text: null,
      emotion: null,
      topics: [],
      milestones: [],
      engagement: 0,
      taggedMembers: [],
      assets: [
        { file: 'preview.jpg', width: 1280, height: 960, aspectRatio: 1.33, kind: 'photo', durationMs: null },
      ],
      illustration: null,
      shareToken: null,
    },
  });

  const result = backfillManifestOriginalFiles(input, { 'preview.jpg': 'original.jpg' });

  assertEquals(result.patchedCount, 1);
  assertEquals(result.unresolved, []);
  assertEquals(result.manifest.memories['mem-1'].assets[0].originalFile, 'original.jpg');
  // Pure -- the input manifest is never mutated.
  assertEquals('originalFile' in input.memories['mem-1'].assets[0], false);
});

Deno.test('backfillManifestOriginalFiles is a no-op for the fallback-key case (lookup resolves file to itself)', () => {
  const input = manifest({
    'mem-1': {
      date: '2024-06-01',
      type: 'photo',
      text: null,
      emotion: null,
      topics: [],
      milestones: [],
      engagement: 0,
      taggedMembers: [],
      assets: [
        { file: 'raw-only.jpg', width: 1280, height: 960, aspectRatio: 1, kind: 'photo', durationMs: null },
      ],
      illustration: null,
      shareToken: null,
    },
  });

  // The map the service-role helper builds keys BOTH object_key and
  // preview_object_key to object_key -- so a fallback asset (file already
  // the object_key) resolves to itself here.
  const result = backfillManifestOriginalFiles(input, { 'raw-only.jpg': 'raw-only.jpg' });

  assertEquals(result.patchedCount, 0);
  assertEquals(result.unresolved, []);
  assertEquals('originalFile' in result.manifest.memories['mem-1'].assets[0], false);
});

Deno.test('backfillManifestOriginalFiles reports an asset with no matching lookup entry as unresolved', () => {
  const input = manifest({
    'mem-1': {
      date: '2024-06-01',
      type: 'photo',
      text: null,
      emotion: null,
      topics: [],
      milestones: [],
      engagement: 0,
      taggedMembers: [],
      assets: [
        { file: 'deleted-media.jpg', width: 1280, height: 960, aspectRatio: 1, kind: 'photo', durationMs: null },
      ],
      illustration: null,
      shareToken: null,
    },
  });

  const result = backfillManifestOriginalFiles(input, {});

  assertEquals(result.patchedCount, 0);
  assertEquals(result.unresolved, [{ memoryId: 'mem-1', file: 'deleted-media.jpg', kind: 'photo' }]);
});

Deno.test('backfillManifestOriginalFiles is idempotent -- an asset that already carries originalFile is left untouched and not recounted', () => {
  const input = manifest({
    'mem-1': {
      date: '2024-06-01',
      type: 'photo',
      text: null,
      emotion: null,
      topics: [],
      milestones: [],
      engagement: 0,
      taggedMembers: [],
      assets: [
        {
          file: 'preview.jpg',
          width: 1280,
          height: 960,
          aspectRatio: 1.33,
          kind: 'photo',
          durationMs: null,
          originalFile: 'already-set.jpg',
        },
      ],
      illustration: null,
      shareToken: null,
    },
  });

  // Even a DIFFERENT map value must not override an already-backfilled asset.
  const result = backfillManifestOriginalFiles(input, { 'preview.jpg': 'different.jpg' });

  assertEquals(result.patchedCount, 0);
  assertEquals(result.unresolved, []);
  assertEquals(result.manifest.memories['mem-1'].assets[0].originalFile, 'already-set.jpg');
});

Deno.test('backfillManifestOriginalFiles patches multiple assets across memories and mixes resolved/unresolved', () => {
  const input = manifest({
    'mem-1': {
      date: '2024-06-01',
      type: 'photo',
      text: null,
      emotion: null,
      topics: [],
      milestones: [],
      engagement: 0,
      taggedMembers: [],
      assets: [
        { file: 'a-preview.jpg', width: 1280, height: 960, aspectRatio: 1.33, kind: 'photo', durationMs: null },
      ],
      illustration: null,
      shareToken: null,
    },
    'mem-2': {
      date: '2024-06-02',
      type: 'media',
      text: null,
      emotion: null,
      topics: [],
      milestones: [],
      engagement: 0,
      taggedMembers: [],
      assets: [
        { file: 'poster.webp', width: 1280, height: 720, aspectRatio: 1.78, kind: 'video-poster', durationMs: 4000 },
        { file: 'unknown.jpg', width: 1280, height: 960, aspectRatio: 1, kind: 'photo', durationMs: null },
      ],
      illustration: null,
      shareToken: null,
    },
  });

  const result = backfillManifestOriginalFiles(input, {
    'a-preview.jpg': 'a-original.jpg',
    'poster.webp': 'clip.mp4',
  });

  assertEquals(result.patchedCount, 2);
  assertEquals(result.unresolved, [{ memoryId: 'mem-2', file: 'unknown.jpg', kind: 'photo' }]);
  assertEquals(result.manifest.memories['mem-1'].assets[0].originalFile, 'a-original.jpg');
  assertEquals(result.manifest.memories['mem-2'].assets[0].originalFile, 'clip.mp4');
  assertEquals('originalFile' in result.manifest.memories['mem-2'].assets[1], false);
});

// --- backfillBookDocumentOriginalFiles (book_document jsonb wrapper) -------

Deno.test('backfillBookDocumentOriginalFiles patches manifest and passes outline through unchanged', () => {
  const bookDocument = {
    outline: { runId: 'run-1', elements: [] },
    manifest: manifest({
      'mem-1': {
        date: '2024-06-01',
        type: 'photo',
        text: null,
        emotion: null,
        topics: [],
        milestones: [],
        engagement: 0,
        taggedMembers: [],
        assets: [
          { file: 'preview.jpg', width: 1280, height: 960, aspectRatio: 1.33, kind: 'photo', durationMs: null },
        ],
        illustration: null,
        shareToken: null,
      },
    }),
  };

  const result = backfillBookDocumentOriginalFiles(bookDocument, { 'preview.jpg': 'original.jpg' });

  assertEquals(result.patchedCount, 1);
  assertEquals(result.bookDocument.outline, bookDocument.outline);
  assertEquals(result.bookDocument.manifest.memories['mem-1'].assets[0].originalFile, 'original.jpg');
});

Deno.test('backfillBookDocumentOriginalFiles throws loudly on a non-object book_document', () => {
  assertThrows(() => backfillBookDocumentOriginalFiles(null, {}), Error, 'book_document is not an object');
  assertThrows(() => backfillBookDocumentOriginalFiles('nope', {}), Error, 'book_document is not an object');
});

Deno.test('backfillBookDocumentOriginalFiles throws loudly when manifest is missing', () => {
  assertThrows(
    () => backfillBookDocumentOriginalFiles({ outline: {} }, {}),
    Error,
    'book_document.manifest is missing',
  );
});
