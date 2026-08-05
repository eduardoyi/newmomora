/**
 * One-time upload of compose-share-card's binary assets (resvg wasm,
 * webp-dec wasm, font TTFs incl. the NotoEmoji subset) to R2, under the
 * system prefix `_assets/share-card/v1/`. Perf-audit round 4 (this
 * package's implementation report): these assets used to be base64-encoded
 * and statically imported inside the compose-share-card Edge Function --
 * ~4.8MB of string-literal text V8 had to PARSE as part of that function's
 * own module-graph evaluation on every cold boot. A control experiment (a
 * trivial hello-world function on the SAME project, hammered the same way:
 * 15/15 success) isolated that as the cause of ~48% bodyless 546 failures.
 * Evicting the assets from the module graph entirely -- host in R2, fetch
 * at request time (assets-loader.ts) -- is the fix; this script performs
 * the one-time (or re-run-on-asset-change) upload half of that.
 *
 * Source files: supabase/functions/compose-share-card/assets/bin/* (raw
 * binary -- NOT imported by the function's module graph, so they add zero
 * bundle weight; they exist purely as this script's upload source AND as
 * local test fixtures, see render.test.ts). Manifest (keys + expected
 * byte counts + sha256): supabase/functions/_shared/share-card-assets-manifest.ts
 * -- the single source of truth shared with the function's runtime loader.
 *
 * Mirrors the structure/conventions of backfill-media-previews.ts: dry-run
 * by default (verifies local bytes against the manifest and reports what
 * WOULD be uploaded, touches nothing), `--apply` to actually upload.
 *
 * Dry run (reports what would be uploaded, touches nothing):
 *   deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *     supabase/scripts/upload-share-card-assets.ts
 *
 * Apply:
 *   ... upload-share-card-assets.ts --apply
 *
 * Optional flags:
 *   --verify    skip upload entirely; download each already-uploaded
 *               asset from R2 and confirm its bytes match the manifest
 *               (post-apply verification)
 *
 * Requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_ENDPOINT, R2_BUCKET (same names as every other script in this
 * directory -- no new secrets). NEVER logs secret values.
 */
import { createPresignedGetUrls, putObjectBytes } from '../functions/_shared/r2.ts';
import {
  SHARE_CARD_ASSET_MANIFEST,
  sha256Hex,
  type ShareCardAssetName,
} from '../functions/_shared/share-card-assets-manifest.ts';

const ASSETS_BIN_DIR = new URL('../functions/compose-share-card/assets/bin/', import.meta.url);

// Maps each manifest entry to its local source file under assets/bin/.
// Kept as an explicit table (not derived from the R2 key) so a future
// rename of the R2 key doesn't silently break the local-file lookup.
const LOCAL_FILE_BY_ASSET: Record<ShareCardAssetName, string> = {
  resvgWasm: 'resvg.wasm',
  webpDecWasm: 'webp-dec.wasm',
  newsreaderRegular: 'newsreader-regular.ttf',
  newsreaderItalic: 'newsreader-italic.ttf',
  newsreaderMedium: 'newsreader-medium.ttf',
  jakartaRegular: 'jakarta-regular.ttf',
  jakartaBold: 'jakarta-bold.ttf',
  notoEmojiSubset: 'noto-emoji-subset.ttf',
};

