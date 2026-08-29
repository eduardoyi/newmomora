import { assertEquals, assertMatch, assertRejects, assertThrows } from 'jsr:@std/assert@1';

import {
  buildDownloadFailure,
  buildFullResolutionPosterFfmpegArgs,
  buildManifest,
  buildManifestAsset,
  buildManifestIllustration,
  buildManifestMemory,
  buildManifestMilestone,
  buildManifestPortrait,
  buildManifestScope,
  buildScoringFrameFfmpegArgs,
  buildTaggedMember,
  candidateFramePercentiles,
  CLI_USAGE,
  coerceManifestLanguage,
  collectMemoryIdsFromElements,
  computeCandidateFrameOffsetsSeconds,
  computeCellSharpnessGrid,
  computeCenterWeightedSubjectSharpness,
  computeLaplacianVarianceSharpness,
  computeMeanBrightness,
  computeMidtoneSpread,
  defaultOutDir,
  DEFAULT_POSTER_FRAME_COUNT,
  DOWNLOAD_FAILURE_EXIT_THRESHOLD,
  exceedsVideoPosterSizeGuard,
  excludePortraitVersionIds,
  extensionFromKey,
  generateShareToken,
  GrayscaleFrame,
  illustrationFileName,
  isClockSkewAuthError,
  isHeicContentType,
  mapScopeKind,
  MAX_VIDEO_POSTER_SOURCE_BYTES,
  mediaAssetFileName,
  memoryNeedsShareToken,
  mergeCandidateMemoryIds,
  objectKeyBasename,
  parseArgs,
  parseOutlineJson,
  pickBestPosterFrameIndex,
  POSTER_SCORING_FRAME_SIZE,
  POSTER_SCORING_GRID_SIZE,
  portraitFileName,
  portraitSourceFileName,
  PRINT_ASSET_HEIC_JPEG_QUALITY,
  resolveManifestLanguageDefault,
  resolvePrintPhotoExtension,
  scorePosterFrameCandidate,
  selectMediaAsset,
  SHARE_TOKEN_LENGTH,
  shouldDownloadOriginalForPrint,
  shouldMeasureOriginalDimensions,
  slugify,
  SUBJECT_SHARPNESS_WEIGHT,
  subtractOneDay,
  summarizeDownloadFailures,
  videoPosterTempFileSuffix,
  withRetries,
} from './eval-memory-book-assets.ts';

// --- collectMemoryIdsFromElements ------------------------------------------

Deno.test('collectMemoryIdsFromElements dedupes across elements, order-preserving', () => {
  const result = collectMemoryIdsFromElements([
    { id: 'cover', kind: 'cover', memoryIds: [] },
    { id: 'backbone:2024-01', kind: 'backbone', memoryIds: ['m1', 'm2'] },
    { id: 'topic:first-steps', kind: 'themed', memoryIds: ['m2', 'm3'] },
    { id: 'firsts', kind: 'firsts', memoryIds: ['m1', 'm4'] },
  ]);
  assertEquals(result, ['m1', 'm2', 'm3', 'm4']);
});

Deno.test('collectMemoryIdsFromElements handles no elements with memories', () => {
  assertEquals(
    collectMemoryIdsFromElements([
      { id: 'cover', kind: 'cover', memoryIds: [] },
      { id: 'closing', kind: 'closing', memoryIds: [] },
    ]),
    [],
  );
});

// --- mergeCandidateMemoryIds (integration gap 1 -- panorama/hero candidates
// that never made the backbone cut, so they only exist in outline.json's
// top-level panoramaCandidates/heroCandidates arrays) ----------------------

Deno.test('mergeCandidateMemoryIds unions element ids with both candidate arrays, deduped', () => {
  const result = mergeCandidateMemoryIds(['m1', 'm2'], ['m2', 'm3'], ['m4', 'm1']);
  assertEquals(result, ['m1', 'm2', 'm3', 'm4']);
});

Deno.test('mergeCandidateMemoryIds tolerates empty candidate arrays (old outlines)', () => {
  assertEquals(mergeCandidateMemoryIds(['m1', 'm2'], [], []), ['m1', 'm2']);
});

Deno.test('mergeCandidateMemoryIds adds candidate-only ids not referenced by any element', () => {
  assertEquals(mergeCandidateMemoryIds([], ['pano-1'], ['hero-1']), ['pano-1', 'hero-1']);
});

// --- selectMediaAsset (image-kind selection incl. HEIC skip + video poster) -

Deno.test('selectMediaAsset prefers preview_object_key for a photo', () => {
  const result = selectMediaAsset({
    contentType: 'image/heic',
    objectKey: 'orig/photo.heic',
    previewObjectKey: 'previews/photo.jpg',
  });
  assertEquals(result, { key: 'previews/photo.jpg', kind: 'photo' });
});

Deno.test('selectMediaAsset uses preview as the poster for a video', () => {
  const result = selectMediaAsset({
    contentType: 'video/mp4',
    objectKey: 'orig/clip.mp4',
    previewObjectKey: 'previews/clip-poster.jpg',
  });
  assertEquals(result, { key: 'previews/clip-poster.jpg', kind: 'video-poster' });
});

Deno.test('selectMediaAsset falls back to the original for jpeg/png/webp without a preview', () => {
  assertEquals(
    selectMediaAsset({ contentType: 'image/jpeg', objectKey: 'orig/a.jpg', previewObjectKey: null }),
    { key: 'orig/a.jpg', kind: 'photo' },
  );
  assertEquals(
    selectMediaAsset({ contentType: 'image/png', objectKey: 'orig/b.png', previewObjectKey: null }),
    { key: 'orig/b.png', kind: 'photo' },
  );
  assertEquals(
    selectMediaAsset({ contentType: 'image/webp', objectKey: 'orig/c.webp', previewObjectKey: null }),
    { key: 'orig/c.webp', kind: 'photo' },
  );
});

Deno.test('selectMediaAsset skips HEIC without a preview', () => {
  assertEquals(
    selectMediaAsset({ contentType: 'image/heic', objectKey: 'orig/d.heic', previewObjectKey: null }),
    null,
  );
});

Deno.test('selectMediaAsset skips a video without a poster preview', () => {
  assertEquals(
    selectMediaAsset({ contentType: 'video/mp4', objectKey: 'orig/e.mp4', previewObjectKey: null }),
    null,
  );
});

// --- extensionFromKey / filename derivation --------------------------------

Deno.test('extensionFromKey defaults to jpg', () => {
  assertEquals(extensionFromKey('previews/photo.jpg'), 'jpg');
});

Deno.test('extensionFromKey recognizes png/webp/heic/heif', () => {
  assertEquals(extensionFromKey('a/b.png'), 'png');
  assertEquals(extensionFromKey('a/b.webp'), 'webp');
  assertEquals(extensionFromKey('a/b.heic'), 'heic');
  assertEquals(extensionFromKey('a/b.heif'), 'heif');
});

// --- print-assets (--print-assets, round-20): download-path selection -----

Deno.test('isHeicContentType recognizes heic and heif, nothing else', () => {
  assertEquals(isHeicContentType('image/heic'), true);
  assertEquals(isHeicContentType('image/heif'), true);
  assertEquals(isHeicContentType('image/jpeg'), false);
  assertEquals(isHeicContentType('image/png'), false);
  assertEquals(isHeicContentType('image/webp'), false);
  assertEquals(isHeicContentType('video/mp4'), false);
});

Deno.test('shouldDownloadOriginalForPrint is true only for a photo job with print mode on', () => {
  assertEquals(shouldDownloadOriginalForPrint(true, 'photo'), true);
  assertEquals(shouldDownloadOriginalForPrint(false, 'photo'), false);
  assertEquals(shouldDownloadOriginalForPrint(true, 'video-poster'), false);
  assertEquals(shouldDownloadOriginalForPrint(false, 'video-poster'), false);
});

