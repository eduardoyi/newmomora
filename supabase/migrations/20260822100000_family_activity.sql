-- Family activity feed (docs/plans/family-activity.md).
--
-- A persistent, family-scoped feed of "who did what" -- memory adds, likes,
-- comments, and household membership changes -- surfaced in-app via a bell
-- + bottom sheet on the timeline (client work lands separately, WP-SVC/
-- WP-UI in the same plan). This migration is DB-only (WP-DB, plan §10.1):
-- the events table, its write triggers, the read/unread/mark-seen RPCs, a
-- one-time like-visibility policy flip, a backfill of recent history, and
-- the retention job that keeps the table bounded.
--
-- Design notes (see the plan for full rationale):
--   * Ids only in the table -- never memory/comment text or names. Content
--     is joined at read time by get_family_activity (security definer,
--     scoped to the caller's family), so deleting a memory/comment/invite
--     cascades its event and there is nothing to separately scrub.
--   * RLS is enabled with NO client policies, same posture as
--     family_activity_log (20260711120000_family_sharing.sql, "Aux
--     tables" comment): every read goes through the RPCs below, every
--     write goes through the triggers below.
--   * Likes stop being private-identity for the activity feed only (locked
--     product decision #1 in the plan) -- memory_likes gets a household-
--     read select policy; insert/delete remain self-only.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table public.family_activity_events (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families on delete cascade,
  actor_id      uuid not null references auth.users on delete cascade,
  kind          text not null check (kind in (
                  'memory_added','memory_commented','memory_liked',
                  'member_joined','member_pending')),
  memory_id     uuid references public.memories on delete cascade,
  comment_id    uuid references public.memory_comments on delete cascade,
  like_user_id  uuid,  -- set for memory_liked; with memory_id identifies the like row
  invite_id     uuid references public.family_invites on delete cascade,
  created_at    timestamptz not null default now()
);

create index idx_family_activity_events_family_created
  on public.family_activity_events (family_id, created_at desc, id desc);
create index idx_family_activity_events_actor
  on public.family_activity_events (actor_id);

alter table public.family_activity_events enable row level security;

-- Aux table: RLS enabled with NO policies. Only ever touched by the
-- security-definer triggers/RPCs below (which run as the table owner and
-- bypass RLS) -- direct PostgREST access must stay denied, otherwise a
-- client could read another family's activity or forge events. Belt and
-- braces against a future default-privilege change: neither `anon` nor
-- `authenticated` was ever granted anything on this table (it is not in
-- 20260731110000_grant_authenticated_client_table_access.sql's list), but
-- every other service-only table in this project revokes explicitly too
-- (see 20260808110000_looking_back_packages.sql,
-- 20260809130000_gallery_import_foundation.sql).
revoke all on table public.family_activity_events from anon;
revoke all on table public.family_activity_events from authenticated;

-- ---------------------------------------------------------------------------
-- 2. family_memberships: last-seen marker for the unread dot
-- ---------------------------------------------------------------------------

alter table public.family_memberships
  add column activity_seen_at timestamptz;

-- Only mark_family_activity_seen (security definer, below) should write
-- this column. family_memberships carries a blanket table-level UPDATE
-- grant to `authenticated` (20260731110000_grant_authenticated_client_
-- table_access.sql) that the client only ever exercises for `role`
-- (updateMemberRole, src/services/family.ts) -- left as-is, a manager could
-- write activity_seen_at directly on their own row (it already satisfies
-- the existing update RLS policy), silently faking their own unread state
-- or, since that policy's USING clause isn't scoped to their own row,
-- another non-owner member's. A table-level grant overrides a column-level
-- revoke (see the comment in 20260801170000_paid_subscription_sol_
-- hardening.sql), so the fix is to replace the blanket grant with a
-- column-level one scoped to the only column the client actually writes --
-- same pattern that migration already used for families/memories.
revoke update on public.family_memberships from authenticated;
grant update (role) on public.family_memberships to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Triggers -- write events (all security definer, set search_path)
-- ---------------------------------------------------------------------------

-- memory_added: skip when user_id is null (gallery-import/service-role
-- inserts with no attributed creator never produce a "someone added" row,
-- matching timeline attribution elsewhere).
create or replace function public.activity_memory_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is not null then
    insert into public.family_activity_events (family_id, actor_id, kind, memory_id, created_at)
    values (new.family_id, new.user_id, 'memory_added', new.id, new.created_at);
  end if;
  return new;
end;
$$;

create trigger trg_activity_memory_added
  after insert on public.memories
  for each row execute function public.activity_memory_added();

create or replace function public.activity_memory_commented()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_family_id uuid;
begin
  select family_id into target_family_id from public.memories where id = new.memory_id;
  if target_family_id is not null then
    insert into public.family_activity_events (family_id, actor_id, kind, memory_id, comment_id, created_at)
    values (target_family_id, new.user_id, 'memory_commented', new.memory_id, new.id, new.created_at);
  end if;
  return new;
end;
$$;

create trigger trg_activity_memory_commented
  after insert on public.memory_comments
  for each row execute function public.activity_memory_commented();

create or replace function public.activity_memory_liked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_family_id uuid;
begin
  select family_id into target_family_id from public.memories where id = new.memory_id;
  if target_family_id is not null then
    insert into public.family_activity_events (family_id, actor_id, kind, memory_id, like_user_id, created_at)
    values (target_family_id, new.user_id, 'memory_liked', new.memory_id, new.user_id, new.created_at);
  end if;
  return new;
end;
$$;

create trigger trg_activity_memory_liked
  after insert on public.memory_likes
  for each row execute function public.activity_memory_liked();

-- Un-liking removes the original event outright rather than logging an
-- "unliked" row -- memory_likes has no id of its own, so memory_id +
-- like_user_id is how the matching event is found.
create or replace function public.activity_memory_unliked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.family_activity_events
  where kind = 'memory_liked'
    and memory_id = old.memory_id
    and like_user_id = old.user_id;
  return old;
end;
$$;

create trigger trg_activity_memory_unliked
  after delete on public.memory_likes
  for each row execute function public.activity_memory_unliked();

-- member_joined only when the family already has >=1 OTHER membership --
-- suppresses the founder's own solo-family row (create_family,
-- commit_onboarding) and every other single-row bootstrap insert in
-- 20260729130000_onboarding_anonymous_lockdown.sql /
-- 20260801120000_paid_subscriptions.sql. All of those insert exactly one
-- membership row per statement, so this per-row EXISTS check is safe even
-- for a hypothetical future multi-row insert in the same family.
create or replace function public.activity_member_joined()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.family_memberships
    where family_id = new.family_id and id <> new.id
  ) then
    insert into public.family_activity_events (family_id, actor_id, kind, created_at)
    values (new.family_id, new.user_id, 'member_joined', new.created_at);
  end if;
  return new;
end;
$$;

create trigger trg_activity_member_joined
  after insert on public.family_memberships
  for each row execute function public.activity_member_joined();

-- member_pending tracks a redeemed-but-undecided invite. redeem-family-
-- invite moves status pending -> redeemed (insert the event); resolve-
-- family-invite moves redeemed -> approved/rejected, and a manager can also
-- revoke straight from redeemed (delete the event either way). family_invites
-- rows are always UPDATEd, never deleted, on decision, so FK cascade alone
-- is not enough to clean these up.
create or replace function public.activity_member_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'redeemed' and old.status is distinct from 'redeemed' and new.redeemed_by is not null then
    insert into public.family_activity_events (family_id, actor_id, kind, invite_id, created_at)
    values (new.family_id, new.redeemed_by, 'member_pending', new.id, coalesce(new.redeemed_at, now()));
  elsif old.status = 'redeemed' and new.status <> 'redeemed' then
    delete from public.family_activity_events
    where kind = 'member_pending' and invite_id = new.id;
  end if;
  return new;
end;
$$;

create trigger trg_activity_member_pending
  after update of status on public.family_invites
  for each row execute function public.activity_member_pending();

-- ---------------------------------------------------------------------------
-- 4. Like-policy flip (plan §5.3, locked product decision #1)
-- ---------------------------------------------------------------------------

-- Likes are no longer private-identity: any active member of the memory's
-- family can see who liked it (scope: this select policy only -- no liker
-- list UI ships in this PR). Insert/delete stay self-only, unchanged from
-- 20260713200000_memory_engagement.sql.
drop policy "Memory likes: select own" on public.memory_likes;

create policy "Memory likes: select household" on public.memory_likes for select
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. RPCs (plan §6) -- security definer, revoke public/anon, grant
--    authenticated; each rejects anonymous sessions and non-members inside
--    the body, same pattern as get_family_member_profiles
--    (20260729130000_onboarding_anonymous_lockdown.sql).
-- ---------------------------------------------------------------------------

create or replace function public.get_family_activity(target_family_id uuid)
returns table (
  id uuid,
  kind text,
  created_at timestamptz,
  actor_id uuid,
  actor_name text,
  actor_is_former boolean,
  memory_id uuid,
  memory_creation_source text,
  memory_excerpt text,
  memory_illustration_key text,
  memory_media_key text,
  memory_media_content_type text,
  comment_id uuid,
  comment_snippet text,
  invite_id uuid
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    e.id,
    e.kind,
    e.created_at,
    e.actor_id,
    up.name as actor_name,
    not exists (
      select 1 from public.family_memberships fm
      where fm.family_id = target_family_id and fm.user_id = e.actor_id
    ) as actor_is_former,
    e.memory_id,
    m.creation_source as memory_creation_source,
    left(coalesce(nullif(btrim(m.content), ''), nullif(btrim(m.audio_transcript), '')), 80) as memory_excerpt,
    m.illustration_key as memory_illustration_key,
    m.media_key as memory_media_key,
    m.media_content_type as memory_media_content_type,
    e.comment_id,
    left(c.content, 120) as comment_snippet,
    e.invite_id
  from public.family_activity_events e
  left join public.user_profiles up on up.id = e.actor_id
  left join public.memories m on m.id = e.memory_id
  left join public.memory_comments c on c.id = e.comment_id
  where e.family_id = target_family_id
    and e.actor_id <> auth.uid()
    and (
      e.kind <> 'member_pending'
      or public.has_family_role(target_family_id, array['owner', 'manager'])
    )
    -- Recipients who blocked the actor never see that actor's events --
    -- same rule push delivery already applies, see docs/features/
    -- content-reporting.md ("Activity pushes exclude recipients who
    -- blocked the actor").
    and not exists (
      select 1 from public.blocked_family_accounts b
      where b.family_id = target_family_id
        and b.blocker_user_id = auth.uid()
        and b.blocked_user_id = e.actor_id
    )
  order by e.created_at desc, e.id desc
  limit 100;
end;
$$;

revoke all on function public.get_family_activity(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activity(uuid) to authenticated;

create or replace function public.get_family_activity_unread(target_family_id uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  seen_at timestamptz;
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select fm.activity_seen_at into seen_at
  from public.family_memberships fm
  where fm.family_id = target_family_id and fm.user_id = auth.uid();

  return exists (
    select 1
    from public.family_activity_events e
    where e.family_id = target_family_id
      and e.actor_id <> auth.uid()
      and e.created_at > coalesce(seen_at, '-infinity'::timestamptz)
      and (
        e.kind <> 'member_pending'
        or public.has_family_role(target_family_id, array['owner', 'manager'])
      )
      -- Same block exclusion as get_family_activity above -- a blocked
      -- actor's events must not even flip the unread dot.
      and not exists (
        select 1 from public.blocked_family_accounts b
        where b.family_id = target_family_id
          and b.blocker_user_id = auth.uid()
          and b.blocked_user_id = e.actor_id
      )
  );
end;
$$;

revoke all on function public.get_family_activity_unread(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activity_unread(uuid) to authenticated;

create or replace function public.mark_family_activity_seen(target_family_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update public.family_memberships
  set activity_seen_at = now()
  where family_id = target_family_id and user_id = auth.uid();
end;
$$;

revoke all on function public.mark_family_activity_seen(uuid) from public, anon, authenticated;
grant execute on function public.mark_family_activity_seen(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Backfill -- so no family starts with an empty feed. created_at is
--    preserved from the source row throughout (these are historical
--    events, not "happening now"). Triggers above do not fire for these
--    plain inserts (they only fire on writes to memories/memory_comments/
--    memory_likes/family_memberships/family_invites themselves).
-- ---------------------------------------------------------------------------

-- memory_added: last 90 days only, matching the plan's storage-cap window --
-- older memories would just be pruned again below.
insert into public.family_activity_events (family_id, actor_id, kind, memory_id, created_at)
select m.family_id, m.user_id, 'memory_added', m.id, m.created_at
from public.memories m
where m.user_id is not null
  and m.created_at >= now() - interval '90 days';

-- memory_commented: all history (comments are lightweight; the retention
-- job below still caps the final per-family count).
insert into public.family_activity_events (family_id, actor_id, kind, memory_id, comment_id, created_at)
select m.family_id, c.user_id, 'memory_commented', c.memory_id, c.id, c.created_at
from public.memory_comments c
join public.memories m on m.id = c.memory_id;

-- memory_liked: all history.
insert into public.family_activity_events (family_id, actor_id, kind, memory_id, like_user_id, created_at)
select m.family_id, l.user_id, 'memory_liked', l.memory_id, l.user_id, l.created_at
from public.memory_likes l
join public.memories m on m.id = l.memory_id;

-- member_joined: every membership except the oldest per family (the
-- founder), mirroring the trigger's own suppression rule.
insert into public.family_activity_events (family_id, actor_id, kind, created_at)
select ranked.family_id, ranked.user_id, 'member_joined', ranked.created_at
from (
  select
    fm.family_id,
    fm.user_id,
    fm.created_at,
    row_number() over (partition by fm.family_id order by fm.created_at asc, fm.id asc) as membership_rank
  from public.family_memberships fm
) ranked
where ranked.membership_rank > 1;

-- member_pending: invites currently awaiting approval.
insert into public.family_activity_events (family_id, actor_id, kind, invite_id, created_at)
select fi.family_id, fi.redeemed_by, 'member_pending', fi.id, coalesce(fi.redeemed_at, fi.updated_at, fi.created_at)
from public.family_invites fi
where fi.status = 'redeemed'
  and fi.redeemed_by is not null;

-- ---------------------------------------------------------------------------
-- 7. Retention (plan §5.4) -- per family, keep at most the newest 200 rows
--    AND drop anything older than 90 days, whichever is stricter. 200 > the
--    100-row read cap in get_family_activity so client-side grouping and
--    the hidden-own-events filter still leave a full sheet.
-- ---------------------------------------------------------------------------

create or replace function public.prune_family_activity_events()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  with ranked as (
    select id, created_at,
      row_number() over (partition by family_id order by created_at desc, id desc) as activity_rank
    from public.family_activity_events
  )
  delete from public.family_activity_events e
  using ranked r
  where e.id = r.id
    and (r.activity_rank > 200 or r.created_at < now() - interval '90 days');

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.prune_family_activity_events() from public, anon, authenticated;
grant execute on function public.prune_family_activity_events() to service_role;

-- Apply once now so no family starts over the cap after the backfill above.
select public.prune_family_activity_events();

-- Daily job, pure SQL (no Vault/pg_net needed -- unlike the other cron jobs
-- in this project, prune_family_activity_events takes no HTTP round trip).
-- 04:30 UTC: distinct from invoke-hard-delete-expired-accounts (03:00 UTC,
-- 20260713180000), invoke-cleanup-abandoned-anonymous-users (04:00 UTC,
-- 20260730120000), and run-ai-usage-alerts' documented 06:00 UTC external
-- schedule (docs/features/usage-limits.md); invoke-schedule-daily-reminders
-- (hourly), redrive-content-report-email-alerts (every 5 minutes), and the
-- gallery-import digest/cleanup jobs (every 5 minutes / hourly) already run
-- continuously rather than owning a specific hour.
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'invoke-prune-family-activity';

select cron.schedule(
  'invoke-prune-family-activity',
  '30 4 * * *',
  $$select public.prune_family_activity_events()$$
);
