/**
 * Backfill `memory_media.preview_object_key` for existing image assets that
 * predate client-side preview generation (Workstream C3, performance-
 * optimizations plan). Mirrors the structure of
 * backfill-media-aspect-ratios.ts: dry-run by default, presigned R2 GETs,
 * DATABASE_PAGE_SIZE-batched candidate paging, per-object worker pool.
 *
 * See docs/plans/preview-backfill.md for the full design.
 *
 * Dry run (reports what would be done, touches nothing) -- same invocation
 * style as `npm run eval:illustration`:
 * deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *   supabase/scripts/backfill-media-previews.ts
 * # or: npm run backfill:previews
 *
 * Apply:
 * ... backfill-media-previews.ts --apply
 * # or: npm run backfill:previews -- --apply
 *
 * Optional flags:
 *   --limit N          first N candidate rows only
 *   --memory-id <uuid>  scope to a single memory (pilot run)
 *   --concurrency N     worker pool size (default 4)
 *   --verify [N]        skip the backfill entirely; instead sample N rows
 *                        (default 10) that already have a preview_object_key
 *                        and confirm the preview downloads OK and is smaller
 *                        than the original (post-apply verification, plan §4)
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET (same names as every other
 * script in this directory -- no new secrets).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import sharp from 'npm:sharp@0.33';

import {
  buildMemoryMediaAssetKey,
  MEMORY_MEDIA_ASSET_EXTENSION_PATTERN,
} from '../functions/_shared/storage-keys.ts';
import { createPresignedGetUrls, putObjectBytes } from '../functions/_shared/r2.ts';
import { ALLOWED_IMAGE_CONTENT_TYPES } from '../../src/utils/media-validation.ts';

// ---------------------------------------------------------------------------
// Resize constants -- MUST stay identical to src/utils/create-image-preview.ts
// (MEMORY_IMAGE_PREVIEW_MAX_DIMENSION / MEMORY_IMAGE_PREVIEW_QUALITY). If
// those change, change these too. Quality here is sharp's 1-100 scale; the
// client's 0.8 (expo-image-manipulator's 0-1 scale) == 80 here.
// ---------------------------------------------------------------------------
export const PREVIEW_MAX_DIMENSION = 1280;
export const PREVIEW_JPEG_QUALITY = 80;

const DATABASE_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_VERIFY_SAMPLE_SIZE = 10;
const PRESIGN_EXPIRES_IN_SECONDS = 300;

export interface MediaAssetRow {
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported + covered by backfill-media-previews.test.ts, per
// plan §5).
// ---------------------------------------------------------------------------

export type PreviewResizeDecision =
  | { action: 'skip' }
  | { action: 'resize'; targetWidth?: number; targetHeight?: number };

/**
 * Decide whether an image needs a resized preview. Mirrors the no-upscale
 * guard in src/utils/create-image-preview.ts's createImagePreviewForUpload
 * EXACTLY: skip (leave preview_object_key null) when dimensions are unknown
 * or the longest edge is already at or under PREVIEW_MAX_DIMENSION; resize by
 * width when width >= height, else by height (letting the encoder
 * auto-compute the other edge), same as the client's `resize` param.
 */
export function decidePreviewResize(
  width: number | null | undefined,
  height: number | null | undefined,
): PreviewResizeDecision {
  if (!width || !height || width <= 0 || height <= 0) {
    return { action: 'skip' };
  }

  const longestEdge = Math.max(width, height);
  if (longestEdge <= PREVIEW_MAX_DIMENSION) {
    return { action: 'skip' };
  }

  return width >= height
    ? { action: 'resize', targetWidth: PREVIEW_MAX_DIMENSION }
    : { action: 'resize', targetHeight: PREVIEW_MAX_DIMENSION };
}

/**
 * Derive the preview object key from an original memory-media asset key,
 * reusing `buildMemoryMediaAssetKey` (the exact same builder
 * src/services/memory-posting.ts's `uploadImagePreviewForAsset` calls --
 * `buildMemoryMediaAssetKey(userId, memoryId, \`${mediaAssetId}-preview\`,
 * 'jpg')`, see that file) so output is byte-identical to the client's
 * derivation for newly-uploaded assets, not just structurally similar.
 *
 * Parses using MEMORY_MEDIA_ASSET_EXTENSION_PATTERN (same pattern
 * `isMemoryMediaKey` validates against) and re-validates the derived key
 * against it before returning. Throws (never returns a bad key) when:
 *   - objectKey isn't a `{userId}/memories/{memoryId}/media/{assetId}.{ext}`
 *     shape
 *   - assetId already ends in `-preview` (never derive a preview-of-a-preview)
 *   - the derived key would equal the original (belt-and-braces; can't
 *     happen given the above, but asserted anyway per the plan)
 */
