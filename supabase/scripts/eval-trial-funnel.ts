// Read-only diagnostic: post-purchase activation funnel across every
// RevenueCat trial in PostHog. Aggregates only -- counts, rates and
// durations; never ids, names or memory content (child/family PII rule).
//
//   npm run eval:trial-funnel -- [--explore] [--trial N]
//
// --explore lists RevenueCat event names and counts (to check the query's
// assumptions about the integration's event names). --trial N prints trial
// N's import/app-open timestamps (hours from trial start) for drill-down.
//
// Return windows are hours from the anchor (trial start or onboarding
// commit): next-day 4-24h (a later session, e.g. next morning), day 2
// 24-48h, day 3 48-72h. No timezone is applied.
import { runHogQL } from './posthog-query.ts';

if (Deno.args.includes('--explore')) {
  const rows = await runHogQL(`
    select event, count() as n, uniq(person_id) as people, min(timestamp), max(timestamp)
    from events
    where event like 'rc_%'
    group by event
    order by n desc`);
  console.log('RevenueCat events in PostHog:');
  for (const row of rows ?? []) console.log(' ', row.join('  '));
  Deno.exit(0);
}

// One row per person who finished owner onboarding or started a trial.
// minIf() with no match returns the epoch, normalized to null below.
const rows = await runHogQL(`
  select
    person_id,
    minIf(timestamp, event = 'onboarding_committed') as committed_at,
    minIf(timestamp, event = 'paywall_viewed') as paywall_at,
    minIf(timestamp, event = 'paywall_purchase_started') as purchase_started_at,
    minIf(timestamp, event = 'paywall_purchase_completed') as purchase_completed_at,
    minIf(timestamp, event = 'rc_trial_started_event') as trial_at,
    minIf(timestamp, event = 'rc_trial_cancelled_event') as cancel_at,
    minIf(timestamp, event = 'rc_trial_converted_event' or event = 'rc_initial_purchase_event' or event = 'rc_renewal_event') as paid_at,
    argMinIf(properties.store, timestamp, event = 'rc_trial_started_event') as store,
    minIf(timestamp, event = 'onboarding_step_viewed' and properties.step = 'portrait') as portrait_at,
    minIf(timestamp, event = 'onboarding_step_viewed' and properties.step = 'reveal') as reveal_at,
    groupArrayIf(timestamp, event in ('Application Opened', 'Application Became Active')) as app_times,
    groupArrayIf(timestamp, event = 'keepsakes_opened') as keepsakes_times,
    groupArrayIf(timestamp, event = 'keepsakes_product_opened' and properties.product = 'memory-book') as book_times,
    groupArrayIf(timestamp, event = 'memory_saved') as save_times,
    groupArrayIf(tuple(timestamp, toInt(properties.asset_count), toInt(properties.tagged_count)), event = 'gallery_import_candidate_approved') as approvals,
    countIf(properties.env = 'prod') as prod_events,
    countIf(properties.env = 'dev') as dev_events
  from events
  where person_id in (
    select person_id from events
    where event = 'onboarding_committed' or event = 'rc_trial_started_event'
  )
  group by person_id
  limit 10000`);
if (!rows) Deno.exit(1);

const HOUR = 3600_000;
const now = Date.now();

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`);
  return Number.isFinite(parsed) && parsed > Date.UTC(2000, 0, 1) ? parsed : null;
}
function times(value: unknown): number[] {
  return (Array.isArray(value) ? value : []).map(time).filter((t): t is number => t !== null);
}
function within(list: number[], anchor: number, fromHours: number, toHours: number): number {
  return list.filter((t) => t >= anchor + fromHours * HOUR && t < anchor + toHours * HOUR).length;
}
function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${part}/${whole} (${Math.round((100 * part) / whole)}%)`;
}
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function hours(ms: number | null): string {
  if (ms === null) return '-';
  return ms < HOUR ? `${Math.round(ms / 60_000)}m` : `${(ms / HOUR).toFixed(1)}h`;
}

interface Person {
  committedAt: number | null;
  paywallAt: number | null;
  purchaseStartedAt: number | null;
  purchaseCompletedAt: number | null;
  trialAt: number | null;
  cancelAt: number | null;
  paidAt: number | null;
  store: string;
  portraitAt: number | null;
  revealAt: number | null;
  appTimes: number[];
  keepsakesTimes: number[];
  bookTimes: number[];
  saveTimes: number[];
  approvals: { at: number; assets: number; tagged: number }[];
  isDevOnly: boolean;
}

