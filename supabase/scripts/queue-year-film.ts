/**
 * Year Film operator tool (docs/plans/year-film-p1.md Step 9, year-film-p2.md
 * Step 1.6/10). Service role via --env-file; DRY RUN unless --apply. Prints
 * ids, dates and statuses only — never memory text or names.
 *
 *   # list a family's films
 *   npm run year-film:queue -- --family <familyId>
 *
 *   # forced canary films (marked `forced`: never take a real film's slot,
 *   # never notified, invisible to members; delete them at the end)
 *   npm run year-film:queue -- --family <id> --forced family_year --start 2026-01-01 --end 2026-12-28 --apply
 *   npm run year-film:queue -- --family <id> --forced birthday --member <memberId> --age-year 4 \
 *     --start 2025-10-17 --end 2026-10-19 --apply
 *
 *   # re-run one film / every non-forced film of a family from scratch
 *   # (status queued, attempt_count, last_failure_code, skip_reason reset)
 *   npm run year-film:queue -- --requeue <filmId> --apply
 *   npm run year-film:queue -- --requeue-all --family <id> --apply
 *
 *   # SILENT HISTORY BACKFILL (no push, no drawer entry). Dry run prints the
 *   # returned table: `inserted` = "would be inserted" in a dry run.
 *   npm run year-film:queue -- --family <id> --backfill --through 2026-09-29
 *   #   smoke subset first (one film key = <kind>:<scope_start_date>):
 *   npm run year-film:queue -- --family <id> --backfill --through 2026-09-29 --only family_month:2026-09-01 --apply
 *   #   then the rest, and launch day for every enabled family:
 *   npm run year-film:queue -- --family <id> --backfill --through 2026-09-29 --apply
 *   npm run year-film:queue -- --all-families --backfill --through 2026-09-29 --apply
 *
 *   # remove films and their R2 prefixes ({ownerId}/year-films/{filmId}/)
 *   npm run year-film:queue -- --family <id> --delete-forced --apply
 *   npm run year-film:queue -- --family <id> --delete-backfilled --apply   # backfill-only rows (see below)
 *   npm run year-film:queue -- --family <id> --purge-prefix <filmId> --apply  # R2 leftovers with no row
 *
 * --delete-backfilled only selects rows that could have come from the history
 * backfill: with year_film_settings.launch_date unset every non-forced row of
 * the family, otherwise non-forced rows whose scope_end_exclusive (= due date)
 * is before launch_date. The dry run prints how many rows that rule excluded.
 *
 * Deleting refuses while a film of the selection is mid-attempt
 * (curating/preparing/rendering): wait for it or requeue after it settles.
 *
 * Renderer parity (gate e) doesn't need this tool: run `bench.sh sample` in
 * the same image locally and on a one-off Fly machine and compare with
 * ffmpeg's psnr filter (render/year-film-renderer/README.md).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from 'npm:@aws-sdk/client-s3@3';
import { createR2Client, getR2Config } from '../functions/_shared/r2.ts';

const args = Deno.args;
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const apply = has('--apply');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['birthday', 'family_month', 'family_year'];
const ACTIVE_STATUSES = ['curating', 'preparing', 'rendering'];

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function assertDate(flag: string, text: string | undefined): string {
  if (!text || !DATE.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error(`${flag} needs a YYYY-MM-DD date`);
  }
  return text;
}

const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? env('EXPO_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function list(familyId: string) {
  const { data, error } = await supabase
    .from('year_films')
    .select('id, kind, forced, age_year, scope_start_date, scope_end_exclusive, placement_date, status, blocked, stale, attempt_count, last_failure_code, surface_at, ready_at')
    .eq('family_id', familyId)
    .order('scope_start_date', { ascending: true });
  if (error) throw error;
  console.table(data);
}

async function ownerIdOf(familyId: string): Promise<string> {
  const { data, error } = await supabase.from('families').select('owner_id').eq('id', familyId).single();
  if (error) throw error;
  return data.owner_id as string;
}

/** Deletes every object under `{ownerId}/year-films/{filmId}/`; returns the count. */
async function deleteFilmPrefix(client: S3Client, bucket: string, ownerId: string, filmId: string): Promise<number> {
  if (!UUID.test(ownerId) || !UUID.test(filmId)) throw new Error('refusing to build an R2 prefix from a non-uuid');
  const prefix = `${ownerId}/year-films/${filmId}/`;
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      const result = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }));
      if (result.Errors?.length) throw new Error(`R2 refused ${result.Errors.length} delete(s) under film ${filmId}`);
      deleted += chunk.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/**
 * R2 prefixes first, then the rows (a failed R2 call leaves the ids to retry with).
 * `backfilled` selects non-forced rows that could only be backfill rows: all of
 * them while launch_date is unset, else those due before launch_date.
 */
