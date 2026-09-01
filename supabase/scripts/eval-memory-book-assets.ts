/**
 * Memory Book V3 -- asset bridge (docs/plans/memory-book.md §5 Stage C "V3
 * design decisions", §9 validation row V3). This is NOT production code; it
 * is a read-only eval harness that turns one V2 outline run (produced by
 * `eval:memory-book-outline`, `supabase/scripts/eval-memory-book-outline.ts`)
 * into the local `book-data/<slug>/` directory the `book-renderer/` workspace
 * (React DOM + Vite + Puppeteer, built separately -- see
 * `book-renderer/src/model/types.ts` / `loader.ts` for the consumer side of
 * this exact contract) reads from disk.
 *
 * Pipeline: read `outline.json` -> collect every memory id it references
 * (spreads/backbone/firsts/birthday elements) -> load the real production
 * columns for those ids (`memories`, `memory_media`, `memory_family_members`
 * -> `family_members`, `memory_milestones`, `memory_likes`/`memory_comments`)
 * -> download media + illustration + portrait assets from R2 -> write
 * `manifest.json` + a verbatim copy of `outline.json` as `book.outline.json`.
 *
 * This script is READ-ONLY against the database: every data read goes
 * through the RLS-scoped client (the service-role admin client only
 * bootstraps the auth session), exactly like eval-memory-book-outline.ts.
 *
 * Round-19 exception -- share tokens (docs/plans/memory-book.md §8, revocable
 * QR links): this script now also performs ONE kind of database WRITE --
 * `ensureShareTokens` mints a `media_share_tokens` row (SELECT active by
 * memory_id, INSERT when absent) for every exported memory whose page
 * carries a QR/scan mark (video or audio, see `memoryNeedsShareToken`).
 * Both the SELECT and the INSERT go through the service-role admin client
 * (`createAdminClient`, factored out of `createAuthedClient`'s own internal
 * one), not the RLS-scoped session client -- `media_share_tokens` has no
 * `authenticated` INSERT policy at all (service-role only, matching
 * `memory_milestones`' write posture). Minting failure is FATAL (throws,
 * uncaught -> non-zero exit): a book whose printed QR code encodes a token
 * that doesn't resolve is a silently broken physical artifact, worse than a
 * failed export run. This does not weaken the "read-only" story for
 * `memories`/`memory_media`/etc. above -- those are still only ever read.
 *
 * PII rule: `manifest.json`/`book.outline.json`/`assets/*` are written under
 * `book-renderer/book-data/` -- gitignored, own-account only, and (per the
 * renderer's own data contract) DELIBERATELY contain full memory text, since
 * the renderer has to typeset it. stdout stays counts-only (memories, assets
 * downloaded, skipped, portraits, illustrations, video-poster fallbacks,
 * download failures) -- never memory text, and any object key that does
 * appear (a failed-download warning/error) is basename-only via
 * `objectKeyBasename` -- never the full key (which carries a user/family id
 * path prefix).
 *
 * Reliability fix -- every R2 object fetch (media, illustrations, portraits,
 * video originals) is retried up to twice (`withRetries`,
 * `DOWNLOAD_RETRY_BACKOFFS_MS`: 250ms then 1s) before giving up. A fetch
 * that still fails is recorded into `downloadFailures` (`{kind,
 * objectKey}`, basename-only) and the affected asset/illustration/portrait
 * is simply omitted from the manifest -- it never crashes the run. The
 * final `manifest.downloadFailures` array and the `Download failures after
 * retries: N` stdout line are how a partial run is surfaced; the run only
 * exits non-zero when failures exceed `DOWNLOAD_FAILURE_EXIT_THRESHOLD`
 * (5%) of attempted downloads.
 *
 * Clock-skew hardening -- the R2 retry above doesn't cover DB reads at all,
 * and a freshly-minted magic-link session occasionally races the server's
 * clock: the FIRST query against it (main()'s initial `Promise.all`) can
 * come back `JWT issued at future`/`JWT expired` even though the session
 * itself is fine a moment later. That specific error class (`
 * isClockSkewAuthError`) gets exactly one narrow retry -- wait 2s, call
 * `createAuthedClient()` again, redo the initial load once (max 2 attempts
 * total). Any other DB error, or a second clock-skew error, still fails
 * fast -- this is not a general DB-retry mechanism.
 *
 * Manifest shape additions (per-memory `illustration`, per-portrait
 * `sourceFile`) -- see the `ManifestMemory`/`ManifestPortrait` interfaces
 * below for the authoritative shape:
 *   - Each `manifest.memories[id].illustration` is either `null` (no AI
 *     illustration for that memory) or `{ file, width, height, aspectRatio }`
 *     for `memories.illustration_key` -- illustrated memories otherwise
 *     exported text-only, since the illustration never lives in
 *     `memory_media`.
 *   - Each `manifest.portraits[]` entry is now
 *     `{ file, sourceFile, date, ageLabel }` -- `file` is the AI portrait
 *     (`illustrated_profile_key`), `sourceFile` is the uploaded source photo
 *     (`profile_picture_key`) the portrait was generated from.
 *   - Video assets (`kind: 'video-poster'`) are, when possible, a first
 *     frame extracted at full resolution from the ORIGINAL video
 *     (`memory_media.object_key`) via a local `ffmpeg` binary, not the
 *     preview-resolution `preview_object_key` poster (which prints blurry).
 *     A video whose original exceeds a 300MB guard, or whose extraction
 *     fails (including no `ffmpeg` on PATH), falls back to the stored
 *     preview poster with a counts-only console warning -- the manifest
 *     shape (`ManifestAsset`) is unchanged either way.
 *
 * Owner round-7 -- smarter poster frames: a single first-frame grab is
 * often mid-motion (dark/blurry). `extractFullResolutionPosterFrame`
 * samples `--poster-frames` candidate offsets spread across the clip's
 * duration -- `computeCandidateFrameOffsetsSeconds` (preferring
 * `memory_media.duration_ms`, falling back to an `ffprobe` read, per
 * `probeVideoDurationMs`, when known; fixed odd-second offsets when not) --
 * decodes each candidate small (ffmpeg `scale` to `POSTER_SCORING_FRAME_SIZE`,
 * raw 8-bit grayscale, no image-decoder dependency needed) and scores it via
 * `scorePosterFrameCandidate`, then re-extracts ONLY the winning offset at
 * full resolution/quality for the actual poster. `--poster-frames 1`
 * collapses this entirely back to the original single-first-frame behavior
 * (no scoring pass, byte-identical ffmpeg args to before this feature). The
 * 300MB size guard, retry wrapper, and preview-poster fallback are
 * unchanged.
 *
 * Owner round-8 -- region-aware poster scoring: round-7's
 * `scorePosterFrameCandidate` only ever measured sharpness/brightness/
 * spread over the WHOLE frame, so a sharp background could fully mask a
 * motion-blurred (usually centered) subject -- confirmed by the owner as
 * blurry-subject stills surviving to the printed poster. Fixes, all in
 * `scorePosterFrameCandidate`/`computeCenterWeightedSubjectSharpness`/
 * `computeCellSharpnessGrid`:
 *   - `POSTER_SCORING_FRAME_SIZE` raised 64 -> 128 (same raw-grayscale
 *     ffmpeg pipe, byte count is still exactly size²) -- more pixels per
 *     grid cell for a less noisy per-region sharpness read.
 *   - The scoring frame is divided into a `POSTER_SCORING_GRID_SIZE` (4x4)
 *     cell grid; `computeCellSharpnessGrid` runs the same
 *     `computeLaplacianVarianceSharpness` independently within each cell.
 *   - `computeCenterWeightedSubjectSharpness` takes the MINIMUM sharpness
 *     over the center 2x2 cells (not a mean) -- one blurred center cell
 *     can't be masked by a sharp neighboring center cell.
 *   - The composite score adds that subject term, scaled by
 *     `SUBJECT_SHARPNESS_WEIGHT`, to the existing global sharpness +
 *     midtone-spread terms, weighted so a frame with a sharp background but
 *     a blurred center loses to a frame with a merely-moderate but
 *     genuinely sharp center (see the "subject vs background" test in the
 *     eval file).
 *   - `--poster-frames` default (`DEFAULT_POSTER_FRAME_COUNT`) raised 5 ->
 *     9 -- more sampled candidates raise the odds a sharp, subject-in-focus
 *     frame is actually offered to the scorer. The rejected-frame
 *     brightness penalty and `--poster-frames 1` single-frame collapse are
 *     unchanged.
 *
 * Candidate-id integration gap -- outline.json's top-level
 * `panoramaCandidates`/`heroCandidates`/`coverCandidates` id arrays
 * (candidates that didn't make the backbone cut, so they may not appear in
 * any element's `memoryIds`) are unioned into the id-collection step via
 * `mergeCandidateMemoryIds` -- tolerant of absence for old outlines
 * (`parseOutlineJson` defaults all three to `[]`). Without this, those
 * memories got neither DB data nor exported assets at all. `coverCandidates`
 * (owner decision, 2026-08-31, cover-safety fix) joined the other two here
 * for the exact same reason -- a cover-only nominee that never lands in a
 * spread still needs its asset exported, or the renderer's own cover
 * precedence silently finds nothing to resolve it to and falls through.
 *
 * Owner round-8 -- original dimensions for every photo -- EVERY photo asset
 * in the export (not just a `panoramaCandidates`/`heroCandidates` memory)
 * also gets `originalWidth`/`originalHeight` recorded from the ORIGINAL
 * (not preview) bytes -- measured then discarded, never written to disk --
 * because the renderer's panorama (>=3500px source width) and full-bleed
 * (300ppi) gates check against real dimensions the ~1280px preview file can
 * never satisfy. Previously this only ran for the small panorama/hero
 * candidate set, which in practice was empty on both real books, leaving
 * the full-bleed gate de facto dead code -- 0 candidates ever measured.
 * `shouldMeasureOriginalDimensions` is the pure gate (`kind === 'photo'`,
 * video-poster jobs never qualify -- their "original" is a video file, not
 * a still image). A non-image original is skipped; a fetch failure here is
 * retried/recorded in `downloadFailures` exactly like every other asset,
 * but does NOT fail the already-exported preview-based asset. This roughly
 * doubles the R2 download volume for photo assets (one preview fetch for
 * the exported file, one original fetch purely for measurement) -- video
 * posters are unaffected.
 *
 * Outline.json gap (see main(), the "through-the-years portraits" step):
 * `outline.json`'s `through-the-years` element never carries portrait-version
 * ids (`buildReadingOrder` in eval-memory-book-outline.ts always emits it
 * with `memoryIds: []`) -- portraits aren't memories. This script re-derives
 * the same set the outline run would have seen by re-querying
 * `family_member_portrait_versions` with the outline's own `child.id` +
 * `window` (identical filter to `loadPortraitVersionsInWindow` in the
 * outline script), rather than guessing from anything in outline.json.
 *
 * Examples:
 *   npm run eval:memory-book-assets -- --outline-run supabase/scripts/eval-output/memory-book-outline/<dir>
 *   npm run eval:memory-book-assets -- --outline-run <dir> --out book-renderer/book-data/enzo-year-one --concurrency 8
 *   npm run eval:memory-book-assets -- --outline-run <dir> --language es
 *   npm run eval:memory-book-assets -- --outline-run <dir> --exclude-portrait-id 1dbc29b2-43d0-42e0-811c-26d58959dfbd
 *   npm run eval:memory-book-assets -- --outline-run <dir> --poster-frames 1
 *   npm run eval:memory-book-assets -- --outline-run <dir> --print-assets
 *
 * `--exclude-portrait-id <uuid>` (repeatable) drops a
 * `family_member_portrait_versions` id from the export entirely -- omitted
 * from `manifest.portraits[]`, never downloaded. Owner editorial call:
 * Mara's 2025-01-25 portrait pair (id `1dbc29b2-43d0-42e0-811c-
 * 26d58959dfbd`) is redundant with the 2025-02-04 one. An unrecognized CLI
 * argument (including a malformed flag) is rejected outright -- `parseArgs`
 * throws with the offending token + `CLI_USAGE` rather than silently
 * dropping it (same hardening fix as eval-memory-book-outline.ts/
 * eval-memory-book-tagging.ts).
 *
 * `--language <es|en>` is written into manifest.json as `language` -- the
 * family's journal language, which book-renderer's furniture (section
 * labels, signatures, scan-mark microcopy) follows. Round-18: when
 * `--language` is omitted, this now defaults from the outline run's own
 * resolved `outline.json` "language" (coerced to "es"/"en" -- see
 * `coerceManifestLanguage`) instead of a hardcoded "en"; an explicit
 * `--language` flag still always wins. Falls back to "en" exactly as
 * before on an outline run that predates that field.
 *
 * Round-20 -- `--print-assets`: the default (preview) loop exports the
 * ~1280px `preview_object_key` JPEG for every photo asset -- fine for a fast
 * iteration loop, but book-renderer/scripts/render-pdf.mts (Puppeteer)
 * embeds whatever sits in `assets/` verbatim, so a print PDF built from a
 * preview-mode export carries ~170dpi photos. `--print-assets` downloads the
 * ORIGINAL R2 object (`memory_media.object_key`) as the exported photo asset
 * instead -- the same object the original-dimensions measurement step
 * (`measureOriginalDimensions`) already fetches for every photo regardless
 * of this flag (see the "original dimensions for every photo" note above);
 * in print mode that one fetch is reused as the exported file itself
 * (written to disk, not discarded) rather than fetched a second time, and
 * its measured dimensions become BOTH the asset's own `width`/`height` AND
 * `originalWidth`/`originalHeight` (`shouldDownloadOriginalForPrint`).
 * Video-poster assets are unaffected either way -- they already extract a
 * full-resolution frame from the original video unconditionally (see above).
 *
 * Puppeteer/Chromium cannot render HEIC. `isHeicContentType` gates a
 * transcode-to-JPEG attempt (`transcodeHeicBytesToJpeg`) via `npm:sharp@0.33`
 * -- the exact package + version backfill-media-previews.ts already relies
 * on, in this same Deno/npm-compat runtime, to decode HEIC uploads and
 * produce JPEG previews in production (`downloadAndResize`'s
 * `sharp(originalBuffer)` runs for every `ALLOWED_IMAGE_CONTENT_TYPES`
 * member, heic/heif included) -- proven working here, unlike shelling out to
 * a local `ffmpeg` binary's HEIC decode support, which depends on that
 * binary having been compiled with libheif (not guaranteed, and would need
 * its own availability probe the way the poster path probes `ffmpeg`/
 * `ffprobe`). No resize on transcode -- `PRINT_ASSET_HEIC_JPEG_QUALITY` (95)
 * is a near-lossless JPEG quality appropriate for print, not the lower
 * `PREVIEW_JPEG_QUALITY` (80) backfill-media-previews.ts uses for in-app
 * thumbnails. A transcode failure (including sharp being unavailable) never
 * fails the export: that one asset falls back to the already-selected
 * preview file (`job.key`, always a JPEG) and is counted in
 * `printAssetHeicFallbackCount`, reported loudly at the end ("N assets fell
 * back to preview resolution") and NOT retried as an original -- callers
 * decide whether the fallback rate is acceptable for a given print run.
 *
 * Preview-mode (`--print-assets` omitted) behavior, byte-for-byte, is
 * unchanged -- the flag only branches the photo-asset download path.
 * `manifest.assetMode` ('preview' | 'print') records which mode produced a
 * given export, so the renderer/audit tooling could later distinguish a
 * preview-quality `book-data/` directory from a print-ready one.
 *
 * Requires Supabase vars in supabase/.env.local and R2 vars for image/video
 * downloads, plus a local `ffmpeg` binary on PATH for full-resolution video
 * poster extraction (same dependency as backfill-video-posters.ts -- absence
 * degrades to the preview-poster fallback above rather than failing the
 * run). DB/R2 env access is not available in every environment this script
 * runs in -- it must typecheck even when it cannot be executed.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getObjectBytes, headObject } from '../functions/_shared/r2.ts';
import { classifyChildOrAdult } from '../functions/_shared/date-context.ts';
import { describeAgeAtDate, getAgeInYearsAtDate } from '../functions/_shared/age.ts';
import { getMilestoneById } from '../functions/_shared/memory-milestones.ts';
// V5a "part B": the pure outline.json-parsing + manifest.json-shaping
// pieces now live in a runtime-agnostic shared module so the upcoming
// Cloudflare Workflow worker can import them too -- same precedent as
// workflow.ts importing prompts.ts. This eval script re-imports them here
// rather than redefining them.
import {
  buildManifest,
  buildManifestAsset,
  buildManifestIllustration,
  buildManifestMemory,
  buildManifestMilestone,
  buildManifestPortrait,
  buildManifestScope,
  buildTaggedMember,
  collectMemoryIdsFromElements,
  generateShareToken,
  memoryNeedsShareToken,
  mergeCandidateMemoryIds,
  parseOutlineJson,
  shouldMeasureOriginalDimensions,
  type DownloadFailure,
  type ManifestAsset,
  type ManifestAssetKind,
  type ManifestIllustration,
  type ManifestLanguage,
  type ManifestMemory,
  type ManifestPortrait,
  type ManifestTaggedMember,
  type OutlineWindow,
} from '../functions/_shared/memory-book-manifest.ts';

// ── CLI ──────────────────────────────────────────────────────────────────
// (ManifestLanguage moved to ../functions/_shared/memory-book-manifest.ts.)

interface CliOptions {
  outlineRun: string | null;
  out: string | null;
  concurrency: number;
  /**
   * The family's journal language, written into manifest.json as
   * `language` -- book-renderer's furniture (section labels, signatures,
   * scan-mark microcopy) follows this, not the app UI language. Round-18:
   * when `--language` is not passed, `main()` now defaults this from the
   * outline run's own resolved `outline.json` "language" field instead of
   * a hardcoded "en" -- see `resolveManifestLanguageDefault`. This field
   * still starts as `DEFAULT_LANGUAGE` here (outline.json isn't loaded yet
   * at CLI-parse time); `languageExplicit` below is what lets `main()` tell
   * "the caller actually passed --language" apart from "still the default."
   */
  language: ManifestLanguage;
  /**
   * Round-18: true only when `--language` was actually passed on the CLI --
   * distinguishes an explicit `--language en` from "the flag was never
   * given," since both otherwise leave `language` at `DEFAULT_LANGUAGE`.
   * `main()` only applies the outline.json default when this is false (an
   * explicit CLI flag always wins over the outline's own resolution).
   */
  languageExplicit: boolean;
  /**
   * Owner editorial exclusion list: `family_member_portrait_versions` ids
   * to drop from the export entirely -- omitted from `manifest.portraits[]`
   * and never downloaded. Repeatable (same convention as
   * eval-memory-book-outline.ts's `--exclude-memory-id`). Motivating case:
   * Mara's 2025-01-25 portrait pair is redundant with the 2025-02-04 one
   * (`--exclude-portrait-id 1dbc29b2-43d0-42e0-811c-26d58959dfbd`).
   */
  excludePortraitIds: string[];
  /**
   * Owner round-7 feature: how many candidate frames to sample across a
   * video's duration (evenly spread by default -- see
   * `candidateFramePercentiles`) and score before picking the sharpest/
   * best-exposed/most-in-focus one as its poster -- see
   * `computeCandidateFrameOffsetsSeconds`/`pickBestPosterFrameIndex`.
   * `--poster-frames 1` restores the pre-round-7 single-first-frame
   * behavior exactly. Defaults to `DEFAULT_POSTER_FRAME_COUNT` (9, per
   * owner round-8).
   */
  posterFrameCount: number;
  /**
   * Round-20: when set, photo assets download the ORIGINAL R2 object
   * (`memory_media.object_key`) instead of the ~1280px
   * `preview_object_key` -- see the header note "`--print-assets`" for the
   * full rationale (Puppeteer print PDFs embedding preview-resolution
   * photos). Defaults to `false` -- the fast preview loop is unchanged
   * unless this flag is passed. Video-poster assets always extract a
   * full-resolution frame from the original video regardless of this flag,
   * so it only ever branches the PHOTO download path
   * (`shouldDownloadOriginalForPrint`).
   */
  printAssets: boolean;
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_LANGUAGE: ManifestLanguage = 'en';

