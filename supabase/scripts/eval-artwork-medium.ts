/**
 * Artwork-medium eval (docs/plans/artwork-scanning.md Phase 0.2): measures
 * how well the Phase 1 artwork prompt addition picks a drawing's medium
 * (crayon, marker, watercolor, ...) under three vision settings, and what
 * each costs per call:
 *
 *   a  768 px edge cap + detail 'low'   (today's analyze-memory path)
 *   b  768 px edge cap + detail 'high'
 *   c  1280 px edge cap + detail 'high' (artwork-only cap, if it wins)
 *
 * Texture cues (wax vs pencil) may be lost to the 768 cap rather than to
 * `detail`, which is why (b) and (c) are separate arms. Ship (a) unless (b)
 * or (c) is clearly better (>= 15 accuracy points) at acceptable cost; if one
 * wins, thread `detail` and a per-call edge cap for artwork only
 * (`chatJsonWithVisionMulti`'s `detail` option and `prepareVisionImageFromBytes`'s
 * `maxEdge` argument already exist for exactly that).
 *
 * It reuses the real pieces: `buildMemoryAnalysisSystemPrompt({ isArtwork })`,
 * `prepareVisionImageFromBytes`, `chatJsonWithVisionMulti`,
 * `parseMemoryAnalysisModelOutput` and `applyArtworkAnalysisMode`, one image
 * per call (per-piece accuracy). It does NOT touch the database, R2, or any
 * memory: input is a local folder only.
 *
 * Input folder (never committed; the repo is public -- keep real drawings
 * outside it):
 *   <folder>/*.jpg|jpeg|png|webp   scans, one piece per file
 *   <folder>/labels.json           ground truth, either
 *       { "scan1.jpg": "crayon", "scan2.jpg": "watercolor" }
 *     or, to also check the "depicted content is not a family event" rule,
 *       { "scan3.jpg": { "medium": "marker", "depictsPlace": true } }
 *     where `depictsPlace` marks a drawing OF a place/trip (castle, beach,
 *     airplane). Include at least two of those: the report counts how often the
 *     model still returned trip-like topics BEFORE the post-processing override.
 *
 * Examples:
 *   npm run eval:artwork-medium -- ~/artwork-eval --dry-run
 *   npm run eval:artwork-medium -- ~/artwork-eval
 *   npm run eval:artwork-medium -- ~/artwork-eval --arms a,c --repeats 2 --yes
 *
 * Requires OPENAI_API_KEY (supabase/.env.local). Paid-call eval: prints the
 * planned call count and a rough ceiling and asks for confirmation unless
 * --yes. Use --dry-run to list the plan without calling OpenAI. Must typecheck
 * even where it cannot run.
 *
 * PII rule: the console report and the JSON results file contain indexes,
 * vocabulary values (mediums, topic ids) and token counts only -- never file
 * names, captions, labels, or descriptions.
 */
import { toFileUrl } from 'jsr:@std/path@1/to-file-url';
import {
  applyArtworkAnalysisMode,
  buildMemoryAnalysisSystemPrompt,
  buildRelevantMilestoneCatalog,
  parseMemoryAnalysisModelOutput,
} from '../functions/_shared/analyze-memory-core.ts';
import { normalizeArtworkMedium } from '../functions/_shared/artwork-medium.ts';
import { buildMemoryContext, formatMemoryContextForPrompt } from '../functions/_shared/date-context.ts';
import { MAX_EMOTION_VISION_EDGE } from '../functions/_shared/image-limits.ts';
import { prepareVisionImageFromBytes } from '../functions/_shared/media-emotion.ts';
import { TOPICS } from '../functions/_shared/memory-topics.ts';
import { chatJsonWithVisionMulti, type ChatVisionUsage } from '../functions/_shared/openai.ts';

