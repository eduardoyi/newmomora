// Single source of truth for compose-share-card's binary assets (resvg
// wasm, webp-dec wasm, font TTFs incl. the NotoEmoji subset), shared between
// the one-time upload script (supabase/scripts/upload-share-card-assets.ts)
// and the Edge Function's runtime asset loader
// (supabase/functions/compose-share-card/assets-loader.ts).
//
// PERF-AUDIT ROUND 4 (this package's implementation report): these 8 assets
// used to be base64-encoded and statically imported as `.ts` modules INSIDE
// compose-share-card -- ~4.8MB of base64 string-literal text that V8 had to
// PARSE as part of this function's own module-graph evaluation, on every
// cold boot (== every request, per S0: no warm isolate has ever been
// observed). A control experiment (a trivial hello-world function deployed
// to the SAME project, hammered with the same request pattern: 15/15
// success) isolated this as the differentiator -- the platform itself is
// healthy; compose-share-card's own ~7.5MB eszip bundle was the outlier.
// Evicting these assets from the module graph entirely (host in R2, fetch
// at request time instead of embedding) is the final, no-tradeoff fix:
// the deployed bundle drops to source code only (a few hundred KB), and the
// fetch cost moves INSIDE the request, in parallel with the DB query and
// image fetches, where it's visible in Server-Timing (`assets;dur=`)
// instead of being invisible platform-boot cost that killed requests with
// no response at all (bodyless 546s, confirmed by their total ABSENCE of a
// Server-Timing header -- proof they never reached our handler).
//
// R2 object keys live under a SYSTEM prefix (`_assets/share-card/v1/`),
// deliberately NOT `{userId}/`-shaped:
//   - hard-delete-expired-accounts' orphan sweep only ever calls
//     listObjectKeys on `${userId}/`-prefixed strings (derived from DB rows
//     -- memory/family-member storage keys, portrait-version prefixes) --
//     verified by reading that function; it can never enumerate or delete
//     anything under `_assets/`.
//   - get-media-url's authorization (`resolveStorageKeyFamilyIds` ->
//     `parseStorageKey`, _shared/storage-keys.ts) requires every key to
//     match one of a fixed set of `{uuid}/...` regexes; a `_assets/...` key
//     matches none of them, so `parseStorageKey` returns null and the
//     request is rejected with `400 validation_error` before a presigned
//     URL is ever created -- verified by reading that function too, not
//     assumed.
export const SHARE_CARD_ASSET_PREFIX = '_assets/share-card/v1/';

export type ShareCardAssetName =
  | 'resvgWasm'
  | 'webpDecWasm'
  | 'newsreaderRegular'
  | 'newsreaderItalic'
  | 'newsreaderMedium'
  | 'jakartaRegular'
  | 'jakartaBold'
  | 'notoEmojiSubset';

export interface ShareCardAssetManifestEntry {
  /** Full R2 object key (already includes SHARE_CARD_ASSET_PREFIX). */
  key: string;
  /** Expected byte length -- cheap first-pass integrity check before the
   * (more expensive) sha256 comparison. */
  bytes: number;
  /** sha256 hex digest of the exact bytes currently deployed/tested --
   * regenerate via the upload script's --print-manifest helper (decodes the
   * local `assets/bin/*` source files) whenever a font/wasm asset changes,
   * and update BOTH this file and re-run the upload script --apply. */
  sha256: string;
}

/**
 * The 8 binary assets compose-share-card needs. Byte counts/hashes were
 * captured from the exact bytes previously embedded in the (now deleted)
 * base64 `.ts` modules under compose-share-card/assets/ -- i.e. this
 * migration is byte-for-byte identical to what was already deployed and
 * tested (the round-1 Latin-subsetted text fonts, the round-1 flag-fixed
 * NotoEmoji subset), not a re-fetch of the original upstream fonts.
 */
export const SHARE_CARD_ASSET_MANIFEST: Record<ShareCardAssetName, ShareCardAssetManifestEntry> = {
  resvgWasm: { key: `${SHARE_CARD_ASSET_PREFIX}resvg.wasm`, bytes: 2478606, sha256: '22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70' },
  webpDecWasm: { key: `${SHARE_CARD_ASSET_PREFIX}webp-dec.wasm`, bytes: 137960, sha256: '30fb52fa2a80166d25ba7debf902218904ba1f05ccce9f959f722beff9e2f344' },
  newsreaderRegular: { key: `${SHARE_CARD_ASSET_PREFIX}newsreader-regular.ttf`, bytes: 75488, sha256: '3bee890ee5ac70c4500a46fb562caba5de0b6d6348be134d8ac9ff509e5f2b29' },
  newsreaderItalic: { key: `${SHARE_CARD_ASSET_PREFIX}newsreader-italic.ttf`, bytes: 84252, sha256: '4982034e1ce30a80204d9a69962ffafdd5fa2e436bf3e9efa5906b169aa56d55' },
  newsreaderMedium: { key: `${SHARE_CARD_ASSET_PREFIX}newsreader-medium.ttf`, bytes: 75836, sha256: '3d42640e56e9c8b1ad46bf097523335952f37d7d21e3d147786c354178d59dfb' },
  jakartaRegular: { key: `${SHARE_CARD_ASSET_PREFIX}jakarta-regular.ttf`, bytes: 31564, sha256: 'b043db69a222306fc7b6dd116c3f89e6e935bb440765cc4be9b85210d31a66f8' },
  jakartaBold: { key: `${SHARE_CARD_ASSET_PREFIX}jakarta-bold.ttf`, bytes: 31568, sha256: '241aafcc1f43086455b388fc6c181835c12473c8c5c05281bd4bc9ab0bce3434' },
  notoEmojiSubset: { key: `${SHARE_CARD_ASSET_PREFIX}noto-emoji-subset.ttf`, bytes: 826552, sha256: 'f25dc96f9307b55d2be4153d2da3c59123b77c3affedbeed0fcfc24686816bf4' },
};

/** sha256 hex digest of `bytes` -- shared helper so the upload script's
 * pre-upload check and the function's post-fetch integrity check use the
 * exact same computation. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