/**
 * Narrows an arbitrary BCP-47 code (as resolved by the outline script's own
 * round-18 LANGUAGE chain -- may be e.g. "es-MX", "en", "fr") down to this
 * script's own bilingual `ManifestLanguage`. book-renderer's furniture
 * currently only ships Spanish/English copy, so anything whose primary
 * subtag is "es" maps to "es"; everything else (including a code this
 * script doesn't recognize at all) maps to `DEFAULT_LANGUAGE` -- the same
 * "no single correct global default" reasoning `DEFAULT_LANGUAGE` already
 * documents, just applied per-outline instead of hardcoded.
 */
export function coerceManifestLanguage(bcp47: string | undefined): ManifestLanguage {
  if (bcp47 && /^es(-|$)/i.test(bcp47.trim())) return 'es';
  return DEFAULT_LANGUAGE;
}

/**
 * Round-18: when `--language` was never passed, default to the outline
 * run's own resolved `outline.json` "language" instead of the hardcoded
 * "en" -- a caption-less book resolved e.g. "es" via the outline's own
 * LANGUAGE chain should export as Spanish furniture without the caller
 * having to know and repeat that choice. An EXPLICIT `--language` flag
 * always wins over the outline's own resolution (owner precedent: the CLI
 * flag was always the final word here). Pure so the default-vs-explicit
 * precedence is unit-testable independent of the outline.json round trip.
 */
export function resolveManifestLanguageDefault(
  languageExplicit: boolean,
  cliLanguage: ManifestLanguage,
  outlineLanguage: string | undefined,
): ManifestLanguage {
  if (languageExplicit) return cliLanguage;
  // Owner incident (2026-08-29): a pre-round-18 outline.json carries no
  // `language` field, and the silent coerce-to-'en' fallback shipped two
  // Spanish books to the printer with English furniture ("Oct 23",
  // "OCTOBER-NOVEMBER 2024"). A missing outline language is now a HARD
  // ERROR when --language wasn't passed -- the caller must state the
  // language explicitly for old outlines rather than inherit a guess.
  if (outlineLanguage === undefined || outlineLanguage === '') {
    throw new Error(
      'outline.json carries no `language` field (pre-round-18 outline) and no --language flag was passed. ' +
        'Pass --language <es|en> explicitly -- refusing to default silently (a Spanish book once shipped to print with English furniture this way).',
    );
  }
  return coerceManifestLanguage(outlineLanguage);
}

/** Printed alongside a rejected argument -- same hardening precedent as
 * eval-memory-book-outline.ts/eval-memory-book-tagging.ts's `CLI_USAGE`:
 * never silently drop an unrecognized token instead of erroring. */
export const CLI_USAGE =
  'Usage: eval-memory-book-assets.ts --outline-run <dir> ' +
  '[--out <dir>] [--concurrency <n>] [--language <es|en>] [--exclude-portrait-id <uuid>]... ' +
  '[--poster-frames <n>] [--print-assets]';

/**
 * Throws on any argument that isn't one of the known flags (or a value
 * already consumed by one) -- same hardening fix as the outline/tagging
 * scripts got. The caller (`main`) catches this and exits non-zero with
 * the offending token + `CLI_USAGE` rather than proceeding with a
 * partially (or entirely) unparsed invocation.
 */