// ── Pricing ──────────────────────────────────────────────────────────────
// gpt-4o-mini per-1M-token rates; same constants as
// backfill-memory-analysis.ts / eval-memory-book-tagging.ts. Update the
// values here if pricing changes.
const INPUT_COST_PER_MILLION_TOKENS_USD = 0.15;
const OUTPUT_COST_PER_MILLION_TOKENS_USD = 0.6;
// Generous per-call ceiling for the pre-run estimate (a 1280 px 'high' image
// is ~6 tiles, ~1.1k image tokens, so real cost is far below this).
const ROUGH_WORST_CASE_COST_PER_CALL_USD = 0.005;

const DEFAULT_CONCURRENCY = 4;
const MIN_WIN_POINTS = 15;

// Mirrors TRIP_TOPICS in _shared/holiday-card-digest.ts (not exported there):
// the topics that feed the holiday-card letter's trips. Update both together.
const TRIP_TOPICS: ReadonlySet<string> = new Set(['travel', 'beach', 'camping', 'road-trip', 'vacation', 'snow-play']);

const IMAGE_EXTENSIONS: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// ── Arms ─────────────────────────────────────────────────────────────────

export type ArmId = 'a' | 'b' | 'c';

export interface ArmSpec {
  id: ArmId;
  label: string;
  maxEdge: number;
  detail: 'low' | 'high';
}

export const ARMS: Readonly<Record<ArmId, ArmSpec>> = {
  a: { id: 'a', label: `${MAX_EMOTION_VISION_EDGE}px cap, detail low (today)`, maxEdge: MAX_EMOTION_VISION_EDGE, detail: 'low' },
  b: { id: 'b', label: `${MAX_EMOTION_VISION_EDGE}px cap, detail high`, maxEdge: MAX_EMOTION_VISION_EDGE, detail: 'high' },
  c: { id: 'c', label: '1280px cap, detail high', maxEdge: 1280, detail: 'high' },
};

// ── Pure helpers (unit-tested in eval-artwork-medium.test.ts) ─────────────

export interface LabelEntry {
  /** Normalized vocabulary medium. */
  medium: string;
  depictsPlace: boolean;
}

/**
 * Parses labels.json. Values may be a medium string or
 * `{ medium, depictsPlace? }`. Mediums are normalized with the production
 * `normalizeArtworkMedium`; entries whose medium is outside the vocabulary
 * are returned in `invalid` (by key) instead of being silently scored wrong.
 */
export function parseLabels(raw: unknown): { labels: Map<string, LabelEntry>; invalid: string[] } {
  const labels = new Map<string, LabelEntry>();
  const invalid: string[] = [];
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  for (const [file, value] of Object.entries(object)) {
    const mediumRaw = typeof value === 'string' ? value : (value as { medium?: unknown } | null)?.medium;
    const depictsPlace =
      typeof value === 'object' && value !== null && (value as { depictsPlace?: unknown }).depictsPlace === true;
    const medium = normalizeArtworkMedium(mediumRaw);
    if (!medium) {
      invalid.push(file);
      continue;
    }
    labels.set(file, { medium, depictsPlace });
  }

  return { labels, invalid };
}