function contentTypeFor(fileName: string): string {
  if (fileName.endsWith('.wasm')) return 'application/wasm';
  if (fileName.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

async function loadLocalAsset(name: ShareCardAssetName): Promise<Uint8Array> {
  const fileName = LOCAL_FILE_BY_ASSET[name];
  const path = new URL(fileName, ASSETS_BIN_DIR);
  return await Deno.readFile(path);
}

async function verifyLocalAgainstManifest(): Promise<{ ok: boolean; entries: Array<{ name: ShareCardAssetName; bytes: Uint8Array }> }> {
  const entries: Array<{ name: ShareCardAssetName; bytes: Uint8Array }> = [];
  let ok = true;

  for (const name of Object.keys(SHARE_CARD_ASSET_MANIFEST) as ShareCardAssetName[]) {
    const manifest = SHARE_CARD_ASSET_MANIFEST[name];
    let bytes: Uint8Array;
    try {
      bytes = await loadLocalAsset(name);
    } catch (error) {
      console.error(`[${name}] FAILED to read local file:`, error instanceof Error ? error.message : 'unknown');
      ok = false;
      continue;
    }

    if (bytes.length !== manifest.bytes) {
      console.error(`[${name}] byte-count mismatch: local=${bytes.length} manifest=${manifest.bytes}`);
      ok = false;
      continue;
    }

    const hash = await sha256Hex(bytes);
    if (hash !== manifest.sha256) {
      console.error(`[${name}] sha256 mismatch: local=${hash} manifest=${manifest.sha256}`);
      ok = false;
      continue;
    }

    console.log(`[${name}] OK -- ${bytes.length} bytes, sha256 matches manifest`);
    entries.push({ name, bytes });
  }

  return { ok, entries };
}

async function runUpload(shouldApply: boolean): Promise<void> {
  const { ok, entries } = await verifyLocalAgainstManifest();

  if (!ok) {
    console.error('\nLocal assets do not match the manifest -- aborting. Fix the mismatch (regenerate the manifest or the local files) before uploading.');
    Deno.exit(1);
  }

  console.log(`\n${entries.length}/${Object.keys(SHARE_CARD_ASSET_MANIFEST).length} assets verified locally against the manifest.`);

  if (!shouldApply) {
    console.log('\nDRY RUN -- would upload:');
    for (const { name, bytes } of entries) {
      const manifest = SHARE_CARD_ASSET_MANIFEST[name];
      console.log(`  ${manifest.key} (${bytes.length} bytes)`);
    }
    console.log('\nRe-run with --apply to actually upload.');
    return;
  }

  console.log('\nUploading...');
  let uploaded = 0;
  for (const { name, bytes } of entries) {
    const manifest = SHARE_CARD_ASSET_MANIFEST[name];
    const fileName = LOCAL_FILE_BY_ASSET[name];
    try {
      await putObjectBytes(manifest.key, bytes, contentTypeFor(fileName));
      console.log(`  [${name}] uploaded -> ${manifest.key}`);
      uploaded += 1;
    } catch (error) {
      console.error(`  [${name}] UPLOAD FAILED:`, error instanceof Error ? error.message : 'unknown');
    }
  }

  console.log(`\nUploaded ${uploaded}/${entries.length} assets.`);
  if (uploaded < entries.length) {
    Deno.exit(1);
  }
}

async function runVerify(): Promise<void> {
  const names = Object.keys(SHARE_CARD_ASSET_MANIFEST) as ShareCardAssetName[];
  const keys = names.map((name) => SHARE_CARD_ASSET_MANIFEST[name].key);

  const urls = await createPresignedGetUrls(keys, 300);

  let passed = 0;
  let failed = 0;

  for (const name of names) {
    const manifest = SHARE_CARD_ASSET_MANIFEST[name];
    const url = urls[manifest.key];
    if (!url) {
      console.error(`[${name}] could not presign a GET url`);
      failed += 1;
      continue;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`fetch failed with status ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== manifest.bytes) {
        throw new Error(`byte-count mismatch: remote=${bytes.length} manifest=${manifest.bytes}`);
      }
      const hash = await sha256Hex(bytes);
      if (hash !== manifest.sha256) {
        throw new Error('sha256 mismatch');
      }
      console.log(`[${name}] OK -- ${bytes.length} bytes, sha256 matches manifest`);
      passed += 1;
    } catch (error) {
      console.error(`[${name}] VERIFY FAILED:`, error instanceof Error ? error.message : 'unknown');
      failed += 1;
    }
  }

  console.log(`\nVerification finished: ${passed} passed, ${failed} failed (of ${names.length}).`);
  if (failed > 0) {
    Deno.exit(1);
  }
}

async function main(): Promise<void> {
  if (Deno.args.includes('--verify')) {
    await runVerify();
    return;
  }

  const shouldApply = Deno.args.includes('--apply');
  await runUpload(shouldApply);
}

if (import.meta.main) {
  await main();
}
