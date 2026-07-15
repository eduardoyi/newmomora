import { assertEquals } from 'jsr:@std/assert@1';

import { deriveMediaPreviewKey } from './backfill-media-previews.ts';
import {
  buildFfmpegPosterArgs,
  parseContentRangeTotalBytes,
  VIDEO_POSTER_FFMPEG_QUALITY,
  VIDEO_POSTER_MAX_DIMENSION,
} from './backfill-video-posters.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';

// --- buildFfmpegPosterArgs --------------------------------------------------

Deno.test('buildFfmpegPosterArgs grabs the first frame, scales without upscaling, and outputs a single JPEG to stdout', () => {
  const url = 'https://r2.example.com/video.mp4?sig=abc';
  const args = buildFfmpegPosterArgs(url);

  assertEquals(args, [
    '-y',
    '-i',
    url,
    '-vframes',
    '1',
    '-vf',
    `scale='min(iw,${VIDEO_POSTER_MAX_DIMENSION})':'min(ih,${VIDEO_POSTER_MAX_DIMENSION})':force_original_aspect_ratio=decrease`,
    '-q:v',
    VIDEO_POSTER_FFMPEG_QUALITY,
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]);
});

Deno.test('buildFfmpegPosterArgs uses a min()-bounded box, not a fixed NxN box, so small sources are never upscaled', () => {
  const args = buildFfmpegPosterArgs('https://example.com/small.mp4');
  const scaleArg = args[args.indexOf('-vf') + 1];

  // A fixed "scale=1280:1280:force_original_aspect_ratio=decrease" box
  // still upscales a source smaller than 1280 on both edges (verified
  // empirically against a real ffmpeg binary while building this script).
  // The min(iw,N)/min(ih,N) box caps the *target* itself at the source's
  // own dimensions, so decrease-mode scaling can never exceed them.
  assertEquals(scaleArg.includes(`min(iw,${VIDEO_POSTER_MAX_DIMENSION})`), true);
  assertEquals(scaleArg.includes(`min(ih,${VIDEO_POSTER_MAX_DIMENSION})`), true);
  assertEquals(scaleArg.includes('force_original_aspect_ratio=decrease'), true);
});

// --- parseContentRangeTotalBytes -------------------------------------------

Deno.test('parseContentRangeTotalBytes parses a standard Content-Range header', () => {
  assertEquals(parseContentRangeTotalBytes('bytes 0-0/12345'), 12345);
});

Deno.test('parseContentRangeTotalBytes returns null for a missing header', () => {
  assertEquals(parseContentRangeTotalBytes(null), null);
});

Deno.test('parseContentRangeTotalBytes returns null for a malformed header', () => {
  assertEquals(parseContentRangeTotalBytes('not-a-content-range'), null);
  assertEquals(parseContentRangeTotalBytes('bytes */*'), null);
});

// --- deriveMediaPreviewKey reused for video extensions ----------------------
// deriveMediaPreviewKey (imported, not copied -- see the module doc comment)
// is generic over every extension MEMORY_MEDIA_ASSET_EXTENSION_PATTERN
// allows, but backfill-media-previews.test.ts only exercises image
// extensions since that script only ever selects image rows. This script is
// the first caller that derives a preview key from a VIDEO original, so pin
// that it produces the same `-preview.jpg` shape for mp4/mov too.

function assetKey(ext: string): string {
  return `${USER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.${ext}`;
}

for (const ext of ['mp4', 'mov']) {
  Deno.test(`deriveMediaPreviewKey derives the -preview.jpg key for .${ext} video originals`, () => {
    const previewKey = deriveMediaPreviewKey(assetKey(ext));
    assertEquals(previewKey, `${USER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}-preview.jpg`);
  });
}