export function estimateCostUsd(usage: ChatVisionUsage | null): number {
  if (!usage) return 0;
  return (
    (usage.promptTokens / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS_USD +
    (usage.completionTokens / 1_000_000) * OUTPUT_COST_PER_MILLION_TOKENS_USD
  );
}

export interface CallResult {
  armId: ArmId;
  /** Position of the image in the sorted folder listing (no file names in output). */
  index: number;
  expected: string;
  got: string | null;
  ok: boolean;
  error: boolean;
  depictsPlace: boolean;
  /** Raw model topics (before the artwork override) that are trip-like. */
  rawTripTopics: number;
  usage: ChatVisionUsage | null;
}

export interface ArmSummary {
  armId: ArmId;
  calls: number;
  errors: number;
  correct: number;
  /** Correct / scored calls (errors count as wrong), 0-100. */
  accuracyPct: number;
  nullParses: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  avgCostUsd: number;
  totalCostUsd: number;
  placeCalls: number;
  placeCallsWithRawTripTopics: number;
}

export function summarizeArm(armId: ArmId, results: CallResult[]): ArmSummary {
  const mine = results.filter((result) => result.armId === armId);
  const withUsage = mine.filter((result) => result.usage);
  const totalCostUsd = mine.reduce((sum, result) => sum + estimateCostUsd(result.usage), 0);
  const average = (pick: (usage: ChatVisionUsage) => number) =>
    withUsage.length === 0 ? 0 : withUsage.reduce((sum, result) => sum + pick(result.usage as ChatVisionUsage), 0) / withUsage.length;
  const placeCalls = mine.filter((result) => result.depictsPlace && !result.error);

  return {
    armId,
    calls: mine.length,
    errors: mine.filter((result) => result.error).length,
    correct: mine.filter((result) => result.ok).length,
    accuracyPct: mine.length === 0 ? 0 : (mine.filter((result) => result.ok).length / mine.length) * 100,
    nullParses: mine.filter((result) => !result.error && result.got === null).length,
    avgPromptTokens: average((usage) => usage.promptTokens),
    avgCompletionTokens: average((usage) => usage.completionTokens),
    avgCostUsd: withUsage.length === 0 ? 0 : totalCostUsd / withUsage.length,
    totalCostUsd,
    placeCalls: placeCalls.length,
    placeCallsWithRawTripTopics: placeCalls.filter((result) => result.rawTripTopics > 0).length,
  };
}

/** One-line recommendation per the plan: ship 'low' unless an alternative is >= 15 points better. */
export function recommend(summaries: ArmSummary[]): string {
  const baseline = summaries.find((summary) => summary.armId === 'a');
  const challengers = summaries.filter((summary) => summary.armId !== 'a');
  if (!baseline || challengers.length === 0) {
    return "Run arm a plus at least one of b/c to get a recommendation.";
  }
  const best = [...challengers].sort((left, right) => right.accuracyPct - left.accuracyPct)[0];
  const delta = best.accuracyPct - baseline.accuracyPct;
  if (delta >= MIN_WIN_POINTS) {
    const multiple = baseline.avgCostUsd > 0 ? best.avgCostUsd / baseline.avgCostUsd : Number.NaN;
    return `Arm ${best.armId} beats today's path by ${delta.toFixed(1)} pts at ${Number.isFinite(multiple) ? `${multiple.toFixed(1)}x` : 'n/a'} the per-call cost: judge whether that cost is acceptable; if so thread detail='high'${ARMS[best.armId].maxEdge > MAX_EMOTION_VISION_EDGE ? ` and a ${ARMS[best.armId].maxEdge}px edge cap` : ''} for artwork only.`;
  }
  return `No arm is >= ${MIN_WIN_POINTS} pts better than today's path (best challenger: arm ${best.armId}, ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts). Ship detail='low' at the ${MAX_EMOTION_VISION_EDGE}px cap unchanged.`;
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliOptions {
  folder: string | null;
  arms: ArmId[];
  repeats: number;
  concurrency: number;
  outputDir: URL;
  yes: boolean;
  dryRun: boolean;
}

const defaultOutputDir = new URL('./eval-output/artwork-medium/', import.meta.url);

function parseArms(raw: string): ArmId[] {
  const arms = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const invalid = arms.filter((arm) => !(arm in ARMS));
  if (invalid.length > 0 || arms.length === 0) {
    console.error(`Unknown --arms value(s): ${invalid.join(', ') || '(none)'}. Allowed: a, b, c`);
    Deno.exit(1);
  }
  return arms as ArmId[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    folder: null,
    arms: ['a', 'b', 'c'],
    repeats: 1,
    concurrency: DEFAULT_CONCURRENCY,
    outputDir: defaultOutputDir,
    yes: false,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case '--arms':
        options.arms = parseArms(next ?? '');
        index += 1;
        break;
      case '--repeats':
        options.repeats = Math.max(1, Number(next) || 1);
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = Math.max(1, Number(next) || DEFAULT_CONCURRENCY);
        index += 1;
        break;
      case '--output-dir': {
        const base = next?.startsWith('/') ? toFileUrl(next) : toFileUrl(`${Deno.cwd()}/${next}`);
        options.outputDir = new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
        index += 1;
        break;
      }
      case '--yes':
        options.yes = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        if (!arg.startsWith('--') && options.folder === null) {
          options.folder = arg;
        }
        break;
    }
  }

  return options;
}

interface ScanImage {
  index: number;
  file: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  label: LabelEntry;
}

async function loadScanImages(folder: string): Promise<{ images: ScanImage[]; unlabeled: number; invalidLabels: number; skipped: number }> {
  let labelsRaw: unknown;
  try {
    labelsRaw = JSON.parse(await Deno.readTextFile(`${folder}/labels.json`));
  } catch (error) {
    console.error(`Could not read ${folder}/labels.json: ${error instanceof Error ? error.message : 'unknown'}`);
    Deno.exit(1);
  }
  const { labels, invalid } = parseLabels(labelsRaw);

  const files: string[] = [];
  for await (const entry of Deno.readDir(folder)) {
    if (entry.isFile) files.push(entry.name);
  }
  files.sort();

  const images: ScanImage[] = [];
  let unlabeled = 0;
  let skipped = 0;
  for (const file of files) {
    const extension = file.split('.').pop()?.toLowerCase() ?? '';
    const contentType = IMAGE_EXTENSIONS[extension];
    if (!contentType) {
      if (file !== 'labels.json') skipped += 1;
      continue;
    }
    const label = labels.get(file);
    if (!label) {
      unlabeled += 1;
      continue;
    }
    images.push({ index: images.length + 1, file, contentType, label });
  }

  return { images, unlabeled, invalidLabels: invalid.length, skipped };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 5 : 4)}`;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

function printReport(summaries: ArmSummary[], results: CallResult[]): void {
  console.log('\nResults');
  console.log(
    [pad('arm', 5), pad('setting', 30), pad('calls', 6), pad('acc %', 7), pad('errors', 7), pad('null', 5), pad('avg in tok', 11), pad('avg out tok', 12), pad('$/call', 10), pad('total $', 10)].join(''),
  );
  for (const summary of summaries) {
    console.log(
      [
        pad(summary.armId, 5),
        pad(ARMS[summary.armId].label, 30),
        pad(summary.calls, 6),
        pad(summary.accuracyPct.toFixed(1), 7),
        pad(summary.errors, 7),
        pad(summary.nullParses, 5),
        pad(summary.avgPromptTokens.toFixed(0), 11),
        pad(summary.avgCompletionTokens.toFixed(0), 12),
        pad(formatUsd(summary.avgCostUsd), 10),
        pad(formatUsd(summary.totalCostUsd), 10),
      ].join(''),
    );
  }

  const placeSummaries = summaries.filter((summary) => summary.placeCalls > 0);
  if (placeSummaries.length > 0) {
    console.log('\nDepicted-place drawings: calls where the model still returned trip-like topics (travel/beach/camping/road-trip/vacation/snow-play) before the artwork override');
    for (const summary of placeSummaries) {
      console.log(`  arm ${summary.armId}: ${summary.placeCallsWithRawTripTopics} of ${summary.placeCalls}`);
    }
    console.log('  (Production forces topics to arts-crafts and lowercases labels regardless; a high count here means the prompt wording needs work.)');
  }

  const misses = results.filter((result) => !result.error && !result.ok);
  if (misses.length > 0) {
    console.log('\nMisses (image index in sorted folder order; expected -> got)');
    for (const miss of misses) {
      console.log(`  arm ${miss.armId} #${miss.index}: ${miss.expected} -> ${miss.got ?? 'null'}`);
    }
  }

  console.log(`\nRecommendation: ${recommend(summaries)}`);
}

