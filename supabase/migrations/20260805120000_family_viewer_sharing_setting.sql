-- Memory share cards (docs/plans/offline-awareness-and-share-cards.md, S1):
-- owner/manager may turn off sharing for viewers, family-wide. Viewers share
-- by default (true). Enforced server-side (compose-share-card checks this
-- column, not just a hidden client-side affordance).
alter table public.families
  add column viewer_sharing_enabled boolean not null default true;

-- RLS is row-level and already applies uniformly to every column update on
-- this table (owner/manager + billing_write_allowed_for_current_user -- see
-- "Families: update" policy, altered in
-- 20260801170000_paid_subscription_sol_hardening.sql), so no policy change is
-- needed here. But that same hardening migration REVOKED table-level UPDATE
-- on public.families and granted column-level `update (name)` only
-- (lines 226-229) -- a column-level grant does NOT implicitly cover new
-- columns. Without this grant the toggle is un-writable by any authenticated
-- client regardless of RLS.
grant update (viewer_sharing_enabled) on public.families to authenticated;
