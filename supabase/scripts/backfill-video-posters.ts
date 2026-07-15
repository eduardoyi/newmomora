/**
 * Backfill `memory_media.preview_object_key` for existing VIDEO assets that
 * predate upload-time video poster generation (Workstream: upload-time
 * video posters, docs/plans/preview-backfill.md "Video-poster extension").
 * Mirrors backfill-media-previews.ts's conventions exactly (dry-run by
 * default, presigned R2 GETs, DATABASE_PAGE_SIZE-batched candidate paging,
 * per-object worker pool, one retry, `IS NULL` update guard, byte report)
 * but shells out to `ffmpeg` instead of `sharp` -- there is no JS
 * video-decode library available in Deno, and ffmpeg is already the
 * established shell-out dependency for video metadata in this directory
 * (see backfill-media-aspect-ratios.ts, which shells to `ffprobe` the same
 * way).
 *
 * Unlike the photo preview backfill, this NEVER skips a candidate for being
 * "already small" -- see createVideoPosterForUpload in
 * src/utils/create-image-preview.ts for why videos always get a poster:
 * there is no acceptable "render the original at full size" fallback for a
 * video list thumbnail the way there is for a photo (the existing fallback,
 * useVideoThumbnail, is exactly the per-device ranged-fetch-and-decode cost
 * this feature exists to remove).
 *
 * See docs/plans/preview-backfill.md for the full design (photo pass) and
 * its "Video-poster extension" section for this script's specifics.
 *
 * Dry run (reports what would be done, touches nothing):
 * deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *   supabase/scripts/backfill-video-posters.ts
 * # or: npm run backfill:video-posters
 *
 * Apply:
 * ... backfill-video-posters.ts --apply
 * # or: npm run backfill:video-posters -- --apply
 *
 * Optional flags:
 *   --limit N          first N candidate rows only
 *   --memory-id <uuid>  scope to a single memory (pilot run)
 *   --concurrency N     worker pool size (default 4)
 *   --verify [N]        skip the backfill entirely; instead sample N rows
 *                        (default 10) of VIDEO rows that already have a
 *                        preview_object_key and confirm the poster downloads
 *                        OK and is smaller than the original
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET (same names as every other
 * script in this directory -- no new secrets). Also requires a local
 * `ffmpeg` binary on PATH (tested against ffmpeg v8; available locally at
 * /usr/local/bin/ffmpeg).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

import { deriveMediaPreviewKey } from './backfill-media-previews.ts';
import { createPresignedGetUrls, putObjectBytes } from '../functions/_shared/r2.ts';
import { ALLOWED_VIDEO_CONTENT_TYPES } from '../../src/utils/media-validation.ts';

// ---------------------------------------------------------------------------
// Poster parameters -- MUST stay identical to what
// src/utils/create-image-preview.ts's createVideoPosterForUpload produces:
// longest edge capped at MEMORY_IMAGE_PREVIEW_MAX_DIMENSION (1280), JPEG
// output at a visually equivalent quality to MEMORY_IMAGE_PREVIEW_QUALITY
// (0.8 on expo-image-manipulator's 0-1 scale). ffmpeg's `-q:v` uses a
// different 2-31 scale (lower is better) with no exact numeric equivalent
// to a 0-1/1-100 JPEG quality -- `-q:v 3` is the value the plan calls out as
// "~q0.8 equivalent." Keep all three in sync (here, the client util, and
// backfill-media-previews.ts's PREVIEW_MAX_DIMENSION/PREVIEW_JPEG_QUALITY)
// if any of them ever change.
// ---------------------------------------------------------------------------
export const VIDEO_POSTER_MAX_DIMENSION = 1280;
export const VIDEO_POSTER_FFMPEG_QUALITY = '3';

const DATABASE_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_VERIFY_SAMPLE_SIZE = 10;
const PRESIGN_EXPIRES_IN_SECONDS = 300;

export interface VideoAssetRow {
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported + covered by backfill-video-posters.test.ts).
// ---------------------------------------------------------------------------

/**
 * Builds the ffmpeg argument list for extracting a first-frame poster from
 * `sourceUrl` (a presigned R2 GET URL -- ffmpeg's libavformat reads
 * http/https URLs directly, no download step needed): grab the first frame
 * (`-vframes 1`), scale it down to at most VIDEO_POSTER_MAX_DIMENSION on its
 * longest edge WITHOUT upscaling (the `min(iw,N)`/`min(ih,N)` box, not a
 * fixed NxN box -- a fixed box with `force_original_aspect_ratio=decrease`
 * still upscales a source smaller than the box), and mux a single JPEG to
 * stdout. Autorotation (applying any embedded rotation/display-matrix
 * metadata before the scale) is ffmpeg's CLI default and is not disabled
 * here.
 */