Deno.test('resolvePrintPhotoExtension always plans jpg for a HEIC/HEIF original', () => {
  assertEquals(resolvePrintPhotoExtension('image/heic', 'orig/photo.heic'), 'jpg');
  assertEquals(resolvePrintPhotoExtension('image/heif', 'orig/photo.heif'), 'jpg');
});

Deno.test('resolvePrintPhotoExtension keeps the original key\'s own extension for non-HEIC content types', () => {
  assertEquals(resolvePrintPhotoExtension('image/jpeg', 'orig/photo.jpg'), 'jpg');
  assertEquals(resolvePrintPhotoExtension('image/png', 'orig/photo.png'), 'png');
  assertEquals(resolvePrintPhotoExtension('image/webp', 'orig/photo.webp'), 'webp');
});

Deno.test('mediaAssetFileName and portraitFileName derivation', () => {
  assertEquals(mediaAssetFileName('mem-1', 0, 'jpg'), 'assets/mem-1-0.jpg');
  assertEquals(mediaAssetFileName('mem-1', 2, 'webp'), 'assets/mem-1-2.webp');
  assertEquals(portraitFileName('ver-1', 'webp'), 'assets/portrait-ver-1.webp');
});

Deno.test('illustrationFileName and portraitSourceFileName derivation', () => {
  assertEquals(illustrationFileName('mem-1', 'jpg'), 'assets/mem-1-illustration.jpg');
  assertEquals(illustrationFileName('mem-2', 'webp'), 'assets/mem-2-illustration.webp');
  assertEquals(portraitSourceFileName('ver-1', 'jpg'), 'assets/portrait-ver-1-source.jpg');
});

// --- excludePortraitVersionIds (--exclude-portrait-id owner editorial cut) -

Deno.test('excludePortraitVersionIds drops exactly the excluded ids', () => {
  const versions = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }];
  assertEquals(excludePortraitVersionIds(versions, ['v2']), [{ id: 'v1' }, { id: 'v3' }]);
});

Deno.test('excludePortraitVersionIds matches the owner\'s motivating case (Mara\'s redundant 2025-01-25 pair)', () => {
  const REDUNDANT_ID = '1dbc29b2-43d0-42e0-811c-26d58959dfbd';
  const versions = [
    { id: REDUNDANT_ID, reference_date: '2025-01-25' },
    { id: 'kept-version', reference_date: '2025-02-04' },
  ];
  assertEquals(excludePortraitVersionIds(versions, [REDUNDANT_ID]), [
    { id: 'kept-version', reference_date: '2025-02-04' },
  ]);
});

Deno.test('excludePortraitVersionIds is a no-op with no excluded ids', () => {
  const versions = [{ id: 'v1' }, { id: 'v2' }];
  assertEquals(excludePortraitVersionIds(versions, []), versions);
});

Deno.test('excludePortraitVersionIds excludes multiple ids and tolerates an id not present', () => {
  const versions = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }];
  assertEquals(excludePortraitVersionIds(versions, ['v1', 'v3', 'does-not-exist']), [{ id: 'v2' }]);
});

// --- exceedsVideoPosterSizeGuard / buildFullResolutionPosterFfmpegArgs /
// videoPosterTempFileSuffix (brief item 2 -- full-resolution video posters) -

Deno.test('exceedsVideoPosterSizeGuard treats null/small sizes as within budget', () => {
  assertEquals(exceedsVideoPosterSizeGuard(null), false);
  assertEquals(exceedsVideoPosterSizeGuard(1024), false);
  assertEquals(exceedsVideoPosterSizeGuard(MAX_VIDEO_POSTER_SOURCE_BYTES), false);
});

Deno.test('exceedsVideoPosterSizeGuard trips over the 300MB guard', () => {
  assertEquals(exceedsVideoPosterSizeGuard(MAX_VIDEO_POSTER_SOURCE_BYTES + 1), true);
  assertEquals(exceedsVideoPosterSizeGuard(500 * 1024 * 1024), true);
});

Deno.test('buildFullResolutionPosterFfmpegArgs builds a full-resolution, no-scale, high-quality first-frame extraction', () => {
  const args = buildFullResolutionPosterFfmpegArgs('/tmp/original-video.mp4');
  assertEquals(args, [
    '-y',
    '-i',
    '/tmp/original-video.mp4',
    '-vframes',
    '1',
    '-q:v',
    '2',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]);
  // No `-vf scale` filter anywhere -- this path must never downscale.
  assertEquals(args.includes('-vf'), false);
});

Deno.test('buildFullResolutionPosterFfmpegArgs seeks to the given offset when non-zero', () => {
  const args = buildFullResolutionPosterFfmpegArgs('/tmp/original-video.mp4', 12.5);
  assertEquals(args, [
    '-y',
    '-ss',
    '12.5',
    '-i',
    '/tmp/original-video.mp4',
    '-vframes',
    '1',
    '-q:v',
    '2',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]);
});

Deno.test('videoPosterTempFileSuffix picks .mov for quicktime, .mp4 otherwise', () => {
  assertEquals(videoPosterTempFileSuffix('video/quicktime'), '.mov');
  assertEquals(videoPosterTempFileSuffix('video/mp4'), '.mp4');
  assertEquals(videoPosterTempFileSuffix('video/unknown-format'), '.mp4');
});

// --- candidateFramePercentiles / computeCandidateFrameOffsetsSeconds (owner
// round-7 -- multi-candidate poster-frame offset computation) --------------

Deno.test('candidateFramePercentiles gives the brief\'s 10/30/50/70/90% spread for 5 candidates', () => {
  assertEquals(candidateFramePercentiles(5), [0.1, 0.3, 0.5, 0.7, 0.9]);
});

Deno.test('candidateFramePercentiles generalizes to other counts (midpoint of each equal segment)', () => {
  // 3 segments of 1/3 each -> midpoints at 1/6, 3/6, 5/6.
  assertEquals(candidateFramePercentiles(3), [1 / 6, 3 / 6, 5 / 6]);
});

// --- owner round-8: DEFAULT_POSTER_FRAME_COUNT raised 5 -> 9 --------------

Deno.test('DEFAULT_POSTER_FRAME_COUNT is 9 (owner round-8, up from round-7\'s 5)', () => {
  assertEquals(DEFAULT_POSTER_FRAME_COUNT, 9);
});

Deno.test('candidateFramePercentiles produces 9 evenly spaced midpoints for the new default', () => {
  const percentiles = candidateFramePercentiles(9);
  assertEquals(percentiles.length, 9);
  assertEquals(
    percentiles,
    [1 / 18, 3 / 18, 5 / 18, 7 / 18, 9 / 18, 11 / 18, 13 / 18, 15 / 18, 17 / 18],
  );
  // "Evenly spaced" -- every consecutive gap is identical (1/9th of the
  // duration), same generalization the round-7 5-candidate spread relied on.
  const gaps = percentiles.slice(1).map((value, i) => value - percentiles[i]);
  for (const gap of gaps) {
    assertEquals(Math.abs(gap - 1 / 9) < 1e-9, true);
  }
});

Deno.test('computeCandidateFrameOffsetsSeconds spreads the new 9-candidate default across a known duration', () => {
  const offsets = computeCandidateFrameOffsetsSeconds(DEFAULT_POSTER_FRAME_COUNT, 180_000); // 180s clip.
  assertEquals(offsets.length, 9);
  // 1/18..17/18 of 180s -- compared with a small epsilon since 11/18*180
  // etc. isn't exactly representable in floating point.
  const expected = [10, 30, 50, 70, 90, 110, 130, 150, 170];
  offsets.forEach((value, i) => assertEquals(Math.abs(value - expected[i]) < 1e-6, true));
});

Deno.test('computeCandidateFrameOffsetsSeconds short-video (unknown-duration) fallback still produces 9 fixed odd-second offsets', () => {
  assertEquals(
    computeCandidateFrameOffsetsSeconds(DEFAULT_POSTER_FRAME_COUNT, null),
    [1, 3, 5, 7, 9, 11, 13, 15, 17],
  );
});