const people: Person[] = rows.map((row) => ({
  committedAt: time(row[1]),
  paywallAt: time(row[2]),
  purchaseStartedAt: time(row[3]),
  purchaseCompletedAt: time(row[4]),
  trialAt: time(row[5]),
  cancelAt: time(row[6]),
  paidAt: time(row[7]),
  store: String(row[8] ?? ''),
  portraitAt: time(row[9]),
  revealAt: time(row[10]),
  appTimes: times(row[11]),
  keepsakesTimes: times(row[12]),
  bookTimes: times(row[13]),
  saveTimes: times(row[14]),
  approvals: (Array.isArray(row[15]) ? row[15] : []).flatMap((entry) => {
    const [at, assets, tagged] = Array.isArray(entry) ? entry : [];
    const parsed = time(at);
    return parsed === null ? [] : [{ at: parsed, assets: Number(assets) || 0, tagged: Number(tagged) || 0 }];
  }),
  isDevOnly: Number(row[17]) > 0 && Number(row[16]) === 0,
}));

const devOnly = people.filter((person) => person.isDevOnly).length;
const cohort = people.filter((person) => !person.isDevOnly);

// ---- Trials -------------------------------------------------------------
const trials = cohort.filter((person) => person.trialAt !== null).sort((a, b) => a.trialAt! - b.trialAt!);
console.log(`=== Trials: ${trials.length} (dev-only people excluded: ${devOnly})`);
console.log('  #  store       started     cancel-after  paid  portrait->reveal  D1  D2  D3  1h-keepsakes  1h-book  saves<24h  imports(assets, tagged)');
trials.forEach((trial, index) => {
  const anchor = trial.trialAt!;
  const portraitMs = trial.portraitAt && trial.revealAt ? trial.revealAt - trial.portraitAt : null;
  const portrait = trial.portraitAt ? (trial.revealAt ? hours(portraitMs) : 'never left') : 'not shown';
  const d1 = now - anchor >= 24 * HOUR ? (within(trial.appTimes, anchor, 4, 24) > 0 ? 'yes' : 'no') : '..';
  const d2 = now - anchor >= 48 * HOUR ? (within(trial.appTimes, anchor, 24, 48) > 0 ? 'yes' : 'no') : '..';
  const d3 = now - anchor >= 72 * HOUR ? (within(trial.appTimes, anchor, 48, 72) > 0 ? 'yes' : 'no') : '..';
  const imports = trial.approvals.filter((approval) => approval.at >= anchor);
  console.log(
    ' ',
    String(index + 1).padEnd(2),
    trial.store.padEnd(11),
    new Date(anchor).toISOString().slice(0, 10).padEnd(11),
    hours(trial.cancelAt ? trial.cancelAt - anchor : null).padEnd(13),
    (trial.paidAt ? 'yes' : 'no').padEnd(5),
    portrait.padEnd(17),
    d1.padEnd(3),
    d2.padEnd(3),
    d3.padEnd(3),
    String(within(trial.keepsakesTimes, anchor, 0, 1)).padEnd(13),
    String(within(trial.bookTimes, anchor, 0, 1)).padEnd(8),
    String(within(trial.saveTimes, anchor, 0, 24)).padEnd(10),
    `${imports.length} (${imports.reduce((sum, a) => sum + a.assets, 0)}, ${imports.filter((a) => a.tagged > 0).length} tagged)`,
  );
});

const drillIndex = Deno.args.indexOf('--trial');
if (drillIndex >= 0) {
  const trial = trials[Number(Deno.args[drillIndex + 1]) - 1];
  if (trial) {
    const rel = (t: number) => `${((t - trial.trialAt!) / HOUR).toFixed(1)}h`;
    console.log(`\n--- trial ${Deno.args[drillIndex + 1]} drill-down (hours from trial start)`);
    console.log('  onboarding commit:', trial.committedAt ? rel(trial.committedAt) : '-');
    console.log('  app opens/actives:', trial.appTimes.sort((a, b) => a - b).map(rel).join(' '));
    console.log('  import approvals:', trial.approvals.sort((a, b) => a.at - b.at).map((a) => `${rel(a.at)}(${a.assets})`).join(' '));
  }
}