async function runCall(
  arm: ArmSpec,
  image: ScanImage,
  bytes: Uint8Array,
  systemPrompt: string,
  userText: string,
): Promise<CallResult> {
  const base = {
    armId: arm.id,
    index: image.index,
    expected: image.label.medium,
    depictsPlace: image.label.depictsPlace,
  };

  try {
    const prepared = await prepareVisionImageFromBytes(bytes, image.contentType, arm.maxEdge);
    if ('code' in prepared) {
      return { ...base, got: null, ok: false, error: true, rawTripTopics: 0, usage: null };
    }

    const { data, usage } = await chatJsonWithVisionMulti<Record<string, unknown>>(systemPrompt, userText, [prepared], {
      detail: arm.detail,
    });
    const parsed = parseMemoryAnalysisModelOutput(data);
    // Run the real artwork post-processing too, so a crash there surfaces here.
    applyArtworkAnalysisMode(parsed);

    return {
      ...base,
      got: parsed.artworkMedium,
      ok: parsed.artworkMedium === image.label.medium,
      error: false,
      rawTripTopics: parsed.topics.filter((topic) => TRIP_TOPICS.has(topic.id)).length,
      usage,
    };
  } catch (error) {
    console.error(`call failed (arm ${arm.id} #${image.index}):`, error instanceof Error ? error.message : 'unknown');
    return { ...base, got: null, ok: false, error: true, rawTripTopics: 0, usage: null };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  if (!options.folder) {
    console.error('Usage: npm run eval:artwork-medium -- <folder-with-scans-and-labels.json> [--arms a,b,c] [--repeats N] [--concurrency N] [--yes] [--dry-run]');
    Deno.exit(1);
  }

  const { images, unlabeled, invalidLabels, skipped } = await loadScanImages(options.folder);
  if (images.length === 0) {
    console.error('No labeled images found (check labels.json keys match file names).');
    Deno.exit(1);
  }

  const plannedCalls = images.length * options.arms.length * options.repeats;
  console.log(`Images: ${images.length} labeled (${unlabeled} unlabeled skipped, ${invalidLabels} labels outside the vocabulary, ${skipped} non-image files ignored)`);
  console.log(`Arms: ${options.arms.map((arm) => `${arm} = ${ARMS[arm].label}`).join('; ')}`);
  console.log(`Place drawings: ${images.filter((image) => image.label.depictsPlace).length} (target >= 2)`);
  console.log(`Planned calls: ${plannedCalls} (${options.repeats} repeat(s))`);
  console.log(`Rough worst-case cost ceiling: ${formatUsd(plannedCalls * ROUGH_WORST_CASE_COST_PER_CALL_USD)}`);

  if (options.dryRun) {
    console.log('\n--dry-run: not calling OpenAI. Exiting.');
    return;
  }
  if (!Deno.env.get('OPENAI_API_KEY')) {
    console.error('\nMissing OPENAI_API_KEY in supabase/.env.local');
    Deno.exit(1);
  }
  if (!options.yes && !confirm(`\nThis will make ${plannedCalls} paid OpenAI call(s). Proceed?`)) {
    console.log('Aborted.');
    return;
  }

  // The real artwork-mode prompt, no tagged members (ages/context are not what
  // this eval measures), no caption.
  const systemPrompt = buildMemoryAnalysisSystemPrompt({
    topics: TOPICS,
    milestoneCatalog: buildRelevantMilestoneCatalog([]),
    isArtwork: true,
  });
  const today = new Date().toISOString().slice(0, 10);
  const userText = `${formatMemoryContextForPrompt(buildMemoryContext(today, []))}\n\nParent's text:\n(no text)`;

  const bytesByIndex = new Map<number, Uint8Array>();
  for (const image of images) {
    bytesByIndex.set(image.index, await Deno.readFile(`${options.folder}/${image.file}`));
  }

  const jobs: Array<() => Promise<CallResult>> = [];
  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    for (const armId of options.arms) {
      for (const image of images) {
        jobs.push(() => runCall(ARMS[armId], image, bytesByIndex.get(image.index) as Uint8Array, systemPrompt, userText));
      }
    }
  }

  const results: CallResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      results.push(await job());
    }
  });
  await Promise.all(workers);

  const summaries = options.arms.map((armId) => summarizeArm(armId, results));
  printReport(summaries, results);

  await Deno.mkdir(options.outputDir, { recursive: true });
  const outputPath = new URL(`results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, options.outputDir);
  await Deno.writeTextFile(outputPath, JSON.stringify({ summaries, results }, null, 2));
  console.log(`\nWrote ${outputPath.pathname}`);
}

if (import.meta.main) {
  await main();
}