Deno.test('computeCandidateFrameOffsetsSeconds returns [0] for a single frame regardless of duration', () => {
  assertEquals(computeCandidateFrameOffsetsSeconds(1, 60_000), [0]);
  assertEquals(computeCandidateFrameOffsetsSeconds(1, null), [0]);
  assertEquals(computeCandidateFrameOffsetsSeconds(0, 60_000), [0]);
});

Deno.test('computeCandidateFrameOffsetsSeconds uses percentile-of-duration offsets when duration is known', () => {
  assertEquals(computeCandidateFrameOffsetsSeconds(5, 100_000), [10, 30, 50, 70, 90]);
  assertEquals(computeCandidateFrameOffsetsSeconds(3, 60_000), [10, 30, 50]);
});

Deno.test('computeCandidateFrameOffsetsSeconds falls back to fixed odd-second offsets when duration is unknown', () => {
  assertEquals(computeCandidateFrameOffsetsSeconds(5, null), [1, 3, 5, 7, 9]);
});

Deno.test('computeCandidateFrameOffsetsSeconds treats a non-positive duration as unknown', () => {
  assertEquals(computeCandidateFrameOffsetsSeconds(5, 0), [1, 3, 5, 7, 9]);
  assertEquals(computeCandidateFrameOffsetsSeconds(5, -1000), [1, 3, 5, 7, 9]);
});

