// Holiday card front picks, orchestration (docs/plans/holiday-cards-p1.md
// Step 4a): the production port of eval-holiday-card-front.ts's photo half.
//
//   pool (Dec 1 of the previous year -> today, >=2 tagged, share-safe, not
//   reported, not low-mood) -> ranged R2 probe of the ORIGINAL pixel size ->
//   print-ready candidates (selectFrontCandidates) -> ~1280 px previews ->
//   vision "card-worthy" judge in batches of FRONT_JUDGE_BATCH (one retry per
//   batch) -> ranking (rankFrontPicks).
//
// All pure logic is holiday-card-photos.ts; this file only sequences it. IO
// is injected (holiday-card-generate-ports.ts): R2 reads, the image-size
// parser, an optional downscaler, the OpenAI call and the usage sink. No
// supabase-js, no Deno.*, no env. Nothing here logs memory text or names.
import {
  type FrontCandidate,
  FRONT_JUDGE_BATCH,
  FRONT_JUDGE_MODEL,
  type FrontDropReason,
  type FrontPhotoInput,
  type FrontRanking,
  type FrontSelection,
  type FrontVerdict,
  buildFrontJudgeRequestBody,
  coreFamilyMemberIds,
  frontPoolPhotos,
  parseFrontJudgeResponse,
  type PixelSize,
  rankFrontPicks,
  selectFrontCandidates,
} from './holiday-card-photos.ts';
import {
  type ChatPort,
  bytesToBase64,
  callModel,
  chunk,
  type ImageReaderPort,
  type ImageSizeParser,
  mapPool,
  type ProgressFn,
  sniffVisionContentType,
  type UsageSink,
} from './holiday-card-generate-ports.ts';
import type { FilmMemberInput, FilmMemoryInput, FilmMilestoneInput } from './year-film-eligibility.ts';
import { type FilmAssetRef, type FilmMemorySource, shareSensitiveIds } from './year-film-script.ts';
import type { VisionImage } from './year-film-vision.ts';

// ── Tuning (same values as the eval) ─────────────────────────────────────

/** First ranged read of an original, then the larger fallback. Mirrors
 * memory-book-worker/src/dimensions.ts. */
export const FRONT_PROBE_BYTES = 256 * 1024;
export const FRONT_PROBE_FALLBACK_BYTES = 4 * 1024 * 1024;
export const FRONT_PROBE_CONCURRENCY = 8;
/** Longest edge of the image sent to the judge. */
export const FRONT_VISION_MAX_EDGE = 1280;
const PREVIEW_CONCURRENCY = 8;
/** Ranked picks kept in the summary the card stores (the editor's "Change
 * photo" candidates; the assets eval's `--options` default). */
export const FRONT_CANDIDATES_KEPT = 12;
/** Photos of legacy single-asset memories (no memory_media row) carry this
 * prefix on their media id; they cannot be referenced as memory_media ids. */
export const LEGACY_MEDIA_PREFIX = 'legacy:';

// ── Input ────────────────────────────────────────────────────────────────

export interface FrontPhoto {
  /** memory_media.id, or `legacy:<memoryId>` for a legacy single-asset photo. */
  mediaId: string;
  /** The ORIGINAL object key (printed from; probed for pixels). */
  objectKey: string;
  /** memory_media.preview_object_key (~1280 px) when the row has one. */
  previewKey: string | null;
  /** memory_media.aspect_ratio (width / height). */
  aspectRatio: number | null;
  /** memory_media.content_type (legacy: memories.media_content_type). Only
   * image/jpeg, image/png and image/webp can be printed (the print renderer
   * cannot decode HEIC/HEIF); anything else, or null, is out of the pool. */
  contentType: string | null;
}

/** The types the card's print path can render. */
export const PRINTABLE_FRONT_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isPrintableFrontType(contentType: string | null | undefined): boolean {
  return !!contentType && PRINTABLE_FRONT_CONTENT_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}