export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    outlineRun: null,
    out: null,
    concurrency: DEFAULT_CONCURRENCY,
    language: DEFAULT_LANGUAGE,
    languageExplicit: false,
    excludePortraitIds: [],
    posterFrameCount: DEFAULT_POSTER_FRAME_COUNT,
    printAssets: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--outline-run':
        options.outlineRun = next ?? null;
        index += 1;
        break;
      case '--out':
        options.out = next ?? null;
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = next ? Number(next) || DEFAULT_CONCURRENCY : DEFAULT_CONCURRENCY;
        index += 1;
        break;
      case '--language':
        options.language = next === 'es' ? 'es' : DEFAULT_LANGUAGE;
        options.languageExplicit = true;
        index += 1;
        break;
      case '--exclude-portrait-id':
        if (next) options.excludePortraitIds.push(next);
        index += 1;
        break;
      case '--poster-frames': {
        const parsed = next ? Number(next) : NaN;
        options.posterFrameCount = Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_POSTER_FRAME_COUNT;
        index += 1;
        break;
      }
      case '--print-assets':
        // Boolean flag -- no value to consume, unlike every other case above.
        options.printAssets = true;
        break;
      default:
        throw new Error(`Unknown argument: "${arg}"\n${CLI_USAGE}`);
    }
  }

  return options;
}

// outline.json parsing (OutlineChild/OutlineScope/OutlineWindow/
// OutlineElementLike/ParsedOutline/parseOutlineJson/
// collectMemoryIdsFromElements/mergeCandidateMemoryIds, incl. their private
// requireString/optionalStringArray helpers) moved to
// ../functions/_shared/memory-book-manifest.ts.
// ── Pure helpers: manifest scope + default output dir ──────────────────────
// (ManifestScopeKind/mapScopeKind/subtractOneDay/ManifestScope/
// buildManifestScope moved to ../functions/_shared/memory-book-manifest.ts.)

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `book-renderer/book-data/<child-first-name-lowercase>-<scope-label-slug>/`
 * (brief default). */
export function defaultOutDir(childName: string, windowLabel: string): string {
  const firstName = childName.trim().split(/\s+/)[0] ?? childName;
  return `book-renderer/book-data/${slugify(firstName)}-${slugify(windowLabel)}/`;
}

// ── Pure helpers: asset selection (brief step 3) ────────────────────────────
// (ManifestAssetKind moved to ../functions/_shared/memory-book-manifest.ts.)

export interface MediaAssetSelectionInput {
  contentType: string;
  objectKey: string;
  previewObjectKey: string | null;
}

export interface SelectedMediaAsset {
  key: string;
  kind: ManifestAssetKind;
}

const FALLBACK_ELIGIBLE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Brief step 3: "prefer preview_object_key (JPEG; also the poster for
 * videos); fall back to original object_key only for jpeg/png/webp; skip
 * HEIC-without-preview (count it)." Returns `null` for anything that must be
 * skipped -- HEIC/HEIF without a preview, or a video without a poster
 * preview (raw video bytes are never a valid "photo" asset).
 */
export function selectMediaAsset(media: MediaAssetSelectionInput): SelectedMediaAsset | null {
  if (media.previewObjectKey) {
    return {
      key: media.previewObjectKey,
      kind: media.contentType.startsWith('video/') ? 'video-poster' : 'photo',
    };
  }
  if (FALLBACK_ELIGIBLE_CONTENT_TYPES.has(media.contentType)) {
    return { key: media.objectKey, kind: 'photo' };
  }
  return null;
}

/** Mirrors the `renderReviewHtml` extension convention in
 * eval-memory-book-outline.ts, extended with heic/heif for completeness
 * (unreachable via `selectMediaAsset`'s own rules, but keeps this pure
 * helper correct for any key regardless of caller). */
export function extensionFromKey(key: string): string {
  if (key.endsWith('.png')) return 'png';
  if (key.endsWith('.webp')) return 'webp';
  if (key.endsWith('.heic')) return 'heic';
  if (key.endsWith('.heif')) return 'heif';
  return 'jpg';
}

export function mediaAssetFileName(memoryId: string, position: number, ext: string): string {
  return `assets/${memoryId}-${position}.${ext}`;
}

// ── Pure helpers: --print-assets download-path selection (round-20) ────────
// See the header note "`--print-assets`" for the full rationale -- these
// three are the ONLY decisions this feature makes ahead of time (before any
// actual network/ffmpeg/sharp work runs), so they're kept pure/unit-testable
// independent of the download itself.

/** True for `image/heic`/`image/heif` -- the two content types Puppeteer/
 * Chromium cannot render, so a print-mode original in either of these needs
 * a JPEG transcode attempt (`transcodeHeicBytesToJpeg`) before it can be
 * embedded in the printed PDF. */
export function isHeicContentType(contentType: string): boolean {
  return contentType === 'image/heic' || contentType === 'image/heif';
}

/**
 * Whether a media job's PRIMARY download should be the ORIGINAL R2 object
 * (`memory_media.object_key`) rather than the `selectMediaAsset`-chosen
 * key (preview, or original-as-fallback for jpeg/png/webp without one).
 * Only ever true for a `photo` job with `--print-assets` set --
 * `video-poster` jobs already extract a full-resolution frame from the
 * original video unconditionally (see `extractFullResolutionPosterFrame`),
 * regardless of this flag, so routing them through the original-download
 * path here would just mean downloading the raw video bytes as a "photo,"
 * which is never correct.
 */
export function shouldDownloadOriginalForPrint(printAssets: boolean, kind: ManifestAssetKind): boolean {
  return printAssets && kind === 'photo';
}

/**
 * The file extension a print-mode photo asset will be written under --
 * decided ahead of the actual download so `mediaAssetFileName` can be
 * computed once, at job-build time, same as the preview-mode path. A HEIC/
 * HEIF original ALWAYS ends up as `jpg` on disk, whether the transcode
 * attempt succeeds (re-encoded to JPEG) or fails (falls back to the
 * already-selected preview file, which `selectMediaAsset` guarantees is
 * itself a JPEG whenever a HEIC job reached this point at all -- see
 * `selectMediaAsset`'s "skip HEIC without a preview" rule). Anything else
 * keeps the original object key's own extension unchanged.
 */
export function resolvePrintPhotoExtension(contentType: string, objectKey: string): string {
  if (isHeicContentType(contentType)) return 'jpg';
  return extensionFromKey(objectKey);
}

/** sharp's 1-100 JPEG quality scale -- near-lossless, appropriate for a
 * print-bound HEIC transcode (`transcodeHeicBytesToJpeg`). Deliberately
 * higher than backfill-media-previews.ts's `PREVIEW_JPEG_QUALITY` (80),
 * which is tuned for a small in-app preview, not a printed page. */
export const PRINT_ASSET_HEIC_JPEG_QUALITY = 95;

/** `memories.illustration_key` export target (brief item 1 -- illustrations
 * live outside `memory_media` entirely, so this is a separate file/id
 * namespace from `mediaAssetFileName`). */
export function illustrationFileName(memoryId: string, ext: string): string {
  return `assets/${memoryId}-illustration.${ext}`;
}

export function portraitFileName(versionId: string, ext: string): string {
  return `assets/portrait-${versionId}.${ext}`;
}

/** Source-photo export target for a portrait version (brief item 3 --
 * `family_member_portrait_versions.profile_picture_key`, the photo the AI
 * portrait at `portraitFileName` was generated from). */
export function portraitSourceFileName(versionId: string, ext: string): string {
  return `assets/portrait-${versionId}-source.${ext}`;
}

/**
 * Owner editorial exclusion (`--exclude-portrait-id`, repeatable): drops
 * any portrait version whose id is in `excludeIds` before it ever becomes
 * a download job -- excluded from `manifest.portraits[]` AND never
 * downloaded, not just hidden after the fact. A no-op (same array
 * reference) when nothing is excluded.
 */
export function excludePortraitVersionIds<T extends { id: string }>(versions: T[], excludeIds: string[]): T[] {
  if (excludeIds.length === 0) return versions;
  const excluded = new Set(excludeIds);
  return versions.filter((version) => !excluded.has(version.id));
}

// ── Pure helpers: video poster full-resolution extraction (brief item 2) ──

/** 300MB guard on the ORIGINAL video an eval run will download to a temp
 * file for ffmpeg extraction -- above this, fall back to the stored preview
 * poster rather than pulling a huge file into memory/disk for one frame. */
export const MAX_VIDEO_POSTER_SOURCE_BYTES = 300 * 1024 * 1024;

export function exceedsVideoPosterSizeGuard(contentLengthBytes: number | null): boolean {
  return contentLengthBytes != null && contentLengthBytes > MAX_VIDEO_POSTER_SOURCE_BYTES;
}

/** ffmpeg quality for full-resolution poster extraction -- lower is better
 * on ffmpeg's `-q:v` 2-31 scale; 2 is near-lossless JPEG, appropriate for a
 * print-bound poster (contrast with backfill-video-posters.ts's `3`, tuned
 * instead for a small in-app list-thumbnail preview). */
export const FULL_RESOLUTION_POSTER_FFMPEG_QUALITY = '2';

/**
 * Builds the ffmpeg argument list for a single-frame, full-resolution
 * poster extraction from `sourcePath` (a local file path -- unlike
 * backfill-video-posters.ts's `buildFfmpegPosterArgs`, this script downloads
 * the original video to a temp file first rather than streaming a presigned
 * URL, per the brief). No `-vf scale` filter: the whole point of this path
 * is print-resolution output, so the frame is kept at the source video's
 * native resolution. `offsetSeconds` (default 0, the historical behavior --
 * `--poster-frames 1` still produces this exact arg list) seeks to the
 * WINNING candidate offset chosen by `pickBestPosterFrameIndex` before
 * re-extracting it at full quality; `-ss` is omitted entirely at 0 rather
 * than passed as `-ss 0`, so the single-frame path's args are byte-identical
 * to before this feature existed.
 */
export function buildFullResolutionPosterFfmpegArgs(sourcePath: string, offsetSeconds = 0): string[] {
  const seekArgs = offsetSeconds > 0 ? ['-ss', String(offsetSeconds)] : [];
  return [
    '-y',
    ...seekArgs,
    '-i',
    sourcePath,
    '-vframes',
    '1',
    '-q:v',
    FULL_RESOLUTION_POSTER_FFMPEG_QUALITY,
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ];
}

/** Temp-file suffix for the downloaded original video, so ffmpeg's own
 * container sniffing has a plausible extension to work with. */
export function videoPosterTempFileSuffix(contentType: string): string {
  return contentType === 'video/quicktime' ? '.mov' : '.mp4';
}

// ── Pure helpers: multi-candidate poster-frame selection (owner round-7 --
// a single first-frame grab is often dark/blurry mid-motion; extract a
// handful of candidates spread across the clip, score them on cheap
// downsampled-grayscale heuristics, and re-extract only the winner at full
// resolution) ────────────────────────────────────────────────────────────

/** `--poster-frames` default -- 9 candidates per video (owner round-8, up
 * from round-7's 5), evenly spread across the clip via
 * `candidateFramePercentiles`/`computeCandidateFrameOffsetsSeconds` (~5.6/
 * 16.7/27.8/38.9/50/61.1/72.2/83.3/94.4% of duration, or fixed odd-second
 * offsets 1/3/5/7/9/11/13/15/17s when duration is unknown). More candidates
 * raise the odds a sharp, well-exposed, subject-in-focus frame is actually
 * sampled. `--poster-frames 1` restores the old single-first-frame
 * behavior exactly (see `computeCandidateFrameOffsetsSeconds`). */
export const DEFAULT_POSTER_FRAME_COUNT = 9;

/** The fraction-of-duration midpoint of the i-th of `frameCount` equal
 * segments -- `(2i+1)/(2n)`. For the original brief's 5 candidates this is
 * exactly 10%/30%/50%/70%/90%; for the current default of 9
 * (`DEFAULT_POSTER_FRAME_COUNT`, owner round-8) it's the same even
 * generalization: ~5.6%/16.7%/27.8%/38.9%/50%/61.1%/72.2%/83.3%/94.4%. */
export function candidateFramePercentiles(frameCount: number): number[] {
  return Array.from({ length: Math.max(frameCount, 1) }, (_, i) => (2 * i + 1) / (2 * frameCount));
}

