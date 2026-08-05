/**
 * One-time (or re-run-on-version-bump) upload of the full Twemoji SVG set
 * to R2 (`_assets/twemoji/v1/{filename}.svg`), for satori's
 * `graphemeImages` emoji rendering -- see compose-share-card/emoji.ts's
 * header comment for the full "a flag emoji renders as two letters"
 * diagnosis and design this feeds.
 *
 * SELF-HOSTED, not a third-party CDN fetch at REQUEST time -- see
 * emoji.ts's header comment for why a per-caption-emoji fetch to a
 * third-party CDN would leak something about caption content to that
 * third party. This script's own network calls are the opposite of that
 * concern: it fetches a fixed, public, non-secret open-source icon set
 * ONCE (or on a deliberate version bump), ahead of time, with zero user/
 * memory data involved -- then the runtime function only ever talks to
 * OUR OWN R2 bucket.
 *
 * SOURCE: the `@twemoji/svg` npm package (MIT-licensed wrapper/tooling,
 * https://github.com/boywithkeyboard/twemoji_svg) bundles the full,
 * current Twemoji SVG set (~3,720 files, ~8MB unpacked) at its package
 * root -- verified against the real published package (this package's
 * implementation report; also confirms `1f1ea-1f1f8.svg`, the exact
 * flag-pair case from the device report/user feedback, is present and a
 * real, valid SVG). Fetched via jsDelivr's raw npm-package CDN mirror
 * (`cdn.jsdelivr.net/npm/...` for file bytes, `data.jsdelivr.com` for the
 * file listing) -- the standard, publicly documented way to read an npm
 * package's raw files without a package manager, and simpler/more robust
 * than either importing the package as an `npm:` specifier (its assets
 * aren't JS modules, and Deno's npm-cache directory layout isn't a stable
 * public API to depend on for raw file access) or hand-parsing a gzipped
 * tarball. The 3,720 SVGs are deliberately NOT checked into this repo --
 * fetched fresh at script runtime instead.
 *
 * LICENSING (MIT/CC-BY note, per this feature's spec): `@twemoji/svg`
 * itself (the packaging/tooling) is MIT-licensed. The Twemoji GRAPHICS
 * (the actual SVG artwork) are Twitter/jdecked's own Twemoji project,
 * whose graphics are licensed CC-BY 4.0 separately from its (MIT) code --
 * see https://github.com/jdecked/twemoji#license ("Copyright 2020
 * Twitter, Inc and other contributors. Code licensed under the MIT
 * License. Graphics licensed under CC-BY 4.0"). Self-hosting these SVGs in
 * our own R2 bucket for internal rendering use is an infrastructure step,
 * not a new redistribution with its own license terms, but the CC-BY
 * attribution obligation on the graphics themselves is NOT removed by
 * this upload -- any public-facing attribution (e.g. an in-app credits
 * screen) is tracked separately in docs/features/memory-sharing.md, not
 * by this script.
 *
 * PINNED VERSION (TWEMOJI_PACKAGE_VERSION below): deliberately NOT
 * `@latest` -- a bare re-run of this script should be a no-op (every key
 * already exists, same bytes), not a silent 3,720-file diff because
 * upstream cut a new release. Bump the constant explicitly (and re-run
 * with `--apply`) when a deliberate emoji-set update is wanted; DESIGN_VERSION
 * (compose-share-card/index.ts) does NOT need a bump for this since the
 * upload is additive/idempotent under the same key prefix, not a
 * rendering-logic change.
 *
 * Mirrors the structure/conventions of backfill-media-previews.ts and
 * upload-share-card-assets.ts: dry-run by default (lists + fetches every
 * candidate to confirm it's real/fetchable, but skips the R2 write),
 * `--apply` to actually upload, progress logging, a final count, and a
 * post-upload verification sample that always includes the flag-pair case.
 *
 * Dry run:
 *   deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *     supabase/scripts/upload-twemoji-assets.ts
 *
 * Apply:
 *   ... upload-twemoji-assets.ts --apply
 *
 * Optional flags:
 *   --limit N     first N files only (pilot run / faster iteration)
 *   --verify [N]  skip listing/upload entirely; sample N already-uploaded
 *                 R2 objects (default 10, ALWAYS includes 1f1ea-1f1f8.svg)
 *                 and confirm each round-trips byte-identical against the
 *                 npm source (post-apply verification)
 *
 * Requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_ENDPOINT, R2_BUCKET (same names as every other script in this
 * directory -- no new secrets). NEVER logs secret values.
 */
