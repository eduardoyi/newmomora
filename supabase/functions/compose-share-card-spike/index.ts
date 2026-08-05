// GATING SPIKE (plan: docs/plans/offline-awareness-and-share-cards.md, Workstream S,
// step S0). Measures whether the worst-case share-card compose (satori SVG layout +
// resvg-wasm PNG raster) fits Supabase Edge Functions' ~2s CPU cap.
//
// IMPORTANT SPIKE FINDING #1 (vendoring): the plan's assumed pattern -- "vendor the
// .wasm alongside the code, loaded via Deno.readFile at module scope" -- DOES NOT
// WORK under `supabase functions deploy --use-api`. A temporary `?debug=fs` handler
// (removed once confirmed; see git history) proved that at runtime:
//   - Deno.readFile 404s for EVERY local file, including index.ts itself.
//   - Deno.readDirSync throws "blocklisted on the current context".
//   - fetch() on a module-relative URL (new URL('./x', import.meta.url)) also fails.
// The only content channel that survives deploy is the executing TS/JS module graph
// itself. Working pattern (used below): base64-encode each binary asset into its own
// .ts module as a plain string constant, statically `import`ed -- see ./assets/*.ts.
// Still "vendored" (no CDN fetch, no network dependency) but NOT the file-based
// pattern the plan text described; S3 must follow this pattern instead.
//
// IMPORTANT SPIKE FINDING #2 (round 1, generic fixture): round 1 of this spike
// reused ONE ~600KB/1280x1600 photo 7x (hero + 6 "portraits"). That is NOT
// representative of production (portraits are small pre-resized thumbnails, not
// full photos) and measurably inflated resvg's decode/composite cost. Round 2
// (this version) uses production-realistic assets: hero = JPEG preview, longest
// edge 1280, ~150KB; 6 DISTINCT portrait JPEGs, 256x256, ~24-35KB each (distinct
// matters in case resvg dedupes identical data URIs).
//
// Cases (query param `case`):
//   - worst   : 5000-char caption, 1080px width (full worst case)
//   - mid     : 500-char caption, 1080px width
//   - worst720: 5000-char caption, 720px width (2/3 scale of ALL dimensions --
//               the plan's "reduced raster scale" mitigation, tested here so the
//               tradeoff has real numbers on both sides)
//
// SPIKE ONLY — self-contained under this function dir. Not wired into the app, not
// authenticated, not rate-limited. Delete after measuring (see plan S0).
//
// Returns TIMING JSON ONLY (never the PNG bytes) to keep the response small:
// { case, satoriMs, resvgMs, totalMs, pngBytes, svgHeight, coldStart }.

import satoriImport from 'npm:satori@0.29.0';
import { initWasm, Resvg } from 'npm:@resvg/resvg-wasm@2.6.2';

import { RESVG_WASM_B64 } from './assets/resvg-wasm-b64.ts';
import { NEWSREADER_REGULAR_B64 } from './assets/font-regular-b64.ts';
import { NEWSREADER_MEDIUM_B64 } from './assets/font-medium-b64.ts';
import { HERO_JPEG_B64 } from './assets/hero-b64.ts';
import { PORTRAITS_B64 } from './assets/portraits-b64.ts';

const satori = satoriImport as unknown as (
  tree: SatoriNode,
  options: {
    width: number;
    fonts: Array<{ name: string; data: Uint8Array; weight: number; style: 'normal' }>;
  },
) => Promise<string>;

interface SatoriNode {
  type: string;
  props: Record<string, unknown> & { children?: SatoriNode | SatoriNode[] | string };
}

