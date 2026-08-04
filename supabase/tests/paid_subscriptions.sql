begin;

-- Server-side billing tests. These run against the Supabase local database,
-- where pgTAP supplies the assertion helpers and Auth supplies auth.uid().
select plan(38);

select is(
  has_function_privilege('authenticated', 'public.billing_write_allowed(uuid, uuid)', 'EXECUTE'),
  false,
  'authenticated clients cannot call the arbitrary-actor billing helper'
);
select is(
  has_function_privilege('authenticated', 'public.billing_write_allowed_for_current_user(uuid)', 'EXECUTE'),
  true,
  'authenticated RLS has the current-user billing wrapper'
);
select is(
  (
    select p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'replace_memory_media_assets'
      and pg_get_function_identity_arguments(p.oid) = 'target_memory_id uuid, assets jsonb'
  ),
  true,
  'media finalization runs as a definer so server-managed memory columns stay protected'
);
select is(
  has_column_privilege('authenticated', 'public.memories', 'media_key', 'UPDATE'),
  false,
  'media object keys remain protected from direct client updates'
);
select is(
  has_column_privilege('authenticated', 'public.memories', 'onboarding_attributed', 'INSERT'),
  false,
  'onboarding attribution is not client-insertable'
);
select is(
  has_table_privilege('authenticated', 'public.owner_complimentary_access', 'SELECT'),
  false,
  'complimentary access rows are not client-readable'
);
select is(
  has_table_privilege('authenticated', 'public.owner_complimentary_access', 'INSERT'),
  false,
  'authenticated clients cannot insert complimentary access rows'
);
select is(
  has_table_privilege('authenticated', 'public.owner_complimentary_access', 'UPDATE'),
  false,
  'authenticated clients cannot update complimentary access rows'
);
select is(
  has_table_privilege('authenticated', 'public.owner_complimentary_access', 'DELETE'),
  false,
  'authenticated clients cannot delete complimentary access rows'
);
select is(
  has_function_privilege('authenticated', 'public.owner_has_billing_access(uuid,timestamptz)', 'EXECUTE'),
  false,
  'authenticated clients cannot call the arbitrary-owner billing helper'
);

insert into auth.users (id, email, is_anonymous)
values
  ('d1000000-0000-4000-8000-000000000001', 'billing-owner@example.test', false),
  ('d1000000-0000-4000-8000-000000000002', 'billing-viewer@example.test', false);

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);

-- A second caller-generated id is idempotent and cannot create another family.
select lives_ok($$
  select public.commit_onboarding(
    'd2000000-0000-4000-8000-000000000001',
    'Billing family',
    '["Lila"]'::jsonb,
    '{"text":"First page","hasMedia":false}'::jsonb,
    '[0]'::jsonb,
    current_date
  )
$$, 'first onboarding commit succeeds');
select lives_ok($$
  select public.commit_onboarding(
    'd2000000-0000-4000-8000-000000000002',
    'Attacker-created second family',
    '["Lila"]'::jsonb,
    '{"text":"Second page","hasMedia":false}'::jsonb,
    '[0]'::jsonb,
    current_date
  )
$$, 'a new id returns the original onboarding commit');
select is(
  (select count(*)::integer from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001'),
  1,
  'one owner cannot mint multiple onboarding families'
);
select is(
  (select count(*)::integer from public.onboarding_commits where user_id = 'd1000000-0000-4000-8000-000000000001'),
  1,
  'one owner has one onboarding commit row'
);

select is(
  (select onboarding_attributed from public.memories where user_id = 'd1000000-0000-4000-8000-000000000001'),
  true,
  'the first illustrated memory starts with one onboarding admission'
);

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '30 days', true
);

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002',
  'production', 'app_store', 'momora_monthly_v1', 'momora_plus', 'monthly', 'active',
  null, false
);
select is(
  public.owner_has_billing_access('d1000000-0000-4000-8000-000000000002'),
  false,
  'an active entitlement without an expiry never grants access'
);
delete from public.owner_entitlements
where owner_user_id = 'd1000000-0000-4000-8000-000000000002'
  and product_id = 'momora_monthly_v1';

select is(
  (select allowed from public.billing_ai_generation_check(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001'),
    'd1000000-0000-4000-8000-000000000001', 'memory',
    (select id from public.memories where user_id = 'd1000000-0000-4000-8000-000000000001'),
    'initial'
  )),
  true,
  'the initial illustration admission is allowed for an active owner'
);
select is(
  (select onboarding_attributed from public.memories where user_id = 'd1000000-0000-4000-8000-000000000001'),
  false,
  'the initial illustration admission is consumed atomically'
);

insert into public.family_memberships (family_id, user_id, role)
select f.id, 'd1000000-0000-4000-8000-000000000002', 'viewer'
from public.families f
where f.owner_id = 'd1000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);

select is(
  public.billing_engagement_allowed(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001'),
    'd1000000-0000-4000-8000-000000000002'
  ),
  true,
  'a paid viewer may use engagement writes'
);

select is(
  (select liked from public.set_memory_like(
    (select id from public.memories where user_id = 'd1000000-0000-4000-8000-000000000001'), true
  )),
  true,
  'a paid viewer can like a memory through the security-definer RPC'
);