/** `FrontDropReason` plus the reason this module adds. */
export type FrontPickDropReason = FrontDropReason | 'not-printable';

/** A memory as the front pick reads it: the film mapping's memory input
 * (text, emotion, topics and tags decide share-safety) plus its photos. */
export interface FrontPickMemory extends FilmMemoryInput {
  photos: FrontPhoto[];
}

export interface FrontPickInput {
  /** The card's date, YYYY-MM-DD (the window ends here). */
  today: string;
  /** Every family member: id, date_of_birth, relationship (core family =
   * own children + parents). */
  members: FilmMemberInput[];
  /** Saved memories (onboarding-pending excluded) with their photos. */
  memories: FrontPickMemory[];
  milestones: FilmMilestoneInput[];
  /** Photos sent to the vision judge (default FRONT_MAX_CANDIDATES = 30). */
  maxVision?: number;
}

/** `FilmMemorySource[]` (the year-film mapping, `mapFamilyRows`) -> front
 * memories. Image assets become photos; a legacy single-asset image (no
 * media id) gets `legacy:<memoryId>`. Pass `includeLegacy: false` to drop the
 * legacy ones (they cannot be referenced as memory_media ids). */
export function frontMemoriesFromFilmSources(
  memories: readonly FilmMemorySource[],
  options: { includeLegacy?: boolean } = {},
): FrontPickMemory[] {
  const includeLegacy = options.includeLegacy ?? true;
  return memories.map((m) => ({
    id: m.id,
    date: m.date,
    type: m.type,
    text: m.text,
    emotion: m.emotion,
    topics: m.topics,
    taggedMemberIds: m.taggedMemberIds,
    illustrationReady: m.illustrationReady,
    media: m.media,
    reported: m.reported,
    photos: m.assets
      .filter((a: FilmAssetRef) => a.kind === 'image' && (a.id !== undefined || includeLegacy))
      .map((a: FilmAssetRef) => ({
        mediaId: a.id ?? `${LEGACY_MEDIA_PREFIX}${m.id}`,
        objectKey: a.key,
        previewKey: a.previewKey,
        aspectRatio: a.aspectRatio,
        contentType: a.contentType ?? null,
      })),
  }));
}

// ── Ports ────────────────────────────────────────────────────────────────

export interface FrontPickPorts {
  chat: ChatPort;
  usage: UsageSink;
  images: ImageReaderPort;
  imageSize: ImageSizeParser;
  /** Downscales an original to a JPEG with the longest edge <= `maxEdge`
   * (EXIF rotation applied). Optional: without it, a photo that has no usable
   * stored preview is left out (unjudged) instead of being read in full. */
  downscaleToJpeg?: (bytes: Uint8Array, maxEdge: number) => Promise<Uint8Array | null>;
  progress?: ProgressFn;
}

// ── Pool ─────────────────────────────────────────────────────────────────

export interface FrontPool {
  /** Memory ids the share-safety filter excludes. */
  excluded: Set<string>;
  /** Every photo of every memory (before the pool filters). */
  rawPhotos: FrontPhotoInput[];
  /** Photos that pass the pool filters and can be printed (dims not yet
   * measured). */
  pool: FrontPhotoInput[];
  /** Photos that passed every other pool filter but are not jpeg/png/webp. */
  notPrintable: number;
  photoByMedia: Map<string, FrontPhoto>;
}