async function deleteFilms(familyId: string, mode: 'forced' | 'backfilled') {
  let launchDate: string | null = null;
  if (mode === 'backfilled') {
    const { data: settings, error: settingsError } = await supabase.from('year_film_settings').select('launch_date').eq('id', true).single();
    if (settingsError) throw settingsError;
    launchDate = (settings.launch_date as string | null) ?? null;
  }
  const selection = (q: any) => {
    let query = q.eq('family_id', familyId).eq('forced', mode === 'forced');
    if (mode === 'backfilled' && launchDate) query = query.lt('scope_end_exclusive', launchDate);
    return query;
  };
  const { data, error } = await selection(supabase.from('year_films').select('id, status'));
  if (error) throw error;
  const films = (data ?? []) as { id: string; status: string }[];
  const label = mode === 'forced' ? 'forced' : 'backfilled';
  console.log(`${apply ? 'Deleting' : '[dry run] would delete'} ${films.length} ${label} film(s) and their R2 prefixes {ownerId}/year-films/{filmId}/.`);
  if (mode === 'backfilled') {
    const { count, error: countError } = await supabase
      .from('year_films')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('forced', false);
    if (countError) throw countError;
    const excluded = (count ?? 0) - films.length;
    console.log(
      launchDate
        ? `launch_date is ${launchDate}: ${excluded} non-forced row(s) due on/after it are excluded (real scheduled films).`
        : `launch_date is unset: ${excluded} row(s) excluded (everything before launch is backfill).`,
    );
  }
  const active = films.filter((f) => ACTIVE_STATUSES.includes(f.status));
  if (active.length > 0) {
    console.table(active);
    throw new Error(`${active.length} film(s) are mid-attempt; wait for them to settle first`);
  }
  if (!apply || films.length === 0) return;

  const ownerId = await ownerIdOf(familyId);
  const config = getR2Config();
  const client = createR2Client(config);
  let objects = 0;
  for (const film of films) objects += await deleteFilmPrefix(client, config.bucket, ownerId, film.id);
  console.log(`deleted ${objects} R2 object(s)`);
  const { error: deleteError } = await selection(supabase.from('year_films').delete());
  if (deleteError) throw deleteError;
}

async function requeueAll(familyId: string) {
  const { data, error } = await supabase
    .from('year_films')
    .select('id, status')
    .eq('family_id', familyId)
    .eq('forced', false)
    .not('status', 'in', `(${ACTIVE_STATUSES.join(',')})`);
  if (error) throw error;
  console.log(`${apply ? 'Requeuing' : '[dry run] would requeue'} ${data?.length ?? 0} non-forced film(s) (mid-attempt films are left alone)`);
  if (!apply || !data?.length) return;
  const { error: updateError } = await supabase
    .from('year_films')
    .update({
      status: 'queued', attempt_count: 0, attempt_id: null, next_attempt_at: null, requeue_after: null,
      skip_reason: null, last_failure_code: null,
    })
    .in('id', data.map((f) => f.id as string));
  if (updateError) throw updateError;
}

interface BackfillRow {
  kind: string;
  family_member_id: string | null;
  age_year: number | null;
  scope_start_date: string;
  due_date: string;
  inserted: boolean;
}

async function backfillOne(familyId: string, through: string, only: { kind: string; scopeStart: string } | null) {
  const { data, error } = await supabase.rpc('queue_year_film_backfill', {
    p_family_id: familyId,
    p_through: through,
    p_dry_run: !apply,
    p_only_kind: only?.kind ?? undefined,
    p_only_scope_start: only?.scopeStart ?? undefined,
  });
  if (error) throw error;
  const rows: BackfillRow[] = data ?? [];
  console.table(rows.map((r) => ({
    due_date: r.due_date,
    kind: r.kind,
    member_id: r.family_member_id,
    age_year: r.age_year,
    scope_start_date: r.scope_start_date,
    [apply ? 'inserted' : 'would_insert']: r.inserted,
  })));
  const fresh = rows.filter((r) => r.inserted).length;
  console.log(`${apply ? 'Queued' : '[dry run] would queue'} ${fresh} of ${rows.length} film(s); the rest already exist.`);
}

const familyId = value('--family');
const allFamilies = has('--all-families');
const requeue = value('--requeue');

if (familyId && !UUID.test(familyId)) throw new Error('--family needs a family id');