import { createPresignedGetUrls, putObjectBytes } from '../functions/_shared/r2.ts';
import { TWEMOJI_ASSET_PREFIX } from '../functions/compose-share-card/emoji.ts';

const TWEMOJI_PACKAGE_NAME = '@twemoji/svg';
const TWEMOJI_PACKAGE_VERSION = '15.0.0';
const JSDELIVR_LIST_URL =
  `https://data.jsdelivr.com/v1/packages/npm/${TWEMOJI_PACKAGE_NAME}@${TWEMOJI_PACKAGE_VERSION}`;
const JSDELIVR_RAW_BASE =
  `https://cdn.jsdelivr.net/npm/${TWEMOJI_PACKAGE_NAME}@${TWEMOJI_PACKAGE_VERSION}/`;
const PRESIGN_EXPIRES_IN_SECONDS = 300;
const DEFAULT_VERIFY_SAMPLE_SIZE = 10;
const CONCURRENCY = 8;

// The exact device-report/user-feedback case (docs/plans/
// share-card-store-through.md's four-part production fix) -- always part
// of any verification sample so a real regression on this specific emoji
// can never be masked by random sampling.
const ALWAYS_VERIFY_FILENAMES = ['1f1ea-1f1f8.svg'];

interface JsDelivrFileEntry {
  type: 'file' | 'directory';
  name: string;
}

interface JsDelivrPackageListing {
  files: JsDelivrFileEntry[];
}

/** Every `.svg` filename at the package root -- the whole set lives flat,
 * no subdirectory (verified against the real listing, this package's
 * implementation report). */
export async function listTwemojiSvgFilenames(): Promise<string[]> {
  const response = await fetch(JSDELIVR_LIST_URL);
  if (!response.ok) {
    throw new Error(
      `Could not list ${TWEMOJI_PACKAGE_NAME}@${TWEMOJI_PACKAGE_VERSION} from jsDelivr (status ${response.status})`,
    );
  }
  const data = await response.json() as JsDelivrPackageListing;
  return data.files
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.svg'))
    .map((entry) => entry.name);
}

