/**
 * Backfill `analyze-memory` enrichment (emotion/topics/labels/description/
 * milestone claims) for existing memories that predate the full analysis
 * pass, or were analyzed against an older topic-vocabulary version
 * (docs/plans/memory-book.md §5 Stage A, §9 V1 exit backfill). This is a
 * thin driver over the SAME analysis pipeline the `analyze-emotion`/
 * `analyze-memory` Edge Functions use -- it reuses `runMemoryAnalysis`,
 * `fetchTaggedMembers`, `updateMemoryAnalysisIfSnapshotMatches`, and
 * `upsertMemoryMilestones` from `_shared/analyze-memory-core.ts` directly
 * rather than reimplementing any part of the analysis or write logic.
 *
 * Mirrors backfill-video-posters.ts's conventions: dry-run by default,
 * hand-rolled arg parsing, DATABASE_PAGE_SIZE-paginated candidate loading
 * (PostgREST's un-paginated select caps at 1000 rows -- same lesson as
 * eval-memory-book-tagging.ts's fetchAllRows), a worker pool for
 * concurrency, one `--apply` flag gating every write.
 *
 * Candidates: memories where `analyzed_at is null` OR
 * `analysis_version < TOPICS_VERSION`, oldest (`memory_date`) first. Because
 * each run only ever selects rows that still need analysis, the backfill is
 * inherently resumable -- an interrupted run leaves nothing to clean up;
 * the next invocation just picks up whatever is still uncovered.
 *
 * Dry run (prints target counts per family/type + a rough cost estimate,
 * makes NO OpenAI calls, touches nothing):
 * deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *   supabase/scripts/backfill-memory-analysis.ts
 * # or: npm run backfill:memory-analysis
 *
 * Apply (calls OpenAI + R2 via runMemoryAnalysis, writes memories +
 * memory_milestones for real):
 * ... backfill-memory-analysis.ts --apply
 * # or: npm run backfill:memory-analysis -- --apply
 *
 * Optional flags:
 *   --limit N            first N candidate rows only
 *   --family-id <uuid>   scope to one family (repeatable)
 *   --memory-id <uuid>   scope to one memory (repeatable) -- additive with
 *                        the "needs analysis" predicate, same as
 *                        backfill-video-posters.ts's --memory-id (not a
 *                        forced re-analyze bypass)
 *   --concurrency N      worker pool size (default 3 -- gentler than the
 *                        eval scripts' default of 4: this hits OpenAI and
 *                        R2 once per memory, and OpenAI is the shared,
 *                        rate-limited resource)
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service-role client --
 * this is an ops script driven by an operator, not an RLS-scoped eval run
 * as a real user), R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/
 * R2_ENDPOINT/R2_BUCKET (image fetch, via runMemoryAnalysis), and
 * OPENAI_API_KEY for --apply (dry run needs none of the R2/OpenAI vars).
 *
 * PII rule (hard, repo-wide): memory content, captions, transcripts, and
 * the model's description/labels are NEVER logged to stdout or written to
 * the per-run JSONL log -- only ids, memory_type, status, error messages
 * (technical provider/DB strings, not memory content), and token counts.
 * The JSONL log lives at supabase/scripts/eval-output/backfill-memory-analysis/
 * <runId>/results.jsonl (gitignored, same convention as the eval scripts'
 * output directory).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  fetchTaggedMembers,
  runMemoryAnalysis,
  updateMemoryAnalysisIfSnapshotMatches,
  upsertMemoryMilestones,
  type MediaAssetForAnalysis,
} from '../functions/_shared/analyze-memory-core.ts';
import { TOPICS_VERSION } from '../functions/_shared/memory-topics.ts';

const DATABASE_PAGE_SIZE = 1000; // PostgREST's un-paginated select cap.
const DEFAULT_CONCURRENCY = 3;

// gpt-4o-mini rates -- same constants as eval-memory-book-tagging.ts's
// estimateCostUsd, reused here rather than duplicated as "logic" (it's a
// two-term pricing formula, not analysis behavior).
const INPUT_COST_PER_MILLION_TOKENS_USD = 0.15;
const OUTPUT_COST_PER_MILLION_TOKENS_USD = 0.6;

// Rough per-memory average for the DRY RUN estimate ONLY (dry run makes no
// OpenAI calls, so there are no real token counts yet): docs/plans/
// memory-book.md's V1a results record "~$0.55 each" across two full runs
// over 726 memories on gpt-4o-mini controlled/discovery-mode calls -- close
// enough in shape (one multimodal chat call per memory) to ballpark actual
// spend before running --apply. The --apply summary always reports real
// measured cost from actual token usage, never this constant.
const ROUGH_DRY_RUN_COST_PER_MEMORY_USD = 0.55 / 726;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateMemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_type: string;
  memory_date: string;
  audio_transcript: string | null;
  updated_at: string;
}

interface CandidateMediaRow {
  object_key: string;
  content_type: string;
  position: number;
  preview_object_key: string | null;
}

export interface CliOptions {
  apply: boolean;
  limit: number | null;
  familyIds: string[];
  memoryIds: string[];
  concurrency: number;
}

export type ResultStatus = 'analyzed' | 'skipped' | 'error';

export interface BackfillResultLine {
  memoryId: string;
  familyId: string;
  memoryType: string;
  status: ResultStatus;
  /** Present only for status 'error' -- a technical provider/DB error
   * message (never memory content). */
  errorMessage?: string;
  /** Present only when the OpenAI call actually ran (status 'analyzed', or
   * 'skipped' via a stale-write race after a real call). */
  promptTokens?: number;
  completionTokens?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported + covered by backfill-memory-analysis.test.ts).
