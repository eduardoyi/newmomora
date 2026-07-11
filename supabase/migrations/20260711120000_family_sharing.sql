-- Family sharing: tenancy schema, RLS rewrite, backfill.
--
-- Introduces `families` / `family_memberships` / `family_invites` (+ two
-- service-role-only auxiliary tables) so multiple users can share one
-- memory journal. Existing `memories.user_id` / `family_members.user_id`
-- are reinterpreted as "creator" attribution (nullable, on delete set
-- null) and gain a `family_id` tenancy column instead. RLS pivots from
-- `auth.uid() = user_id` to helper functions that check family
-- membership/role.

-- ---------------------------------------------------------------------------
-- 1. New tables
-- ---------------------------------------------------------------------------

create table public.families (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  name text not null,
  illustration_style text not null default 'default',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.family_memberships (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('owner', 'manager', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_id, user_id)
);

create table public.family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  code text not null unique,
  role text not null check (role in ('manager', 'viewer')),
  status text not null default 'pending'
    check (status in ('pending', 'redeemed', 'approved', 'rejected', 'revoked')),
  invited_by uuid not null references auth.users on delete cascade,
  redeemed_by uuid references auth.users on delete set null,
  redeemed_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ~1,000 curated words (seed migration). Touched only by
-- `create_family_invite` (security definer) and, later, the
-- redeem-family-invite Edge Function (service role) -- never directly by
-- clients, hence "no policies" below rather than a permissive read policy.
create table public.invite_code_words (
  word text primary key
);

-- Rate-limit log for invite redemption attempts. Service-role /
-- definer-function only. `ip` is nullable best-effort defense in depth
-- (plan §9: per-user AND per-IP limits -- per-user alone is farmable via
-- fresh OTP signups); populated by the redeem-family-invite Edge Function
-- (Phase 5) from the platform-appended hop of x-forwarded-for.
create table public.invite_redemption_attempts (
  user_id uuid not null,
  ip text,
  attempted_at timestamptz not null default now()
);

-- New-memory push debounce log (see docs/plans/family-sharing.md §10).
-- Service-role / definer-function only.
create table public.family_activity_log (
  family_id uuid not null references public.families on delete cascade,
  actor_id uuid not null,
  kind text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Indexes on new tables
-- ---------------------------------------------------------------------------

-- Exactly one 'owner' membership row per family.
create unique index one_owner_per_family on public.family_memberships (family_id) where role = 'owner';

-- Perf: RLS helper functions filter by user_id first (auth.uid()), then
-- family_id -- see §14 risk #1 in the plan.
create index idx_family_memberships_user_id_family_id on public.family_memberships (user_id, family_id);

create index idx_family_invites_family_id on public.family_invites (family_id);
create index idx_family_invites_redeemed_by on public.family_invites (redeemed_by) where redeemed_by is not null;

create index idx_invite_redemption_attempts_user_id on public.invite_redemption_attempts (user_id, attempted_at);
create index idx_invite_redemption_attempts_ip on public.invite_redemption_attempts (ip, attempted_at);

create index idx_family_activity_log_family_actor_kind
  on public.family_activity_log (family_id, actor_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Row Level Security -- enable on all new tables
-- ---------------------------------------------------------------------------

alter table public.families enable row level security;
alter table public.family_memberships enable row level security;
alter table public.family_invites enable row level security;

-- Aux tables: RLS enabled with NO policies. They are only ever touched by
-- security-definer RPCs / service-role Edge Functions (which run as the
-- table owner and bypass RLS), so direct PostgREST access must be denied
-- -- otherwise clients could read other families' activity logs or delete
-- rate-limit rows.
alter table public.invite_code_words enable row level security;
alter table public.invite_redemption_attempts enable row level security;
alter table public.family_activity_log enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Helper functions (security definer, stable) -- membership lookups
--    must not recurse through the RLS they gate.
-- ---------------------------------------------------------------------------

-- `f.deleted_at is null or f.owner_id = auth.uid()` is an owner exemption:
-- without it, `cancel-account-deletion` (which runs on the *user* JWT)
-- would match zero rows when clearing `families.deleted_at`, permanently
-- stranding a soft-deleted family.
create or replace function public.is_family_member(fam uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.family_memberships fm
    join public.families f on f.id = fm.family_id
    where fm.family_id = fam
      and fm.user_id = auth.uid()
      and (f.deleted_at is null or f.owner_id = auth.uid())
  );
$$;

create or replace function public.has_family_role(fam uuid, roles text[])
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.family_memberships fm
    join public.families f on f.id = fm.family_id
    where fm.family_id = fam
      and fm.user_id = auth.uid()
      and fm.role = any(roles)
      and (f.deleted_at is null or f.owner_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS policies -- new tables
-- ---------------------------------------------------------------------------

-- families: no insert policy -- creation is RPC-only (`create_family`,
-- security definer).
create policy "Families: select" on public.families for select
  using (public.is_family_member(id));

create policy "Families: update" on public.families for update
  using (public.has_family_role(id, array['owner', 'manager']))
  with check (public.has_family_role(id, array['owner', 'manager']));

create policy "Families: delete" on public.families for delete
  using (public.has_family_role(id, array['owner']));

-- family_memberships: no insert policy -- RPC-only (`create_family`,
-- invite-approval Edge Function).
create policy "Family memberships: select" on public.family_memberships for select
  using (public.is_family_member(family_id));

-- manager+ may change a non-owner's role, but never promote to/demote an
-- owner (ownership transfer is out of scope for MVP).
create policy "Family memberships: update" on public.family_memberships for update
  using (
    public.has_family_role(family_id, array['owner', 'manager'])
    and role <> 'owner'
  )
  with check (
    public.has_family_role(family_id, array['owner', 'manager'])
    and role <> 'owner'
  );

-- manager+ may remove a non-owner member; any non-owner member may remove
-- themselves (leave).
create policy "Family memberships: delete" on public.family_memberships for delete
  using (
    (public.has_family_role(family_id, array['owner', 'manager']) and role <> 'owner')
    or (user_id = auth.uid() and role <> 'owner')
  );

-- family_invites: no insert policy -- RPC-only (`create_family_invite`).
-- No delete policy -- revoke is an update (`status = 'revoked'`).
create policy "Family invites: select" on public.family_invites for select
  using (public.has_family_role(family_id, array['owner', 'manager']));

create policy "Family invites: update" on public.family_invites for update
  using (public.has_family_role(family_id, array['owner', 'manager']))
  with check (public.has_family_role(family_id, array['owner', 'manager']));

-- ---------------------------------------------------------------------------
-- 6. Triggers on new tables
-- ---------------------------------------------------------------------------

create trigger set_families_updated_at
  before update on public.families
  for each row execute function public.set_updated_at();

create trigger set_family_memberships_updated_at
  before update on public.family_memberships
  for each row execute function public.set_updated_at();

create trigger set_family_invites_updated_at
  before update on public.family_invites
  for each row execute function public.set_updated_at();

-- 50-member cap. Insert-only trigger (memberships are only ever inserted
-- via security-definer RPCs, so this naturally guards `create_family` and
-- the future invite-approval Edge Function alike).
create or replace function public.enforce_family_membership_limit()
returns trigger
language plpgsql
as $$
begin
  if (
    select count(*) from public.family_memberships where family_id = new.family_id
  ) >= 50 then
    raise exception 'Maximum 50 members per family' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger family_memberships_member_limit
  before insert on public.family_memberships
  for each row execute function public.enforce_family_membership_limit();

-- Immutable columns on memories/family_members (trigger attached in §8/§9,
-- once those tables have family_id). Two protections:
--
-- * `family_id`: without this, a manager of two families could
--   `update memories set family_id = B where id = <in A>` and relocate
--   content -- and its stranded tags/media -- across tenants. The
--   `old.family_id is not null` guard is deliberate: it keeps this
--   trigger order-independent relative to the same-migration null->value
--   backfill in §11 (a bare `is distinct from` check would abort that
--   backfill UPDATE if the trigger were attached first).
-- * `user_id` (creator attribution): without this, a manager could
--   reassign or erase "Added by X" attribution on another member's
--   content. The `new.user_id is not null` allowance is required: the
--   FK's `on delete set null` referential action fires UPDATE triggers,
--   so value->null must stay legal (hard-deleted creator).
create or replace function public.enforce_family_content_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if old.family_id is not null and new.family_id is distinct from old.family_id then
    raise exception 'family_id cannot be changed once set' using errcode = 'P0001';
  end if;
  if new.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'user_id (creator attribution) cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Immutable columns on family_memberships: `role` is the only column a
-- manager may legitimately change (see the update policy above). Without
-- this, a manager could `update family_memberships set user_id = <uid>`
-- on an existing viewer row -- adding an arbitrary user to the family and
-- bypassing the invite/approval flow entirely (or reparent a membership
-- across families via family_id).
create or replace function public.enforce_membership_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'membership user_id cannot be changed' using errcode = 'P0001';
  end if;
  if new.family_id is distinct from old.family_id then
    raise exception 'membership family_id cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger family_memberships_immutable_columns
  before update on public.family_memberships
  for each row execute function public.enforce_membership_immutable_columns();

-- Restricted columns on families: the update policy is manager+ (so
-- managers can rename the family / change illustration_style), but
-- * `owner_id` must never change -- a manager rewriting it to themselves
--   would hijack the soft-delete owner exemption, the owned-families cap,
--   and the future "family dies with owner" lifecycle;
-- * `deleted_at` (soft delete/restore) is owner-only -- otherwise a
--   manager could hide the family from every non-owner (vandalism/DoS).
--   `auth.uid() is null` stays legal: service-role Edge Functions (e.g.
--   delete-user-account) and migrations run without a user JWT. The
--   owner's own JWT path matters too -- `cancel-account-deletion` clears
--   deleted_at as the user.
create or replace function public.enforce_families_restricted_columns()
returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed' using errcode = 'P0001';
  end if;
  if new.deleted_at is distinct from old.deleted_at
    and auth.uid() is not null
    and auth.uid() <> old.owner_id
  then
    raise exception 'Only the owner can soft-delete or restore a family' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger families_restricted_columns
  before update on public.families
  for each row execute function public.enforce_families_restricted_columns();

-- ---------------------------------------------------------------------------
-- 7. user_profiles: new columns (added before backfill, which populates
--    active_family_id)
-- ---------------------------------------------------------------------------

alter table public.user_profiles
  add column active_family_id uuid references public.families on delete set null,
  add column notify_new_memories boolean not null default true;

-- ---------------------------------------------------------------------------
-- 8. memories: family_id + user_id reinterpretation
-- ---------------------------------------------------------------------------

alter table public.memories
  add column family_id uuid references public.families on delete cascade;

alter table public.memories
  alter column user_id drop not null;

alter table public.memories
  drop constraint memories_user_id_fkey,
  add constraint memories_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete set null;

create trigger memories_immutable_columns
  before update on public.memories
  for each row execute function public.enforce_family_content_immutable_columns();

-- ---------------------------------------------------------------------------
-- 9. family_members (children roster): same family_id + user_id treatment
-- ---------------------------------------------------------------------------

alter table public.family_members
  add column family_id uuid references public.families on delete cascade;

alter table public.family_members
  alter column user_id drop not null;

alter table public.family_members
  drop constraint family_members_user_id_fkey,
  add constraint family_members_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete set null;

create trigger family_members_immutable_columns
  before update on public.family_members
  for each row execute function public.enforce_family_content_immutable_columns();

-- ---------------------------------------------------------------------------
-- 10. Backfill -- one family per existing user_profiles row
-- ---------------------------------------------------------------------------

-- Session-scoped temp table (deliberately no `on commit drop`: migrations
-- may run as a sequence of auto-committing statements rather than inside
-- one explicit transaction, and a temp table created that way would
-- vanish before the later statements in this section could use it). It is
-- dropped explicitly at the end of this section.
create temporary table _family_sharing_backfill (
  user_id uuid primary key,
  family_id uuid not null default gen_random_uuid()
);

insert into _family_sharing_backfill (user_id)
select id from public.user_profiles;

insert into public.families (id, owner_id, name, illustration_style)
select b.family_id, up.id, up.name || '''s family', up.illustration_style
from _family_sharing_backfill b
join public.user_profiles up on up.id = b.user_id;

insert into public.family_memberships (family_id, user_id, role)
select family_id, user_id, 'owner'
from _family_sharing_backfill;

update public.user_profiles up
set active_family_id = b.family_id
from _family_sharing_backfill b
where b.user_id = up.id;

update public.memories m
set family_id = b.family_id
from _family_sharing_backfill b
where b.user_id = m.user_id;

update public.family_members fm
set family_id = b.family_id
from _family_sharing_backfill b
where b.user_id = fm.user_id;

drop table _family_sharing_backfill;

-- ---------------------------------------------------------------------------
-- 11. Finalize family_id NOT NULL (safe now that every pre-existing row
--     has been backfilled)
-- ---------------------------------------------------------------------------

alter table public.memories
  alter column family_id set not null;

alter table public.family_members
  alter column family_id set not null;

-- ---------------------------------------------------------------------------
-- 12. Drop user_profiles.illustration_style (value now lives on
--     families, copied during backfill above)
-- ---------------------------------------------------------------------------

alter table public.user_profiles
  drop column illustration_style;

-- ---------------------------------------------------------------------------
-- 13. Index swap on memories -- timeline/calendar now filter by
--     family_id, not user_id
-- ---------------------------------------------------------------------------

drop index if exists public.idx_memories_user_id;
drop index if exists public.idx_memories_memory_date;

create index idx_memories_family_id_memory_date on public.memories (family_id, memory_date desc);

-- ---------------------------------------------------------------------------
-- 14. RLS rewrite -- existing tables
-- ---------------------------------------------------------------------------

-- family_members (children roster)
drop policy "Users can CRUD own family members" on public.family_members;

create policy "Family members: select" on public.family_members for select
  using (public.is_family_member(family_id));

create policy "Family members: insert" on public.family_members for insert
  with check (public.has_family_role(family_id, array['owner', 'manager']));

create policy "Family members: update" on public.family_members for update
  using (public.has_family_role(family_id, array['owner', 'manager']))
  with check (public.has_family_role(family_id, array['owner', 'manager']));

create policy "Family members: delete" on public.family_members for delete
  using (public.has_family_role(family_id, array['owner', 'manager']));

-- memories
drop policy "Users can CRUD own memories" on public.memories;

create policy "Memories: select" on public.memories for select
  using (public.is_family_member(family_id));

create policy "Memories: insert" on public.memories for insert
  with check (
    user_id = auth.uid()
    and public.has_family_role(family_id, array['owner', 'manager'])
  );

create policy "Memories: update" on public.memories for update
  using (public.has_family_role(family_id, array['owner', 'manager']))
  with check (public.has_family_role(family_id, array['owner', 'manager']));

create policy "Memories: delete" on public.memories for delete
  using (public.has_family_role(family_id, array['owner', 'manager']));

-- memory_family_members (tags): the with-check on insert additionally
-- requires the tagged child to belong to the *same* family as the memory
-- -- without it, a manager of two families could tag family B's child on
-- a family A memory, and `generate-illustration` would pull that child's
-- portrait into another family's illustration.
drop policy "Users can CRUD own memory tags" on public.memory_family_members;

create policy "Memory tags: select" on public.memory_family_members for select
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

create policy "Memory tags: insert" on public.memory_family_members for insert
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
    )
    and exists (
      select 1
      from public.family_members fm
      join public.memories m on m.id = memory_id
      where fm.id = family_member_id
        and fm.family_id = m.family_id
    )
  );

create policy "Memory tags: delete" on public.memory_family_members for delete
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
    )
  );

-- memory_media: writes flow through `replace_memory_media_assets`
-- (reworked in §16). The RPC runs with invoker rights, so these policies
-- still apply to its statements -- and they also guard direct PostgREST
-- access. Key-shape / ownership validation lives in the RPC, not RLS.
drop policy "Users can view own memory media" on public.memory_media;
drop policy "Users can insert own memory media" on public.memory_media;
drop policy "Users can update own memory media" on public.memory_media;
drop policy "Users can delete own memory media" on public.memory_media;

create policy "Memory media: select" on public.memory_media for select
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

create policy "Memory media: insert" on public.memory_media for insert
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
    )
  );

create policy "Memory media: update" on public.memory_media for update
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
    )
  )
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
    )
  );

create policy "Memory media: delete" on public.memory_media for delete
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
    )
  );

-- user_profiles: unchanged -- still "own row only" (holds
-- `expo_push_token` / notification prefs; cross-member reads go through
-- `get_family_member_profiles` below, not a widened profile policy).

-- ---------------------------------------------------------------------------
-- 15. Definer API functions
-- ---------------------------------------------------------------------------

-- Member names for attribution/member list. Deliberately does NOT widen
-- user_profiles RLS. Covers two populations:
--   1. current members (via family_memberships)
--   2. former members who still show up as creators of the family's
--      memories/family_members rows -- a removed-but-not-deleted user
--      keeps their auth.users row, so the client's "user_id is null"
--      fallback never fires for them; without this branch their
--      attribution would silently resolve to nothing.
create or replace function public.get_family_member_profiles(fam uuid)
returns table (
  user_id uuid,
  name text,
  role text,
  is_active_member boolean,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_family_member(fam) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    up.id as user_id,
    up.name,
    fm.role,
    true as is_active_member,
    fm.created_at
  from public.family_memberships fm
  join public.user_profiles up on up.id = fm.user_id
  where fm.family_id = fam

  union

  select
    up.id as user_id,
    up.name,
    null::text as role,
    false as is_active_member,
    min(src.created_at) as created_at
  from (
    select m.user_id, m.created_at from public.memories m
    where m.family_id = fam and m.user_id is not null
    union all
    select fam_m.user_id, fam_m.created_at from public.family_members fam_m
    where fam_m.family_id = fam and fam_m.user_id is not null
  ) src
  join public.user_profiles up on up.id = src.user_id
  where src.user_id not in (
    select fm2.user_id from public.family_memberships fm2 where fm2.family_id = fam
  )
  group by up.id, up.name;
end;
$$;

-- Name + email of an invite's redeemer, for the pending-approvals screen.
-- The manager+ guard is bound to *this invite's* family (resolved
-- internally) rather than "manager anywhere" -- otherwise a Family A
-- manager could probe Family B invite ids for names + emails.
create or replace function public.get_invite_redeemer(invite_id uuid)
returns table (
  name text,
  email text
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  invite_family_id uuid;
  invite_redeemed_by uuid;
begin
  select fi.family_id, fi.redeemed_by
  into invite_family_id, invite_redeemed_by
  from public.family_invites fi
  where fi.id = invite_id;

  if invite_family_id is null then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;

  if not public.has_family_role(invite_family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if invite_redeemed_by is null then
    return;
  end if;

  return query
  select up.name, au.email::text
  from public.user_profiles up
  join auth.users au on au.id = up.id
  where up.id = invite_redeemed_by;
end;
$$;

-- Status of the caller's own most recent redeemed invite, for the
-- post-redeem waiting screen. Scoped implicitly by `redeemed_by =
-- auth.uid()`, so no membership check is needed (the caller isn't a
-- member of the target family yet). Surfaces `family_unavailable` when
-- the family was soft-deleted while the redemption was pending.
create or replace function public.get_my_redeemed_invite_status()
returns table (
  invite_id uuid,
  status text,
  family_name text,
  family_unavailable boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select
    fi.id as invite_id,
    fi.status,
    f.name as family_name,
    (f.deleted_at is not null) as family_unavailable
  from public.family_invites fi
  join public.families f on f.id = fi.family_id
  where fi.redeemed_by = auth.uid()
  order by fi.redeemed_at desc nulls last
  limit 1;
$$;

-- Creates a family + the caller's owner membership; sets the caller's
-- active_family_id if they didn't already have one. Capped at 5 owned
-- families per user -- there's no legitimate MVP case for more, and an
-- uncapped RPC is an easy abuse/retry-loop target.
create or replace function public.create_family(name text)
returns public.families
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  owned_count integer;
  new_family public.families;
begin
  if current_user_id is null then
    raise exception 'Unauthorized' using errcode = '28000';
  end if;

  if name is null or trim(name) = '' then
    raise exception 'Family name is required' using errcode = '22023';
  end if;

  select count(*) into owned_count
  from public.families
  where owner_id = current_user_id;

  if owned_count >= 5 then
    raise exception 'Maximum 5 owned families' using errcode = 'P0001';
  end if;

  insert into public.families (owner_id, name)
  values (current_user_id, trim(name))
  returning * into new_family;

  insert into public.family_memberships (family_id, user_id, role)
  values (new_family.id, current_user_id, 'owner');

  update public.user_profiles
  set active_family_id = new_family.id
  where id = current_user_id
    and active_family_id is null;

  return new_family;
end;
$$;

-- Generates a 3-random-word invite code, retrying on the (rare) unique
-- collision. Requires manager+ in the target family.
create or replace function public.create_family_invite(fam uuid, invite_role text)
returns public.family_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  new_code text;
  new_invite public.family_invites;
  attempt integer := 0;
begin
  if current_user_id is null then
    raise exception 'Unauthorized' using errcode = '28000';
  end if;

  if invite_role not in ('manager', 'viewer') then
    raise exception 'Invalid invite role' using errcode = '22023';
  end if;

  if not public.has_family_role(fam, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  loop
    attempt := attempt + 1;

    select string_agg(word, '-') into new_code
    from (
      select word from public.invite_code_words
      order by random()
      limit 3
    ) picked;

    begin
      insert into public.family_invites (family_id, code, role, invited_by)
      values (fam, new_code, invite_role, current_user_id)
      returning * into new_invite;

      return new_invite;
    exception when unique_violation then
      if attempt >= 10 then
        raise exception 'Could not generate a unique invite code' using errcode = 'P0001';
      end if;
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Rework replace_memory_media_assets for family tenancy
-- ---------------------------------------------------------------------------

create or replace function public.replace_memory_media_assets(
  target_memory_id uuid,
  assets jsonb
)
returns void
language plpgsql
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_family_id uuid;
  asset_count integer;
  asset jsonb;
  asset_index integer;
  asset_key text;
  asset_content_type text;
  asset_duration_ms integer;
  caller_prefix text;
  first_key text;
  first_content_type text;
  existing_keys text[];
begin
  if current_user_id is null then
    raise exception 'Unauthorized' using errcode = '28000';
  end if;

  if jsonb_typeof(assets) <> 'array' then
    raise exception 'assets must be an array' using errcode = '22023';
  end if;

  asset_count := jsonb_array_length(assets);

  if asset_count < 1 or asset_count > 10 then
    raise exception 'Media memories require 1 to 10 assets' using errcode = '22023';
  end if;

  select m.family_id into target_family_id
  from public.memories m
  where m.id = target_memory_id
    and m.memory_type = 'media';

  if target_family_id is null then
    raise exception 'Memory not found' using errcode = 'P0002';
  end if;

  -- family-role auth instead of `user_id = auth.uid()`: a manager must be
  -- able to replace assets on a memory created by another member.
  if not public.has_family_role(target_family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  caller_prefix := current_user_id::text || '/memories/' || target_memory_id::text;

  -- Snapshot existing keys BEFORE the delete below -- the "key already
  -- belongs to this memory" check must run against this snapshot, not a
  -- mid-transaction re-query of memory_media (which would find nothing
  -- and silently collapse back to the caller-prefix-only rule).
  select coalesce(array_agg(object_key), '{}')
  into existing_keys
  from public.memory_media
  where memory_id = target_memory_id;

  delete from public.memory_media
  where memory_id = target_memory_id;

  for asset, asset_index in
    select value, ordinality - 1
    from jsonb_array_elements(assets) with ordinality
  loop
    asset_key := asset->>'objectKey';
    asset_content_type := asset->>'contentType';
    asset_duration_ms := nullif(asset->>'durationMs', '')::integer;

    if asset_key is null or asset_content_type is null then
      raise exception 'Each media asset requires objectKey and contentType' using errcode = '22023';
    end if;

    if asset_content_type not in (
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/heif',
      'image/webp',
      'video/mp4',
      'video/quicktime'
    ) then
      raise exception 'Unsupported media content type' using errcode = '22023';
    end if;

    -- Allowed keys: one already belonging to this memory (kept from
    -- before the delete above -- e.g. a manager editing another member's
    -- memory keeps that member's assets), OR a fresh key under the
    -- caller's own prefix.
    if not (
      asset_key = any(existing_keys)
      or asset_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
      or asset_key ~ ('^' || caller_prefix || '/media[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
    ) then
      raise exception 'Invalid media object key' using errcode = '22023';
    end if;

    insert into public.memory_media (
      memory_id,
      object_key,
      content_type,
      duration_ms,
      position
    ) values (
      target_memory_id,
      asset_key,
      asset_content_type,
      asset_duration_ms,
      asset_index
    );

    if asset_index = 0 then
      first_key := asset_key;
      first_content_type := asset_content_type;
    end if;
  end loop;

  -- No `user_id = current_user_id` predicate here (unlike the original):
  -- when a manager edits another member's memory, that predicate matched
  -- zero rows and silently left the cover fields stale.
  update public.memories
  set
    media_key = first_key,
    media_content_type = first_content_type,
    updated_at = now()
  where id = target_memory_id;
end;
$$;
