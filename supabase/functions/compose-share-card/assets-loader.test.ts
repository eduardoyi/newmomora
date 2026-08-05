// Tests for the round-4 R2 asset loader (this package's implementation
// report): loader memoization, the integrity-check failure path
// (size/hash mismatch and outright fetch failure), and manifest key
// shapes. NEVER touches real R2 -- fetchAndVerifyAssets accepts an
// injectable batch-fetcher specifically so these tests can substitute a
// fake one (see assets-loader.ts's doc comment on that parameter).
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';

import {
  _resetShareCardAssetsForTests,
  fetchAndVerifyAssets,
  loadShareCardAssets,
  ShareCardAssetsUnavailableError,
} from './assets-loader.ts';
import { SHARE_CARD_ASSET_MANIFEST, SHARE_CARD_ASSET_PREFIX, type ShareCardAssetName } from '../_shared/share-card-assets-manifest.ts';
import type { ObjectBytesBatchEntry } from '../_shared/r2.ts';

const ASSET_NAMES = Object.keys(SHARE_CARD_ASSET_MANIFEST) as ShareCardAssetName[];

/** Builds a fake batch-fetcher that returns the CORRECT bytes (read from
 * the real local fixture files, so hashes genuinely match the manifest)
 * for every key, so integrity-mismatch tests can override just ONE key's
 * result. */
async function loadRealAssetBytes(): Promise<Record<string, Uint8Array>> {
  const dir = new URL('./assets/bin/', import.meta.url);
  const fileByName: Record<ShareCardAssetName, string> = {
    resvgWasm: 'resvg.wasm',
    webpDecWasm: 'webp-dec.wasm',
    newsreaderRegular: 'newsreader-regular.ttf',
    newsreaderItalic: 'newsreader-italic.ttf',
    newsreaderMedium: 'newsreader-medium.ttf',
    jakartaRegular: 'jakarta-regular.ttf',
    jakartaBold: 'jakarta-bold.ttf',
    notoEmojiSubset: 'noto-emoji-subset.ttf',
  };
  const byKey: Record<string, Uint8Array> = {};
  for (const name of ASSET_NAMES) {
    const bytes = await Deno.readFile(new URL(fileByName[name], dir));
    byKey[SHARE_CARD_ASSET_MANIFEST[name].key] = bytes;
  }
  return byKey;
}

const REAL_BYTES_BY_KEY = await loadRealAssetBytes();

function fakeBatchFetcher(
  overrides: Record<string, ObjectBytesBatchEntry> = {},
): (keys: string[]) => Promise<Map<string, ObjectBytesBatchEntry>> {
  return async (keys: string[]) => {
    const result = new Map<string, ObjectBytesBatchEntry>();
    for (const key of keys) {
      if (key in overrides) {
        result.set(key, overrides[key]);
        continue;
      }
      const bytes = REAL_BYTES_BY_KEY[key];
      result.set(key, bytes ? { ok: true, bytes } : { ok: false, error: new Error('no fixture for key') });
    }
    return result;
  };
}

// ── fetchAndVerifyAssets: integrity checks (precise, injected fetcher) ────

Deno.test('fetchAndVerifyAssets succeeds and returns all 8 assets when every key matches the manifest', async () => {
  const result = await fetchAndVerifyAssets(fakeBatchFetcher());
  for (const name of ASSET_NAMES) {
    assertEquals(result[name].length, SHARE_CARD_ASSET_MANIFEST[name].bytes);
  }
});

Deno.test('fetchAndVerifyAssets throws ShareCardAssetsUnavailableError when one asset\'s R2 fetch fails (ok:false)', async () => {
  const failingKey = SHARE_CARD_ASSET_MANIFEST.resvgWasm.key;
  const fetcher = fakeBatchFetcher({
    [failingKey]: { ok: false, error: new Error('R2 fetch failed with status 500') },
  });
  await assertRejects(() => fetchAndVerifyAssets(fetcher), ShareCardAssetsUnavailableError);
});

Deno.test('fetchAndVerifyAssets throws ShareCardAssetsUnavailableError on a byte-count mismatch (integrity check, not just a fetch failure)', async () => {
  const key = SHARE_CARD_ASSET_MANIFEST.jakartaBold.key;
  const wrongSizeBytes = new Uint8Array(10); // real fetch "succeeded" but returned the wrong asset/truncated bytes
  const fetcher = fakeBatchFetcher({
    [key]: { ok: true, bytes: wrongSizeBytes },
  });
  await assertRejects(() => fetchAndVerifyAssets(fetcher), ShareCardAssetsUnavailableError);
});