export function buildFfmpegPosterArgs(sourceUrl: string): string[] {
  return [
    '-y',
    '-i',
    sourceUrl,
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
  ];
}

/**
 * Parses the total resource size out of a `Content-Range: bytes 0-0/12345`
 * response header (from a 1-byte range request used to learn an original
 * video's size without downloading it -- see getRemoteSizeBytes below).
 * Returns null for a missing/malformed header.
 */
export function parseContentRangeTotalBytes(contentRangeHeader: string | null): number | null {
  if (!contentRangeHeader) {
    return null;
  }

  const match = contentRangeHeader.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Script entry point -- everything below has side effects (network/process)
// and is intentionally not exported/tested directly; the pure helpers above
// are.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function getFlagValue(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = Deno.args[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (firstError) {
    console.warn(
      'Transient failure, retrying once:',
      firstError instanceof Error ? firstError.message : firstError,
    );
    return await fn();
  }
}

/**
 * HEAD-equivalent original size lookup via a 1-byte range request, so the
 * byte report doesn't require downloading the whole source video (a
 * presigned S3/R2 GET URL is method-specific and does not reliably
 * authenticate a real HEAD request).
 */
async function getRemoteSizeBytes(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const fromRange = parseContentRangeTotalBytes(response.headers.get('content-range'));
    if (fromRange != null) {
      return fromRange;
    }

    const contentLength = response.headers.get('content-length');
    return contentLength ? Number(contentLength) : null;
  } catch {
    return null;
  }
}

async function runFfmpegPoster(sourceUrl: string): Promise<Uint8Array> {
  const command = new Deno.Command('ffmpeg', {
    args: buildFfmpegPosterArgs(sourceUrl),
    stdout: 'piped',
    stderr: 'piped',
  });

  const output = await command.output();

  if (!output.success || output.stdout.length === 0) {
    const stderr = new TextDecoder().decode(output.stderr).trim().slice(-500);
    throw new Error(`ffmpeg failed to extract a poster frame: ${stderr || 'no output'}`);
  }

  return output.stdout;
}