Deno.test('buildScoringFrameFfmpegArgs force-scales to a fixed square and outputs raw grayscale', () => {
  const args = buildScoringFrameFfmpegArgs('/tmp/original-video.mp4', 30);
  assertEquals(args, [
    '-y',
    '-ss',
    '30',
    '-i',
    '/tmp/original-video.mp4',
    '-vframes',
    '1',
    '-vf',
    `scale=${POSTER_SCORING_FRAME_SIZE}:${POSTER_SCORING_FRAME_SIZE}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ]);
});

Deno.test('buildScoringFrameFfmpegArgs omits -ss at offset 0', () => {
  const args = buildScoringFrameFfmpegArgs('/tmp/original-video.mp4', 0);
  assertEquals(args.includes('-ss'), false);
});

// --- Poster-frame scoring (owner round-7 -- sharpness/brightness/spread on
// fabricated pixel buffers: sharp-bright beats blurry-dark, too-dark
// rejected; owner round-8 adds a region-aware center-subject-sharpness term
// -- see the "computeCellSharpnessGrid / computeCenterWeightedSubjectSharpness"
// and "region-aware subject-vs-background scenario" sections below) -------

/** Builds a flat (uniform-value) grayscale frame -- zero Laplacian variance
 * and zero midtone spread by construction, so it isolates the brightness
 * term from the other two. */
function flatFrame(width: number, height: number, value: number): GrayscaleFrame {
  return { width, height, pixels: new Array(width * height).fill(value) };
}

/** Builds a high-contrast checkerboard grayscale frame (alternating `low`/
 * `high` values) -- strong edges everywhere, so it scores high on both the
 * Laplacian-variance sharpness term and the midtone-spread term. */
function checkerboardFrame(width: number, height: number, low: number, high: number): GrayscaleFrame {
  const pixels = new Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = (x + y) % 2 === 0 ? low : high;
    }
  }
  return { width, height, pixels };
}

Deno.test('computeMeanBrightness averages a flat frame to its own value', () => {
  assertEquals(computeMeanBrightness(flatFrame(8, 8, 100)), 100);
});

Deno.test('computeLaplacianVarianceSharpness is zero for a perfectly flat frame', () => {
  assertEquals(computeLaplacianVarianceSharpness(flatFrame(8, 8, 120)), 0);
});

Deno.test('computeLaplacianVarianceSharpness is well above zero for a high-contrast checkerboard', () => {
  const sharpness = computeLaplacianVarianceSharpness(checkerboardFrame(8, 8, 50, 200));
  assertEquals(sharpness > 0, true);
});

Deno.test('computeMidtoneSpread is zero for a flat frame and positive for a checkerboard', () => {
  assertEquals(computeMidtoneSpread(flatFrame(8, 8, 120)), 0);
  assertEquals(computeMidtoneSpread(checkerboardFrame(8, 8, 50, 200)) > 0, true);
});

Deno.test('scorePosterFrameCandidate rejects a too-dark frame', () => {
  const result = scorePosterFrameCandidate(flatFrame(8, 8, 5));
  assertEquals(result.rejected, true);
  assertEquals(result.meanBrightness, 5);
});

Deno.test('scorePosterFrameCandidate rejects a too-bright (blown-out) frame', () => {
  const result = scorePosterFrameCandidate(flatFrame(8, 8, 250));
  assertEquals(result.rejected, true);
  assertEquals(result.meanBrightness, 250);
});

Deno.test('scorePosterFrameCandidate accepts a well-exposed frame', () => {
  const result = scorePosterFrameCandidate(checkerboardFrame(8, 8, 50, 200));
  assertEquals(result.rejected, false);
});

Deno.test('scorePosterFrameCandidate: a sharp, well-exposed frame outscores a blurry, dark one', () => {
  // "Blurry-dark": uniform low-brightness frame, well within the accepted
  // brightness band on its own (40 > MIN threshold) but with zero
  // sharpness/spread.
  const blurryDark = scorePosterFrameCandidate(flatFrame(8, 8, 40));
  // "Sharp-bright": high-contrast checkerboard, healthy mean brightness.
  const sharpBright = scorePosterFrameCandidate(checkerboardFrame(8, 8, 50, 200));
  assertEquals(blurryDark.rejected, false);
  assertEquals(sharpBright.rejected, false);
  assertEquals(sharpBright.score > blurryDark.score, true);
});

// --- computeCellSharpnessGrid / computeCenterWeightedSubjectSharpness
// (owner round-8 -- region-aware scoring: a 4x4 cell grid + a center-2x2
// MINIMUM subject-sharpness term, so a sharp background can no longer mask
// a blurred, usually-centered, subject) --------------------------------

/** Builds a frame where every `cellSize`x`cellSize` grid cell is flat
 * (uniform `value`) EXCEPT the `sharpCellRow`/`sharpCellCol` cell, which
 * gets a high-contrast checkerboard (`lo`/`hi`). Lets a test isolate the
 * effect of exactly one sharp (or exactly one flat) cell. */
function frameWithOneDistinctCell(
  cellSize: number,
  gridSize: number,
  value: number,
  sharpCellRow: number,
  sharpCellCol: number,
  lo: number,
  hi: number,
): GrayscaleFrame {
  const size = cellSize * gridSize;
  const pixels = new Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const cellRow = Math.floor(y / cellSize);
    for (let x = 0; x < size; x += 1) {
      const cellCol = Math.floor(x / cellSize);
      pixels[y * size + x] =
        cellRow === sharpCellRow && cellCol === sharpCellCol ? ((x + y) % 2 === 0 ? lo : hi) : value;
    }
  }
  return { width: size, height: size, pixels };
}

Deno.test('computeCellSharpnessGrid returns a POSTER_SCORING_GRID_SIZE x POSTER_SCORING_GRID_SIZE grid, uniform for a uniform-texture frame', () => {
  const grid = computeCellSharpnessGrid(checkerboardFrame(16, 16, 50, 200), POSTER_SCORING_GRID_SIZE);
  assertEquals(grid.length, POSTER_SCORING_GRID_SIZE);
  for (const row of grid) assertEquals(row.length, POSTER_SCORING_GRID_SIZE);
  // A uniform checkerboard texture scores identically in every cell.
  const flatScores = grid.flat();
  assertEquals(flatScores.every((score) => score === flatScores[0]), true);
  assertEquals(flatScores[0] > 0, true);
});

Deno.test('computeCellSharpnessGrid isolates a single sharp cell against an otherwise-flat frame', () => {
  const frame = frameWithOneDistinctCell(4, 4, 120, 2, 1, 50, 200);
  const grid = computeCellSharpnessGrid(frame, 4);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      if (row === 2 && col === 1) {
        assertEquals(grid[row][col] > 0, true);
      } else {
        assertEquals(grid[row][col], 0);
      }
    }
  }
});

Deno.test('computeCenterWeightedSubjectSharpness is 0 when every center cell is flat, even with a sharp background', () => {
  // Sharp cell is (0,0) -- an OUTER cell, not one of the center 2x2 (rows/
  // cols 1-2). The center itself is untextured.
  const frame = frameWithOneDistinctCell(4, 4, 120, 0, 0, 50, 200);
  assertEquals(computeCenterWeightedSubjectSharpness(frame), 0);
});

Deno.test('computeCenterWeightedSubjectSharpness is positive when every center cell is sharp', () => {
  // Since the term is a MINIMUM over all 4 center cells, ALL of them (not
  // just one) need texture for the result to be positive -- see
  // sharpBackgroundBlurredCenterFrame's inverse below for the "one flat
  // cell still zeroes it out" case.
  const cellSize = 4;
  const size = cellSize * 4;
  const pixels = new Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const cellRow = Math.floor(y / cellSize);
    for (let x = 0; x < size; x += 1) {
      const cellCol = Math.floor(x / cellSize);
      const isCenter = (cellRow === 1 || cellRow === 2) && (cellCol === 1 || cellCol === 2);
      pixels[y * size + x] = isCenter ? ((x + y) % 2 === 0 ? 50 : 200) : 120;
    }
  }
  const frame: GrayscaleFrame = { width: size, height: size, pixels };
  assertEquals(computeCenterWeightedSubjectSharpness(frame) > 0, true);
});

Deno.test('computeCenterWeightedSubjectSharpness takes the MINIMUM over the center cells, not a mean', () => {
  // 3 of the 4 center cells (rows/cols 1-2) are sharp; the 4th, (1,1), is
  // flat. A mean would be pulled up by the 3 sharp cells; the MIN must
  // reflect the one flat (blurred-subject) cell instead.
  const size = 16;
  const pixels = new Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const cellRow = Math.floor(y / 4);
    for (let x = 0; x < size; x += 1) {
      const cellCol = Math.floor(x / 4);
      const isFlatCenterCell = cellRow === 1 && cellCol === 1;
      const isOtherCenterCell = (cellRow === 1 || cellRow === 2) && (cellCol === 1 || cellCol === 2) && !isFlatCenterCell;
      pixels[y * size + x] = isFlatCenterCell ? 120 : isOtherCenterCell ? ((x + y) % 2 === 0 ? 50 : 200) : 120;
    }
  }
  const frame: GrayscaleFrame = { width: size, height: size, pixels };
  assertEquals(computeCenterWeightedSubjectSharpness(frame), 0);
});

// --- scorePosterFrameCandidate: region-aware subject-vs-background
// scenario (owner round-8's motivating diagnosis -- a sharp background
// dominates the OLD whole-frame-only metric even when the subject itself is
// motion-blurred; the composite score must flip the ranking) --------------

/** A frame with a sharp, high-contrast BACKGROUND (every cell except the
 * center 2x2) and a flat, textureless CENTER -- the "blurry subject in
 * front of a sharp background" failure case the owner diagnosed. */
function sharpBackgroundBlurredCenterFrame(cellSize: number): GrayscaleFrame {
  const size = cellSize * POSTER_SCORING_GRID_SIZE;
  const pixels = new Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const cellRow = Math.floor(y / cellSize);
    for (let x = 0; x < size; x += 1) {
      const cellCol = Math.floor(x / cellSize);
      const isCenter = cellRow >= 1 && cellRow <= 2 && cellCol >= 1 && cellCol <= 2;
      pixels[y * size + x] = isCenter ? 95 : (x + y) % 2 === 0 ? 40 : 150;
    }
  }
  return { width: size, height: size, pixels };
}

/** A frame with only MODERATE contrast, but spread evenly across the WHOLE
 * frame including the center -- less sharp overall than
 * `sharpBackgroundBlurredCenterFrame`, but with a genuinely in-focus
 * subject region. This is the frame round-8's scoring should now prefer. */
function moderateContrastEverywhereFrame(cellSize: number): GrayscaleFrame {
  const size = cellSize * POSTER_SCORING_GRID_SIZE;
  const pixels = new Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      pixels[y * size + x] = (x + y) % 2 === 0 ? 90 : 140;
    }
  }
  return { width: size, height: size, pixels };
}

Deno.test('scorePosterFrameCandidate: a sharp-background/blurred-center frame has zero subject sharpness', () => {
  const result = scorePosterFrameCandidate(sharpBackgroundBlurredCenterFrame(8));
  assertEquals(result.subjectSharpness, 0);
  assertEquals(result.rejected, false); // well-exposed on its own -- this is a composition failure, not a brightness one.
});

Deno.test('scorePosterFrameCandidate: region-aware score flips the ranking -- moderate-everywhere (sharp subject) beats sharp-background/blurred-center', () => {
  const sharpBackgroundBlurredCenter = scorePosterFrameCandidate(sharpBackgroundBlurredCenterFrame(8));
  const moderateEverywhere = scorePosterFrameCandidate(moderateContrastEverywhereFrame(8));

  // The OLD whole-frame-only metric (sharpness + midtoneSpread, no subject
  // term) would still rank the sharp-background frame higher -- confirming
  // this scenario really does exercise the diagnosed blind spot.
  const oldMetric = (s: { sharpness: number; midtoneSpread: number }) => s.sharpness + s.midtoneSpread;
  assertEquals(oldMetric(sharpBackgroundBlurredCenter) > oldMetric(moderateEverywhere), true);

  // The NEW composite score (with the weighted subject term) flips it: the
  // frame with a real in-focus subject wins.
  assertEquals(moderateEverywhere.score > sharpBackgroundBlurredCenter.score, true);
});

Deno.test('pickBestPosterFrameIndex prefers the sharp-subject frame over the sharp-background/blurred-center frame', () => {
  const sharpBackgroundBlurredCenter = sharpBackgroundBlurredCenterFrame(8);
  const moderateEverywhere = moderateContrastEverywhereFrame(8);
  assertEquals(pickBestPosterFrameIndex([sharpBackgroundBlurredCenter, moderateEverywhere]), 1);
  assertEquals(pickBestPosterFrameIndex([moderateEverywhere, sharpBackgroundBlurredCenter]), 0);
});

Deno.test('SUBJECT_SHARPNESS_WEIGHT is a positive finite weight', () => {
  assertEquals(SUBJECT_SHARPNESS_WEIGHT > 0, true);
  assertEquals(Number.isFinite(SUBJECT_SHARPNESS_WEIGHT), true);
});

Deno.test('pickBestPosterFrameIndex picks the sharp-bright candidate over a rejected too-dark one', () => {
  const tooDark = flatFrame(8, 8, 5);
  const sharpBright = checkerboardFrame(8, 8, 50, 200);
  assertEquals(pickBestPosterFrameIndex([tooDark, sharpBright]), 1);
  assertEquals(pickBestPosterFrameIndex([sharpBright, tooDark]), 0);
});

Deno.test('pickBestPosterFrameIndex picks the least-bad candidate when every candidate is rejected', () => {
  const veryDark = flatFrame(8, 8, 2);
  const lessDark = flatFrame(8, 8, 20);
  // Both rejected (below MIN_ACCEPTABLE_MEAN_BRIGHTNESS), but the scoring
  // must still resolve deterministically rather than treat them as tied.
  assertEquals(pickBestPosterFrameIndex([veryDark, lessDark]), 1);
});

Deno.test('pickBestPosterFrameIndex throws on an empty candidate list', () => {
  assertThrows(() => pickBestPosterFrameIndex([]), Error, 'requires at least one candidate frame');
});

// --- withRetries / objectKeyBasename / buildDownloadFailure /
// summarizeDownloadFailures (reliability fix -- retry every R2 fetch, never
// crash the run on one, record + skip whatever still fails) ----------------

/** No-op sleep for tests -- records the requested backoffs without actually
 * waiting, so a 3-attempt retry test runs in microseconds instead of over a
 * second (250ms + 1000ms). */
function fakeSleepRecorder(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

Deno.test('withRetries returns the first successful result without retrying', async () => {
  const { sleep, calls } = fakeSleepRecorder();
  let attempts = 0;
  const result = await withRetries(
    () => {
      attempts += 1;
      return Promise.resolve('ok');
    },
    { sleep },
  );
  assertEquals(result, 'ok');
  assertEquals(attempts, 1);
  assertEquals(calls, []);
});

Deno.test('withRetries retries on failure and returns the eventual success', async () => {
  const { sleep, calls } = fakeSleepRecorder();
  let attempts = 0;
  const result = await withRetries(
    () => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error(`transient failure #${attempts}`));
      }
      return Promise.resolve('ok on third try');
    },
    { sleep, backoffsMs: [250, 1000] },
  );
  assertEquals(result, 'ok on third try');
  assertEquals(attempts, 3);
  // Backoff before the 2nd and 3rd attempts, matching the brief's schedule.
  assertEquals(calls, [250, 1000]);
});