/**
 * Seconds-from-start offsets for each poster-frame candidate.
 * - `frameCount <= 1`: `[0]` -- exactly the pre-existing single-first-frame
 *   behavior (`--poster-frames 1`).
 * - `durationMs` known (positive): percentile-of-duration offsets from
 *   `candidateFramePercentiles` -- evenly spread across the clip (10/30/
 *   50/70/90% for the original 5-candidate brief; ~5.6/16.7/27.8/38.9/50/
 *   61.1/72.2/83.3/94.4% for the current 9-candidate default). `durationMs`
 *   should be the manifest/DB's own `memory_media.duration_ms` when
 *   present; ffprobe is the fallback source (see `probeVideoDurationSeconds`
 *   in main()), not duplicated here since this helper only computes offsets
 *   from a duration it's given.
 * - `durationMs` unknown/non-positive: fixed odd-second offsets (1s/3s/5s/
 *   7s/9s for 5 candidates, extending the same way to 1/3/5/7/9/11/13/15/
 *   17s for the current 9-candidate default) -- a percentage of an unknown
 *   duration is meaningless, so this falls back to absolute seconds per
 *   the brief.
 */
export function computeCandidateFrameOffsetsSeconds(frameCount: number, durationMs: number | null): number[] {
  if (frameCount <= 1) return [0];
  if (durationMs != null && durationMs > 0) {
    const durationSeconds = durationMs / 1000;
    return candidateFramePercentiles(frameCount).map((percentile) => percentile * durationSeconds);
  }
  return Array.from({ length: frameCount }, (_, i) => 2 * i + 1);
}

/** Downscale size (px, square) for a scoring candidate -- small enough that
 * decoding + scoring `DEFAULT_POSTER_FRAME_COUNT` candidates per video is
 * cheap, large enough that the Laplacian/brightness/spread heuristics below
 * aren't dominated by noise. Raised 64 -> 128 (owner round-8) so the 4x4
 * region grid (`POSTER_SCORING_GRID_SIZE`) used by
 * `computeCenterWeightedSubjectSharpness` gets a full 32x32px per cell
 * instead of 16x16px -- more pixels per region for a less noisy per-cell
 * sharpness read. Must stay evenly divisible by `POSTER_SCORING_GRID_SIZE`. */
export const POSTER_SCORING_FRAME_SIZE = 128;

/**
 * Builds the ffmpeg argument list for one scoring candidate: seek to
 * `offsetSeconds`, grab a single frame, force-scale to a fixed
 * `POSTER_SCORING_FRAME_SIZE`x`POSTER_SCORING_FRAME_SIZE` square (ignoring
 * aspect ratio -- scoring doesn't care about visual correctness, only
 * texture, and a fixed size means the raw output byte count is always
 * exactly known with no header to parse), and mux raw 8-bit grayscale
 * pixels to stdout (`-pix_fmt gray`) rather than a JPEG -- no image decoder
 * needed on this side, the bytes ARE the pixel buffer.
 */
export function buildScoringFrameFfmpegArgs(sourcePath: string, offsetSeconds: number): string[] {
  const seekArgs = offsetSeconds > 0 ? ['-ss', String(offsetSeconds)] : [];
  return [
    '-y',
    ...seekArgs,
    '-i',
    sourcePath,
    '-vframes',
    '1',
    '-vf',
    `scale=${POSTER_SCORING_FRAME_SIZE}:${POSTER_SCORING_FRAME_SIZE}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ];
}

/** A decoded scoring candidate: row-major 8-bit grayscale pixels,
 * `pixels.length === width * height`. */
export interface GrayscaleFrame {
  width: number;
  height: number;
  pixels: Uint8Array | number[];
}

const MIN_ACCEPTABLE_MEAN_BRIGHTNESS = 25; // 0-255 scale -- below this reads as a black/near-black frame.
const MAX_ACCEPTABLE_MEAN_BRIGHTNESS = 230; // above this reads as blown-out/washed-out.

export function computeMeanBrightness(frame: GrayscaleFrame): number {
  const { pixels } = frame;
  if (pixels.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 1) sum += pixels[i];
  return sum / pixels.length;
}

/**
 * Laplacian-variance sharpness approximation -- a standard cheap focus
 * metric: convolve interior pixels with the discrete Laplacian kernel
 * `[[0,1,0],[1,-4,1],[0,1,0]]` and take the variance of the responses. A
 * blurry frame has smooth gradients everywhere, so its Laplacian responses
 * cluster near zero (low variance); a sharp frame has strong edges that
 * spike the Laplacian in both directions (high variance). Operates on the
 * already-downsampled `POSTER_SCORING_FRAME_SIZE` buffer, not the eventual
 * full-resolution poster.
 */
export function computeLaplacianVarianceSharpness(frame: GrayscaleFrame): number {
  const { width, height, pixels } = frame;
  if (width < 3 || height < 3) return 0;

  const at = (x: number, y: number) => pixels[y * width + x];
  const responses: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      responses.push(at(x, y - 1) + at(x, y + 1) + at(x - 1, y) + at(x + 1, y) - 4 * at(x, y));
    }
  }
  if (responses.length === 0) return 0;

  const mean = responses.reduce((sum, value) => sum + value, 0) / responses.length;
  return responses.reduce((sum, value) => sum + (value - mean) ** 2, 0) / responses.length;
}

/** Midtone spread, approximated as the standard deviation of every pixel
 * value in the frame -- rewards contrast. A flat/foggy/washed-out frame can
 * still register as "sharp" by the Laplacian alone (compression artifacts,
 * sensor noise) while having almost no real tonal range; this term
 * penalizes that case and rewards a frame with genuine light-to-dark
 * spread across its midtones. */
export function computeMidtoneSpread(frame: GrayscaleFrame): number {
  const { pixels } = frame;
  if (pixels.length === 0) return 0;
  const mean = computeMeanBrightness(frame);
  let sumSquaredDeviation = 0;
  for (let i = 0; i < pixels.length; i += 1) sumSquaredDeviation += (pixels[i] - mean) ** 2;
  return Math.sqrt(sumSquaredDeviation / pixels.length);
}

// ── Region-aware subject-sharpness scoring (owner round-8 -- a sharp
// background can fully dominate the whole-frame sharpness term above even
// when the (usually centered) subject is itself motion-blurred; owner
// confirmed blurry-subject stills surviving to the printed poster) ────────

/** Cells per side when dividing a scoring frame into a spatial grid for
 * `computeCellSharpnessGrid`/`computeCenterWeightedSubjectSharpness`. At the
 * current `POSTER_SCORING_FRAME_SIZE` (128) this gives 32x32px cells. */
export const POSTER_SCORING_GRID_SIZE = 4;

/**
 * Splits `frame` into a `gridSize`x`gridSize` grid of equal-size cells and
 * computes `computeLaplacianVarianceSharpness` independently within each
 * cell (each cell scored as its own small `GrayscaleFrame`). Returns a
 * row-major `gridSize`x`gridSize` array, `result[row][col]`. Any remainder
 * pixels from a non-evenly-divisible `width`/`height` are simply dropped
 * from the trailing row/column -- this is a scoring heuristic, not a
 * precision requirement, and `POSTER_SCORING_FRAME_SIZE` (128) divides
 * evenly by `POSTER_SCORING_GRID_SIZE` (4) in production anyway.
 */
export function computeCellSharpnessGrid(frame: GrayscaleFrame, gridSize: number): number[][] {
  const { width, height, pixels } = frame;
  const cellWidth = Math.floor(width / gridSize);
  const cellHeight = Math.floor(height / gridSize);

  const grid: number[][] = [];
  for (let row = 0; row < gridSize; row += 1) {
    const rowScores: number[] = [];
    for (let col = 0; col < gridSize; col += 1) {
      const cellPixels: number[] = [];
      for (let y = 0; y < cellHeight; y += 1) {
        for (let x = 0; x < cellWidth; x += 1) {
          const sourceX = col * cellWidth + x;
          const sourceY = row * cellHeight + y;
          cellPixels.push(pixels[sourceY * width + sourceX]);
        }
      }
      rowScores.push(computeLaplacianVarianceSharpness({ width: cellWidth, height: cellHeight, pixels: cellPixels }));
    }
    grid.push(rowScores);
  }
  return grid;
}

/**
 * Center-weighted "subject sharpness" term: the MINIMUM
 * `computeLaplacianVarianceSharpness` among the center 2x2 cells of a
 * `POSTER_SCORING_GRID_SIZE`x`POSTER_SCORING_GRID_SIZE` grid
 * (`computeCellSharpnessGrid`). Taking the MINIMUM, not a mean, means one
 * blurred center cell can't be masked by a sharp neighboring center cell --
 * the subject region has to be sharp everywhere it occupies, not just on
 * average. This is what lets `scorePosterFrameCandidate`'s composite score
 * penalize a frame whose background is sharp but whose (usually centered)
 * subject is motion-blurred, which the whole-frame `sharpness` term alone
 * cannot distinguish from a frame that's genuinely sharp everywhere.
 */
export function computeCenterWeightedSubjectSharpness(frame: GrayscaleFrame): number {
  const grid = computeCellSharpnessGrid(frame, POSTER_SCORING_GRID_SIZE);
  const centerStart = Math.floor(POSTER_SCORING_GRID_SIZE / 2) - 1;
  const centerEnd = centerStart + 1;

  let minSharpness = Infinity;
  for (let row = centerStart; row <= centerEnd; row += 1) {
    for (let col = centerStart; col <= centerEnd; col += 1) {
      minSharpness = Math.min(minSharpness, grid[row][col]);
    }
  }
  return minSharpness === Infinity ? 0 : minSharpness;
}

/** Weight applied to `computeCenterWeightedSubjectSharpness` in the
 * composite poster-frame score (owner round-8) -- chosen so a frame with a
 * sharp background but a flat/blurred center loses to a frame with only
 * moderate sharpness but a genuinely sharp center (see the "subject vs
 * background" scenario test alongside `scorePosterFrameCandidate`'s other
 * tests). */
export const SUBJECT_SHARPNESS_WEIGHT = 4;

export interface PosterFrameScore {
  sharpness: number;
  meanBrightness: number;
  midtoneSpread: number;
  /** Center-weighted subject-sharpness term -- see
   * `computeCenterWeightedSubjectSharpness`. Contributes to `score` scaled
   * by `SUBJECT_SHARPNESS_WEIGHT`. */
  subjectSharpness: number;
  /** True when `meanBrightness` fails the brightness-sanity check
   * (too-dark or blown-out) -- a rejected frame is only ever chosen if
   * EVERY candidate is rejected (see `pickBestPosterFrameIndex`). */
  rejected: boolean;
  /** Composite ranking score -- whole-frame sharpness + midtone spread +
   * `SUBJECT_SHARPNESS_WEIGHT * subjectSharpness`, minus a heavy (but
   * finite, not `-Infinity`) penalty when rejected. The penalty grows with
   * HOW FAR outside the acceptable brightness band the mean is (not a flat
   * constant), so a relative ranking among an all-rejected candidate set
   * still resolves deterministically to the least-bad one instead of a tie
   * -- e.g. a barely-too-dark frame still outranks a pitch-black one. */
  score: number;
}

const REJECTED_FRAME_SCORE_PENALTY = 1_000_000;

/** Scores one candidate frame -- see `computeLaplacianVarianceSharpness`
 * (whole-frame sharpness), `computeMeanBrightness` (brightness sanity),
 * `computeMidtoneSpread` (contrast), and `computeCenterWeightedSubjectSharpness`
 * (region-aware subject-sharpness, owner round-8) for what each term means. */
export function scorePosterFrameCandidate(frame: GrayscaleFrame): PosterFrameScore {
  const meanBrightness = computeMeanBrightness(frame);
  const sharpness = computeLaplacianVarianceSharpness(frame);
  const midtoneSpread = computeMidtoneSpread(frame);
  const subjectSharpness = computeCenterWeightedSubjectSharpness(frame);
  const combined = sharpness + midtoneSpread + SUBJECT_SHARPNESS_WEIGHT * subjectSharpness;

  const distanceOutsideBrightnessRange =
    meanBrightness < MIN_ACCEPTABLE_MEAN_BRIGHTNESS
      ? MIN_ACCEPTABLE_MEAN_BRIGHTNESS - meanBrightness
      : meanBrightness > MAX_ACCEPTABLE_MEAN_BRIGHTNESS
        ? meanBrightness - MAX_ACCEPTABLE_MEAN_BRIGHTNESS
        : 0;
  const rejected = distanceOutsideBrightnessRange > 0;

  return {
    sharpness,
    meanBrightness,
    midtoneSpread,
    subjectSharpness,
    rejected,
    score: rejected ? combined - REJECTED_FRAME_SCORE_PENALTY - distanceOutsideBrightnessRange : combined,
  };
}

/** Index of the best-scoring candidate in `frames` (highest `score` from
 * `scorePosterFrameCandidate`, ties keep the earlier/lower index). Throws
 * on an empty array -- callers always have at least one candidate offset
 * (`computeCandidateFrameOffsetsSeconds` never returns `[]`). */
export function pickBestPosterFrameIndex(frames: GrayscaleFrame[]): number {
  if (frames.length === 0) {
    throw new Error('pickBestPosterFrameIndex requires at least one candidate frame');
  }
  let bestIndex = 0;
  let bestScore = scorePosterFrameCandidate(frames[0]).score;
  for (let i = 1; i < frames.length; i += 1) {
    const score = scorePosterFrameCandidate(frames[i]).score;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// ── Pure helpers: download retries + failure-summary assembly (reliability
// fix -- the export previously crashed the whole run on a single transient
// R2 fetch failure across ~260 downloads; every R2 object fetch now retries
// a few times and, failing that, is recorded + skipped rather than thrown) ──

/** Backoff schedule between retry attempts, in ms -- up to 2 retries (3
 * attempts total) per the brief: 250ms, then 1s. */
export const DOWNLOAD_RETRY_BACKOFFS_MS = [250, 1000];

export interface WithRetriesOptions {
  backoffsMs?: number[];
  /** Injectable for tests -- production default is a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries `fn` on ANY thrown error, up to `backoffsMs.length` additional
 * times, sleeping the corresponding backoff between attempts. Rethrows the
 * LAST error once the schedule is exhausted -- callers decide what "give
 * up" means (skip + record vs. genuinely fatal); this helper never
 * swallows a failure on its own.
 */
export async function withRetries<T>(fn: () => Promise<T>, options: WithRetriesOptions = {}): Promise<T> {
  const backoffsMs = options.backoffsMs ?? DOWNLOAD_RETRY_BACKOFFS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt <= backoffsMs.length; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < backoffsMs.length) {
        await sleep(backoffsMs[attempt]);
      }
    }
  }
  throw lastError;
}

/** Last path segment of an R2 object key -- keeps `downloadFailures` (which
 * end up in both manifest.json and stdout warnings) free of the
 * user/family/memory id path prefix real object keys carry (PII rule). */
export function objectKeyBasename(objectKey: string): string {
  const segments = objectKey.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : objectKey;
}

// DownloadFailure moved to ../functions/_shared/memory-book-manifest.ts
// (needed by BookManifest's own signature) -- objectKey is ALWAYS the
// basename (see `objectKeyBasename`) -- never the full key.

export function buildDownloadFailure(kind: string, objectKey: string): DownloadFailure {
  return { kind, objectKey: objectKeyBasename(objectKey) };
}

/** Exit-code threshold: only fail the run outright when more than 5% of
 * attempted downloads failed after retries -- a handful of transient
 * misses in a run of hundreds of assets shouldn't block the export. */
export const DOWNLOAD_FAILURE_EXIT_THRESHOLD = 0.05;

export interface DownloadFailureSummary {
  failures: DownloadFailure[];
  attempted: number;
  failedCount: number;
  failureRate: number;
  shouldExitNonZero: boolean;
}

export function summarizeDownloadFailures(failures: DownloadFailure[], attempted: number): DownloadFailureSummary {
  const failedCount = failures.length;
  const failureRate = attempted > 0 ? failedCount / attempted : 0;
  return {
    failures,
    attempted,
    failedCount,
    failureRate,
    shouldExitNonZero: failureRate > DOWNLOAD_FAILURE_EXIT_THRESHOLD,
  };
}

// Manifest assembly (ManifestAsset/buildManifestAsset/
// shouldMeasureOriginalDimensions, ManifestMilestone/buildManifestMilestone,
// share tokens (SHARE_TOKEN_LENGTH/generateShareToken/
// memoryNeedsShareToken), ManifestTaggedMember/buildTaggedMember,
// ManifestIllustration/buildManifestIllustration, ManifestMemory/
// ManifestMemorySourceRow/buildManifestMemory, ManifestPortrait/
// buildManifestPortrait, ManifestAssetMode, BookManifest/buildManifest)
// moved to ../functions/_shared/memory-book-manifest.ts -- this is the
// verbatim book-renderer/src/model/types.ts BookManifest consumer contract.

// ── Small utilities (same pattern as eval-memory-book-outline.ts) ──────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const CHUNK_SIZE = 200;
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  errorLabel: string,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to load ${errorLabel}: ${error.message}`);
    }

    const rows = data ?? [];
    out.push(...rows);

    if (rows.length < PAGE_SIZE) {
      break;
    }

    from += PAGE_SIZE;
  }

  return out;
}