Deno.test('fetchAndVerifyAssets throws ShareCardAssetsUnavailableError on a sha256 mismatch even when the byte COUNT happens to match', async () => {
  const key = SHARE_CARD_ASSET_MANIFEST.jakartaBold.key;
  const manifestBytes = SHARE_CARD_ASSET_MANIFEST.jakartaBold.bytes;
  // Same length as the real asset, but corrupted content -- byte-count
  // check alone would NOT catch this; only the sha256 comparison does.
  const corruptedBytes = new Uint8Array(manifestBytes).fill(0xff);
  const fetcher = fakeBatchFetcher({
    [key]: { ok: true, bytes: corruptedBytes },
  });
  await assertRejects(() => fetchAndVerifyAssets(fetcher), ShareCardAssetsUnavailableError);
});

Deno.test('fetchAndVerifyAssets throws ShareCardAssetsUnavailableError when a key is entirely missing from the batch result', async () => {
  const fetcher = async (keys: string[]) => {
    const result = new Map<string, ObjectBytesBatchEntry>();
    // Deliberately never populate the map -- simulates a batch fetcher bug
    // that returns an empty/incomplete result without erroring.
    void keys;
    return result;
  };
  await assertRejects(() => fetchAndVerifyAssets(fetcher), ShareCardAssetsUnavailableError);
});

// ── loadShareCardAssets: memoization ───────────────────────────────────────

Deno.test('loadShareCardAssets returns the SAME promise reference on repeated calls before it settles (memoization)', () => {
  _resetShareCardAssetsForTests();
  const first = loadShareCardAssets();
  const second = loadShareCardAssets();
  assertEquals(first, second);
  // Swallow the rejection (no real R2 config in this test environment) --
  // this test only cares about reference identity, not the outcome.
  first.catch(() => {});
});

Deno.test('loadShareCardAssets resets its memo on failure so a later call retries with a NEW promise, not a permanently-cached rejection', async () => {
  _resetShareCardAssetsForTests();
  const first = loadShareCardAssets();
  await assertRejects(() => first); // real R2 isn't configured in this test env -- expected to fail
  const second = loadShareCardAssets();
  // Different promise object -- proves the module-scope memo was cleared
  // on failure (assets-loader.ts's `.catch((error) => { assetsPromise =
  // null; throw error; })`), not stuck returning the same rejected promise
  // forever (which would mean a transient R2 blip permanently breaks the
  // isolate until redeploy).
  assertEquals(first === second, false);
  second.catch(() => {});
});

// ── Manifest key shapes (round-4 design ask: "manifest key shapes") ───────

Deno.test('SHARE_CARD_ASSET_MANIFEST has exactly the 8 expected asset names', () => {
  const expected = [
    'resvgWasm', 'webpDecWasm',
    'newsreaderRegular', 'newsreaderItalic', 'newsreaderMedium',
    'jakartaRegular', 'jakartaBold', 'notoEmojiSubset',
  ].sort();
  assertEquals(ASSET_NAMES.sort(), expected);
});

Deno.test('every manifest entry\'s key is under the system prefix (never {userId}/-shaped)', () => {
  for (const name of ASSET_NAMES) {
    const entry = SHARE_CARD_ASSET_MANIFEST[name];
    assertEquals(entry.key.startsWith(SHARE_CARD_ASSET_PREFIX), true);
    // Explicitly NOT a UUID-prefixed key -- this is what makes it inert to
    // both hard-delete-expired-accounts' orphan sweep (only ever lists
    // `${userId}/`-prefixed strings) and get-media-url's authorization
    // (parseStorageKey requires a `{uuid}/...` shape) -- see this
    // manifest's own header comment for the full verification.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;
    assertEquals(uuidPattern.test(entry.key), false);
  }
});

Deno.test('every manifest entry has a positive byte count and a well-formed 64-char hex sha256', () => {
  const hexPattern = /^[0-9a-f]{64}$/;
  for (const name of ASSET_NAMES) {
    const entry = SHARE_CARD_ASSET_MANIFEST[name];
    assertEquals(entry.bytes > 0, true);
    assertEquals(hexPattern.test(entry.sha256), true);
  }
});

Deno.test('manifest keys are all unique (no two assets accidentally share an R2 object key)', () => {
  const keys = ASSET_NAMES.map((name) => SHARE_CARD_ASSET_MANIFEST[name].key);
  assertEquals(new Set(keys).size, keys.length);
});
