/**
 * Milestone honesty cleanup (owner rule, 2026-10-01: never assume or infer a
 * milestone unless the parent's memory text explicitly states it). Re-checks
 * every STORED `memory_milestones` row with status 'candidate' against the
 * same deterministic explicit-evidence gate the live detector now applies
 * (`_shared/memory-milestone-evidence.ts`; see docs/features/memory-analysis.md
 * "Explicit-evidence gate"), and dismisses the rows the memory's own text does
 * not support.
 *
 * Old rows have no stored evidence quote, so the gate runs on the memory text
 * itself: a row is kept only if some sentence (or two adjacent sentences) of
 * the memory's text carries the explicit first-time / achievement language its
 * catalog entry requires AND mentions the milestone's subject
 * (`memoryTextStatesMilestone`). The text considered is exactly what the
 * analyzer sees (`buildAnalysisInput`: caption/content, plus the transcript for
 * audio memories).
 *
 * Hard guarantees:
 *   - ONLY rows with status 'candidate' are read or written. 'confirmed'
 *     (a parent said yes) and 'dismissed' are never touched; the update is also
 *     guarded `status = 'candidate'` so a row confirmed mid-run is left alone.
 *   - `birthday` rows are exempt (the one sanctioned non-text path: the
 *     deterministic DOB join, a database fact -- see memory-analysis.md).
 *   - Rows whose milestone id is not in the catalog are left alone.
 *   - Dry-run by default; prints COUNTS ONLY (no memory text, no names, no
 *     ids of memories). `--apply` is required for any write.
 *   - Reversible: `--apply` first writes a rollback file under
 *     supabase/scripts/eval-output/milestone-honesty/<runId>/rollback.json
 *     (gitignored) listing every row id it intends to dismiss with its
 *     previous status; `--rollback <file> --apply` restores them.
 *
 * Usage (npm script wraps the deno flags / env files):
 *   npm run eval:milestone-honesty                       # dry run, counts only
 *   npm run eval:milestone-honesty -- --apply            # dismiss failing rows
 *   npm run eval:milestone-honesty -- --rollback <file>           # dry-run restore
 *   npm run eval:milestone-honesty -- --rollback <file> --apply   # restore
 *
 * Optional flags: --family-id <uuid> (repeatable) scope to families;
 * --batch-size N (default 200) update/restore batch size.
 *
 * Requires SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) and
 * SUPABASE_SERVICE_ROLE_KEY from the env files (service-role ops script, same
 * pattern as the other eval/backfill scripts).
 *
 * PII rule (hard, repo-wide): never prints or writes memory content, names, or
 * memory ids. The rollback file holds milestone-row ids, milestone ids, a
 * reason code and the previous status only.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { buildAnalysisInput } from '../functions/_shared/analyze-memory-core.ts';
import { MILESTONE_EVIDENCE_RULES, memoryTextStatesMilestone } from '../functions/_shared/memory-milestone-evidence.ts';

const DATABASE_PAGE_SIZE = 1000; // PostgREST's un-paginated select cap.
const MEMORY_ID_CHUNK = 100; // keeps `.in(...)` URLs well under length limits.
const DEFAULT_BATCH_SIZE = 200;
/** The deterministic DOB-join path; never text-gated (see header). */
const EXEMPT_MILESTONE_IDS: ReadonlySet<string> = new Set(['birthday']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliOptions {
  apply: boolean;
  rollbackFile: string | null;
  familyIds: string[];
  batchSize: number;
}

export interface CandidateMilestoneRow {
  id: string;
  memory_id: string;
  family_id: string;
  milestone_id: string;
  status: string;
}

export interface MemoryTextSource {
  memory_type: string;
  content: string | null;
  audio_transcript: string | null;
}

export type RowDecision =
  | { action: 'keep' }
  | { action: 'exempt'; why: 'birthday' | 'unknown_milestone' | 'memory_missing' }
  | { action: 'dismiss'; reason: string };

export interface RollbackRow {
  id: string;
  milestoneId: string;
  previousStatus: 'candidate';
  reason: string;
}

export interface RollbackFile {
  version: 1;
  runId: string;
  createdAt: string;
  rows: RollbackRow[];
}

export interface HonestySummary {
  total: number;
  kept: number;
  wouldDismiss: number;
  exempt: number;
  byMilestone: Array<{ milestoneId: string; total: number; kept: number; wouldDismiss: number; exempt: number }>;
  byReason: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported + covered by milestone-honesty-backfill.test.ts).
// ---------------------------------------------------------------------------

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { apply: false, rollbackFile: null, familyIds: [], batchSize: DEFAULT_BATCH_SIZE };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case '--apply':
        options.apply = true;
        break;
      case '--rollback':
        if (next) options.rollbackFile = next;
        index += 1;
        break;
      case '--family-id':
        if (next) options.familyIds.push(next);
        index += 1;
        break;
      case '--batch-size': {
        const parsed = Number(next);
        options.batchSize = Number.isInteger(parsed) && parsed > 0 ? parsed : options.batchSize;
        index += 1;
        break;
      }
      default:
        break;
    }
  }
  return options;
}

