// Runtime asset loader (perf-audit round 4, this package's implementation
// report): fetches compose-share-card's 8 binary assets (resvg wasm,
// webp-dec wasm, font TTFs incl. the NotoEmoji subset) from R2 in ONE
// batched call, instead of the previous base64-encoded static `.ts`
// imports (~4.8MB of string-literal text V8 had to parse on every cold
// boot -- see share-card-assets-manifest.ts's header comment for the full
// diagnosis, including the control experiment that isolated this as the
// cause of the bodyless-546 failures).
//
// Memoized per isolate (`assetsPromise`) exactly like render.ts's
// getFonts()/resvg-wasm-compile memoization: the real fetch+verify only
// ever runs once; a later request in a rare warm isolate just awaits the
// already-settled promise.
import { getObjectBytesBatch, type ObjectBytesBatchEntry } from '../_shared/r2.ts';
import {
  SHARE_CARD_ASSET_MANIFEST,
  sha256Hex,
  type ShareCardAssetName,
} from '../_shared/share-card-assets-manifest.ts';

type BatchFetcher = (keys: string[]) => Promise<Map<string, ObjectBytesBatchEntry>>;

export interface ShareCardAssetBytes {
  resvgWasm: Uint8Array;
  webpDecWasm: Uint8Array;
  newsreaderRegular: Uint8Array;
  newsreaderItalic: Uint8Array;
  newsreaderMedium: Uint8Array;
  jakartaRegular: Uint8Array;
  jakartaBold: Uint8Array;
  notoEmojiSubset: Uint8Array;
}

/** Thrown for ANY asset-loading failure (R2 fetch failure, size mismatch,
 * hash mismatch) -- a fixed, content-free message so the caller
 * (index.ts's runShareCardCompose) can `instanceof`-check it and map to a
 * distinct `assets_unavailable` error code + id-only log line WITHOUT
 * needing to read (and risk logging) any dynamic error detail. Never
 * embed a key name or byte count in a *logged* message -- ids/numbers are
 * fine per AGENTS.md logging discipline, but keeping this class's own
 * message perfectly fixed removes any temptation to log it directly. */
export class ShareCardAssetsUnavailableError extends Error {
  constructor() {
    super('share_card_assets_unavailable');
    this.name = 'ShareCardAssetsUnavailableError';
  }
}

/**
 * Exported (not just an internal implementation detail of
 * loadShareCardAssets below) so tests can exercise the integrity-check
 * logic PRECISELY -- inject a fake `batchFetcher` that returns
 * deliberately-wrong bytes for a given key, without needing real R2
 * access, real credentials, or a real fetch failure to produce a
 * mismatch. Production never passes `batchFetcher` (defaults to the real
 * getObjectBytesBatch); this parameter exists for testability only.
 */
export async function fetchAndVerifyAssets(batchFetcher: BatchFetcher = getObjectBytesBatch): Promise<ShareCardAssetBytes> {
  const entries = Object.entries(SHARE_CARD_ASSET_MANIFEST) as Array<
    [ShareCardAssetName, (typeof SHARE_CARD_ASSET_MANIFEST)[ShareCardAssetName]]
  >;
  const keys = entries.map(([, entry]) => entry.key);

  // ONE batched presign + parallel-fetch call for all 8 assets (perf-audit
  // round 4 design) -- see getObjectBytesBatch's own header comment
  // (_shared/r2.ts) for why this beats N separate getObjectBytes() calls.
  const batch = await batchFetcher(keys);

  const result: Partial<ShareCardAssetBytes> = {};

  for (const [name, entry] of entries) {
    const fetched = batch.get(entry.key);
    if (!fetched || !fetched.ok || !fetched.bytes) {
      throw new ShareCardAssetsUnavailableError();
    }
    if (fetched.bytes.length !== entry.bytes) {
      throw new ShareCardAssetsUnavailableError();
    }
    const hash = await sha256Hex(fetched.bytes);
    if (hash !== entry.sha256) {
      throw new ShareCardAssetsUnavailableError();
    }
    result[name] = fetched.bytes;
  }

  return result as ShareCardAssetBytes;
}

let assetsPromise: Promise<ShareCardAssetBytes> | null = null;

/**
 * Kicks off (or returns the already-in-flight/settled) asset fetch+verify.
 * Callers should invoke this as EARLY as possible (handleComposeShareCard's
 * very first lines, per the round-4 design) so the fetch overlaps with the
 * DB query and image fetches instead of adding to the critical path
 * serially.
 */
export function loadShareCardAssets(): Promise<ShareCardAssetBytes> {
  if (!assetsPromise) {
    assetsPromise = fetchAndVerifyAssets().catch((error) => {
      assetsPromise = null;
      throw error;
    });
  }
  return assetsPromise;
}

// Exposed for tests only -- avoids cross-test memoization bleed (same
// pattern as index.ts's _resetRateLimitStateForTests).
export function _resetShareCardAssetsForTests(): void {
  assetsPromise = null;
}