function h(
  type: string,
  props: Record<string, unknown>,
  children?: SatoriNode | SatoriNode[] | string,
): SatoriNode {
  return { type, props: { ...props, children } };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface InitializedAssets {
  regularFont: Uint8Array;
  mediumFont: Uint8Array;
  heroDataUri: string;
  portraitDataUris: string[];
}

let initPromise: Promise<InitializedAssets> | null = null;
let isFirstInvocation = true;

async function initialize(): Promise<InitializedAssets> {
  const wasmBytes = base64ToBytes(RESVG_WASM_B64);
  const regularFont = base64ToBytes(NEWSREADER_REGULAR_B64);
  const mediumFont = base64ToBytes(NEWSREADER_MEDIUM_B64);

  await initWasm(wasmBytes);

  return {
    regularFont,
    mediumFont,
    heroDataUri: `data:image/jpeg;base64,${HERO_JPEG_B64}`,
    portraitDataUris: PORTRAITS_B64.map((b64) => `data:image/jpeg;base64,${b64}`),
  };
}

function getAssets(): Promise<InitializedAssets> {
  if (!initPromise) {
    initPromise = initialize().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

// --- Caption fixture: mixed words + a few emoji (emoji may render as tofu /
// be skipped by the Newsreader glyph fallback -- that's expected and fine, we
// are measuring CPU cost of satori's text shaping + emoji-detection path, not
// visual fidelity; the real S3 function vendors a monochrome NotoEmoji subset). ---

const CAPTION_WORDS = [
  'today', 'we', 'went', 'to', 'the', 'park', 'and', 'she', 'laughed', 'so',
  'hard', 'at', 'the', 'ducks', 'swimming', 'by', 'the', 'pond', 'grandma',
  'brought', 'her', 'favorite', 'blanket', 'and', 'we', 'had', 'a', 'picnic',
  'under', 'the', 'big', 'oak', 'tree', 'while', 'the', 'clouds', 'drifted',
  'slowly', 'overhead', 'it', 'was', 'the', 'kind', 'of', 'afternoon', 'you',
  'want', 'to', 'remember', 'forever', 'little', 'moments', 'like', 'these',
];
const CAPTION_EMOJI = ['\u{1F600}', '\u{1F389}', '❤️', '\u{1F333}', '\u{1F986}'];

function buildCaption(targetLen: number): string {
  let out = '';
  let i = 0;
  while (out.length < targetLen) {
    out += CAPTION_WORDS[i % CAPTION_WORDS.length] + ' ';
    i += 1;
    if (i % 40 === 0) {
      out += CAPTION_EMOJI[(i / 40) % CAPTION_EMOJI.length] + ' ';
    }
  }
  return out.slice(0, targetLen);
}

// --- Card layout: replicates (approximately -- spike, not pixel-perfect) the
// planned simplified share card: header w/ wordmark + date, 6 overlapping
// portrait circles, full-bleed photo block, full (untruncated) caption.
//
// `scale` multiplies every pixel dimension (the "reduced raster scale"
// mitigation renders the identical layout at 2/3 scale -- 720px width instead
// of 1080px -- rather than reflowing content). ---

function buildCardTree(
  captionLen: number,
  heroDataUri: string,
  portraitDataUris: string[],
  scale: number,
): SatoriNode {
  const s = (px: number) => Math.round(px * scale);
  const width = s(1080);
  const photoHeight = s(1350);
  const caption = buildCaption(captionLen);

  const header = h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: `${s(32)}px ${s(48)}px 0 ${s(48)}px`,
      },
    },
    [
      h(
        'div',
        { style: { display: 'flex', fontSize: s(28), fontFamily: 'Newsreader-Medium', color: '#3A2E28' } },
        'Momora.',
      ),
      h('div', { style: { display: 'flex', fontSize: s(22), color: '#8A7B6C' } }, 'August 5, 2026'),
    ],
  );

  const portraitSize = s(64);
  const portraitRow = h(
    'div',
    { style: { display: 'flex', flexDirection: 'row', marginTop: s(32), marginLeft: s(48) } },
    portraitDataUris.map((src, idx) =>
      h('img', {
        src,
        width: portraitSize,
        height: portraitSize,
        style: {
          borderRadius: portraitSize,
          marginLeft: idx === 0 ? 0 : s(-16),
          border: `${s(3)}px solid #FAF7F2`,
        },
      })),
  );

  const photo = h('img', {
    src: heroDataUri,
    width,
    height: photoHeight,
    style: { display: 'flex', marginTop: s(32) },
  });

  const captionBlock = h(
    'div',
    {
      style: {
        display: 'flex',
        fontSize: s(32),
        lineHeight: 1.5,
        color: '#3A2E28',
        fontFamily: 'Newsreader-Regular',
        padding: `${s(32)}px ${s(48)}px ${s(64)}px ${s(48)}px`,
        whiteSpace: 'pre-wrap',
      },
    },
    caption,
  );

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width,
        backgroundColor: '#FAF7F2',
        fontFamily: 'Newsreader-Regular',
      },
    },
    [header, portraitRow, photo, captionBlock],
  );
}

type CaseName = 'worst' | 'mid' | 'worst720';

const CASE_CONFIG: Record<CaseName, { captionLen: number; width: number; scale: number }> = {
  worst: { captionLen: 5000, width: 1080, scale: 1 },
  mid: { captionLen: 500, width: 1080, scale: 1 },
  worst720: { captionLen: 5000, width: 720, scale: 2 / 3 },
};

interface TimingResult {
  case: CaseName;
  captionLen: number;
  width: number;
  satoriMs: number;
  resvgMs: number;
  totalMs: number;
  pngBytes: number;
  svgBytes: number;
  svgHeight: number | null;
  coldStart: boolean;
}

async function composeAndTime(kind: CaseName): Promise<TimingResult> {
  const assets = await getAssets();
  const coldStart = isFirstInvocation;
  isFirstInvocation = false;

  const { captionLen, width, scale } = CASE_CONFIG[kind];
  const tree = buildCardTree(captionLen, assets.heroDataUri, assets.portraitDataUris, scale);

  const t0 = performance.now();
  const svg = await satori(tree, {
    width,
    fonts: [
      { name: 'Newsreader-Regular', data: assets.regularFont, weight: 400, style: 'normal' },
      { name: 'Newsreader-Medium', data: assets.mediumFont, weight: 500, style: 'normal' },
    ],
  });
  const t1 = performance.now();

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  const t2 = performance.now();

  return {
    case: kind,
    captionLen,
    width,
    satoriMs: Math.round((t1 - t0) * 10) / 10,
    resvgMs: Math.round((t2 - t1) * 10) / 10,
    totalMs: Math.round((t2 - t0) * 10) / 10,
    pngBytes: pngBuffer.length,
    svgBytes: svg.length,
    svgHeight: Number(svg.match(/height="(\d+)"/)?.[1]) || null,
    coldStart,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    });
  }

  const url = new URL(req.url);
  const requestedCaseRaw = url.searchParams.get('case');
  const requestedCase: CaseName =
    requestedCaseRaw === 'mid' ? 'mid' : requestedCaseRaw === 'worst720' ? 'worst720' : 'worst';

  try {
    const result = await composeAndTime(requestedCase);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    // Spike-only debug path: fine to return raw error detail here because this
    // function never touches real memory content. The real S3 function must
    // NEVER do this (AGENTS.md logging discipline: ids + status codes only).
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('compose-share-card-spike failed', message);
    return new Response(JSON.stringify({ error: message, stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});