/** Fixed-size worker pool over a shared index cursor -- same pattern as
 * eval-memory-book-audit.ts's runPool(). */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
}

// ── Pure helper: clock-skew auth-error classification (hardening fix -- a
// freshly-created magic-link session occasionally races the server's own
// clock, and Supabase surfaces that as a JWT validation error on the FIRST
// query that uses the session, not at session-creation time; the R2 retry
// helper above doesn't cover DB reads at all). Narrowly scoped to this one
// error class -- every other DB error still fails fast, unretried. ────────

const CLOCK_SKEW_AUTH_ERROR_PATTERN = /JWT issued at future|JWT expired/i;

export function isClockSkewAuthError(message: string | null | undefined): boolean {
  return typeof message === 'string' && CLOCK_SKEW_AUTH_ERROR_PATTERN.test(message);
}

// ── Auth (same pattern as eval-memory-book-outline.ts) ──────────────────────

/**
 * The service-role admin client -- factored out of `createAuthedClient`
 * (below), which originally built one of these ONLY to bootstrap a
 * magic-link session, never exposing it further ("the service-role admin
 * client only bootstraps the auth session", per this file's header). Round-19
 * needs a second, longer-lived use for it: `ensureShareTokens` mints
 * `media_share_tokens` rows, which has no `authenticated` RLS policy at all
 * (service-role only -- see the migration).
 */
function createAdminClient() {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase env vars in supabase/.env.local (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type AdminClient = ReturnType<typeof createAdminClient>;

async function createAuthedClient() {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing Supabase env vars in supabase/.env.local');
  }

  const admin = createAdminClient();

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: userEmail,
  });

  if (linkError || !linkData.properties?.hashed_token) {
    throw new Error(linkError?.message ?? 'Failed to generate auth link');
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: sessionData, error: sessionError } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });

  if (sessionError || !sessionData.session?.access_token) {
    throw new Error(sessionError?.message ?? 'Failed to create session');
  }

  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type AuthedClient = Awaited<ReturnType<typeof createAuthedClient>>;

// ── Share token minting (Round-19 -- see this file's header note on the
// "READ-ONLY... one exception" and `memoryNeedsShareToken` above). Both
// functions use the ADMIN client, never the RLS-scoped `AuthedClient` --
// `media_share_tokens` INSERT has no `authenticated` policy to satisfy in
// the first place. ──────────────────────────────────────────────────────

interface ShareTokenRow {
  memory_id: string;
  token: string;
}

async function loadActiveShareTokens(admin: AdminClient, memoryIds: string[]): Promise<Map<string, string>> {
  const tokensByMemory = new Map<string, string>();
  for (const idChunk of chunk(memoryIds, CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const { data, error } = await admin
      .from('media_share_tokens')
      .select('memory_id, token')
      .in('memory_id', idChunk)
      .is('revoked_at', null);
    if (error) throw new Error(`Failed to load media_share_tokens: ${error.message}`);
    for (const row of (data ?? []) as ShareTokenRow[]) {
      tokensByMemory.set(row.memory_id, row.token);
    }
  }
  return tokensByMemory;
}

/**
 * Ensures every id in `memoryIds` (every QR-eligible memory in this export,
 * per `memoryNeedsShareToken`) has an active `media_share_tokens` row:
 * reads whatever already exists, then mints (INSERTs) a fresh
 * `generateShareToken()` row for whichever ids come back without one.
 * Returns memoryId -> token, guaranteed to cover every id in `memoryIds` on
 * success.
 *
 * Fails LOUDLY (throws, uncaught by any caller -> the whole run exits
 * non-zero) on any read or write error -- unlike this file's R2 download
 * path (retry, record, keep going), a QR page that encodes an unminted
 * token is a silently broken printed artifact discovered only after the
 * book is in someone's hands. No partial-failure tolerance here.
 */
async function ensureShareTokens(admin: AdminClient, memoryIds: string[]): Promise<Map<string, string>> {
  if (memoryIds.length === 0) return new Map();

  const tokensByMemory = await loadActiveShareTokens(admin, memoryIds);
  const missingIds = memoryIds.filter((id) => !tokensByMemory.has(id));

  if (missingIds.length > 0) {
    const newRows = missingIds.map((memory_id) => ({ memory_id, token: generateShareToken() }));
    const { error } = await admin.from('media_share_tokens').insert(newRows);
    if (error) {
      throw new Error(
        `Failed to mint media_share_tokens for ${missingIds.length} memor${missingIds.length === 1 ? 'y' : 'ies'}: ${error.message}`,
      );
    }
    for (const row of newRows) tokensByMemory.set(row.memory_id, row.token);
  }

  return tokensByMemory;
}

// ── Row shapes (hand-typed -- matches src/types/database.ts) ───────────────

interface DbMemoryRow {
  id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[];
  topic_details: Record<string, string>;
  illustration_key: string | null;
}

interface DbMediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  position: number;
  duration_ms: number | null;
  aspect_ratio: number | null;
}

interface DbTagRow {
  memory_id: string;
  family_member_id: string;
}

interface DbMilestoneRow {
  memory_id: string;
  milestone_id: string;
  detail: string | null;
}

interface DbFamilyMemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
}

interface DbPortraitVersionRow {
  id: string;
  reference_date: string | null;
  illustrated_profile_key: string | null;
  /** Source photo the AI portrait was generated from -- required in the DB
   * schema (never null), unlike `illustrated_profile_key`. */
  profile_picture_key: string;
}

// ── Data loading (RLS-scoped client for every read; every by-id read is
// chunked + paginated, same pattern as eval-memory-book-outline.ts) ────────

