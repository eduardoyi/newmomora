// Read-only diagnostic: recent RevenueCat trial starts and cancellations, with
// each owner's billing ledger, RevenueCat subscriber state (when the secret is
// in the env files) and a content-free activity summary. Prints ids, statuses,
// counts and timestamps only -- never memory content, names or emails (child/
// family PII rule).
//
//   npm run eval:billing-trials -- [--days 5]
import { createClient } from 'npm:@supabase/supabase-js@2';
import { runHogQL } from './posthog-query.ts';

function argValue(name: string, fallback: number): number {
  const index = Deno.args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(Deno.args[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const days = argValue('days', 5);

const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the env files.');
  Deno.exit(1);
}
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const revenueCatKey = Deno.env.get('REVENUECAT_SECRET_API_KEY');
const revenueCatProject = Deno.env.get('REVENUECAT_PROJECT_ID');

async function posthogTimeline(userId: string) {
  const query = `
    select timestamp, event, properties
    from events
    where person_id = (select person_id from person_distinct_ids where distinct_id = '${userId}' limit 1)
    order by timestamp asc
    limit 500`;
  const results = await runHogQL(query) as [string, string, string | Record<string, unknown>][] | null;
  if (!results) return;
  console.log(`posthog events: ${results.length}`);
  for (const [timestamp, event, rawProperties] of results) {
    const properties = typeof rawProperties === 'string' ? JSON.parse(rawProperties) : rawProperties;
    // Momora's event properties are content-free by design; drop PostHog's
    // own $-prefixed device noise except a few useful fields.
    const shown: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties ?? {})) {
      if (!key.startsWith('$') || ['$os', '$app_version', '$screen_name'].includes(key)) shown[key] = value;
    }
    console.log(' ', timestamp, event.padEnd(32), JSON.stringify(shown));
  }
}

const since = new Date(Date.now() - days * 86400_000).toISOString();
const eventColumns =
  'event_id, event_type, event_at, store, environment, product_id, period_type, purchased_at, expires_at, will_renew, status, last_error, processed_at, owner_user_id, app_user_id';

const { data: recentEvents, error } = await supabase
  .from('billing_webhook_events')
  .select(eventColumns)
  .gte('event_at', since)
  .order('event_at', { ascending: true });
if (error) {
  console.error('billing_webhook_events query failed:', error.message);
  Deno.exit(1);
}

console.log(`=== webhook events since ${since}`);
for (const event of recentEvents ?? []) {
  console.log(
    event.event_at,
    event.event_type.padEnd(22),
    event.environment,
    event.store,
    event.product_id,
    `owner=${event.owner_user_id ?? event.app_user_id}`,
    `status=${event.status}`,
  );
}

const owners = [
  ...new Set((recentEvents ?? []).map((event) => event.owner_user_id ?? event.app_user_id).filter(Boolean)),
] as string[];