export function buildFrontPool(input: Pick<FrontPickInput, 'today' | 'memories' | 'milestones'>): FrontPool {
  const excluded = shareSensitiveIds(input.memories, input.milestones);
  const rawPhotos: FrontPhotoInput[] = input.memories.flatMap((m) =>
    m.photos.map((p) => ({
      memoryId: m.id,
      mediaId: p.mediaId,
      date: m.date,
      taggedMemberIds: m.taggedMemberIds,
      emotion: m.emotion,
      topics: m.topics,
      reported: m.reported,
      dims: null,
      aspectRatio: p.aspectRatio,
    }))
  );
  const photoByMedia = new Map<string, FrontPhoto>();
  for (const memory of input.memories) for (const photo of memory.photos) photoByMedia.set(photo.mediaId, photo);
  const eligible = frontPoolPhotos(rawPhotos, { today: input.today, excludedMemoryIds: excluded });
  const pool = eligible.filter((p) => isPrintableFrontType(photoByMedia.get(p.mediaId)?.contentType));
  return { excluded, rawPhotos, pool, notPrintable: eligible.length - pool.length, photoByMedia };
}

// ── Pixel probe (ranged reads) ───────────────────────────────────────────

function upright(width: number, height: number, orientation?: number): PixelSize {
  // EXIF orientations 5-8 rotate the stored pixels by 90 degrees.
  return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
}

/** Original pixel size of one object from its leading bytes: a 256 KB range,
 * then 4 MB. null when it cannot be read or parsed. Never reads the whole
 * object unless it is shorter than the range. */
export async function probePhotoDimensions(
  key: string,
  images: ImageReaderPort,
  imageSize: ImageSizeParser,
): Promise<PixelSize | null> {
  for (const bytes of [FRONT_PROBE_BYTES, FRONT_PROBE_FALLBACK_BYTES]) {
    let data: Uint8Array | null;
    try {
      data = await images.readRange(key, bytes);
    } catch {
      continue; // transient read problem: try the larger range
    }
    if (!data) return null;
    let size: ReturnType<ImageSizeParser>;
    try {
      size = imageSize(data);
    } catch {
      size = null; // header not complete in this range
    }
    if (size?.width && size.height) return upright(size.width, size.height, size.orientation);
    if (data.byteLength < bytes) return null; // that was the whole object
  }
  return null;
}

export async function measurePhotos(
  keys: readonly string[],
  images: ImageReaderPort,
  imageSize: ImageSizeParser,
  progress?: ProgressFn,
): Promise<Map<string, PixelSize | null>> {
  const results = new Map<string, PixelSize | null>();
  let done = 0;
  await mapPool(keys, FRONT_PROBE_CONCURRENCY, async (key) => {
    results.set(key, await probePhotoDimensions(key, images, imageSize));
    done += 1;
    if (done % 50 === 0 || done === keys.length) progress?.(`  ... pixel probe ${done}/${keys.length}`);
  });
  return results;
}

// ── Previews ─────────────────────────────────────────────────────────────

export interface PreviewImage {
  bytes: Uint8Array;
  contentType: VisionImage['contentType'];
  source: 'preview' | 'original';
}

/** The stored ~1280 px preview when the media row has a readable one, else
 * the original downscaled (when a downscaler is injected). Photos whose bytes
 * cannot be read are simply left out. */
export async function fetchPreviewImages(
  photos: ReadonlyMap<string, FrontPhoto>,
  ports: Pick<FrontPickPorts, 'images' | 'downscaleToJpeg'>,
): Promise<Map<string, PreviewImage>> {
  const entries = [...photos.entries()];
  const found = await mapPool(entries, PREVIEW_CONCURRENCY, async ([, photo]): Promise<PreviewImage | null> => {
    if (photo.previewKey) {
      try {
        const bytes = await ports.images.read(photo.previewKey);
        const contentType = bytes ? sniffVisionContentType(bytes) : null;
        if (bytes && contentType) return { bytes, contentType, source: 'preview' };
      } catch {
        // fall through to the original
      }
    }
    if (!ports.downscaleToJpeg) return null;
    try {
      const original = await ports.images.read(photo.objectKey);
      if (!original) return null;
      const jpeg = await ports.downscaleToJpeg(original, FRONT_VISION_MAX_EDGE);
      return jpeg ? { bytes: jpeg, contentType: 'image/jpeg', source: 'original' } : null;
    } catch {
      return null;
    }
  });
  const out = new Map<string, PreviewImage>();
  entries.forEach(([mediaId], i) => {
    const image = found[i];
    if (image) out.set(mediaId, image);
  });
  return out;
}

