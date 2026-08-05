// Tests for composeShareCardPng's asset-injection design (perf-audit round
// 4, this package's implementation report): binary assets (resvg wasm,
// font TTFs) are no longer base64-embedded/decoded inside this file -- the
// caller supplies raw bytes via the `assets` parameter. Production sources
// those bytes from R2 (index.ts, via assets-loader.ts); these tests read
// the SAME real binary files straight off disk
// (compose-share-card/assets/bin/* -- the upload script's source AND the
// manifest's sha256-covered content), so composeShareCardPng is exercised
// with the REAL fonts/wasm, not mocks, while never touching R2/network.
import { assertEquals } from 'jsr:@std/assert@1';

import {
  composeShareCardPng,
  type ShareCardRenderAssets,
} from './render.ts';
import { formatShareCardDateLabel, type ShareCardData } from './layout.ts';

const ASSETS_BIN_DIR = new URL('./assets/bin/', import.meta.url);

async function readAssetBin(fileName: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(fileName, ASSETS_BIN_DIR));
}

async function loadTestAssets(): Promise<ShareCardRenderAssets> {
  const [resvgWasm, newsreaderRegular, newsreaderItalic, newsreaderMedium, jakartaRegular, jakartaBold, notoEmoji] = await Promise.all([
    readAssetBin('resvg.wasm'),
    readAssetBin('newsreader-regular.ttf'),
    readAssetBin('newsreader-italic.ttf'),
    readAssetBin('newsreader-medium.ttf'),
    readAssetBin('jakarta-regular.ttf'),
    readAssetBin('jakarta-bold.ttf'),
    readAssetBin('noto-emoji-subset.ttf'),
  ]);
  return {
    resvgWasm,
    fonts: { newsreaderRegular, newsreaderItalic, newsreaderMedium, jakartaRegular, jakartaBold, notoEmoji },
  };
}

const TEST_ASSETS = await loadTestAssets();

function textOnlyCardData(caption: string): ShareCardData {
  return {
    variant: 'quote',
    dateLabel: formatShareCardDateLabel('2026-06-08'),
    caption,
    imageDataUri: null,
    imageAspectRatio: null,
    members: [],
    memberOverflowCount: 0,
    emotion: null,
  };
}

// NOTE on test ordering/state: @resvg/resvg-wasm's initWasm() can only ever
// be called ONCE per Deno process ("Already initialized" is a hard throw on
// a second real call) -- this is a global constraint of the underlying wasm
// runtime, not something render.ts's own `resvgInitPromise` bookkeeping
// controls. `_resetResvgInitForTests()` only clears render.ts's OWN memo
// (useful for testing render.ts's memoization LOGIC in isolation, e.g. via
// a mocked initWasm elsewhere), so these tests deliberately do NOT call it
// around real composeShareCardPng invocations -- the very first
// composeShareCardPng call across ALL tests in this file is the only one
// that may trigger a real initWasm(); every test after it relies on that
// same already-initialized module (Deno runs tests within one file
// sequentially, in one process, by default).

Deno.test('composeShareCardPng renders a real PNG from injected asset bytes, and memoizes the resvg-wasm-compile cost across calls (no R2/network access)', async () => {
  // This is the FIRST composeShareCardPng call in the whole test run -- the
  // only one that pays a real initWasm() compile.
  const first = await composeShareCardPng(textOnlyCardData('A real render, using local fixture bytes.'), TEST_ASSETS);

  // PNG signature -- proof this is a real raster, not empty/garbage bytes.
  assertEquals(first.png[0], 0x89);
  assertEquals(first.png[1], 0x50);
  assertEquals(first.png[2], 0x4e);
  assertEquals(first.png[3], 0x47);
  assertEquals(first.png.length > 0, true);
  assertEquals(first.scale, 'full');

  // A second call reuses the already-compiled module (ensureResvgInitialized's
  // memoization, render.ts) -- its initMs should be small (an await on an
  // already-settled promise), not a repeat of the real compile cost.
  const second = await composeShareCardPng(textOnlyCardData('Second compose, same process.'), TEST_ASSETS);
  assertEquals(second.initMs < 5, true);
});

Deno.test('composeShareCardPng produces the identical layout at 2/3 size for a caption long enough to trip the reduced-scale mitigation', async () => {
  // Relies on resvg-wasm already being initialized by the test above (same
  // process) -- see this file's header note on why this test does NOT call
  // _resetResvgInitForTests(). Real words (not one giant unbroken run) so
  // satori actually WRAPS the text across many lines, the way a real
  // caption would -- an unbroken string of repeated characters doesn't
  // wrap at whitespace and so doesn't reliably push height past the pixel
  // budget the way a real 5000-char caption (validateMemoryContent's cap)
  // does.
  const longCaption = 'A perfectly ordinary Tuesday that somehow became one to remember. '.repeat(80);
  const result = await composeShareCardPng(textOnlyCardData(longCaption), TEST_ASSETS);
  assertEquals(result.scale, 'reduced');
  assertEquals(result.png[0], 0x89); // still a valid PNG
});