export function deriveMediaPreviewKey(objectKey: string): string {
  const firstSlash = objectKey.indexOf('/');
  if (firstSlash === -1) {
    throw new Error(`Cannot parse user id from object key: ${objectKey}`);
  }

  const userId = objectKey.slice(0, firstSlash);
  const memoriesPrefix = `${userId}/memories/`;
  if (!objectKey.startsWith(memoriesPrefix)) {
    throw new Error(`Object key is not a memory-media asset key: ${objectKey}`);
  }

  const rest = objectKey.slice(memoriesPrefix.length);
  const match = rest.match(MEMORY_MEDIA_ASSET_EXTENSION_PATTERN);
  if (!match) {
    throw new Error(`Object key does not match the memory-media asset shape: ${objectKey}`);
  }

  const [, memoryId, assetId] = match;
  if (assetId.endsWith('-preview')) {
    throw new Error(`Refusing to derive a preview key from an existing preview key: ${objectKey}`);
  }

  const previewKey = buildMemoryMediaAssetKey(userId, memoryId, `${assetId}-preview`, 'jpg');

  if (previewKey === objectKey) {
    throw new Error(`Derived preview key must not equal the original key: ${objectKey}`);
  }

  const previewRest = previewKey.slice(memoriesPrefix.length);
  if (!MEMORY_MEDIA_ASSET_EXTENSION_PATTERN.test(previewRest)) {
    throw new Error(`Derived preview key failed validation: ${previewKey}`);
  }

  return previewKey;
}

// ---------------------------------------------------------------------------
// Script entry point -- everything below has side effects (network/env) and
// is intentionally not exported/tested directly; the pure helpers above are.
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

interface DownloadAndResizeResult {
  decision: PreviewResizeDecision;
  longestEdge: number;
  originalBytes: number;
  previewBuffer?: Uint8Array;
}

async function downloadAndResize(objectKey: string): Promise<DownloadAndResizeResult> {
  const urls = await createPresignedGetUrls([objectKey], PRESIGN_EXPIRES_IN_SECONDS);
  const url = urls[objectKey];
  if (!url) {
    throw new Error('Could not create a presigned GET url');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const originalBuffer = new Uint8Array(await response.arrayBuffer());
  const image = sharp(originalBuffer);
  const metadata = await image.metadata();
  const decision = decidePreviewResize(metadata.width, metadata.height);
  const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);

  if (decision.action === 'skip') {
    return { decision, longestEdge, originalBytes: originalBuffer.length };
  }

  // No withMetadata() call -- output stays metadata-free, same as the
  // client's createImagePreviewForUpload (originals are already
  // EXIF-stripped at upload time, so there is no orientation tag to honor).
  const resizeOptions = decision.targetWidth
    ? { width: decision.targetWidth }
    : { height: decision.targetHeight };
  const previewBuffer = await image
    .resize(resizeOptions)
    .jpeg({ quality: PREVIEW_JPEG_QUALITY })
    .toBuffer();

  return {
    decision,
    longestEdge,
    originalBytes: originalBuffer.length,
    previewBuffer: new Uint8Array(previewBuffer),
  };
}