async function fetchTwemojiSvgBytes(filename: string): Promise<Uint8Array> {
  const response = await fetch(`${JSDELIVR_RAW_BASE}${filename}`);
  if (!response.ok) {
    throw new Error(`Could not fetch ${filename} from jsDelivr (status ${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
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
    console.warn('Transient failure, retrying once:', firstError instanceof Error ? firstError.message : firstError);
    return await fn();
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

async function runVerify(sampleSize: number): Promise<void> {
  const allFilenames = await listTwemojiSvgFilenames();
  const rest = allFilenames.filter((f) => !ALWAYS_VERIFY_FILENAMES.includes(f));
  const shuffled = [...rest].sort(() => Math.random() - 0.5);
  const remainingCount = Math.max(0, sampleSize - ALWAYS_VERIFY_FILENAMES.length);
  const sampleFilenames = [...ALWAYS_VERIFY_FILENAMES, ...shuffled.slice(0, remainingCount)];

  const keys = sampleFilenames.map((f) => `${TWEMOJI_ASSET_PREFIX}${f}`);
  const urls = await createPresignedGetUrls(keys, PRESIGN_EXPIRES_IN_SECONDS);

  let passed = 0;
  let failed = 0;

  for (const filename of sampleFilenames) {
    const key = `${TWEMOJI_ASSET_PREFIX}${filename}`;
    try {
      const url = urls[key];
      if (!url) {
        throw new Error('could not presign a GET url');
      }
      const [remoteResponse, sourceBytes] = await Promise.all([fetch(url), fetchTwemojiSvgBytes(filename)]);
      if (!remoteResponse.ok) {
        throw new Error(`R2 fetch failed with status ${remoteResponse.status}`);
      }
      const remoteBytes = new Uint8Array(await remoteResponse.arrayBuffer());
      if (!bytesEqual(remoteBytes, sourceBytes)) {
        throw new Error(`byte mismatch: R2=${remoteBytes.length}B npm-source=${sourceBytes.length}B`);
      }
      console.log(`[${filename}] OK -- ${remoteBytes.length} bytes, round-trips byte-identical`);
      passed += 1;
    } catch (error) {
      console.error(`[${filename}] VERIFY FAILED:`, error instanceof Error ? error.message : 'unknown');
      failed += 1;
    }
  }

  console.log(`\nVerification finished: ${passed} passed, ${failed} failed (of ${sampleFilenames.length}).`);
  if (failed > 0) {
    Deno.exit(1);
  }
}

async function runUpload(shouldApply: boolean, limit: number | undefined): Promise<void> {
  console.log(`Listing ${TWEMOJI_PACKAGE_NAME}@${TWEMOJI_PACKAGE_VERSION} SVG files from jsDelivr...`);
  const allFilenames = await listTwemojiSvgFilenames();
  const filenames = limit ? allFilenames.slice(0, limit) : allFilenames;
  console.log(
    `Found ${allFilenames.length} SVG file(s)` +
      (limit ? `, processing the first ${filenames.length} (--limit)` : '') + '.',
  );
  console.log(`${shouldApply ? 'Applying' : 'Dry-running'} Twemoji asset upload -> R2 prefix "${TWEMOJI_ASSET_PREFIX}"`);

  let succeeded = 0;
  let failed = 0;
  const failedFilenames: string[] = [];

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < filenames.length) {
      const filename = filenames[nextIndex];
      nextIndex += 1;
      const key = `${TWEMOJI_ASSET_PREFIX}${filename}`;
      try {
        const bytes = await withOneRetry(() => fetchTwemojiSvgBytes(filename));
        if (shouldApply) {
          await withOneRetry(() => putObjectBytes(key, bytes, 'image/svg+xml'));
        }
        succeeded += 1;
        if (succeeded % 250 === 0 || succeeded === filenames.length) {
          console.log(`  ${succeeded}/${filenames.length} ${shouldApply ? 'uploaded' : 'verified fetchable'}...`);
        }
      } catch (error) {
        failed += 1;
        failedFilenames.push(filename);
        console.error(`  [${filename}] FAILED:`, error instanceof Error ? error.message : 'unknown');
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, filenames.length) }, () => worker()));

  console.log(
    `\nFinished: ${succeeded}/${filenames.length} ${shouldApply ? 'uploaded' : 'would be uploaded'}, ${failed} failed` +
      (failedFilenames.length > 0
        ? ` [${failedFilenames.slice(0, 20).join(', ')}${failedFilenames.length > 20 ? ', ...' : ''}]`
        : ''),
  );

  if (shouldApply && failed === 0) {
    console.log('\nRunning post-upload verification sample...');
    await runVerify(DEFAULT_VERIFY_SAMPLE_SIZE);
  }

  if (failed > 0) {
    Deno.exit(1);
  }
}

async function main(): Promise<void> {
  if (Deno.args.includes('--verify')) {
    const sampleSize = Number(getFlagValue('--verify') ?? DEFAULT_VERIFY_SAMPLE_SIZE);
    await runVerify(sampleSize);
    return;
  }

  const shouldApply = Deno.args.includes('--apply');
  const limitFlag = getFlagValue('--limit');
  const limit = limitFlag ? Number(limitFlag) : undefined;
  await runUpload(shouldApply, limit);
}

if (import.meta.main) {
  await main();
}