if (has('--backfill')) {
  const through = assertDate('--through', value('--through'));
  const onlyText = value('--only');
  let only: { kind: string; scopeStart: string } | null = null;
  if (onlyText) {
    const [kind, scopeStart] = onlyText.split(':');
    if (!KINDS.includes(kind)) throw new Error('--only <birthday|family_month|family_year>:<scope_start YYYY-MM-DD>');
    only = { kind, scopeStart: assertDate('--only', scopeStart) };
  }
  if (allFamilies === Boolean(familyId)) throw new Error('--backfill needs exactly one of --family <id> or --all-families');

  if (familyId) {
    console.log(`family ${familyId}`);
    await backfillOne(familyId, through, only);
    await list(familyId);
  } else {
    const { data, error } = await supabase.rpc('year_film_enabled_families');
    if (error) throw error;
    const families = ((data ?? []) as { family_id: string }[]).map((r) => r.family_id);
    console.log(`${families.length} enabled family(ies)`);
    let failed = 0;
    for (const id of families) {
      console.log(`family ${id}`);
      try {
        await backfillOne(id, through, only);
      } catch (e) {
        failed += 1;
        // RPC errors carry a code and a fixed message, never content.
        const err = e as { code?: string; message?: string };
        console.error(`  skipped: ${err.code ?? ''} ${err.message ?? 'error'}`);
      }
    }
    if (failed > 0) console.error(`${failed} family(ies) were skipped (see above).`);
  }
} else if (requeue) {
  if (!UUID.test(requeue)) throw new Error('--requeue needs a film id');
  console.log(`${apply ? 'Requeuing' : '[dry run] would requeue'} ${requeue}`);
  if (apply) {
    const { error } = await supabase
      .from('year_films')
      .update({ status: 'queued', attempt_count: 0, attempt_id: null, next_attempt_at: null, requeue_after: null, skip_reason: null })
      .eq('id', requeue)
      .not('status', 'in', `(${ACTIVE_STATUSES.map((s) => `"${s}"`).join(',')})`);
    if (error) throw error;
  }
} else if (familyId && has('--requeue-all')) {
  await requeueAll(familyId);
  await list(familyId);
} else if (familyId && has('--delete-forced')) {
  await deleteFilms(familyId, 'forced');
  await list(familyId);
} else if (familyId && has('--delete-backfilled')) {
  await deleteFilms(familyId, 'backfilled');
  await list(familyId);
} else if (familyId && value('--purge-prefix')) {
  const filmId = value('--purge-prefix')!;
  if (!UUID.test(filmId)) throw new Error('--purge-prefix needs a film id');
  const { data, error } = await supabase.from('year_films').select('id').eq('id', filmId).maybeSingle();
  if (error) throw error;
  if (data) throw new Error('that film still has a row: use --delete-forced / --delete-backfilled instead');
  console.log(`${apply ? 'Deleting' : '[dry run] would delete'} the R2 prefix of row-less film ${filmId}`);
  if (apply) {
    const config = getR2Config();
    const objects = await deleteFilmPrefix(createR2Client(config), config.bucket, await ownerIdOf(familyId), filmId);
    console.log(`deleted ${objects} R2 object(s)`);
  }
} else if (familyId && value('--forced')) {
  const kind = value('--forced');
  const start = value('--start');
  const end = value('--end');
  const member = value('--member') ?? null;
  const ageYear = value('--age-year') ? Number(value('--age-year')) : null;
  if (!KINDS.includes(kind!)) throw new Error('--forced birthday|family_month|family_year');
  if (!start || !DATE.test(start) || !end || !DATE.test(end)) throw new Error('--start and --end (exclusive) as YYYY-MM-DD');
  if (kind === 'birthday' && (!member || !ageYear)) throw new Error('birthday needs --member and --age-year');
  console.log(`${apply ? 'Queuing' : '[dry run] would queue'} forced ${kind} ${start} → ${end} for family ${familyId}`);
  if (apply) {
    const { data, error } = await supabase.rpc('queue_year_film_forced', {
      p_family_id: familyId, p_kind: kind, p_member_id: member, p_age_year: ageYear,
      p_scope_start: start, p_scope_end_exclusive: end, p_surface_at: new Date().toISOString(),
    });
    if (error) throw error;
    console.log(`queued film ${data}; the next hourly scheduler run dispatches it (rollout must include the family).`);
  }
  await list(familyId);
} else if (familyId) {
  await list(familyId);
} else {
  console.log('Nothing to do. See the header of supabase/scripts/queue-year-film.ts.');
}
