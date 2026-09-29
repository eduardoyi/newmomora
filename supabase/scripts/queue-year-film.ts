/**
 * Year Film canary / operator tool (docs/plans/year-film-p1.md Step 9).
 * Service role via --env-file; DRY RUN unless --apply. Prints ids and
 * statuses only — never memory text or names.
 *
 *   # list a family's films
 *   npm run year-film:queue -- --family <familyId>
 *
 *   # forced canary films (marked `forced`: never take a real film's slot,
 *   # never notified; delete them at the end of the canary)
 *   npm run year-film:queue -- --family <id> --forced family_year --start 2026-01-01 --end 2026-09-29 --apply
 *   npm run year-film:queue -- --family <id> --forced birthday --member <memberId> --age-year 4 \
 *     --start 2025-10-23 --end 2026-10-26 --apply
 *
 *   # re-run a film from scratch (new cycle)
 *   npm run year-film:queue -- --requeue <filmId> --apply
 *
 *   # remove every forced film of a family (canary end)
 *   npm run year-film:queue -- --family <id> --delete-forced --apply
 *
 * Renderer parity (gate e) doesn't need this tool: run `bench.sh sample` in
 * the same image locally and on a one-off Fly machine and compare with
 * ffmpeg's psnr filter (render/year-film-renderer/README.md).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const args = Deno.args;
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes('--apply');
const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? env('EXPO_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function list(familyId: string) {
  const { data, error } = await supabase
    .from('year_films')
    .select('id, kind, forced, age_year, scope_start_date, scope_end_exclusive, status, blocked, stale, attempt_count, last_failure_code, surface_at, ready_at')
    .eq('family_id', familyId)
    .order('scope_start_date', { ascending: true });
  if (error) throw error;
  console.table(data);
}

const familyId = value('--family');
const requeue = value('--requeue');

if (requeue) {
  if (!UUID.test(requeue)) throw new Error('--requeue needs a film id');
  console.log(`${apply ? 'Requeuing' : '[dry run] would requeue'} ${requeue}`);
  if (apply) {
    const { error } = await supabase
      .from('year_films')
      .update({ status: 'queued', attempt_count: 0, attempt_id: null, next_attempt_at: null, requeue_after: null, skip_reason: null })
      .eq('id', requeue)
      .not('status', 'in', '("curating","preparing","rendering")');
    if (error) throw error;
  }
} else if (familyId && args.includes('--delete-forced')) {
  const { data, error } = await supabase.from('year_films').select('id').eq('family_id', familyId).eq('forced', true);
  if (error) throw error;
  console.log(`${apply ? 'Deleting' : '[dry run] would delete'} ${data?.length ?? 0} forced film(s). R2 objects are swept by the owner-prefix cleanup; delete them now with the scheduler's cleanup or by prefix.`);
  if (apply) {
    const { error: deleteError } = await supabase.from('year_films').delete().eq('family_id', familyId).eq('forced', true);
    if (deleteError) throw deleteError;
  }
} else if (familyId && value('--forced')) {
  const kind = value('--forced');
  const start = value('--start');
  const end = value('--end');
  const member = value('--member') ?? null;
  const ageYear = value('--age-year') ? Number(value('--age-year')) : null;
  if (!['birthday', 'family_month', 'family_year'].includes(kind!)) throw new Error('--forced birthday|family_month|family_year');
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
}

if (familyId) await list(familyId);
if (!familyId && !requeue) console.log('Nothing to do. See the header of supabase/scripts/queue-year-film.ts.');
