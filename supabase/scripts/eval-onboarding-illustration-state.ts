// Read-only diagnostic: the illustration state of recent onboarding memories
// (memories.onboarding_attributed), with their illustration jobs and the
// tagged kids' portrait versions/jobs, as a timeline. Prints ids, statuses,
// error codes and timestamps only -- never memory content or names (child/
// family PII rule).
//
//   npm run eval:onboarding-illustration-state -- [--hours 48] [--limit 5] [--pending]
//
// --all shows every text_illustration memory in the window.
// --pending widens the search to every text_illustration memory still at
// illustration_status 'pending' or 'generating', onboarding-attributed or not.
import { createClient } from 'npm:@supabase/supabase-js@2';

function argValue(name: string, fallback: number): number {
  const index = Deno.args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(Deno.args[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const hours = argValue('hours', 48);
const pendingOnly = Deno.args.includes('--pending');
const allIllustrated = Deno.args.includes('--all');
const limit = argValue('limit', 5);

const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the env files.');
  Deno.exit(1);
}
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const since = new Date(Date.now() - hours * 3600_000).toISOString();
let memoriesQuery = supabase
  .from('memories')
  .select(
    'id, family_id, memory_type, onboarding_attributed, illustration_status, illustration_key, illustration_generation_attempt_id, illustration_generation_started_at, created_at, updated_at',
  )
  .gte('created_at', since);
memoriesQuery = allIllustrated
  ? memoriesQuery.eq('memory_type', 'text_illustration')
  : pendingOnly
  ? memoriesQuery.eq('memory_type', 'text_illustration').in('illustration_status', ['pending', 'generating'])
  : memoriesQuery.eq('onboarding_attributed', true);
const { data: memories, error } = await memoriesQuery
  .order('created_at', { ascending: false })
  .limit(limit);
if (error) {
  console.error('memories query failed:', error.message);
  Deno.exit(1);
}

for (const memory of memories ?? []) {
  console.log('\n=== memory', memory.id);
  console.log({
    family_id: memory.family_id,
    memory_type: memory.memory_type,
    onboarding_attributed: memory.onboarding_attributed,
    illustration_status: memory.illustration_status,
    has_illustration_key: Boolean(memory.illustration_key),
    attempt_id: memory.illustration_generation_attempt_id,
    generation_started_at: memory.illustration_generation_started_at,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  });

  const { data: jobs, error: jobsError } = await supabase
    .from('memory_illustration_jobs')
    .select('id, attempt_id, request_intent, status, error_code, primary_attempts, fallback_attempts, started_at, completed_at')
    .eq('memory_id', memory.id)
    .order('started_at', { ascending: true });
  console.log('illustration jobs:', jobsError ? `ERROR ${jobsError.message}` : jobs ?? []);

  const { data: tags, error: tagsError } = await supabase
    .from('memory_family_members')
    .select('family_member_id')
    .eq('memory_id', memory.id);
  const memberIds = (tags ?? []).map((tag) => tag.family_member_id);
  console.log('tagged member ids:', tagsError ? `ERROR ${tagsError.message}` : memberIds);

  if (memberIds.length > 0) {
    const { data: versions, error: versionsError } = await supabase
      .from('family_member_portrait_versions')
      .select('id, family_member_id, illustrated_profile_status, reference_date, created_at')
      .in('family_member_id', memberIds)
      .order('created_at', { ascending: true });
    console.log('portrait versions:', versionsError ? `ERROR ${versionsError.message}` : versions ?? []);

    const versionIds = (versions ?? []).map((version) => version.id);
    if (versionIds.length > 0) {
      const { data: portraitJobs, error: portraitJobsError } = await supabase
        .from('portrait_generation_jobs')
        .select('id, portrait_version_id, status, error_code, started_at, completed_at')
        .in('portrait_version_id', versionIds)
        .order('started_at', { ascending: true });
      console.log('portrait jobs:', portraitJobsError ? `ERROR ${portraitJobsError.message}` : portraitJobs ?? []);
    }
  }

  const { data: usage, error: usageError } = await supabase
    .from('ai_usage_events')
    .select('operation, request_intent, billing_status, model, created_at')
    .eq('family_id', memory.family_id)
    .gte('created_at', memory.created_at)
    .order('created_at', { ascending: true })
    .limit(30);
  console.log('ai usage events (family, since memory):', usageError ? `ERROR ${usageError.message}` : usage ?? []);
}

if ((memories ?? []).length === 0) {
  console.log(`No onboarding memories in the last ${hours}h.`);
}