// ---------------------------------------------------------------------------

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    limit: null,
    familyIds: [],
    memoryIds: [],
    concurrency: DEFAULT_CONCURRENCY,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--apply':
        options.apply = true;
        break;
      case '--limit': {
        const parsed = Number(next);
        options.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : options.limit;
        index += 1;
        break;
      }
      case '--family-id':
        if (next) options.familyIds.push(next);
        index += 1;
        break;
      case '--memory-id':
        if (next) options.memoryIds.push(next);
        index += 1;
        break;
      case '--concurrency': {
        const parsed = Number(next);
        options.concurrency = Number.isFinite(parsed) && parsed > 0 ? parsed : options.concurrency;
        index += 1;
        break;
      }
      default:
        break;
    }
  }

  return options;
}

/** gpt-4o-mini cost estimate from real token counts -- same rates as
 * eval-memory-book-tagging.ts's estimateCostUsd. */
export function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS_USD +
    (completionTokens / 1_000_000) * OUTPUT_COST_PER_MILLION_TOKENS_USD
  );
}

/** Rough, unmeasured dry-run-only estimate -- see the constant's doc comment
 * above for its source and why it's a ballpark, not a measurement. */
export function estimateDryRunCostUsd(candidateCount: number): number {
  return candidateCount * ROUGH_DRY_RUN_COST_PER_MEMORY_USD;
}

/** Candidate counts grouped by family id, sorted by count descending (ties
 * broken by family id for determinism). */
