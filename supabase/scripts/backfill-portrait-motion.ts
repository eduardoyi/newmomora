/**
 * Living portraits backfill (docs/plans/living-portraits.md): drives the
 * deployed `portrait-motion-backfill` Edge Function in batches until no
 * portrait is left without a loop. Prints counts only (no names, keys or ids).
 *
 *   npm run backfill:portrait-motion -- [--dry-run] [--batch 10] [--pause 45] [--max-batches N] [--all]
 *
 *   --dry-run    one call, reports how many portraits are eligible; claims nothing
 *   --batch N    portraits per call, 1-25 (default 10)
 *   --pause S    seconds to wait between batches (default 45, lets the Worker
 *                finish a batch before the next one starts)
 *   --max-batches N  stop after N batches (e.g. `--batch 1 --max-batches 1` to try one)
 *   --all        every ready portrait version, not just each member's current one
 *
 * Uses the service role bearer from the env file
 * (SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, the
 * same names the eval scripts use), run with --env-file=supabase/.env.local.
 */

interface BackfillCounts {
  eligible: number;
  claimed: number;
  dispatched: number;
  failed: number;
}

interface CliOptions {
  dryRun: boolean;
  batch: number;
  pauseSeconds: number;
  maxBatches: number | null;
  all: boolean;
}

// A batch that claims nothing while work remains would loop forever; stop
// after this many in a row (a raced claim is normal once in a while).
const MAX_STALLED_BATCHES = 3;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, batch: 10, pauseSeconds: 45, maxBatches: null, all: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--batch' || arg === '--pause') {
      const value = Number(argv[index + 1]);
      index += 1;
      if (arg === '--batch') {
        if (!Number.isInteger(value) || value < 1 || value > 25) throw new Error('--batch must be an integer from 1 to 25');
        options.batch = value;
      } else {
        if (!Number.isFinite(value) || value < 0) throw new Error('--pause must be a number of seconds >= 0');
        options.pauseSeconds = value;
      }
    } else if (arg === '--max-batches') {
      const value = Number(argv[index + 1]);
      index += 1;
      if (!Number.isInteger(value) || value < 1) throw new Error('--max-batches must be a positive integer');
      options.maxBatches = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function callBackfill(
  baseUrl: string,
  serviceRoleKey: string,
  body: { limit: number; dryRun: boolean; scope: 'current' | 'all' },
): Promise<BackfillCounts> {
  const response = await fetch(`${baseUrl}/functions/v1/portrait-motion-backfill`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Status only: the body could echo request details.
    throw new Error(`portrait-motion-backfill failed (${response.status})`);
  }
  const counts = await response.json() as Partial<BackfillCounts>;
  for (const key of ['eligible', 'claimed', 'dispatched', 'failed'] as const) {
    if (typeof counts[key] !== 'number') throw new Error('Unexpected portrait-motion-backfill response');
  }
  return counts as BackfillCounts;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  const baseUrl = (Deno.env.get('SUPABASE_URL') ?? Deno.env.get('EXPO_PUBLIC_SUPABASE_URL'))?.replace(/\/$/, '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY: run with --env-file=supabase/.env.local');
  }

  if (options.dryRun) {
    const counts = await callBackfill(baseUrl, serviceRoleKey, { limit: options.batch, dryRun: true, scope: options.all ? 'all' : 'current' });
    console.log(`dry run: ${counts.eligible} portraits would get a living portrait`);
    return;
  }

  const totals: BackfillCounts = { eligible: 0, claimed: 0, dispatched: 0, failed: 0 };
  let batch = 0;
  let stalled = 0;
  for (;;) {
    batch += 1;
    const counts = await callBackfill(baseUrl, serviceRoleKey, { limit: options.batch, dryRun: false, scope: options.all ? 'all' : 'current' });
    if (batch === 1) totals.eligible = counts.eligible;
    totals.claimed += counts.claimed;
    totals.dispatched += counts.dispatched;
    totals.failed += counts.failed;
    console.log(
      `batch ${batch}: eligible ${counts.eligible}, claimed ${counts.claimed}, dispatched ${counts.dispatched}, failed ${counts.failed}`,
    );
    if (counts.eligible === 0) break;
    if (options.maxBatches !== null && batch >= options.maxBatches) break;
    stalled = counts.claimed === 0 ? stalled + 1 : 0;
    if (stalled >= MAX_STALLED_BATCHES) {
      console.error(`stopping: ${MAX_STALLED_BATCHES} batches in a row claimed nothing while ${counts.eligible} remain eligible`);
      Deno.exitCode = 1;
      break;
    }
    await sleep(options.pauseSeconds * 1000);
  }
  console.log(
    `done: ${totals.eligible} eligible at start, ${totals.claimed} claimed, ${totals.dispatched} dispatched, ${totals.failed} failed`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'backfill failed');
    Deno.exit(1);
  });
}