Deno.test('withRetries exhausts the schedule and rethrows the last error', async () => {
  const { sleep, calls } = fakeSleepRecorder();
  let attempts = 0;
  await assertRejects(
    () =>
      withRetries(
        () => {
          attempts += 1;
          return Promise.reject(new Error(`always fails #${attempts}`));
        },
        { sleep, backoffsMs: [250, 1000] },
      ),
    Error,
    'always fails #3',
  );
  assertEquals(attempts, 3); // 1 initial attempt + 2 retries.
  assertEquals(calls, [250, 1000]);
});

Deno.test('objectKeyBasename strips a user/family/memory id path prefix', () => {
  assertEquals(
    objectKeyBasename('user-123/family/member-456/portraits/version-789/photo.jpg'),
    'photo.jpg',
  );
  assertEquals(objectKeyBasename('previews/memory-1/clip-poster.jpg'), 'clip-poster.jpg');
});

Deno.test('objectKeyBasename handles a bare filename and a trailing slash', () => {
  assertEquals(objectKeyBasename('photo.jpg'), 'photo.jpg');
  assertEquals(objectKeyBasename('a/b/c/'), 'c');
});

Deno.test('buildDownloadFailure records the kind + basename-only object key', () => {
  assertEquals(
    buildDownloadFailure('media', 'user-123/family/member-456/media/photo.jpg'),
    { kind: 'media', objectKey: 'photo.jpg' },
  );
});

Deno.test('summarizeDownloadFailures stays below threshold for a handful of failures in a big run', () => {
  const failures = [buildDownloadFailure('media', 'a/b.jpg')];
  const summary = summarizeDownloadFailures(failures, 100);
  assertEquals(summary.failedCount, 1);
  assertEquals(summary.attempted, 100);
  assertEquals(summary.failureRate, 0.01);
  assertEquals(summary.shouldExitNonZero, false);
});

Deno.test('summarizeDownloadFailures trips the exit threshold above 5%', () => {
  const failures = Array.from({ length: 6 }, (_, i) => buildDownloadFailure('media', `a/${i}.jpg`));
  const summary = summarizeDownloadFailures(failures, 100);
  assertEquals(summary.failedCount, 6);
  assertEquals(summary.failureRate, 0.06);
  assertEquals(summary.shouldExitNonZero, true);
});

Deno.test('summarizeDownloadFailures treats exactly the threshold as passing (strictly greater-than)', () => {
  const failures = Array.from({ length: 5 }, (_, i) => buildDownloadFailure('media', `a/${i}.jpg`));
  const summary = summarizeDownloadFailures(failures, 100);
  assertEquals(summary.failureRate, DOWNLOAD_FAILURE_EXIT_THRESHOLD);
  assertEquals(summary.shouldExitNonZero, false);
});

Deno.test('summarizeDownloadFailures handles zero attempted downloads without dividing by zero', () => {
  const summary = summarizeDownloadFailures([], 0);
  assertEquals(summary.failureRate, 0);
  assertEquals(summary.shouldExitNonZero, false);
});

// --- isClockSkewAuthError (hardening fix -- narrowly-scoped auth-error
// classification for the one-time session-recreate retry on the first DB
// read; other DB errors must NOT match) ------------------------------------

Deno.test('isClockSkewAuthError matches "JWT issued at future"', () => {
  assertEquals(isClockSkewAuthError('Failed to load memories: JWT issued at future'), true);
});

Deno.test('isClockSkewAuthError matches "JWT expired", case-insensitively', () => {
  assertEquals(isClockSkewAuthError('jwt expired'), true);
  assertEquals(isClockSkewAuthError('JWT EXPIRED'), true);
});

Deno.test('isClockSkewAuthError does not match an unrelated DB error', () => {
  assertEquals(isClockSkewAuthError('Failed to load memories: permission denied for table memories'), false);
  assertEquals(isClockSkewAuthError('relation "memories" does not exist'), false);
});

Deno.test('isClockSkewAuthError handles null/undefined/empty messages', () => {
  assertEquals(isClockSkewAuthError(null), false);
  assertEquals(isClockSkewAuthError(undefined), false);
  assertEquals(isClockSkewAuthError(''), false);
});

// --- subtractOneDay / mapScopeKind / buildManifestScope --------------------

Deno.test('subtractOneDay handles plain, month, and year boundaries', () => {
  assertEquals(subtractOneDay('2024-06-15'), '2024-06-14');
  assertEquals(subtractOneDay('2024-03-01'), '2024-02-29'); // leap year
  assertEquals(subtractOneDay('2023-03-01'), '2023-02-28'); // non-leap year
  assertEquals(subtractOneDay('2024-01-01'), '2023-12-31');
});

Deno.test('mapScopeKind maps custom-range to custom, passes through the rest', () => {
  assertEquals(mapScopeKind('age-year'), 'age-year');
  assertEquals(mapScopeKind('calendar-year'), 'calendar-year');
  assertEquals(mapScopeKind('custom-range'), 'custom');
});

Deno.test('buildManifestScope derives an inclusive end from the exclusive window', () => {
  const scope = buildManifestScope('custom-range', {
    start: '2023-06-01',
    endExclusive: '2023-12-25',
    label: '2023-06-01 to 2023-12-24',
  });
  assertEquals(scope, { kind: 'custom', label: '2023-06-01 to 2023-12-24', start: '2023-06-01', end: '2023-12-24' });
});

// --- slugify / defaultOutDir ------------------------------------------------

Deno.test('slugify lowercases and hyphenates', () => {
  assertEquals(slugify('Year One'), 'year-one');
  assertEquals(slugify('2023-06-01 to 2023-12-24'), '2023-06-01-to-2023-12-24');
});

Deno.test('defaultOutDir combines first name + scope label', () => {
  assertEquals(defaultOutDir('Enzo Rivera', 'Year One'), 'book-renderer/book-data/enzo-year-one/');
  assertEquals(defaultOutDir('Mara', '2024'), 'book-renderer/book-data/mara-2024/');
});

// --- buildTaggedMember / buildManifestMilestone / buildManifestAsset -------

Deno.test('buildTaggedMember classifies a young child as isChild', () => {
  const result = buildTaggedMember({ name: 'Enzo', dateOfBirth: '2023-01-01', memoryDate: '2024-01-01' });
  assertEquals(result, { name: 'Enzo', isChild: true });
});

Deno.test('buildTaggedMember classifies an adult as not isChild', () => {
  const result = buildTaggedMember({ name: 'Mom', dateOfBirth: '1990-01-01', memoryDate: '2024-01-01' });
  assertEquals(result, { name: 'Mom', isChild: false });
});