export function summarizeCandidatesByFamily(rows: CandidateMemoryRow[]): Array<{ familyId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.family_id, (counts.get(row.family_id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([familyId, count]) => ({ familyId, count }))
    .sort((a, b) => b.count - a.count || a.familyId.localeCompare(b.familyId));
}

/** Candidate counts grouped by memory_type, sorted by count descending (ties
 * broken alphabetically for determinism). */
export function summarizeCandidatesByType(rows: CandidateMemoryRow[]): Array<{ memoryType: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.memory_type, (counts.get(row.memory_type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([memoryType, count]) => ({ memoryType, count }))
    .sort((a, b) => b.count - a.count || a.memoryType.localeCompare(b.memoryType));
}

/** Exit non-zero only when MORE than 10% of attempted memories errored
 * (never on zero attempts -- an empty candidate set is success, not
 * failure). */
export function shouldExitNonZero(attempted: number, errors: number): boolean {
  return attempted > 0 && errors / attempted > 0.1;
}

// ---------------------------------------------------------------------------
// Script entry point -- everything below has side effects (network/process)
// and is intentionally not exported/tested directly; the pure helpers above
// are (same convention as backfill-video-posters.ts).
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function loadCandidates(
  admin: SupabaseClient,
  options: CliOptions,
): Promise<CandidateMemoryRow[]> {
  const rows: CandidateMemoryRow[] = [];

  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    let query = admin
      .from('memories')
      .select('id, family_id, content, memory_type, memory_date, audio_transcript, updated_at')
      .or(`analyzed_at.is.null,analysis_version.lt.${TOPICS_VERSION}`)
      .order('memory_date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + DATABASE_PAGE_SIZE - 1);

    if (options.familyIds.length > 0) {
      query = query.in('family_id', options.familyIds);
    }
    if (options.memoryIds.length > 0) {
      query = query.in('id', options.memoryIds);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Could not load candidate memories: ${error.message}`);
    }

    const page = (data ?? []) as CandidateMemoryRow[];
    rows.push(...page);

    if (page.length < DATABASE_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

async function loadOrderedMedia(
  admin: SupabaseClient,
  memoryId: string,
): Promise<MediaAssetForAnalysis[]> {
  const { data, error } = await admin
    .from('memory_media')
    .select('object_key, content_type, position, preview_object_key')
    .eq('memory_id', memoryId)
    .order('position', { ascending: true });

  if (error) {
    throw new Error(`media lookup failed: ${error.message}`);
  }

  return ((data ?? []) as CandidateMediaRow[]).map((row) => ({
    objectKey: row.object_key,
    contentType: row.content_type,
    position: row.position,
    previewObjectKey: row.preview_object_key,
  }));
}

let writeChain: Promise<void> = Promise.resolve();

/** Serialized JSONL append so concurrent workers never interleave partial
 * lines (same pattern as eval-memory-book-tagging.ts's
 * queueAppendResultLine). */
function queueAppendResultLine(path: string, line: BackfillResultLine): Promise<void> {
  writeChain = writeChain.then(async () => {
    await Deno.writeTextFile(path, JSON.stringify(line) + '\n', { append: true, create: true });
  });
  return writeChain;
}

async function processCandidate(
  admin: SupabaseClient,
  candidate: CandidateMemoryRow,
): Promise<BackfillResultLine> {
  const base = { memoryId: candidate.id, familyId: candidate.family_id, memoryType: candidate.memory_type };

  try {
    const [taggedMembers, media] = await Promise.all([
      fetchTaggedMembers(admin, candidate.id),
      candidate.memory_type === 'media' ? loadOrderedMedia(admin, candidate.id) : Promise.resolve([]),
    ]);

    const result = await runMemoryAnalysis({
      memory: {
        id: candidate.id,
        content: candidate.content,
        memoryType: candidate.memory_type,
        memoryDate: candidate.memory_date,
        audioTranscript: candidate.audio_transcript,
      },
      taggedMembers,
      media,
    });

    if (result.skipped) {
      return { ...base, status: 'skipped' };
    }

    const usageFields = result.usage
      ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens }
      : {};

    const updated = await updateMemoryAnalysisIfSnapshotMatches(
      admin,
      candidate.id,
      {
        emotion: result.emotion,
        topics: result.topics,
        topicDetails: result.topicDetails,
        labels: result.labels,
        description: result.description,
      },
      { updated_at: candidate.updated_at, content: candidate.content },
    );

    if (!updated) {
      // The memory changed between select and write (concurrent edit) --
      // this analysis ran against now-superseded content. Nothing is
      // persisted; the memory naturally remains a candidate and will be
      // re-analyzed against its current content on the next run. Real
      // OpenAI cost was still incurred, so token usage is still reported.
      return { ...base, status: 'skipped', ...usageFields };
    }

    await upsertMemoryMilestones(admin, candidate.id, candidate.family_id, result.milestones);

    return { ...base, status: 'analyzed', ...usageFields };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

async function runWorkerPool(
  candidates: CandidateMemoryRow[],
  concurrency: number,
  worker: (candidate: CandidateMemoryRow) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(candidates[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => runWorker()));
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`analyze-memory backfill -- TOPICS_VERSION=${TOPICS_VERSION}`);

  const allCandidates = await loadCandidates(admin, options);
  const candidates = options.limit ? allCandidates.slice(0, options.limit) : allCandidates;

  if (candidates.length === 0) {
    console.log('No memories need re-analysis');
    return;
  }

  if (!options.apply) {
    console.log(`Found ${candidates.length} candidate memor${candidates.length === 1 ? 'y' : 'ies'} (dry run -- no OpenAI calls made)`);
    console.log('By family:');
    for (const { familyId, count } of summarizeCandidatesByFamily(candidates)) {
      console.log(`  ${familyId}: ${count}`);
    }
    console.log('By memory type:');
    for (const { memoryType, count } of summarizeCandidatesByType(candidates)) {
      console.log(`  ${memoryType}: ${count}`);
    }
    console.log(
      `Rough estimated cost: $${estimateDryRunCostUsd(candidates.length).toFixed(4)} ` +
        '(unmeasured -- based on the V1a eval\'s average $/memory; --apply reports real measured cost)',
    );
    console.log('Dry run only -- pass --apply to actually analyze and write these memories.');
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = new URL(`./eval-output/backfill-memory-analysis/${runId}/`, import.meta.url);
  await Deno.mkdir(outputDir, { recursive: true });
  const resultsPath = new URL('results.jsonl', outputDir).pathname;

  console.log(
    `Applying analysis to ${candidates.length} memor${candidates.length === 1 ? 'y' : 'ies'} ` +
      `(concurrency ${options.concurrency}). Log: ${resultsPath}`,
  );

  let analyzed = 0;
  let skipped = 0;
  let errors = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let completed = 0;

  await runWorkerPool(candidates, options.concurrency, async (candidate) => {
    const line = await processCandidate(admin, candidate);
    await queueAppendResultLine(resultsPath, line);

    if (line.status === 'analyzed') analyzed += 1;
    else if (line.status === 'skipped') skipped += 1;
    else errors += 1;

    promptTokens += line.promptTokens ?? 0;
    completionTokens += line.completionTokens ?? 0;

    completed += 1;
    if (completed % 25 === 0 || completed === candidates.length) {
      console.log(`  ... ${completed}/${candidates.length} processed`);
    }
  });

  const attempted = candidates.length;
  console.log('\nFinished.');
  console.log(`  Attempted: ${attempted}`);
  console.log(`  Analyzed: ${analyzed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Tokens: prompt=${promptTokens}, completion=${completionTokens}`);
  console.log(`  Estimated cost: $${estimateCostUsd(promptTokens, completionTokens).toFixed(4)}`);
  console.log(`  Output: ${outputDir.pathname}`);

  if (shouldExitNonZero(attempted, errors)) {
    console.error(`Error rate exceeded 10% (${errors}/${attempted}) -- exiting non-zero`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