const cancelDelays = trials.filter((trial) => trial.cancelAt).map((trial) => trial.cancelAt! - trial.trialAt!);
const buckets = { '<1h': 0, '1-24h': 0, '1-3d': 0, '3-7d': 0, '>7d': 0 };
for (const delay of cancelDelays) {
  if (delay < HOUR) buckets['<1h'] += 1;
  else if (delay < 24 * HOUR) buckets['1-24h'] += 1;
  else if (delay < 72 * HOUR) buckets['1-3d'] += 1;
  else if (delay < 168 * HOUR) buckets['3-7d'] += 1;
  else buckets['>7d'] += 1;
}
console.log(`\n  cancelled: ${pct(cancelDelays.length, trials.length)}, paid: ${pct(trials.filter((t) => t.paidAt).length, trials.length)}`);
console.log(`  time to cancel: median ${hours(median(cancelDelays))}`, buckets);
const portraitShown = trials.filter((trial) => trial.portraitAt);
const portraitDone = portraitShown.filter((trial) => trial.revealAt);
console.log(
  `  portrait step: completed ${pct(portraitDone.length, portraitShown.length)},`,
  `median time ${hours(median(portraitDone.map((trial) => trial.revealAt! - trial.portraitAt!)))}`,
);

// ---- Wider cohort: everyone who finished owner onboarding ----------------
const owners = cohort.filter((person) => person.committedAt !== null);
console.log(`\n=== Owners who finished onboarding (onboarding_committed): ${owners.length}`);
const sawPaywall = owners.filter((owner) => owner.paywallAt).length;
const startedPurchase = owners.filter((owner) => owner.purchaseStartedAt).length;
const completedPurchase = owners.filter((owner) => owner.purchaseCompletedAt).length;
console.log(`  paywall viewed ${pct(sawPaywall, owners.length)}; purchase started ${pct(startedPurchase, sawPaywall)}; completed ${pct(completedPurchase, startedPurchase)}`);
// Why started purchases didn't complete (store sheet cancel vs error).
const purchaseOutcomes = await runHogQL(`
  select event, toString(properties.code) as code, count() as n, uniq(person_id) as people,
    toString(toDate(min(timestamp))) as first_seen, toString(toDate(max(timestamp))) as last_seen,
    countIf(timestamp > now() - interval 30 day) as last_30d
  from events
  where event in ('paywall_purchase_failed', 'paywall_error_shown', 'paywall_abandoned')
    and properties.env = 'prod'
  group by event, code
  order by n desc`);
console.log('  paywall failures/abandons (event, code, events, people, first, last, events in last 30d):');
for (const row of purchaseOutcomes ?? []) console.log('   ', row.join('  '));

function cohortStats(label: string, group: Person[]) {
  const anchorOf = (person: Person) => person.purchaseCompletedAt ?? person.committedAt!;
  const d1Eligible = group.filter((person) => now - anchorOf(person) >= 24 * HOUR);
  const d1 = d1Eligible.filter((person) => within(person.appTimes, anchorOf(person), 4, 24) > 0).length;
  const d2Eligible = group.filter((person) => now - anchorOf(person) >= 48 * HOUR);
  const d3Eligible = group.filter((person) => now - anchorOf(person) >= 72 * HOUR);
  const d2 = d2Eligible.filter((person) => within(person.appTimes, anchorOf(person), 24, 48) > 0).length;
  const d3 = d3Eligible.filter((person) => within(person.appTimes, anchorOf(person), 48, 72) > 0).length;
  const keepsakes1h = group.filter((person) => within(person.keepsakesTimes, anchorOf(person), 0, 1) > 0).length;
  const book1h = group.filter((person) => within(person.bookTimes, anchorOf(person), 0, 1) > 0).length;
  const importers = group.filter((person) => person.approvals.length > 0);
  const approvals = importers.flatMap((person) => person.approvals);
  console.log(`\n  -- ${label}: ${group.length}`);
  console.log(`  returned next day (4-24h) ${pct(d1, d1Eligible.length)}; day 2 (24-48h) ${pct(d2, d2Eligible.length)}; day 3 (48-72h) ${pct(d3, d3Eligible.length)}`);
  console.log(`  opened Keepsakes in first hour ${pct(keepsakes1h, group.length)}; Memory book page ${pct(book1h, group.length)}`);
  console.log(
    `  gallery import: ${pct(importers.length, group.length)} approved any;`,
    `${approvals.length} approvals / ${approvals.reduce((sum, a) => sum + a.assets, 0)} photos;`,
    `approvals with anyone tagged ${pct(approvals.filter((a) => a.tagged > 0).length, approvals.length)}`,
  );
  console.log(`  median memories saved in first 24h: ${median(group.map((person) => within(person.saveTimes, anchorOf(person), 0, 24))) ?? '-'}`);
}
cohortStats('purchased (anchor = purchase)', owners.filter((owner) => owner.purchaseCompletedAt));
cohortStats('did not purchase (anchor = onboarding commit)', owners.filter((owner) => !owner.purchaseCompletedAt));