Deno.test('buildTaggedMember with no date_of_birth is unknown -> not isChild', () => {
  const result = buildTaggedMember({ name: 'Grandpa', dateOfBirth: null, memoryDate: '2024-01-01' });
  assertEquals(result, { name: 'Grandpa', isChild: false });
});

Deno.test('buildManifestMilestone falls back to the raw id when unknown', () => {
  const result = buildManifestMilestone('totally-unknown-milestone', 'a detail');
  assertEquals(result, { id: 'totally-unknown-milestone', name: 'totally-unknown-milestone', detail: 'a detail' });
});

Deno.test('buildManifestAsset prefers the DB aspect ratio, falls back to width/height', () => {
  assertEquals(
    buildManifestAsset({ file: 'assets/a.jpg', width: 1000, height: 500, kind: 'photo', durationMs: null, dbAspectRatio: 1.5 }),
    { file: 'assets/a.jpg', width: 1000, height: 500, aspectRatio: 1.5, kind: 'photo', durationMs: null },
  );
  assertEquals(
    buildManifestAsset({ file: 'assets/b.jpg', width: 1000, height: 500, kind: 'video-poster', durationMs: 4000, dbAspectRatio: null }),
    { file: 'assets/b.jpg', width: 1000, height: 500, aspectRatio: 2, kind: 'video-poster', durationMs: 4000 },
  );
});

// --- shouldMeasureOriginalDimensions (owner round-8 -- original dimensions
// for EVERY photo asset, not just a panorama/hero candidate memory) --------

Deno.test('shouldMeasureOriginalDimensions is true for a photo asset', () => {
  assertEquals(shouldMeasureOriginalDimensions('photo'), true);
});

Deno.test('shouldMeasureOriginalDimensions is false for a video-poster asset', () => {
  assertEquals(shouldMeasureOriginalDimensions('video-poster'), false);
});

// --- buildManifestAsset originalWidth/originalHeight (integration gap 2 --
// panorama/hero candidates need real ORIGINAL dimensions, since the
// exported preview file's own width/height can never clear those gates) ----

Deno.test('buildManifestAsset records originalWidth/originalHeight when originalDimensions is given', () => {
  const result = buildManifestAsset({
    file: 'assets/pano-0.jpg',
    width: 1280,
    height: 720,
    kind: 'photo',
    durationMs: null,
    dbAspectRatio: null,
    originalDimensions: { width: 4032, height: 3024 },
  });
  assertEquals(result.originalWidth, 4032);
  assertEquals(result.originalHeight, 3024);
  // Preview-derived fields are untouched by the original-dimensions add-on.
  assertEquals(result.width, 1280);
  assertEquals(result.height, 720);
});

Deno.test('buildManifestAsset omits originalWidth/originalHeight entirely when not given', () => {
  const result = buildManifestAsset({
    file: 'assets/c.jpg',
    width: 1000,
    height: 500,
    kind: 'photo',
    durationMs: null,
    dbAspectRatio: null,
  });
  assertEquals('originalWidth' in result, false);
  assertEquals('originalHeight' in result, false);
});

Deno.test('buildManifestAsset omits originalWidth/originalHeight when originalDimensions is explicitly null', () => {
  const result = buildManifestAsset({
    file: 'assets/d.jpg',
    width: 1000,
    height: 500,
    kind: 'photo',
    durationMs: null,
    dbAspectRatio: null,
    originalDimensions: null,
  });
  assertEquals('originalWidth' in result, false);
  assertEquals('originalHeight' in result, false);
});

Deno.test('buildManifestPortrait derives ageLabel from date of birth and carries the source photo file', () => {
  const result = buildManifestPortrait({
    file: 'assets/portrait-v1.webp',
    sourceFile: 'assets/portrait-v1-source.jpg',
    referenceDate: '2024-06-15',
    dateOfBirth: '2023-06-15',
  });
  assertEquals(result.file, 'assets/portrait-v1.webp');
  assertEquals(result.sourceFile, 'assets/portrait-v1-source.jpg');
  assertEquals(result.date, '2024-06-15');
  assertEquals(typeof result.ageLabel, 'string');
  assertEquals(result.ageLabel.length > 0, true);
});

// --- buildManifestIllustration (brief item 1 -- memories.illustration_key) -

Deno.test('buildManifestIllustration computes aspect ratio from width/height', () => {
  assertEquals(
    buildManifestIllustration({ file: 'assets/m1-illustration.jpg', width: 1000, height: 500 }),
    { file: 'assets/m1-illustration.jpg', width: 1000, height: 500, aspectRatio: 2 },
  );
});

Deno.test('buildManifestIllustration falls back to aspectRatio 1 for a zero height', () => {
  assertEquals(
    buildManifestIllustration({ file: 'assets/m2-illustration.jpg', width: 800, height: 0 }),
    { file: 'assets/m2-illustration.jpg', width: 800, height: 0, aspectRatio: 1 },
  );
});

// --- buildManifestMemory (manifest assembly from fabricated rows) ----------

Deno.test('buildManifestMemory assembles the full per-memory shape, including an illustration', () => {
  const result = buildManifestMemory({
    memory: {
      memory_date: '2024-03-10',
      memory_type: 'media',
      content: '  First steps in the backyard!  ',
      emotion: 'joy',
      topics: ['first-steps', 'backyard'],
    },
    assets: [{ file: 'assets/m1-0.jpg', width: 800, height: 600, aspectRatio: 800 / 600, kind: 'photo', durationMs: null }],
    milestones: [{ id: 'first-steps', name: 'First steps', detail: 'in the backyard' }],
    taggedMembers: [{ name: 'Enzo', isChild: true }],
    engagement: 3,
    illustration: { file: 'assets/m1-illustration.jpg', width: 1024, height: 1024, aspectRatio: 1 },
    shareToken: null,
  });

  assertEquals(result, {
    date: '2024-03-10',
    type: 'media',
    text: 'First steps in the backyard!',
    emotion: 'joy',
    topics: ['first-steps', 'backyard'],
    milestones: [{ id: 'first-steps', name: 'First steps', detail: 'in the backyard' }],
    engagement: 3,
    taggedMembers: [{ name: 'Enzo', isChild: true }],
    assets: [{ file: 'assets/m1-0.jpg', width: 800, height: 600, aspectRatio: 800 / 600, kind: 'photo', durationMs: null }],
    illustration: { file: 'assets/m1-illustration.jpg', width: 1024, height: 1024, aspectRatio: 1 },
    shareToken: null,
  });
});

Deno.test('buildManifestMemory threads a minted share token straight through, verbatim', () => {
  const result = buildManifestMemory({
    memory: {
      memory_date: '2024-03-10',
      memory_type: 'media',
      content: 'A video of first steps.',
      emotion: 'joy',
      topics: [],
    },
    assets: [{ file: 'assets/m1-0.jpg', width: 800, height: 600, aspectRatio: 800 / 600, kind: 'video-poster', durationMs: 9000 }],
    milestones: [],
    taggedMembers: [],
    engagement: 0,
    illustration: null,
    shareToken: 'aB3xQ9zK1mN7pR5tW2yC4d',
  });
  assertEquals(result.shareToken, 'aB3xQ9zK1mN7pR5tW2yC4d');
});

Deno.test('buildManifestMemory normalizes blank content to null text and defaults illustration to null', () => {
  const result = buildManifestMemory({
    memory: { memory_date: '2024-03-10', memory_type: 'text_only', content: '   ', emotion: null, topics: [] },
    assets: [],
    milestones: [],
    taggedMembers: [],
    engagement: 0,
    illustration: null,
    shareToken: null,
  });
  assertEquals(result.text, null);
  assertEquals(result.illustration, null);
  assertEquals(result.shareToken, null);
});

// --- buildManifest (top-level assembly) ------------------------------------