// ── Vision judge ─────────────────────────────────────────────────────────

/** Judges the candidates that have an image, in batches of FRONT_JUDGE_BATCH;
 * a batch that comes back incomplete is asked once more. */
export async function judgeFrontCandidates(
  candidates: readonly FrontCandidate[],
  images: ReadonlyMap<string, PreviewImage>,
  ports: Pick<FrontPickPorts, 'chat' | 'usage' | 'progress'>,
): Promise<Map<string, FrontVerdict>> {
  const verdicts = new Map<string, FrontVerdict>();
  const judgeable = candidates.filter((c) => images.has(c.mediaId));
  const batches = chunk(judgeable, FRONT_JUDGE_BATCH);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const items = batches[batchIndex].map((c) => {
      const image = images.get(c.mediaId)!;
      return {
        id: c.mediaId,
        image: { base64: bytesToBase64(image.bytes), contentType: image.contentType },
        orientation: c.orientation,
        expectedPeople: c.taggedMemberIds.length,
      };
    });
    const ids = items.map((item) => item.id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await callModel(
        ports,
        'holiday_card_front_judge',
        `front_judge:${batchIndex}:${attempt}`,
        buildFrontJudgeRequestBody(FRONT_JUDGE_MODEL, items),
      );
      const parsed = raw ? parseFrontJudgeResponse(raw, ids) : new Map<string, FrontVerdict>();
      for (const [id, verdict] of parsed) verdicts.set(id, verdict);
      if (ids.every((id) => verdicts.has(id))) break;
      ports.progress?.(
        `  judge batch: ${ids.filter((id) => verdicts.has(id)).length}/${ids.length} valid verdicts${attempt === 0 ? ', retrying' : ''}`,
      );
    }
  }
  return verdicts;
}

// ── Pipeline ─────────────────────────────────────────────────────────────

/** Everything one run produced, in memory (images included): for the eval's
 * review page. Production stores `summarizeFrontPicks` only. */
export interface FrontRun {
  coreMemberIds: Set<string>;
  pool: FrontPool;
  /** Distinct original objects probed. */
  probedKeys: number;
  selection: FrontSelection;
  previews: Map<string, PreviewImage>;
  verdicts: Map<string, FrontVerdict>;
  ranking: FrontRanking;
}

export async function runFrontPipeline(input: FrontPickInput, ports: FrontPickPorts): Promise<FrontRun> {
  const pool = buildFrontPool(input);

  // Original pixel sizes for the pool (ranged reads).
  const probeKeys = [...new Set(pool.pool.map((p) => pool.photoByMedia.get(p.mediaId)!.objectKey))];
  ports.progress?.(`probing ${probeKeys.length} photo originals`);
  const pixels = await measurePhotos(probeKeys, ports.images, ports.imageSize, ports.progress);
  const measured = pool.pool.map((p) => ({ ...p, dims: pixels.get(pool.photoByMedia.get(p.mediaId)!.objectKey) ?? null }));

  const coreMemberIds = coreFamilyMemberIds(input.members, input.today);
  const selection = selectFrontCandidates(measured, {
    today: input.today,
    excludedMemoryIds: pool.excluded,
    coreMemberIds,
    maxCandidates: input.maxVision,
  });
  ports.progress?.(
    `candidates: ${selection.eligible} print-ready, ${selection.candidates.length} sent to vision; ` +
      `dropped ${JSON.stringify(selection.dropped)}`,
  );

  const previews = await fetchPreviewImages(
    new Map(selection.candidates.map((c) => [c.mediaId, pool.photoByMedia.get(c.mediaId)!])),
    ports,
  );
  const stored = [...previews.values()].filter((p) => p.source === 'preview').length;
  ports.progress?.(
    `previews: ${previews.size}/${selection.candidates.length} (${stored} stored previews, ${previews.size - stored} downscaled originals)`,
  );

  const verdicts = await judgeFrontCandidates(selection.candidates, previews, ports);
  const ranking = rankFrontPicks(selection.candidates, verdicts, { today: input.today, expectedPeople: coreMemberIds.size });
  return { coreMemberIds, pool, probedKeys: probeKeys.length, selection, previews, verdicts, ranking };
}