/** The text the analyzer would have seen for this memory (caption/content,
 * plus the transcript for audio memories). Null when there is none. */
export function memoryTextForGate(memory: MemoryTextSource): string | null {
  return buildAnalysisInput(memory.memory_type, memory.content, memory.audio_transcript, []).text;
}

export function decideRow(row: CandidateMilestoneRow, memory: MemoryTextSource | undefined): RowDecision {
  if (EXEMPT_MILESTONE_IDS.has(row.milestone_id)) return { action: 'exempt', why: 'birthday' };
  if (!(row.milestone_id in MILESTONE_EVIDENCE_RULES)) return { action: 'exempt', why: 'unknown_milestone' };
  if (!memory) return { action: 'exempt', why: 'memory_missing' };

  const verdict = memoryTextStatesMilestone(row.milestone_id, memoryTextForGate(memory));
  return verdict.ok ? { action: 'keep' } : { action: 'dismiss', reason: verdict.reason };
}

export function summarize(rows: Array<{ milestoneId: string; decision: RowDecision }>): HonestySummary {
  const byMilestone = new Map<string, { total: number; kept: number; wouldDismiss: number; exempt: number }>();
  const byReason = new Map<string, number>();
  let kept = 0;
  let wouldDismiss = 0;
  let exempt = 0;

  for (const { milestoneId, decision } of rows) {
    const bucket = byMilestone.get(milestoneId) ?? { total: 0, kept: 0, wouldDismiss: 0, exempt: 0 };
    bucket.total += 1;
    if (decision.action === 'keep') {
      kept += 1;
      bucket.kept += 1;
    } else if (decision.action === 'exempt') {
      exempt += 1;
      bucket.exempt += 1;
    } else {
      wouldDismiss += 1;
      bucket.wouldDismiss += 1;
      byReason.set(decision.reason, (byReason.get(decision.reason) ?? 0) + 1);
    }
    byMilestone.set(milestoneId, bucket);
  }

  return {
    total: rows.length,
    kept,
    wouldDismiss,
    exempt,
    byMilestone: [...byMilestone.entries()]
      .map(([milestoneId, counts]) => ({ milestoneId, ...counts }))
      .sort((a, b) => b.total - a.total || a.milestoneId.localeCompare(b.milestoneId)),
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export function buildRollbackFile(
  runId: string,
  createdAt: string,
  dismissals: Array<{ row: CandidateMilestoneRow; reason: string }>,
): RollbackFile {
  return {
    version: 1,
    runId,
    createdAt,
    rows: dismissals.map(({ row, reason }) => ({
      id: row.id,
      milestoneId: row.milestone_id,
      previousStatus: row.status as 'candidate',
      reason,
    })),
  };
}

/** Strict shape check for a rollback file read from disk; throws on anything
 * unexpected so a hand-edited or wrong file can never widen what gets written
 * (only previousStatus 'candidate' is restorable). */
export function parseRollbackFile(raw: unknown): RollbackFile {
  const obj = raw as Partial<RollbackFile> | null;
  if (!obj || obj.version !== 1 || !Array.isArray(obj.rows) || typeof obj.runId !== 'string') {
    throw new Error('Not a milestone-honesty rollback file (version 1)');
  }
  for (const row of obj.rows) {
    if (
      !row ||
      typeof row.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(row.id) ||
      row.previousStatus !== 'candidate'
    ) {
      throw new Error('Rollback file has a malformed row');
    }
  }
  return obj as RollbackFile;
}

// ---------------------------------------------------------------------------
// Script entry point -- side effects below; the pure helpers above are what
// the unit tests cover (same convention as the other backfill scripts).
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function loadCandidateRows(admin: SupabaseClient, options: CliOptions): Promise<CandidateMilestoneRow[]> {
  const rows: CandidateMilestoneRow[] = [];
  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    let query = admin
      .from('memory_milestones')
      .select('id, memory_id, family_id, milestone_id, status')
      .eq('status', 'candidate') // NEVER confirmed / dismissed.
      .order('id', { ascending: true })
      .range(offset, offset + DATABASE_PAGE_SIZE - 1);
    if (options.familyIds.length > 0) query = query.in('family_id', options.familyIds);

    const { data, error } = await query;
    if (error) throw new Error(`Could not load candidate milestones: ${error.message}`);
    const page = (data ?? []) as CandidateMilestoneRow[];
    rows.push(...page);
    if (page.length < DATABASE_PAGE_SIZE) break;
  }
  return rows;
}

async function loadMemoryTexts(admin: SupabaseClient, memoryIds: string[]): Promise<Map<string, MemoryTextSource>> {
  const byId = new Map<string, MemoryTextSource>();
  for (const chunk of chunkArray(memoryIds, MEMORY_ID_CHUNK)) {
    const { data, error } = await admin
      .from('memories')
      .select('id, memory_type, content, audio_transcript')
      .in('id', chunk);
    if (error) throw new Error(`Could not load memories: ${error.message}`);
    for (const row of (data ?? []) as Array<MemoryTextSource & { id: string }>) {
      byId.set(row.id, { memory_type: row.memory_type, content: row.content, audio_transcript: row.audio_transcript });
    }
  }
  return byId;
}

function printSummary(summary: HonestySummary): void {
  console.log(`Candidate milestone rows: ${summary.total}`);
  console.log(`  would keep:    ${summary.kept}`);
  console.log(`  would dismiss: ${summary.wouldDismiss}`);
  console.log(`  exempt (birthday / unknown id / memory missing): ${summary.exempt}`);
  console.log('By milestone_id (total / keep / dismiss / exempt):');
  for (const row of summary.byMilestone) {
    console.log(`  ${row.milestoneId}: ${row.total} / ${row.kept} / ${row.wouldDismiss} / ${row.exempt}`);
  }
  console.log('Dismissal reasons:');
  for (const { reason, count } of summary.byReason) {
    console.log(`  ${reason}: ${count}`);
  }
}

async function runRollback(admin: SupabaseClient, options: CliOptions): Promise<void> {
  const file = parseRollbackFile(JSON.parse(await Deno.readTextFile(options.rollbackFile!)));
  const ids = file.rows.map((row) => row.id);
  console.log(`Rollback file ${file.runId}: ${ids.length} row(s) to restore to 'candidate'`);

  if (!options.apply) {
    console.log('Dry run only -- pass --apply with --rollback to restore these rows.');
    return;
  }

  let restored = 0;
  for (const batch of chunkArray(ids, options.batchSize)) {
    const { data, error } = await admin
      .from('memory_milestones')
      .update({ status: 'candidate' })
      .in('id', batch)
      .eq('status', 'dismissed') // only undo what is still dismissed
      .select('id');
    if (error) throw new Error(`Rollback batch failed: ${error.message}`);
    restored += (data ?? []).length;
    console.log(`  ... restored ${restored}/${ids.length}`);
  }
  console.log(`Restored ${restored} row(s) (${ids.length - restored} were no longer dismissed and were left alone).`);
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (options.rollbackFile) {
    await runRollback(admin, options);
    return;
  }

  const rows = await loadCandidateRows(admin, options);
  const memories = await loadMemoryTexts(admin, [...new Set(rows.map((row) => row.memory_id))]);
  const decided = rows.map((row) => ({ row, decision: decideRow(row, memories.get(row.memory_id)) }));
  const summary = summarize(decided.map(({ row, decision }) => ({ milestoneId: row.milestone_id, decision })));

  console.log(`milestone honesty cleanup -- ${options.apply ? 'APPLY' : 'DRY RUN'}`);
  printSummary(summary);

  const dismissals = decided.flatMap(({ row, decision }) =>
    decision.action === 'dismiss' ? [{ row, reason: decision.reason }] : [],
  );

  if (!options.apply) {
    console.log('Dry run only -- nothing was written. Pass --apply to dismiss the rows above.');
    return;
  }
  if (dismissals.length === 0) {
    console.log('Nothing to dismiss.');
    return;
  }

  // Rollback file FIRST, so a crash mid-run can always be undone.
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = new URL(`./eval-output/milestone-honesty/${runId}/`, import.meta.url);
  await Deno.mkdir(outputDir, { recursive: true });
  const rollbackPath = new URL('rollback.json', outputDir).pathname;
  await Deno.writeTextFile(
    rollbackPath,
    JSON.stringify(buildRollbackFile(runId, new Date().toISOString(), dismissals), null, 2),
  );
  console.log(`Rollback file written: ${rollbackPath}`);

  let dismissed = 0;
  for (const batch of chunkArray(dismissals.map(({ row }) => row.id), options.batchSize)) {
    const { data, error } = await admin
      .from('memory_milestones')
      .update({ status: 'dismissed' })
      .in('id', batch)
      .eq('status', 'candidate') // never override a row confirmed mid-run
      .select('id');
    if (error) throw new Error(`Dismiss batch failed: ${error.message} (rollback file: ${rollbackPath})`);
    dismissed += (data ?? []).length;
    console.log(`  ... dismissed ${dismissed}/${dismissals.length}`);
  }
  console.log(`Dismissed ${dismissed} row(s). To undo: npm run eval:milestone-honesty -- --rollback ${rollbackPath} --apply`);
}

if (import.meta.main) {
  await main();
}