Deno.test('buildManifest assembles the full BookManifest shape, including language + downloadFailures', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');
  const result = buildManifest({
    child: { id: 'child-1', name: 'Enzo' },
    scope: { kind: 'age-year', label: 'Year One', start: '2023-06-01', end: '2024-05-31' },
    outlineRun: 'child-1-2026-08-26T10-00-00-000Z',
    memories: {},
    portraits: [],
    language: 'es',
    downloadFailures: [{ kind: 'media', objectKey: 'photo.jpg' }],
    now,
  });

  assertEquals(result, {
    child: { id: 'child-1', name: 'Enzo' },
    scope: { kind: 'age-year', label: 'Year One', start: '2023-06-01', end: '2024-05-31' },
    generatedAt: '2026-08-26T12:00:00.000Z',
    outlineRun: 'child-1-2026-08-26T10-00-00-000Z',
    memories: {},
    portraits: [],
    language: 'es',
    downloadFailures: [{ kind: 'media', objectKey: 'photo.jpg' }],
    assetMode: 'preview',
  });
});

Deno.test('buildManifest records assetMode "print" when explicitly given (round-20, --print-assets)', () => {
  const result = buildManifest({
    child: { id: 'child-1', name: 'Enzo' },
    scope: { kind: 'age-year', label: 'Year One', start: '2023-06-01', end: '2024-05-31' },
    outlineRun: 'child-1-2026-08-26T10-00-00-000Z',
    memories: {},
    portraits: [],
    language: 'en',
    downloadFailures: [],
    assetMode: 'print',
    now: new Date('2026-08-26T12:00:00.000Z'),
  });
  assertEquals(result.assetMode, 'print');
});

Deno.test('PRINT_ASSET_HEIC_JPEG_QUALITY is a near-lossless JPEG quality, above the preview quality', () => {
  // Sanity bound only -- this file has no access to backfill-media-previews.ts's
  // own PREVIEW_JPEG_QUALITY (80) constant, so this just pins "high" and
  // "sharp's 1-100 scale" rather than duplicating that import across files.
  assertEquals(PRINT_ASSET_HEIC_JPEG_QUALITY > 80, true);
  assertEquals(PRINT_ASSET_HEIC_JPEG_QUALITY <= 100, true);
});

// --- parseArgs: --language --------------------------------------------------

Deno.test('parseArgs defaults language to "en" when --language is absent', () => {
  const options = parseArgs(['--outline-run', 'some-dir']);
  assertEquals(options.language, 'en');
});

Deno.test('parseArgs reads --language es', () => {
  const options = parseArgs(['--outline-run', 'some-dir', '--language', 'es']);
  assertEquals(options.language, 'es');
});

Deno.test('parseArgs falls back to "en" for an unrecognized --language value', () => {
  const options = parseArgs(['--language', 'fr']);
  assertEquals(options.language, 'en');
});

// --- parseArgs: languageExplicit (round-18) --------------------------------
// distinguishes "the flag was never passed" from "an explicit --language en"
// -- both otherwise leave `language` at DEFAULT_LANGUAGE ("en"), but only
// the former should let main() apply the outline.json default.

Deno.test('parseArgs: languageExplicit is false when --language was never passed', () => {
  const options = parseArgs(['--outline-run', 'some-dir']);
  assertEquals(options.languageExplicit, false);
});

Deno.test('parseArgs: languageExplicit is true for an explicit --language es', () => {
  const options = parseArgs(['--outline-run', 'some-dir', '--language', 'es']);
  assertEquals(options.languageExplicit, true);
});

Deno.test('parseArgs: languageExplicit is true even for an explicit --language en (still distinguishable from "never passed")', () => {
  const options = parseArgs(['--outline-run', 'some-dir', '--language', 'en']);
  assertEquals(options.languageExplicit, true);
  assertEquals(options.language, 'en');
});

// --- coerceManifestLanguage / resolveManifestLanguageDefault (round-18) ----

Deno.test('coerceManifestLanguage: maps any "es" primary subtag to "es"', () => {
  assertEquals(coerceManifestLanguage('es'), 'es');
  assertEquals(coerceManifestLanguage('es-MX'), 'es');
  assertEquals(coerceManifestLanguage('ES-us'), 'es');
});

Deno.test('coerceManifestLanguage: everything else (including unset, "en", and an unrelated language) maps to "en"', () => {
  assertEquals(coerceManifestLanguage(undefined), 'en');
  assertEquals(coerceManifestLanguage('en'), 'en');
  assertEquals(coerceManifestLanguage('fr'), 'en');
  assertEquals(coerceManifestLanguage('pt-BR'), 'en');
});

Deno.test('resolveManifestLanguageDefault: an explicit CLI language always wins over the outline\'s own resolution', () => {
  assertEquals(resolveManifestLanguageDefault(true, 'en', 'es'), 'en');
  assertEquals(resolveManifestLanguageDefault(true, 'es', undefined), 'es');
});

Deno.test('resolveManifestLanguageDefault: when --language was not passed, defaults from the outline\'s resolved language', () => {
  assertEquals(resolveManifestLanguageDefault(false, 'en', 'es'), 'es');
  assertEquals(resolveManifestLanguageDefault(false, 'en', 'es-MX'), 'es');
});

Deno.test('resolveManifestLanguageDefault: when --language was not passed and the outline has no language field (old runs), THROWS instead of silently defaulting (owner incident 2026-08-29: two Spanish books shipped to print with English furniture via this fallback)', () => {
  let threw = false;
  try {
    resolveManifestLanguageDefault(false, 'en', undefined);
  } catch (error) {
    threw = true;
    if (!(error instanceof Error) || !error.message.includes('--language')) {
      throw new Error('expected the guard error to instruct passing --language');
    }
  }
  if (!threw) throw new Error('expected resolveManifestLanguageDefault to throw for a language-less outline with no explicit flag');
});

// --- parseArgs: --exclude-portrait-id (repeatable) --------------------------

Deno.test('parseArgs defaults excludePortraitIds to [] when absent', () => {
  const options = parseArgs(['--outline-run', 'some-dir']);
  assertEquals(options.excludePortraitIds, []);
});

Deno.test('parseArgs collects repeated --exclude-portrait-id flags in order', () => {
  const options = parseArgs([
    '--outline-run',
    'some-dir',
    '--exclude-portrait-id',
    '1dbc29b2-43d0-42e0-811c-26d58959dfbd',
    '--exclude-portrait-id',
    'another-version-id',
  ]);
  assertEquals(options.excludePortraitIds, ['1dbc29b2-43d0-42e0-811c-26d58959dfbd', 'another-version-id']);
});

// --- parseArgs: --print-assets (round-20) ----------------------------------

Deno.test('parseArgs defaults printAssets to false when --print-assets is absent', () => {
  const options = parseArgs(['--outline-run', 'some-dir']);
  assertEquals(options.printAssets, false);
});

Deno.test('parseArgs sets printAssets to true when --print-assets is passed (no value consumed)', () => {
  const options = parseArgs(['--outline-run', 'some-dir', '--print-assets']);
  assertEquals(options.printAssets, true);
  assertEquals(options.outlineRun, 'some-dir');
});

Deno.test('parseArgs: --print-assets does not swallow the next flag as its own value', () => {
  const options = parseArgs(['--print-assets', '--outline-run', 'some-dir', '--language', 'es']);
  assertEquals(options.printAssets, true);
  assertEquals(options.outlineRun, 'some-dir');
  assertEquals(options.language, 'es');
});

Deno.test('CLI_USAGE documents --print-assets', () => {
  assertMatch(CLI_USAGE, /--print-assets/);
});

// --- parseArgs: unknown-argument rejection guard (same hardening fix as the
// outline/tagging scripts -- never silently drop an unrecognized token) ----

Deno.test('parseArgs throws on an unrecognized argument, naming the offending token + CLI_USAGE', () => {
  assertThrows(
    () => parseArgs(['--outline-run', 'some-dir', '--totally-made-up-flag', 'value']),
    Error,
    `Unknown argument: "--totally-made-up-flag"\n${CLI_USAGE}`,
  );
});