async function main(): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Nested closure (rather than a top-level function taking `admin` as a
  // parameter) so its type flows from the `createClient(...)` call above by
  // inference -- same precedent as backfill-media-previews.ts's
  // runVerification (a known supabase-js generic-default mismatch across
  // separate call sites).
  async function runVerification(sampleSize: number): Promise<void> {
    const { data, error } = await admin
      .from('memory_media')
      .select('id, object_key, preview_object_key')
      .not('preview_object_key', 'is', null)
      .in('content_type', [...ALLOWED_VIDEO_CONTENT_TYPES])
      .limit(sampleSize);

    if (error) {
      throw new Error(`Could not sample video posters: ${error.message}`);
    }

    if (!data || data.length === 0) {
      console.log('No video posters to verify yet');
      return;
    }

    let passed = 0;
    let failed = 0;

    for (const row of data) {
      const posterKey = row.preview_object_key as string;
      try {
        const urls = await createPresignedGetUrls(
          [row.object_key, posterKey],
          PRESIGN_EXPIRES_IN_SECONDS,
        );
        const [originalResponse, posterResponse] = await Promise.all([
          fetch(urls[row.object_key]),
          fetch(urls[posterKey]),
        ]);

        if (!originalResponse.ok || !posterResponse.ok) {
          throw new Error(
            `non-200 response (original ${originalResponse.status}, poster ${posterResponse.status})`,
          );
        }

        const [originalBytes, posterBytes] = await Promise.all([
          originalResponse.arrayBuffer().then((buf) => buf.byteLength),
          posterResponse.arrayBuffer().then((buf) => buf.byteLength),
        ]);

        if (posterBytes >= originalBytes) {
          throw new Error(
            `poster (${posterBytes}B) is not smaller than the original (${originalBytes}B)`,
          );
        }

        passed += 1;
        console.log(`Media ${row.id}: OK (poster ${posterBytes}B < original ${originalBytes}B)`);
      } catch (verifyError) {
        failed += 1;
        console.error(
          `Media ${row.id}: verification failed`,
          verifyError instanceof Error ? verifyError.message : verifyError,
        );
      }
    }

    console.log(
      `Verification finished: ${passed} passed, ${failed} failed (sampled ${data.length})`,
    );
    if (failed > 0) {
      Deno.exit(1);
    }
  }

  const shouldVerify = Deno.args.includes('--verify');
  if (shouldVerify) {
    const sampleSize = Number(getFlagValue('--verify') ?? DEFAULT_VERIFY_SAMPLE_SIZE);
    await runVerification(sampleSize);
    return;
  }

  const shouldApply = Deno.args.includes('--apply');
  const limitFlag = getFlagValue('--limit');
  const limit = limitFlag ? Number(limitFlag) : undefined;
  const memoryIdFilter = getFlagValue('--memory-id');
  const concurrencyFlag = getFlagValue('--concurrency');
  const concurrency = concurrencyFlag ? Number(concurrencyFlag) : DEFAULT_CONCURRENCY;

  const videoContentTypes = [...ALLOWED_VIDEO_CONTENT_TYPES];
  const assets: VideoAssetRow[] = [];

  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    let query = admin
      .from('memory_media')
      .select('id, memory_id, object_key, content_type')
      .is('preview_object_key', null)
      .in('content_type', videoContentTypes)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + DATABASE_PAGE_SIZE - 1);

    if (memoryIdFilter) {
      query = query.eq('memory_id', memoryIdFilter);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Could not load media rows: ${error.message}`);
    }

    assets.push(...data);
    if (data.length < DATABASE_PAGE_SIZE) {
      break;
    }
  }

  const candidateAssets = limit ? assets.slice(0, limit) : assets;

  if (candidateAssets.length === 0) {
    console.log('No video posters need backfilling');
    return;
  }

  // Dedupe by object_key (same precedent as backfill-media-previews.ts) so a
  // shared R2 object is only downloaded/processed/uploaded once even if
  // multiple memory_media rows reference it.
  const assetsByObjectKey = new Map<string, VideoAssetRow[]>();
  for (const asset of candidateAssets) {
    const matching = assetsByObjectKey.get(asset.object_key) ?? [];
    matching.push(asset);
    assetsByObjectKey.set(asset.object_key, matching);
  }

  const memoryCount = new Set(candidateAssets.map((asset) => asset.memory_id)).size;
  console.log(
    `Found ${candidateAssets.length} candidate video row(s) across ${memoryCount} memory/memories and ` +
      `${assetsByObjectKey.size} unique R2 object(s)`,
  );
  console.log(`${shouldApply ? 'Applying' : 'Dry-running'} video poster backfill`);

  let writtenCount = 0;
  let failedCount = 0;
  const failedIds: string[] = [];
  let totalOriginalBytes = 0;
  let totalPosterBytes = 0;

  async function processObjectKey(objectKey: string, rows: VideoAssetRow[]): Promise<void> {
    const representative = rows[0];
    const duplicateSuffix = rows.length > 1 ? ` (+${rows.length - 1} duplicate row(s))` : '';

    try {
      const urls = await createPresignedGetUrls([objectKey], PRESIGN_EXPIRES_IN_SECONDS);
      const url = urls[objectKey];
      if (!url) {
        throw new Error('Could not create a presigned GET url');
      }

      // Original size is only used for the byte report -- fetched via a
      // cheap ranged request, not a full download (ffmpeg streams the
      // source itself). A failure here is non-fatal to the backfill.
      const originalBytes = await getRemoteSizeBytes(url);

      const posterBytes = await withOneRetry(() => runFfmpegPoster(url));
      const posterKey = deriveMediaPreviewKey(objectKey);

      if (shouldApply) {
        await withOneRetry(() => putObjectBytes(posterKey, posterBytes, 'image/jpeg'));

        const { error: updateError } = await admin
          .from('memory_media')
          .update({ preview_object_key: posterKey })
          .in(
            'id',
            rows.map((row) => row.id),
          )
          .is('preview_object_key', null);

        if (updateError) {
          throw updateError;
        }
      }

      writtenCount += rows.length;
      if (originalBytes != null) {
        totalOriginalBytes += originalBytes;
      }
      totalPosterBytes += posterBytes.length;
      console.log(
        `Media ${representative.id}${duplicateSuffix}: ` +
          `${originalBytes ?? 'unknown'}B -> ${posterBytes.length}B` +
          `${shouldApply ? ' saved' : ' (dry run)'} key=${posterKey}`,
      );
    } catch (error) {
      failedCount += rows.length;
      failedIds.push(...rows.map((row) => row.id));
      console.error(
        `Media ${representative.id}${duplicateSuffix}: failed`,
        error instanceof Error ? error.message : 'unknown error',
      );
    }
  }

  const objectEntries = [...assetsByObjectKey.entries()];
  let nextObjectIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextObjectIndex < objectEntries.length) {
      const entry = objectEntries[nextObjectIndex];
      nextObjectIndex += 1;
      await processObjectKey(...entry);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, objectEntries.length) }, () => runWorker()),
  );

  console.log(
    `Finished: ${writtenCount} poster(s) ${shouldApply ? 'written' : 'would be written'}, ` +
      `${failedCount} failed` + (failedIds.length > 0 ? ` [${failedIds.join(', ')}]` : ''),
  );
  console.log(
    `Bytes: ${totalOriginalBytes} original -> ${totalPosterBytes} poster` +
      (totalOriginalBytes > 0
        ? ` (${(100 * (1 - totalPosterBytes / totalOriginalBytes)).toFixed(1)}% reduction)`
        : ''),
  );

  if (failedCount > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