async function main(): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Nested closure (rather than a top-level function taking `admin` as a
  // parameter) so its type flows from the `createClient(...)` call above by
  // inference -- giving `admin` a standalone parameter type here trips a
  // known supabase-js generic-default mismatch across separate call sites.
  async function runVerification(sampleSize: number): Promise<void> {
    const { data, error } = await admin
      .from('memory_media')
      .select('id, object_key, preview_object_key')
      .not('preview_object_key', 'is', null)
      .limit(sampleSize);

    if (error) {
      throw new Error(`Could not sample previews: ${error.message}`);
    }

    if (!data || data.length === 0) {
      console.log('No previews to verify yet');
      return;
    }

    let passed = 0;
    let failed = 0;

    for (const row of data) {
      const previewKey = row.preview_object_key as string;
      try {
        const urls = await createPresignedGetUrls(
          [row.object_key, previewKey],
          PRESIGN_EXPIRES_IN_SECONDS,
        );
        const [originalResponse, previewResponse] = await Promise.all([
          fetch(urls[row.object_key]),
          fetch(urls[previewKey]),
        ]);

        if (!originalResponse.ok || !previewResponse.ok) {
          throw new Error(
            `non-200 response (original ${originalResponse.status}, preview ${previewResponse.status})`,
          );
        }

        const [originalBytes, previewBytes] = await Promise.all([
          originalResponse.arrayBuffer().then((buf) => buf.byteLength),
          previewResponse.arrayBuffer().then((buf) => buf.byteLength),
        ]);

        if (previewBytes >= originalBytes) {
          throw new Error(
            `preview (${previewBytes}B) is not smaller than the original (${originalBytes}B)`,
          );
        }

        passed += 1;
        console.log(`Media ${row.id}: OK (preview ${previewBytes}B < original ${originalBytes}B)`);
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

  const imageContentTypes = [...ALLOWED_IMAGE_CONTENT_TYPES];
  const assets: MediaAssetRow[] = [];

  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    let query = admin
      .from('memory_media')
      .select('id, memory_id, object_key, content_type')
      .is('preview_object_key', null)
      .in('content_type', imageContentTypes)
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
    console.log('No media previews need backfilling');
    return;
  }

  // Dedupe by object_key (like backfill-media-aspect-ratios.ts) so a shared
  // R2 object is only downloaded/resized/uploaded once even if multiple
  // memory_media rows reference it.
  const assetsByObjectKey = new Map<string, MediaAssetRow[]>();
  for (const asset of candidateAssets) {
    const matching = assetsByObjectKey.get(asset.object_key) ?? [];
    matching.push(asset);
    assetsByObjectKey.set(asset.object_key, matching);
  }

  const memoryCount = new Set(candidateAssets.map((asset) => asset.memory_id)).size;
  console.log(
    `Found ${candidateAssets.length} candidate media row(s) across ${memoryCount} memory/memories and ` +
      `${assetsByObjectKey.size} unique R2 object(s)`,
  );
  console.log(`${shouldApply ? 'Applying' : 'Dry-running'} media preview backfill`);

  let writtenCount = 0;
  let skippedSmallCount = 0;
  let failedCount = 0;
  const failedIds: string[] = [];
  let totalOriginalBytes = 0;
  let totalPreviewBytes = 0;

  async function processObjectKey(objectKey: string, rows: MediaAssetRow[]): Promise<void> {
    const representative = rows[0];
    const duplicateSuffix = rows.length > 1 ? ` (+${rows.length - 1} duplicate row(s))` : '';

    try {
      const result = await withOneRetry(() => downloadAndResize(objectKey));

      if (result.decision.action === 'skip') {
        skippedSmallCount += rows.length;
        console.log(
          `Media ${representative.id}${duplicateSuffix}: longest edge ${result.longestEdge} <= ` +
            `${PREVIEW_MAX_DIMENSION}, skipping permanently (small)`,
        );
        return;
      }

      const previewBuffer = result.previewBuffer as Uint8Array;
      const previewKey = deriveMediaPreviewKey(objectKey);

      if (shouldApply) {
        await withOneRetry(() => putObjectBytes(previewKey, previewBuffer, 'image/jpeg'));

        const { error: updateError } = await admin
          .from('memory_media')
          .update({ preview_object_key: previewKey })
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
      totalOriginalBytes += result.originalBytes;
      totalPreviewBytes += previewBuffer.length;
      console.log(
        `Media ${representative.id}${duplicateSuffix}: ${result.originalBytes}B -> ` +
          `${previewBuffer.length}B${shouldApply ? ' saved' : ' (dry run)'} key=${previewKey}`,
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
    `Finished: ${writtenCount} preview(s) ${shouldApply ? 'written' : 'would be written'}, ` +
      `${skippedSmallCount} skipped (small), ${failedCount} failed` +
      (failedIds.length > 0 ? ` [${failedIds.join(', ')}]` : ''),
  );
  console.log(
    `Bytes: ${totalOriginalBytes} original -> ${totalPreviewBytes} preview` +
      (totalOriginalBytes > 0
        ? ` (${(100 * (1 - totalPreviewBytes / totalOriginalBytes)).toFixed(1)}% reduction)`
        : ''),
  );

  if (failedCount > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
