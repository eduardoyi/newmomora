begin;

-- Memory share cards (docs/plans/offline-awareness-and-share-cards.md, S1):
-- proves families.viewer_sharing_enabled is actually writable end-to-end,
-- through BOTH layers -- 20260801170000_paid_subscription_sol_hardening.sql
-- revoked table-level UPDATE on public.families and granted column-level
-- `update (name)` only, so a migration that only widened RLS coverage would
-- still leave this toggle un-writable without the matching column-level
-- grant added in 20260805120000_family_viewer_sharing_setting.sql.
select plan(6);

select ok(
  has_column_privilege('authenticated', 'public.families', 'viewer_sharing_enabled', 'UPDATE'),
  'authenticated has the column-level grant needed to flip viewer_sharing_enabled'
);

insert into auth.users (id, email, is_anonymous) values
  ('e1000000-0000-4000-8000-000000000001', 'viewer-sharing-owner@example.test', false),
  ('e1000000-0000-4000-8000-000000000002', 'viewer-sharing-manager@example.test', false),
  ('e1000000-0000-4000-8000-000000000003', 'viewer-sharing-viewer@example.test', false);

insert into public.families (id, name, owner_id)
values ('e2000000-0000-4000-8000-000000000001', 'Viewer sharing fixture family', 'e1000000-0000-4000-8000-000000000001');

insert into public.family_memberships (family_id, user_id, role)
values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'owner'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'manager'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'viewer');

-- A brand-new family has billing_grace_until = null (create_family sets it
-- explicitly to null -- there is no grace period baked into creation), so
-- billing_write_allowed_for_current_user only passes with a real active
-- entitlement. Without this, EVERY update below -- not just the intended
-- lockout case -- would silently match zero rows.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '30 days', true
);

select is(
  (select viewer_sharing_enabled from public.families where id = 'e2000000-0000-4000-8000-000000000001'),
  true,
  'viewer_sharing_enabled defaults to true for a new family'
);

-- Owner can flip it off (grant + RLS both satisfied). A plain UPDATE whose
-- USING clause is denied simply matches zero rows (no exception), so each
-- attempt below is a bare statement and the assertion reads back the
-- persisted value as postgres -- same pattern as
-- onboarding_anonymous_lockdown.sql's RLS-denied UPDATE check.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
update public.families set viewer_sharing_enabled = false
where id = 'e2000000-0000-4000-8000-000000000001';

set local role postgres;
select is(
  (select viewer_sharing_enabled from public.families where id = 'e2000000-0000-4000-8000-000000000001'),
  false,
  'owner can flip viewer_sharing_enabled off through the grant + RLS'
);

-- Manager can flip it back on.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
update public.families set viewer_sharing_enabled = true
where id = 'e2000000-0000-4000-8000-000000000001';

set local role postgres;
select is(
  (select viewer_sharing_enabled from public.families where id = 'e2000000-0000-4000-8000-000000000001'),
  true,
  'a manager can flip viewer_sharing_enabled on through the grant + RLS'
);

-- Viewer cannot write it -- RLS's role check (owner/manager only) matches
-- zero rows for the viewer's own UPDATE, so the column stays unchanged.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000003', true);
update public.families set viewer_sharing_enabled = false
where id = 'e2000000-0000-4000-8000-000000000001';

set local role postgres;
select is(
  (select viewer_sharing_enabled from public.families where id = 'e2000000-0000-4000-8000-000000000001'),
  true,
  'a viewer cannot flip viewer_sharing_enabled -- RLS role check blocks the write'
);

-- Billing lockout (S2 requirement): the families UPDATE policy also
-- requires billing_write_allowed_for_current_user -- a lapsed-subscription
-- owner cannot flip this toggle either, the same way family rename is
-- already blocked. The settings row's error handling must expect this.
update public.owner_entitlements
set status = 'expired', expires_at = transaction_timestamp() - interval '1 minute'
where owner_user_id = 'e1000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', true);
update public.families set viewer_sharing_enabled = false
where id = 'e2000000-0000-4000-8000-000000000001';

set local role postgres;
select is(
  (select viewer_sharing_enabled from public.families where id = 'e2000000-0000-4000-8000-000000000001'),
  true,
  'a lapsed-billing owner cannot flip viewer_sharing_enabled -- billing_write_allowed_for_current_user blocks the write'
);

select * from finish();
rollback;