function summarize(rows: Record<string, unknown>[] | null, key: string) {
  const counts: Record<string, number> = {};
  for (const row of rows ?? []) {
    const value = String(row[key]);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

for (const owner of owners) {
  console.log(`\n\n######## owner ${owner}`);

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(owner);
  const user = userData?.user;
  console.log('auth user:', userError ? `ERROR ${userError.message}` : {
    created_at: user?.created_at,
    last_sign_in_at: user?.last_sign_in_at,
    providers: user?.app_metadata?.providers ?? user?.app_metadata?.provider,
  });

  const { data: events } = await supabase
    .from('billing_webhook_events')
    .select(eventColumns)
    .or(`owner_user_id.eq.${owner},app_user_id.eq.${owner}`)
    .order('event_at', { ascending: true });
  console.log('all webhook events:');
  for (const event of events ?? []) {
    console.log(' ', {
      event_at: event.event_at,
      type: event.event_type,
      env: event.environment,
      store: event.store,
      product: event.product_id,
      period: event.period_type,
      purchased_at: event.purchased_at,
      expires_at: event.expires_at,
      will_renew: event.will_renew,
      status: event.status,
      last_error: event.last_error,
    });
  }

  const { data: entitlements, error: entitlementError } = await supabase
    .from('owner_entitlements')
    .select('environment, store, product_id, period_type, status, purchased_at, expires_at, will_renew, last_event_at, created_at, updated_at')
    .eq('owner_user_id', owner);
  console.log('owner_entitlements:', entitlementError ? `ERROR ${entitlementError.message}` : entitlements);

  const { data: reminders } = await supabase
    .from('billing_trial_reminder_outbox')
    .select('channel, due_at, status, attempts, sent_at, last_error')
    .eq('owner_user_id', owner);
  console.log('trial reminders:', reminders);

  if (revenueCatKey && revenueCatProject) {
    const response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(owner)}`, {
      headers: { Authorization: `Bearer ${revenueCatKey}`, 'X-Project-ID': revenueCatProject, Accept: 'application/json' },
    });
    if (response.ok) {
      const payload = await response.json();
      const subscriber = payload.subscriber ?? {};
      console.log('revenuecat first_seen/last_seen:', subscriber.first_seen, subscriber.last_seen);
      for (const [productId, sub] of Object.entries(subscriber.subscriptions ?? {})) {
        const value = sub as Record<string, unknown>;
        console.log('revenuecat subscription', productId, {
          store: value.store,
          period_type: value.period_type,
          is_sandbox: value.is_sandbox,
          purchase_date: value.purchase_date,
          original_purchase_date: value.original_purchase_date,
          expires_date: value.expires_date,
          unsubscribe_detected_at: value.unsubscribe_detected_at,
          billing_issues_detected_at: value.billing_issues_detected_at,
          refunded_at: value.refunded_at,
          ownership_type: value.ownership_type,
        });
      }
    } else {
      console.log('revenuecat lookup failed:', response.status);
    }
  } else {
    console.log('revenuecat: no REVENUECAT_SECRET_API_KEY/PROJECT_ID in env files; skipped');
  }

  await posthogTimeline(owner);

  const { data: commits } = await supabase
    .from('onboarding_commits')
    .select('family_id, memory_id, is_new_family, created_at')
    .eq('user_id', owner);
  console.log('onboarding_commits:', commits);

  const { data: families } = await supabase
    .from('families')
    .select('id, deleted_at, created_at, billing_grace_until')
    .eq('owner_id', owner);
  console.log('families:', families);

  for (const family of families ?? []) {
    const { data: memberships } = await supabase
      .from('family_memberships')
      .select('role, created_at')
      .eq('family_id', family.id);
    console.log(`family ${family.id} memberships:`, summarize(memberships, 'role'));

    const { data: members, error: membersError } = await supabase
      .from('family_members')
      .select('illustrated_profile_status, is_user_profile, profile_picture_key, created_at')
      .eq('family_id', family.id);
    console.log(
      `family ${family.id} profiles:`,
      membersError ? `ERROR ${membersError.message}` : (members ?? []).map((member) => ({
        portrait: member.illustrated_profile_status,
        has_photo: Boolean(member.profile_picture_key),
        is_user_profile: member.is_user_profile,
        created_at: member.created_at,
      })),
    );

    const { data: memories, error: memoriesError } = await supabase
      .from('memories')
      .select('id, memory_type, illustration_status, onboarding_attributed, created_at')
      .eq('family_id', family.id)
      .order('created_at', { ascending: true });
    if (memoriesError) {
      console.log('memories: ERROR', memoriesError.message);
      continue;
    }
    console.log(`family ${family.id} memories: ${memories?.length ?? 0}`, summarize(memories, 'memory_type'));
    for (const memory of memories ?? []) {
      console.log(' ', memory.created_at, memory.memory_type, `illustration=${memory.illustration_status}`, memory.onboarding_attributed ? 'onboarding' : '');
    }
  }
}