// ── What production stores ───────────────────────────────────────────────

/** A ranked pick as `holiday_cards.front_candidates` holds it: ids, numbers
 * and enums only (no `why`, no `setting`, no text from the model). */
export interface FrontCandidateSummary {
  mediaId: string;
  memoryId: string;
  /** 1-based rank. */
  rank: number;
  score: number;
  cardOrientation: 'portrait' | 'landscape';
  printClass: 'full-bleed' | 'bordered';
  width: number;
  height: number;
  verdict: {
    cardScore: number;
    peopleVisible: number;
    allFacesVisible: boolean;
    eyesOpenMostly: boolean;
    lookingAtCamera: 'most' | 'some' | 'none';
    light: 'good' | 'ok' | 'poor';
    sharp: boolean;
    cropRisk: boolean;
  };
}

export interface FrontPickCounts {
  /** Photos in the pool (>=2 tagged, share-safe, in the window). */
  poolPhotos: number;
  probed: number;
  /** Print-ready candidates before the vision cap. */
  eligible: number;
  /** Sent to the judge. */
  candidates: number;
  /** Candidates with an image to show the judge. */
  previews: number;
  judged: number;
  picks: number;
  nearMisses: number;
  unjudged: number;
}

export interface FrontPickResult {
  /** Ranked best first (at most `keep`). */
  candidates: FrontCandidateSummary[];
  counts: FrontPickCounts;
  /** Photos dropped before the judge, by reason. */
  dropped: Partial<Record<FrontPickDropReason, number>>;
}

export function summarizeFrontPicks(run: FrontRun, keep = FRONT_CANDIDATES_KEPT): FrontPickResult {
  return {
    candidates: run.ranking.picks.slice(0, keep).map((pick, index) => ({
      mediaId: pick.candidate.mediaId,
      memoryId: pick.candidate.memoryId,
      rank: index + 1,
      score: pick.score,
      cardOrientation: pick.candidate.cardOrientation,
      printClass: pick.candidate.printClass,
      width: pick.candidate.width,
      height: pick.candidate.height,
      verdict: {
        cardScore: pick.verdict.cardScore,
        peopleVisible: pick.verdict.peopleVisible,
        allFacesVisible: pick.verdict.allFacesVisible,
        eyesOpenMostly: pick.verdict.eyesOpenMostly,
        lookingAtCamera: pick.verdict.lookingAtCamera,
        light: pick.verdict.light,
        sharp: pick.verdict.sharp,
        cropRisk: pick.verdict.cropRisk,
      },
    })),
    counts: {
      poolPhotos: run.pool.pool.length,
      probed: run.probedKeys,
      eligible: run.selection.eligible,
      candidates: run.selection.candidates.length,
      previews: run.previews.size,
      judged: run.verdicts.size,
      picks: run.ranking.picks.length,
      nearMisses: run.ranking.nearMisses.length,
      unjudged: run.ranking.unjudged,
    },
    dropped: {
      ...run.selection.dropped,
      ...(run.pool.notPrintable > 0 ? { 'not-printable': run.pool.notPrintable } : {}),
    },
  };
}

/** Production entry point: the ranked front candidates for one family. */
export async function pickFrontCandidates(
  input: FrontPickInput & { keep?: number },
  ports: FrontPickPorts,
): Promise<FrontPickResult> {
  return summarizeFrontPicks(await runFrontPipeline(input, ports), input.keep);
}