Deno.test('parseArgs throws on a stray positional token that matches no flag', () => {
  assertThrows(() => parseArgs(['some-mangled-string-with-flags-inside']), Error, 'Unknown argument:');
});

// --- parseOutlineJson --------------------------------------------------------

const VALID_OUTLINE = {
  runId: 'run-1',
  child: { id: 'child-1', name: 'Enzo' },
  scope: { type: 'age-year', ageYear: 1 },
  window: { start: '2023-06-01', endExclusive: '2024-06-01', label: 'Year One' },
  elements: [
    { id: 'cover', kind: 'cover', memoryIds: [] },
    { id: 'backbone:2023-06', kind: 'backbone', memoryIds: ['m1'] },
  ],
};

Deno.test('parseOutlineJson accepts a well-formed outline', () => {
  const result = parseOutlineJson(VALID_OUTLINE);
  assertEquals(result.runId, 'run-1');
  assertEquals(result.child, { id: 'child-1', name: 'Enzo' });
  assertEquals(result.scope, { type: 'age-year' });
  assertEquals(result.window, { start: '2023-06-01', endExclusive: '2024-06-01', label: 'Year One' });
  assertEquals(result.elements.length, 2);
});

// --- parseOutlineJson: panoramaCandidates/heroCandidates (integration gap 1)

Deno.test('parseOutlineJson defaults panoramaCandidates/heroCandidates to [] when absent (old outlines)', () => {
  const result = parseOutlineJson(VALID_OUTLINE);
  assertEquals(result.panoramaCandidates, []);
  assertEquals(result.heroCandidates, []);
});

Deno.test('parseOutlineJson reads panoramaCandidates/heroCandidates when present', () => {
  const result = parseOutlineJson({
    ...VALID_OUTLINE,
    panoramaCandidates: ['m5', 'm6'],
    heroCandidates: ['m7'],
  });
  assertEquals(result.panoramaCandidates, ['m5', 'm6']);
  assertEquals(result.heroCandidates, ['m7']);
});

Deno.test('parseOutlineJson throws when panoramaCandidates is present but not an array', () => {
  assertThrows(
    () => parseOutlineJson({ ...VALID_OUTLINE, panoramaCandidates: 'm5' }),
    Error,
    '"panoramaCandidates" must be an array when present',
  );
});

Deno.test('parseOutlineJson throws when heroCandidates contains a non-string id', () => {
  assertThrows(
    () => parseOutlineJson({ ...VALID_OUTLINE, heroCandidates: ['m7', 42] }),
    Error,
    'heroCandidates[1]',
  );
});

// --- parseOutlineJson: language (round-18) ---------------------------------

Deno.test('parseOutlineJson: language is undefined when absent (old outlines predate this field)', () => {
  const result = parseOutlineJson(VALID_OUTLINE);
  assertEquals(result.language, undefined);
});

Deno.test('parseOutlineJson: reads a present language field', () => {
  const result = parseOutlineJson({ ...VALID_OUTLINE, language: 'es-MX' });
  assertEquals(result.language, 'es-MX');
});

Deno.test('parseOutlineJson: throws when language is present but not a string', () => {
  assertThrows(
    () => parseOutlineJson({ ...VALID_OUTLINE, language: 42 }),
    Error,
    '"language" must be a string when present',
  );
});

Deno.test('parseOutlineJson throws on a non-object', () => {
  assertThrows(() => parseOutlineJson(null), Error, 'outline.json is not a JSON object');
  assertThrows(() => parseOutlineJson('nope'), Error, 'outline.json is not a JSON object');
});

Deno.test('parseOutlineJson throws when child is missing', () => {
  const { child: _child, ...rest } = VALID_OUTLINE;
  assertThrows(() => parseOutlineJson(rest), Error, 'outline.json missing "child"');
});

Deno.test('parseOutlineJson throws when window.endExclusive is missing', () => {
  const broken = { ...VALID_OUTLINE, window: { start: '2023-06-01', label: 'Year One' } };
  assertThrows(() => parseOutlineJson(broken), Error, 'window.endExclusive');
});

Deno.test('parseOutlineJson throws when an element is missing memoryIds', () => {
  const broken = { ...VALID_OUTLINE, elements: [{ id: 'cover', kind: 'cover' }] };
  assertThrows(() => parseOutlineJson(broken), Error, 'memoryIds');
});

// --- generateShareToken (Round-19 -- revocable QR share tokens) -----------

Deno.test('generateShareToken produces a 22-char base62 string by default', () => {
  const token = generateShareToken();
  assertEquals(token.length, SHARE_TOKEN_LENGTH);
  assertMatch(token, /^[0-9A-Za-z]{22}$/);
});

Deno.test('generateShareToken draws from a real (non-repeating) entropy source across many calls', () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 500; i += 1) tokens.add(generateShareToken());
  assertEquals(tokens.size, 500); // no collisions across 500 samples.
});

Deno.test('generateShareToken applies rejection sampling: bytes >= 248 are discarded, not reduced mod 62', () => {
  // 248 (= 62*4, the rejection ceiling) must be skipped entirely rather than
  // folded into the alphabet via `248 % 62 === 0` -- if it weren't, this
  // fixed byte queue would start with alphabet[0] ('0'), not alphabet[1].
  const queue = [248, 0, 1, 61, ...Array(SHARE_TOKEN_LENGTH - 3).fill(2)];
  let cursor = 0;
  const fakeRandomBytes = (count: number) => {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) bytes[i] = queue[cursor++] ?? 2;
    return bytes;
  };
  const token = generateShareToken(fakeRandomBytes);
  // '248' rejected; '0'->'0', '1'->'1', '61'->'z' (last char of the base62
  // alphabet); every remaining byte is '2'->'2', spanning a second
  // randomBytes() call once the first batch's one rejection leaves the
  // token one character short -- exercising the "keep pulling more bytes
  // until full" loop, not just a single pass.
  assertEquals(token, '01z' + '2'.repeat(19));
  assertEquals(token.length, SHARE_TOKEN_LENGTH);
});

Deno.test('generateShareToken never emits a character for a rejected byte', () => {
  // Every byte in [248, 255] rejected; only the trailing valid bytes count.
  const queue = [255, 254, 253, 252, 251, 250, 249, 248, 5, 5];
  let cursor = 0;
  const fakeRandomBytes = (count: number) => {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) bytes[i] = queue[cursor++] ?? 5;
    return bytes;
  };
  const token = generateShareToken(fakeRandomBytes);
  assertEquals(token, '5'.repeat(SHARE_TOKEN_LENGTH));
});

// --- memoryNeedsShareToken (QR-eligibility, mirrors book-renderer's own
// isVideoAsset/isAudioMemory rules) -----------------------------------------

Deno.test('memoryNeedsShareToken: an audio memory always needs a token', () => {
  assertEquals(memoryNeedsShareToken('audio', []), true);
});

Deno.test('memoryNeedsShareToken: a media memory with a video-poster asset needs a token', () => {
  assertEquals(memoryNeedsShareToken('media', [{ kind: 'video-poster' }]), true);
});

Deno.test('memoryNeedsShareToken: a media memory with only photo assets needs no token', () => {
  assertEquals(memoryNeedsShareToken('media', [{ kind: 'photo' }]), false);
});

Deno.test('memoryNeedsShareToken: a media memory with a mix still needs a token (any video-poster asset qualifies)', () => {
  assertEquals(memoryNeedsShareToken('media', [{ kind: 'photo' }, { kind: 'video-poster' }]), true);
});

Deno.test('memoryNeedsShareToken: a media memory with no assets needs no token', () => {
  assertEquals(memoryNeedsShareToken('media', []), false);
});

Deno.test('memoryNeedsShareToken: text memory types never need a token', () => {
  assertEquals(memoryNeedsShareToken('text_illustration', []), false);
  assertEquals(memoryNeedsShareToken('text_only', []), false);
});