update public.owner_entitlements
set status = 'expired', expires_at = transaction_timestamp() - interval '1 minute'
where owner_user_id = 'd1000000-0000-4000-8000-000000000001';
update public.families
set billing_grace_until = transaction_timestamp() - interval '1 minute'
where owner_id = 'd1000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select is(
  public.billing_engagement_allowed(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001'),
    'd1000000-0000-4000-8000-000000000002'
  ),
  false,
  'engagement writes stop when the owner entitlement expires'
);

insert into public.families (id, owner_id, name)
values
  ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Second billing family'),
  ('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 'Invited-only billing family');
insert into public.family_memberships (family_id, user_id, role)
values
  ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'owner'),
  ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 'viewer'),
  ('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 'owner'),
  ('d4000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'viewer');

insert into public.owner_complimentary_access (owner_user_id, note)
values ('d1000000-0000-4000-8000-000000000001', 'Grandfathered billing test');
select is(
  public.owner_has_billing_access('d1000000-0000-4000-8000-000000000001'),
  true,
  'a permanent complimentary grant restores owner billing access'
);
select is(
  (public.get_family_billing_status(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001' order by created_at limit 1)
  )->>'access_reason'),
  'complimentary',
  'billing status identifies complimentary access separately from a store plan'
);
select is(
  public.billing_engagement_allowed(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001' order by created_at limit 1),
    'd1000000-0000-4000-8000-000000000002'
  ),
  true,
  'a viewer inherits engagement access from the owner complimentary grant'
);
select is(
  public.billing_write_allowed(
    'd3000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001'
  ),
  true,
  'a complimentary grant covers every family owned by the same owner'
);
select is(
  public.billing_engagement_allowed(
    'd4000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001'
  ),
  false,
  'a complimentary owner grant does not follow an invited member into another family'
);
select is(
  (select allowed from public.billing_ai_generation_check(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001' limit 1),
    'd1000000-0000-4000-8000-000000000001', 'memory',
    (select id from public.memories where user_id = 'd1000000-0000-4000-8000-000000000001'),
    'recovery'
  )),
  true,
  'AI generation admission accepts a complimentary owner grant'
);

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew, management_url
)
values (
  'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_monthly_v1', 'momora_plus', 'monthly', 'active',
  transaction_timestamp() + interval '30 days', true, 'https://example.test/manage'
);
select is(
  (public.get_family_billing_status(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001' limit 1)
  )->>'access_reason'),
  'active',
  'a real paid entitlement remains the reported access source beside a complimentary grant'
);
select is(
  (public.get_family_billing_status(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001' limit 1)
  )->>'period_type'),
  'monthly',
  'paid plan metadata remains visible beside a complimentary grant'
);
select is(
  (public.get_family_billing_status(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001' limit 1)
  )->>'management_url'),
  'https://example.test/manage',
  'paid subscription management remains available beside a complimentary grant'
);
select is(
  (public.get_family_billing_status(
    (select id from public.families where owner_id = 'd1000000-0000-4000-8000-000000000001' limit 1)
  )->>'will_renew'),
  'true',
  'paid renewal metadata remains visible beside a complimentary grant'
);
delete from public.owner_entitlements
where owner_user_id = 'd1000000-0000-4000-8000-000000000001'
  and product_id = 'momora_monthly_v1';
delete from public.owner_complimentary_access
where owner_user_id = 'd1000000-0000-4000-8000-000000000001';
select is(
  public.owner_has_billing_access('d1000000-0000-4000-8000-000000000001'),
  false,
  'deleting a complimentary row revokes access immediately'
);
insert into public.owner_complimentary_access (owner_user_id, expires_at, note)
values (
  'd1000000-0000-4000-8000-000000000001',
  transaction_timestamp() + interval '1 hour',
  'Temporary billing test'
);
select is(
  public.owner_has_billing_access('d1000000-0000-4000-8000-000000000001'),
  true,
  'a future complimentary expiry grants access'
);
update public.owner_complimentary_access
set expires_at = transaction_timestamp() - interval '1 minute'
where owner_user_id = 'd1000000-0000-4000-8000-000000000001';
select is(
  public.owner_has_billing_access('d1000000-0000-4000-8000-000000000001'),
  false,
  'an expired complimentary grant does not grant access'
);
delete from public.owner_complimentary_access
where owner_user_id = 'd1000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.set_memory_like((select id from public.memories limit 1), true)$$,
  'P0001',
  'Subscription required for engagement',
  'the like RPC enforces paid access instead of relying on RLS alone'
);

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values
  ('d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'production', 'play_store', 'momora:annual', 'momora_plus', 'annual', 'trial', transaction_timestamp() + interval '48 hours', true),
  ('d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'production', 'play_store', 'momora:monthly', 'momora_plus', 'monthly', 'trial', transaction_timestamp() + interval '48 hours', true);
select is(
  public.enqueue_billing_trial_reminders(transaction_timestamp()),
  1,
  'only annual trials are scheduled for the two-day reminder'
);
select is(
  (select count(*)::integer from public.billing_trial_reminder_outbox),
  2,
  'the annual trial creates email and push reminder rows'
);

update public.owner_entitlements
set status = 'active'
where product_id = 'momora:annual' and period_type = 'annual' and status = 'trial';
select is(
  (select count(*)::integer from public.billing_trial_reminder_outbox where status = 'failed'),
  2,
  'conversion cancels pending trial reminders'
);

select * from finish();
rollback;