async function loadMemoriesByIds(supabase: AuthedClient, ids: string[]): Promise<DbMemoryRow[]> {
  const out: DbMemoryRow[] = [];
  for (const idChunk of chunk(ids, CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const rows = await fetchAllRows<DbMemoryRow>(
      (from, to) =>
        supabase
          .from('memories')
          .select('id, content, memory_date, memory_type, emotion, topics, topic_details, illustration_key')
          .in('id', idChunk)
          .order('id', { ascending: true })
          .range(from, to),
      'memories',
    );
    out.push(...rows);
  }
  return out;
}

async function loadMediaForMemories(supabase: AuthedClient, memoryIds: string[]): Promise<DbMediaRow[]> {
  const out: DbMediaRow[] = [];
  for (const idChunk of chunk(memoryIds, CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const rows = await fetchAllRows<DbMediaRow>(
      (from, to) =>
        supabase
          .from('memory_media')
          .select('id, memory_id, object_key, preview_object_key, content_type, position, duration_ms, aspect_ratio')
          .in('memory_id', idChunk)
          .order('memory_id', { ascending: true })
          .order('position', { ascending: true })
          .range(from, to),
      'memory_media',
    );
    out.push(...rows);
  }
  return out;
}

async function loadTagsForMemories(supabase: AuthedClient, memoryIds: string[]): Promise<DbTagRow[]> {
  const out: DbTagRow[] = [];
  for (const idChunk of chunk(memoryIds, CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const rows = await fetchAllRows<DbTagRow>(
      (from, to) =>
        supabase
          .from('memory_family_members')
          .select('memory_id, family_member_id')
          .in('memory_id', idChunk)
          .order('memory_id', { ascending: true })
          .order('family_member_id', { ascending: true })
          .range(from, to),
      'memory_family_members',
    );
    out.push(...rows);
  }
  return out;
}

async function loadMilestonesForMemories(supabase: AuthedClient, memoryIds: string[]): Promise<DbMilestoneRow[]> {
  const out: DbMilestoneRow[] = [];
  for (const idChunk of chunk(memoryIds, CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const rows = await fetchAllRows<DbMilestoneRow>(
      (from, to) =>
        supabase
          .from('memory_milestones')
          .select('memory_id, milestone_id, detail')
          .in('memory_id', idChunk)
          .order('memory_id', { ascending: true })
          .range(from, to),
      'memory_milestones',
    );
    out.push(...rows);
  }
  return out;
}

async function loadEngagementCounts(supabase: AuthedClient, memoryIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const id of memoryIds) counts.set(id, 0);

  for (const idChunk of chunk(memoryIds, CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;

    const [likeRows, commentRows] = await Promise.all([
      fetchAllRows<{ memory_id: string }>(
        (from, to) =>
          supabase
            .from('memory_likes')
            .select('memory_id')
            .in('memory_id', idChunk)
            .order('memory_id', { ascending: true })
            .order('user_id', { ascending: true })
            .range(from, to),
        'memory_likes',
      ),
      fetchAllRows<{ memory_id: string }>(
        (from, to) =>
          supabase
            .from('memory_comments')
            .select('memory_id')
            .in('memory_id', idChunk)
            .order('id', { ascending: true })
            .range(from, to),
        'memory_comments',
      ),
    ]);

    for (const row of likeRows) counts.set(row.memory_id, (counts.get(row.memory_id) ?? 0) + 1);
    for (const row of commentRows) counts.set(row.memory_id, (counts.get(row.memory_id) ?? 0) + 1);
  }

  return counts;
}

async function loadFamilyMembersByIds(supabase: AuthedClient, ids: string[]): Promise<DbFamilyMemberRow[]> {
  const out: DbFamilyMemberRow[] = [];
  for (const idChunk of chunk(ids, CHUNK_SIZE)) {
    if (idChunk.length === 0) continue;
    const { data, error } = await supabase
      .from('family_members')
      .select('id, name, date_of_birth')
      .in('id', idChunk);
    if (error) throw new Error(`Failed to load family_members: ${error.message}`);
    out.push(...((data ?? []) as DbFamilyMemberRow[]));
  }
  return out;
}

/** Same filter as `loadPortraitVersionsInWindow` in eval-memory-book-outline.ts
 * (child id + `illustrated_profile_status = 'ready'` + `reference_date` inside
 * the outline's own window) -- see the header note on why this is re-derived
 * here instead of read from outline.json. */
async function loadPortraitVersionsInWindow(
  supabase: AuthedClient,
  childId: string,
  window: OutlineWindow,
): Promise<DbPortraitVersionRow[]> {
  const { data, error } = await supabase
    .from('family_member_portrait_versions')
    .select('id, reference_date, illustrated_profile_key, profile_picture_key')
    .eq('family_member_id', childId)
    .eq('illustrated_profile_status', 'ready')
    .gte('reference_date', window.start)
    .lt('reference_date', window.endExclusive)
    .order('reference_date', { ascending: true });

  if (error) throw new Error(`Failed to load family_member_portrait_versions: ${error.message}`);
  return (data ?? []) as DbPortraitVersionRow[];
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }

  if (!options.outlineRun) {
    console.error('Missing required --outline-run <path to a run dir under supabase/scripts/eval-output/memory-book-outline/>.');
    Deno.exit(1);
  }

  const runDir = options.outlineRun.replace(/\/+$/, '');
  const outlineJsonPath = `${runDir}/outline.json`;

  let rawOutline: string;
  try {
    rawOutline = await Deno.readTextFile(outlineJsonPath);
  } catch {
    console.error(`No outline.json found at ${outlineJsonPath} -- pass --outline-run <dir containing outline.json>.`);
    Deno.exit(1);
    return;
  }

  const outline = parseOutlineJson(JSON.parse(rawOutline));
  const runBasename = runDir.split('/').filter(Boolean).pop() ?? runDir;

  // Round-18: an explicit --language always wins; otherwise default from
  // the outline's own resolved language (falls back to DEFAULT_LANGUAGE on
  // an outline run that predates this field -- current behavior when
  // absent, unchanged).
  options.language = resolveManifestLanguageDefault(options.languageExplicit, options.language, outline.language);

  const outDir = (options.out ?? defaultOutDir(outline.child.name, outline.window.label)).replace(/\/+$/, '');
  await Deno.mkdir(`${outDir}/assets`, { recursive: true });

  console.log(
    `Memory Book V3 asset export -- outline run ${runBasename} -- child ${outline.child.id} -- ` +
      `language ${options.language} -- assets ${options.printAssets ? 'print' : 'preview'}`,
  );

  const memoryIds = mergeCandidateMemoryIds(
    collectMemoryIdsFromElements(outline.elements),
    outline.panoramaCandidates,
    outline.heroCandidates,
    outline.coverCandidates,
  );

  let supabase = await createAuthedClient();
  // Round-19: the service-role client `ensureShareTokens` mints
  // media_share_tokens rows with, further down. Created once up front (no
  // I/O of its own -- unlike `supabase` above, this doesn't touch the
  // network until first used) rather than re-derived at the point of use.
  const admin = createAdminClient();

  // Hardening fix: the first query against a freshly-minted session
  // occasionally races the server's clock and comes back as a JWT
  // validation error rather than a real data problem. Narrowly retried --
  // wait 2s, recreate the session, try the whole initial load once more
  // (max 2 attempts total) -- ONLY for that error class; any other error
  // (including a second clock-skew error) fails fast, same as before this
  // fix existed.
  const loadInitialData = () =>
    Promise.all([
      loadMemoriesByIds(supabase, memoryIds),
      loadMediaForMemories(supabase, memoryIds),
      loadTagsForMemories(supabase, memoryIds),
      loadMilestonesForMemories(supabase, memoryIds),
      loadEngagementCounts(supabase, memoryIds),
      loadPortraitVersionsInWindow(supabase, outline.child.id, outline.window),
    ] as const);

  let initialData: Awaited<ReturnType<typeof loadInitialData>>;
  try {
    initialData = await loadInitialData();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isClockSkewAuthError(message)) throw error;
    console.warn(`First DB read hit a clock-skew auth error (${message}) -- recreating session and retrying once.`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    supabase = await createAuthedClient();
    initialData = await loadInitialData();
  }

  const [memories, media, tags, milestoneRows, engagementCounts, portraitVersions] = initialData;

  const taggedFamilyMemberIds = new Set<string>();
  for (const tag of tags) taggedFamilyMemberIds.add(tag.family_member_id);
  taggedFamilyMemberIds.add(outline.child.id); // needed for portrait ageLabel even if untagged.
  const familyMembers = await loadFamilyMembersByIds(supabase, [...taggedFamilyMemberIds]);
  const familyMembersById = new Map(familyMembers.map((m) => [m.id, m]));
  const childDateOfBirth = familyMembersById.get(outline.child.id)?.date_of_birth ?? null;

  const memoriesById = new Map(memories.map((m) => [m.id, m]));

  const mediaByMemory = new Map<string, DbMediaRow[]>();
  for (const row of media) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }

  const tagsByMemory = new Map<string, string[]>();
  for (const tag of tags) {
    const list = tagsByMemory.get(tag.memory_id) ?? [];
    list.push(tag.family_member_id);
    tagsByMemory.set(tag.memory_id, list);
  }

  const milestonesByMemory = new Map<string, DbMilestoneRow[]>();
  for (const row of milestoneRows) {
    const list = milestonesByMemory.get(row.memory_id) ?? [];
    list.push(row);
    milestonesByMemory.set(row.memory_id, list);
  }

  // ── Media asset selection + download ──────────────────────────────────

  interface MediaJob {
    memoryId: string;
    /** `row.position` -- kept alongside `file` so a print-mode preview
     * fallback (see `shouldDownloadOriginalForPrint`) can recompute the
     * exported filename's extension without re-deriving it from scratch. */
    position: number;
    file: string;
    kind: ManifestAssetKind;
    durationMs: number | null;
    dbAspectRatio: number | null;
    /** Resolved preview/original key for a photo; resolved preview key
     * (the video-poster fallback source) for a video. Also the print-mode
     * fallback source for a photo whose original couldn't be used (HEIC
     * transcode failure, or the original itself failed to download) --
     * always a JPEG in that role, per `selectMediaAsset`. */
    key: string;
    /** Raw `object_key` -- for a video-poster job, the ORIGINAL video this
     * script extracts a full-resolution frame from (brief item 2). For a
     * `--print-assets` photo job, the ORIGINAL photo this script downloads
     * as the exported asset itself (round-20, `shouldDownloadOriginalForPrint`).
     * Unused for a preview-mode photo job. */
    objectKey: string;
    contentType: string;
  }

  const mediaJobs: MediaJob[] = [];
  let mediaSkippedCount = 0;

  for (const memoryId of memoryIds) {
    const rows = (mediaByMemory.get(memoryId) ?? []).slice().sort((a, b) => a.position - b.position);
    for (const row of rows) {
      const selected = selectMediaAsset({
        contentType: row.content_type,
        objectKey: row.object_key,
        previewObjectKey: row.preview_object_key,
      });
      if (!selected) {
        mediaSkippedCount += 1;
        continue;
      }
      // Round-20: a print-mode photo's exported file is the ORIGINAL
      // object, so its extension comes from the original (HEIC/HEIF always
      // planned as 'jpg' -- see `resolvePrintPhotoExtension`), not from
      // `selected.key` (which stays the PREVIEW-mode/fallback source).
      const fileExtension = shouldDownloadOriginalForPrint(options.printAssets, selected.kind)
        ? resolvePrintPhotoExtension(row.content_type, row.object_key)
        : extensionFromKey(selected.key);
      mediaJobs.push({
        memoryId,
        position: row.position,
        file: mediaAssetFileName(memoryId, row.position, fileExtension),
        kind: selected.kind,
        durationMs: row.duration_ms,
        dbAspectRatio: row.aspect_ratio,
        key: selected.key,
        objectKey: row.object_key,
        contentType: row.content_type,
      });
    }
  }

  const mediaSlots: Array<ManifestAsset | null> = new Array(mediaJobs.length).fill(null);
  let mediaFailedCount = 0;
  let videoPosterFallbackCount = 0;
  /** Round-20 (`--print-assets`): a photo asset that could NOT use its
   * original -- either a HEIC/HEIF transcode failure (`transcodeHeicBytesToJpeg`)
   * or the original object itself failing to download/decode after retries
   * -- and fell back to the already-selected preview file instead. Always
   * `0` outside print mode. Reported loudly at the end (never silent --
   * a print run with a meaningful fallback count means the printed book
   * will carry some preview-resolution photos). */
  let printAssetPreviewFallbackCount = 0;

  // ── Reliability fix: retry every R2 object fetch, never crash the run on
  // one, and keep a record of whatever still fails after retries ──────────
  const downloadFailures: DownloadFailure[] = [];
  let attemptedDownloads = 0;

  /**
   * Every R2 object byte fetch in this script (media, illustrations,
   * portraits, video originals) goes through here: retried per
   * `withRetries`/`DOWNLOAD_RETRY_BACKOFFS_MS`, and on final exhaustion
   * recorded into `downloadFailures` (basename-only, PII-clean) before
   * rethrowing to the caller's own per-item try/catch -- which already
   * omits the affected asset from the manifest rather than writing a
   * broken reference (see the media/portrait/illustration worker catches
   * below). `kind` is a short label for the failures list, e.g. 'media',
   * 'portrait', 'portrait-source', 'illustration', 'video-original',
   * 'video-poster-fallback'.
   */
  async function fetchObjectBytesWithRetries(objectKey: string, kind: string): Promise<Uint8Array> {
    attemptedDownloads += 1;
    try {
      return await withRetries(() => getObjectBytes(objectKey));
    } catch (error) {
      downloadFailures.push(buildDownloadFailure(kind, objectKey));
      throw error;
    }
  }

  /**
   * Owner round-8: for every photo media job (`shouldMeasureOriginalDimensions`
   * gates the call site), downloads the ORIGINAL photo bytes (never written
   * to disk -- measured then discarded, the exported asset stays the
   * preview file) to get real dimensions for the renderer's panorama/
   * full-bleed gates, which the preview's capped dimensions can never
   * clear. Returns `null` (no hard failure) for a non-image original, or
   * one that fails to download/decode -- the preview-based asset is
   * exported normally either way, just without `originalWidth/Height`. A
   * genuine fetch failure still lands in `downloadFailures` as usual, via
   * `fetchObjectBytesWithRetries`.
   */
  async function measureOriginalDimensions(job: MediaJob): Promise<{ width: number; height: number } | null> {
    if (!job.contentType.startsWith('image/')) return null; // skip non-image originals.
    try {
      const originalBytes = await fetchObjectBytesWithRetries(job.objectKey, 'original-dimensions');
      const { imageSize } = await import('npm:image-size@1.2.1');
      const { width, height } = imageSize(originalBytes);
      if (!width || !height) {
        console.warn(`  original-dimensions unreadable, skipping (${objectKeyBasename(job.objectKey)})`);
        return null;
      }
      return { width, height };
    } catch {
      return null; // already recorded into downloadFailures by fetchObjectBytesWithRetries.
    }
  }

  /**
   * Round-20 (`--print-assets`): fetches the ORIGINAL photo bytes for `job`
   * -- reusing `fetchObjectBytesWithRetries`/`job.objectKey`, the exact same
   * fetch+retry `measureOriginalDimensions` above already performs -- and
   * returns them alongside their real dimensions (`image-size` reads a
   * HEIC/HEIF box header without a full decode, so this works even when the
   * content is HEIC and the transcode step below hasn't run yet). Unlike
   * `measureOriginalDimensions`, the bytes are NOT discarded: in print mode
   * they (or their HEIC transcode) become the EXPORTED asset file itself,
   * so this is the ONE original-fetch print mode needs per photo, not a
   * measure-then-discard-then-fetch-again. Returns `null` on any failure
   * (non-image original, fetch exhausted its retries, unreadable
   * dimensions) -- the caller falls back to the stored preview file for
   * that one asset, same posture as every other per-asset failure in this
   * script.
   */
  async function fetchOriginalPhotoForPrint(
    job: MediaJob,
  ): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
    if (!job.contentType.startsWith('image/')) return null; // photo kind should always be an image; defensive.
    try {
      const originalBytes = await fetchObjectBytesWithRetries(job.objectKey, 'media-original');
      const { imageSize } = await import('npm:image-size@1.2.1');
      const { width, height } = imageSize(originalBytes);
      if (!width || !height) {
        console.warn(`  print-asset original unreadable, falling back to preview (${objectKeyBasename(job.objectKey)})`);
        return null;
      }
      return { bytes: originalBytes, width, height };
    } catch {
      return null; // already recorded into downloadFailures by fetchObjectBytesWithRetries.
    }
  }

  /**
   * Round-20 (`--print-assets`): transcodes HEIC/HEIF original bytes to a
   * near-lossless JPEG (`PRINT_ASSET_HEIC_JPEG_QUALITY`) via `npm:sharp@0.33`
   * -- Puppeteer/Chromium cannot render HEIC. Same package + exact version
   * backfill-media-previews.ts already relies on to decode HEIC uploads
   * successfully in this same Deno/npm-compat runtime (see this file's
   * header note on `--print-assets` for the full comparison against
   * shelling out to `ffmpeg`). Dynamically imported -- like every other npm
   * import in this file's worker functions -- so the default preview loop
   * never pays for loading sharp's native binary unless print mode actually
   * encounters a HEIC original. No resize: print quality, not preview
   * quality. Throws on any decode/encode failure or missing binary; the
   * only caller wraps this in try/catch and falls back to the preview file
   * for that one asset (`printAssetPreviewFallbackCount`) rather than
   * failing the whole export.
   */
  async function transcodeHeicBytesToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
    const { default: sharp } = await import('npm:sharp@0.33');
    const jpegBuffer = await sharp(bytes).jpeg({ quality: PRINT_ASSET_HEIC_JPEG_QUALITY }).toBuffer();
    return new Uint8Array(jpegBuffer);
  }

  /** Best-effort clip duration via `ffprobe` -- used only when the DB's own
   * `memory_media.duration_ms` is null (see `extractFullResolutionPosterFrame`'s
   * `durationMs` param). Returns `null` on any failure (missing ffprobe,
   * unparseable output, non-positive duration) so the caller falls back to
   * `computeCandidateFrameOffsetsSeconds`'s fixed-second offsets, exactly
   * like an unknown duration from the DB. */
  async function probeVideoDurationMs(filePath: string): Promise<number | null> {
    try {
      const command = new Deno.Command('ffprobe', {
        args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
        stdout: 'piped',
        stderr: 'piped',
      });
      const output = await command.output();
      if (!output.success) return null;
      const seconds = Number(new TextDecoder().decode(output.stdout).trim());
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    } catch {
      return null;
    }
  }

  /** Runs one ffmpeg extraction (either a scoring candidate or the final
   * full-resolution winner) and returns its stdout bytes, or throws with
   * ffmpeg's own stderr tail on a non-zero exit / empty output. */
  async function runFfmpegExtraction(args: string[], failureLabel: string): Promise<Uint8Array> {
    const command = new Deno.Command('ffmpeg', { args, stdout: 'piped', stderr: 'piped' });
    const output = await command.output();
    if (!output.success || output.stdout.length === 0) {
      const stderr = new TextDecoder().decode(output.stderr).trim().slice(-500);
      throw new Error(`ffmpeg failed to ${failureLabel}: ${stderr || 'no output'}`);
    }
    return output.stdout;
  }

  /**
   * Owner round-7: extracts `posterFrameCount` candidate frames spread
   * across the clip (`computeCandidateFrameOffsetsSeconds`), scores each on
   * a cheap downsampled-grayscale heuristic (`scorePosterFrameCandidate`),
   * and re-extracts only the WINNING offset at full resolution/quality.
   * `posterFrameCount <= 1` collapses to a single extraction at offset 0 --
   * byte-identical to the pre-round-7 behavior, no scoring pass at all.
   * A scoring candidate that fails to extract (e.g. an offset past a
   * shorter-than-expected clip) is simply skipped, not fatal; if every
   * candidate fails to extract, offset 0 is used as the last resort.
   */
  async function pickWinningPosterOffsetSeconds(
    tempFile: string,
    durationMs: number | null,
    posterFrameCount: number,
  ): Promise<number> {
    const offsets = computeCandidateFrameOffsetsSeconds(posterFrameCount, durationMs);
    if (offsets.length <= 1) return offsets[0];

    const candidates: Array<{ offset: number; frame: GrayscaleFrame }> = [];
    for (const offset of offsets) {
      try {
        const raw = await runFfmpegExtraction(
          buildScoringFrameFfmpegArgs(tempFile, offset),
          `extract a scoring candidate at ${offset}s`,
        );
        if (raw.length !== POSTER_SCORING_FRAME_SIZE * POSTER_SCORING_FRAME_SIZE) continue; // malformed/short read.
        candidates.push({ offset, frame: { width: POSTER_SCORING_FRAME_SIZE, height: POSTER_SCORING_FRAME_SIZE, pixels: raw } });
      } catch {
        // This one candidate failed to extract -- try the rest.
      }
    }
    if (candidates.length === 0) return offsets[0];

    const bestIndex = pickBestPosterFrameIndex(candidates.map((candidate) => candidate.frame));
    return candidates[bestIndex].offset;
  }

  /**
   * Downloads the ORIGINAL video (`objectKey`) to a temp file and shells out
   * to `ffmpeg` for a full-resolution poster frame -- mirrors
   * backfill-video-posters.ts's `buildFfmpegPosterArgs` pattern, but at full
   * resolution/quality, against a local temp file rather than a streamed
   * presigned URL, and (owner round-7) from the best of several sampled
   * candidates rather than always the very first frame. Guarded at
   * `MAX_VIDEO_POSTER_SOURCE_BYTES` before downloading anything. Throws on
   * any failure (size guard, missing ffmpeg, non-zero exit) -- callers fall
   * back to the stored preview poster.
   */
  async function extractFullResolutionPosterFrame(
    objectKey: string,
    contentType: string,
    durationMs: number | null,
    posterFrameCount: number,
  ): Promise<Uint8Array> {
    const head = await withRetries(() => headObject(objectKey));
    if (exceedsVideoPosterSizeGuard(head?.contentLength ?? null)) {
      throw new Error(
        `original video (${head?.contentLength ?? 'unknown'} bytes) exceeds the ${MAX_VIDEO_POSTER_SOURCE_BYTES}-byte poster-extraction guard`,
      );
    }

    const videoBytes = await fetchObjectBytesWithRetries(objectKey, 'video-original');
    const tempFile = await Deno.makeTempFile({
      prefix: 'memory-book-video-poster-',
      suffix: videoPosterTempFileSuffix(contentType),
    });

    try {
      await Deno.writeFile(tempFile, videoBytes);

      // Prefer the DB's own duration; ffprobe is only consulted when that's
      // null, per the brief ("get duration via ffprobe or the manifest's
      // durationMs when present").
      const resolvedDurationMs = durationMs ?? (await probeVideoDurationMs(tempFile));
      const winningOffsetSeconds = await pickWinningPosterOffsetSeconds(tempFile, resolvedDurationMs, posterFrameCount);

      return await runFfmpegExtraction(
        buildFullResolutionPosterFfmpegArgs(tempFile, winningOffsetSeconds),
        'extract a full-resolution poster frame',
      );
    } finally {
      // Best-effort cleanup -- never let a temp-file removal failure mask
      // the real result/error above.
      await Deno.remove(tempFile).catch(() => undefined);
    }
  }

  await runPool(mediaJobs, options.concurrency, async (job, index) => {
    try {
      let bytes: Uint8Array;
      let originalDimensions: { width: number; height: number } | null = null;

      if (job.kind === 'video-poster') {
        try {
          bytes = await extractFullResolutionPosterFrame(job.objectKey, job.contentType, job.durationMs, options.posterFrameCount);
        } catch (extractionError) {
          videoPosterFallbackCount += 1;
          console.warn(
            `  video poster full-resolution extraction failed, falling back to stored preview (${objectKeyBasename(job.objectKey)}):`,
            extractionError instanceof Error ? extractionError.message : extractionError,
          );
          bytes = await fetchObjectBytesWithRetries(job.key, 'video-poster-fallback'); // stored preview_object_key poster.
        }
      } else if (shouldDownloadOriginalForPrint(options.printAssets, job.kind)) {
        // Round-20 (`--print-assets`): the ORIGINAL object becomes the
        // exported photo asset -- one fetch (`fetchOriginalPhotoForPrint`)
        // serves both the export AND the originalWidth/originalHeight
        // measurement, instead of preview mode's separate
        // fetch-then-discard `measureOriginalDimensions` call below.
        const original = await fetchOriginalPhotoForPrint(job);
        if (original && isHeicContentType(job.contentType)) {
          // image-size can read HEIC/HEIF dimensions from the box header
          // alone, so these are already known even if the transcode itself
          // fails below.
          originalDimensions = { width: original.width, height: original.height };
          try {
            bytes = await transcodeHeicBytesToJpeg(original.bytes);
          } catch (transcodeError) {
            printAssetPreviewFallbackCount += 1;
            console.warn(
              `  print-asset HEIC transcode failed, falling back to preview resolution (${objectKeyBasename(job.objectKey)}):`,
              transcodeError instanceof Error ? transcodeError.message : transcodeError,
            );
            bytes = await fetchObjectBytesWithRetries(job.key, 'media'); // stored preview_object_key -- always JPEG.
          }
        } else if (original) {
          bytes = original.bytes;
          originalDimensions = { width: original.width, height: original.height };
        } else {
          printAssetPreviewFallbackCount += 1;
          console.warn(`  print-asset original unavailable, falling back to preview resolution (${objectKeyBasename(job.objectKey)})`);
          bytes = await fetchObjectBytesWithRetries(job.key, 'media');
          // The planned filename assumed the original's own extension
          // (round-20's resolvePrintPhotoExtension) -- since the fallback
          // bytes are the stored preview (always JPEG), keep the written
          // filename truthful to what's actually on disk.
          job.file = mediaAssetFileName(job.memoryId, job.position, 'jpg');
        }
      } else {
        bytes = await fetchObjectBytesWithRetries(job.key, 'media');
      }

      // NOTE: pinned to the version actually present in node_modules -- see
      // eval-memory-book-audit.ts's identical comment on this pattern.
      const { imageSize } = await import('npm:image-size@1.2.1');
      const { width, height } = imageSize(bytes);
      if (!width || !height) throw new Error('unreadable image dimensions');
      await Deno.writeFile(`${outDir}/${job.file}`, bytes);

      // Owner round-8: every photo asset gets original dimensions measured
      // (not just panorama/hero candidates) -- see measureOriginalDimensions.
      // Round-20: print mode already set this above from the same original
      // fetch used for the export itself; only fall through to a SEPARATE
      // fetch-and-discard when it didn't (preview mode, or a print-mode
      // asset whose original was entirely unavailable).
      if (originalDimensions === null && shouldMeasureOriginalDimensions(job.kind)) {
        originalDimensions = await measureOriginalDimensions(job);
      }

      mediaSlots[index] = buildManifestAsset({
        file: job.file,
        width,
        height,
        kind: job.kind,
        durationMs: job.durationMs,
        dbAspectRatio: job.dbAspectRatio,
        originalDimensions,
      });
    } catch (error) {
      mediaFailedCount += 1;
      console.error(`  media asset failed (${objectKeyBasename(job.key)}):`, error instanceof Error ? error.message : error);
    }
  });

  const assetsByMemory = new Map<string, ManifestAsset[]>();
  mediaJobs.forEach((job, index) => {
    const asset = mediaSlots[index];
    if (!asset) return;
    const list = assetsByMemory.get(job.memoryId) ?? [];
    list.push(asset);
    assetsByMemory.set(job.memoryId, list);
  });

  // ── Through-the-years portraits ────────────────────────────────────────

  interface PortraitJob {
    versionId: string;
    referenceDate: string;
    file: string;
    key: string;
    /** `profile_picture_key` -- the source photo (brief item 3). Always
     * present: the column is non-null in the DB schema. */
    sourceFile: string;
    sourceKey: string;
  }

  const includedPortraitVersions = excludePortraitVersionIds(portraitVersions, options.excludePortraitIds);
  const excludedPortraitCount = portraitVersions.length - includedPortraitVersions.length;
  if (excludedPortraitCount > 0) {
    console.log(`Portraits excluded by --exclude-portrait-id: ${excludedPortraitCount}`);
  }

  const portraitJobs: PortraitJob[] = includedPortraitVersions
    .filter((v): v is DbPortraitVersionRow & { reference_date: string; illustrated_profile_key: string } =>
      Boolean(v.reference_date && v.illustrated_profile_key),
    )
    .map((v) => ({
      versionId: v.id,
      referenceDate: v.reference_date,
      key: v.illustrated_profile_key,
      file: portraitFileName(v.id, extensionFromKey(v.illustrated_profile_key)),
      sourceKey: v.profile_picture_key,
      sourceFile: portraitSourceFileName(v.id, extensionFromKey(v.profile_picture_key)),
    }));

  const portraitSlots: Array<ManifestPortrait | null> = new Array(portraitJobs.length).fill(null);
  let portraitFailedCount = 0;

  await runPool(portraitJobs, options.concurrency, async (job, index) => {
    try {
      const [portraitBytes, sourceBytes] = await Promise.all([
        fetchObjectBytesWithRetries(job.key, 'portrait'),
        fetchObjectBytesWithRetries(job.sourceKey, 'portrait-source'),
      ]);
      const { imageSize } = await import('npm:image-size@1.2.1');
      const portraitDimensions = imageSize(portraitBytes);
      if (!portraitDimensions.width || !portraitDimensions.height) {
        throw new Error('unreadable portrait image dimensions');
      }
      const sourceDimensions = imageSize(sourceBytes);
      if (!sourceDimensions.width || !sourceDimensions.height) {
        throw new Error('unreadable source photo image dimensions');
      }
      await Promise.all([
        Deno.writeFile(`${outDir}/${job.file}`, portraitBytes),
        Deno.writeFile(`${outDir}/${job.sourceFile}`, sourceBytes),
      ]);
      portraitSlots[index] = buildManifestPortrait({
        file: job.file,
        sourceFile: job.sourceFile,
        referenceDate: job.referenceDate,
        dateOfBirth: childDateOfBirth,
      });
    } catch (error) {
      portraitFailedCount += 1;
      console.error(`  portrait asset failed (${objectKeyBasename(job.key)}):`, error instanceof Error ? error.message : error);
    }
  });

  const portraits = portraitSlots.filter((p): p is ManifestPortrait => p !== null);

  // ── Illustrations (memories.illustration_key, brief item 1) ────────────

  interface IllustrationJob {
    memoryId: string;
    file: string;
    key: string;
  }

  const illustrationJobs: IllustrationJob[] = [];
  for (const memoryId of memoryIds) {
    const memoryRow = memoriesById.get(memoryId);
    if (!memoryRow?.illustration_key) continue;
    illustrationJobs.push({
      memoryId,
      key: memoryRow.illustration_key,
      file: illustrationFileName(memoryId, extensionFromKey(memoryRow.illustration_key)),
    });
  }

  const illustrationSlots: Array<ManifestIllustration | null> = new Array(illustrationJobs.length).fill(null);
  let illustrationFailedCount = 0;

  await runPool(illustrationJobs, options.concurrency, async (job, index) => {
    try {
      const bytes = await fetchObjectBytesWithRetries(job.key, 'illustration');
      const { imageSize } = await import('npm:image-size@1.2.1');
      const { width, height } = imageSize(bytes);
      if (!width || !height) throw new Error('unreadable image dimensions');
      await Deno.writeFile(`${outDir}/${job.file}`, bytes);
      illustrationSlots[index] = buildManifestIllustration({ file: job.file, width, height });
    } catch (error) {
      illustrationFailedCount += 1;
      console.error(`  illustration asset failed (${objectKeyBasename(job.key)}):`, error instanceof Error ? error.message : error);
    }
  });

  const illustrationsByMemory = new Map<string, ManifestIllustration>();
  illustrationJobs.forEach((job, index) => {
    const illustration = illustrationSlots[index];
    if (illustration) illustrationsByMemory.set(job.memoryId, illustration);
  });

  // ── Share tokens (Round-19) ─────────────────────────────────────────────
  // Every memory whose EXPORTED page will actually carry a QR/scan mark --
  // computed from the same post-download `assetsByMemory` the manifest
  // itself is about to be built from (a video whose poster failed every
  // download retry has no photo slot in this export, so it needs no token
  // either). Minted/looked-up once, in a single batch, before the
  // per-memory loop below so buildManifestMemory can just look the result
  // up rather than making its own DB call per memory.
  const shareTokenEligibleIds = memoryIds.filter((id) => {
    const memoryRow = memoriesById.get(id);
    if (!memoryRow) return false;
    return memoryNeedsShareToken(memoryRow.memory_type, assetsByMemory.get(id) ?? []);
  });
  const shareTokensByMemory = await ensureShareTokens(admin, shareTokenEligibleIds);
  if (shareTokenEligibleIds.length > 0) {
    console.log(
      `Share tokens ensured for ${shareTokenEligibleIds.length} QR-eligible memor${shareTokenEligibleIds.length === 1 ? 'y' : 'ies'}.`,
    );
  }

  // ── Manifest memories ────────────────────────────────────────────────

  const manifestMemories: Record<string, ManifestMemory> = {};
  let missingFromDbCount = 0;

  for (const memoryId of memoryIds) {
    const memoryRow = memoriesById.get(memoryId);
    if (!memoryRow) {
      missingFromDbCount += 1;
      continue;
    }

    const taggedMembers: ManifestTaggedMember[] = [];
    for (const familyMemberId of tagsByMemory.get(memoryId) ?? []) {
      const familyMember = familyMembersById.get(familyMemberId);
      if (!familyMember) continue;
      taggedMembers.push(
        buildTaggedMember({
          name: familyMember.name,
          dateOfBirth: familyMember.date_of_birth,
          memoryDate: memoryRow.memory_date,
        }),
      );
    }

    const milestones = (milestonesByMemory.get(memoryId) ?? []).map((row) =>
      buildManifestMilestone(row.milestone_id, row.detail),
    );

    manifestMemories[memoryId] = buildManifestMemory({
      memory: memoryRow,
      assets: assetsByMemory.get(memoryId) ?? [],
      milestones,
      taggedMembers,
      engagement: engagementCounts.get(memoryId) ?? 0,
      illustration: illustrationsByMemory.get(memoryId) ?? null,
      shareToken: shareTokensByMemory.get(memoryId) ?? null,
    });
  }

  // ── Write manifest.json + book.outline.json ────────────────────────────

  const downloadFailureSummary = summarizeDownloadFailures(downloadFailures, attemptedDownloads);

  const manifest = buildManifest({
    child: outline.child,
    scope: buildManifestScope(outline.scope.type, outline.window),
    outlineRun: runBasename,
    memories: manifestMemories,
    portraits,
    language: options.language,
    downloadFailures: downloadFailureSummary.failures,
    assetMode: options.printAssets ? 'print' : 'preview',
  });

  await Deno.writeTextFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  await Deno.writeTextFile(`${outDir}/book.outline.json`, rawOutline);

  const mediaDownloadedCount = mediaJobs.length - mediaFailedCount;
  const portraitDownloadedCount = portraitJobs.length - portraitFailedCount;
  const illustrationDownloadedCount = illustrationJobs.length - illustrationFailedCount;

  console.log(`Memories: ${memoryIds.length} referenced in outline (${missingFromDbCount} missing from DB).`);
  console.log(
    `Assets downloaded: ${mediaDownloadedCount} -- skipped: ${mediaSkippedCount + mediaFailedCount} -- ` +
      `portraits: ${portraitDownloadedCount} -- illustrations: ${illustrationDownloadedCount}`,
  );
  if (videoPosterFallbackCount > 0) {
    console.log(
      `Video posters using the stored preview fallback (ffmpeg unavailable/failed or 300MB size guard): ${videoPosterFallbackCount}`,
    );
  }
  if (printAssetPreviewFallbackCount > 0) {
    console.warn(`WARNING: ${printAssetPreviewFallbackCount} assets fell back to preview resolution`);
  }
  console.log(`Download failures after retries: ${downloadFailureSummary.failedCount}`);
  console.log(`Wrote ${outDir}/manifest.json + book.outline.json + assets/`);

  if (downloadFailureSummary.shouldExitNonZero) {
    console.error(
      `Download failure rate ${(downloadFailureSummary.failureRate * 100).toFixed(1)}% of ${downloadFailureSummary.attempted} ` +
        `attempted download(s) exceeds the ${(DOWNLOAD_FAILURE_EXIT_THRESHOLD * 100).toFixed(0)}% threshold -- failing the run.`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
