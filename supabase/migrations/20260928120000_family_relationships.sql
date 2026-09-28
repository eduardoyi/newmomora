-- Family relationships (docs/plans/family-relationships.md, Step 1).
--
-- Every person in a family's list can carry who they are to the kids
-- (`relationship` + a family side), every account can say "this is me"
-- (`family_memberships.family_member_id`), and an AI job proposes both as
-- pending suggestions that only an owner/manager accepting them ever writes.
--
-- Sections:
--   1. family_members: relationship / family_side / side_member_id + triggers
--   2. family_memberships: family_member_id / not_in_list
--   3. RPCs: set_my_family_member, unlink_family_member_account
--   4. family_member_suggestions table + service-role insert function
--   5. resolve_family_member_suggestions
--   6. families.relationship_suggested_at + claim/backoff + signals (service role)
--   7. commit_onboarding: onboarding kids are 'child'
--   8. ai_usage_events: 'relationship_chat' operation
--
-- Every security-definer function below re-checks what RLS would have
-- checked: definers bypass RLS (and therefore the anonymous lockdown,
-- 20260729130000_onboarding_anonymous_lockdown.sql, and the billing gate on
-- "Family members: update", 20260801120000_paid_subscriptions.sql).

-- ---------------------------------------------------------------------------
-- 1. family_members
-- ---------------------------------------------------------------------------

alter table public.family_members
  add column relationship text,
  add column family_side text,
  add column side_member_id uuid;

alter table public.family_members
  add constraint family_members_relationship_check
    check (relationship is null or relationship in (
      'child', 'parent', 'grandparent', 'great_grandparent', 'aunt_uncle',
      'cousin', 'family_friend', 'caregiver', 'pet', 'other'
    )),
  add constraint family_members_family_side_check
    check (family_side is null or family_side in ('maternal', 'paternal', 'both')),
  -- (side_member_id, family_id) -> (id, family_id): the side parent must be in
  -- the same family. PG15+ column list so deleting the parent nulls only
  -- side_member_id (family_id is NOT NULL and must survive).
  add constraint family_members_side_member_fkey
    foreign key (side_member_id, family_id)
    references public.family_members (id, family_id)
    on delete set null (side_member_id),
  add constraint family_members_side_member_not_self_check
    check (side_member_id is null or side_member_id <> id),
  add constraint family_members_one_side_check
    check (not (family_side is not null and side_member_id is not null)),
  add constraint family_members_side_requires_side_role_check
    check (
      (family_side is null and side_member_id is null)
      -- coalesce: an unsorted (null) role must not slip through as NULL = pass
      or coalesce(relationship in ('grandparent', 'great_grandparent', 'aunt_uncle', 'cousin'), false)
    );

comment on column public.family_members.relationship is
  'Who this person is to the kids: child | parent | grandparent | great_grandparent | aunt_uncle | cousin | family_friend | caregiver | pet | other. NULL = not sorted yet (own-child rule falls back to the DOB < 13 rule). See docs/features/family-relationships.md.';
comment on column public.family_members.family_side is
  'maternal | paternal | both, for side roles (grandparent, great_grandparent, aunt_uncle, cousin) when no parent member is marked. Mutually exclusive with side_member_id.';
comment on column public.family_members.side_member_id is
  'The parent member whose side this person is on ("Eduardo''s side"). Must reference a member with relationship = parent in the same family. Mutually exclusive with family_side.';
comment on column public.family_members.is_user_profile is
  'DEPRECATED: superseded by family_memberships.family_member_id ("this is me"). Only demo seed scripts still set it; readers keep it as a fallback.';

-- BEFORE INSERT/UPDATE: keep side fields consistent so no writer (client,
-- definer RPC, seed script) can trip the side-role check by changing the role,
-- and make sure the side member really is a parent.
create or replace function public.family_members_normalize_relationship()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.relationship is null
     or new.relationship not in ('grandparent', 'great_grandparent', 'aunt_uncle', 'cousin') then
    new.family_side := null;
    new.side_member_id := null;
  end if;

  if new.side_member_id is not null
     and (tg_op = 'INSERT' or new.side_member_id is distinct from old.side_member_id) then
    if not exists (
      select 1
      from public.family_members p
      where p.id = new.side_member_id
        and p.family_id = new.family_id
        and p.relationship = 'parent'
    ) then
      raise exception 'side_member_must_be_parent'
        using errcode = '23514',
              hint = 'side_member_id must reference a member of the same family with relationship = parent';
    end if;
  end if;

  return new;
end;
$$;

create trigger family_members_normalize_relationship
  before insert or update on public.family_members
  for each row execute function public.family_members_normalize_relationship();

-- family_member_suggestions is created in section 4; the AFTER trigger that
-- dismisses stale suggestions is attached there, once the table exists.

-- ---------------------------------------------------------------------------
-- 2. family_memberships: "this is me" link
-- ---------------------------------------------------------------------------

alter table public.family_memberships
  add column family_member_id uuid,
  add column not_in_list boolean not null default false;

alter table public.family_memberships
  add constraint family_memberships_family_member_fkey
    foreign key (family_member_id, family_id)
    references public.family_members (id, family_id)
    on delete set null (family_member_id),
  add constraint family_memberships_not_in_list_no_link_check
    check (not (not_in_list and family_member_id is not null));

-- One account per person: a member can be claimed by at most one account.
create unique index family_memberships_family_member_id_key
  on public.family_memberships (family_member_id)
  where family_member_id is not null;

comment on column public.family_memberships.family_member_id is
  '"This is me": the family_members row this account is. Written only by set_my_family_member / unlink_family_member_account (definer RPCs) and the relationship trigger. The client column grant stays update (role) only.';
comment on column public.family_memberships.not_in_list is
  'The account said "I''m not in the list" -- suppresses the Who''s who prompt. Reset whenever the account links or unlinks.';

-- ---------------------------------------------------------------------------
-- 3. RPCs: set_my_family_member / unlink_family_member_account
-- ---------------------------------------------------------------------------

create or replace function public.set_my_family_member(
  p_family_id uuid,
  p_member_id uuid,
  p_not_in_list boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_relationship text;
  v_dob date;
  v_not_in_list boolean := coalesce(p_not_in_list, false);
begin
  -- Definers bypass the RLS-only anonymous lockdown (same guard as
  -- mark_family_activity_seen).
  if v_uid is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(p_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_not_in_list and p_member_id is not null then
    raise exception 'not_in_list_with_member'
      using errcode = '22023',
            hint = 'not_in_list cannot be combined with a member id';
  end if;

  if p_member_id is not null then
    select m.relationship, m.date_of_birth
    into v_relationship, v_dob
    from public.family_members m
    where m.id = p_member_id and m.family_id = p_family_id;

    if not found then
      raise exception 'member_not_in_family'
        using errcode = '22023',
              hint = 'member_not_in_family';
    end if;

    -- Kids and pets can't be an account: explicit role, or (unsorted) under 13.
    if v_relationship in ('child', 'pet')
       or (
         v_relationship is null
         and v_dob is not null
         and date_part('year', age(current_date, v_dob)) < 13
       ) then
      raise exception 'member_not_linkable'
        using errcode = '22023',
              hint = 'member_not_linkable';
    end if;
  end if;

  begin
    -- Own row only. Link, unlink (null member) or "not in the list" all reset
    -- the previous state; not_in_list is true only for the explicit case.
    update public.family_memberships
    set family_member_id = p_member_id,
        not_in_list = v_not_in_list
    where family_id = p_family_id and user_id = v_uid;
  exception when unique_violation then
    raise exception 'member_already_linked'
      using errcode = '23505',
            hint = 'member_already_linked';
  end;
end;
$$;

revoke all on function public.set_my_family_member(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_my_family_member(uuid, uuid, boolean) to authenticated;

comment on function public.set_my_family_member(uuid, uuid, boolean) is
  'Caller links (or unlinks, p_member_id null) their own membership to a family member, or flags "not in the list". Not billing-gated: account metadata, like leaving a family. Errors: 42501 not authorized; 22023 not_in_list_with_member / member_not_in_family / member_not_linkable; 23505 member_already_linked.';

-- Recovery path for "someone else already picked this person" and for a
-- wrong claim: an owner/manager can clear whichever account points at a member.
create or replace function public.unlink_family_member_account(
  p_family_id uuid,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.has_family_role(p_family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update public.family_memberships
  set family_member_id = null
  where family_id = p_family_id and family_member_id = p_member_id;
end;
$$;

revoke all on function public.unlink_family_member_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.unlink_family_member_account(uuid, uuid) to authenticated;

comment on function public.unlink_family_member_account(uuid, uuid) is
  'Owner/manager clears the account link of a family member (recovery for wrong or contested "this is me" claims). Not billing-gated: account metadata.';

-- ---------------------------------------------------------------------------
-- 4. family_member_suggestions
-- ---------------------------------------------------------------------------

create table public.family_member_suggestions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  family_member_id uuid not null,
  field text not null check (field in ('relationship', 'family_side', 'nickname')),
  -- relationship: a role value; family_side: maternal|paternal|both, or the
  -- sentinel 'member' when side_member_id is set; nickname: the nickname.
  value text not null check (char_length(value) between 1 and 100),
  side_member_id uuid,
  -- The field's value when the suggestion was made, for compare-and-set on
  -- accept (a manual edit wins). relationship: the role (null = unsorted);
  -- family_side: the current side encoded as 'maternal' | 'paternal' | 'both'
  -- | 'member:<parent uuid>' (null = no side); nickname: null.
  based_on text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  constraint family_member_suggestions_member_fkey
    foreign key (family_member_id, family_id)
    references public.family_members (id, family_id) on delete cascade,
  constraint family_member_suggestions_side_member_fkey
    foreign key (side_member_id, family_id)
    references public.family_members (id, family_id) on delete cascade,
  constraint family_member_suggestions_relationship_value_check
    check (field <> 'relationship' or value in (
      'child', 'parent', 'grandparent', 'great_grandparent', 'aunt_uncle',
      'cousin', 'family_friend', 'caregiver', 'pet', 'other'
    )),
  constraint family_member_suggestions_side_value_check
    check (field <> 'family_side' or value in ('maternal', 'paternal', 'both', 'member')),
  -- side_member_id is set exactly for the 'member' side sentinel.
  constraint family_member_suggestions_side_member_shape_check
    check ((field = 'family_side' and value = 'member') = (side_member_id is not null)),
  constraint family_member_suggestions_decided_check
    check ((status = 'pending') = (decided_at is null))
);

-- Dismissed values (any casing) are never re-proposed; inserts go through
-- insert_family_member_suggestions (on conflict do nothing) because PostgREST
-- upsert can't target an expression index.
create unique index family_member_suggestions_dedupe_key
  on public.family_member_suggestions (
    family_member_id,
    field,
    lower(value),
    coalesce(side_member_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index idx_family_member_suggestions_pending
  on public.family_member_suggestions (family_id, created_at desc)
  where status = 'pending';

alter table public.family_member_suggestions enable row level security;

-- Hosted default privileges grant ALL on new public tables to anon and
-- authenticated: revoke first, then grant only what the client needs.
revoke all on table public.family_member_suggestions from anon;
revoke all on table public.family_member_suggestions from authenticated;
grant select on table public.family_member_suggestions to authenticated;

create policy "Family member suggestions: select" on public.family_member_suggestions
  for select
  using (public.has_family_role(family_id, array['owner', 'manager']));

create policy "Family member suggestions: deny anonymous" on public.family_member_suggestions
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

comment on table public.family_member_suggestions is
  'AI-proposed relationship / family side / nickname values for family members. Pending until an owner/manager accepts or dismisses them via resolve_family_member_suggestions; the AI never writes family_members. Written only by insert_family_member_suggestions (service role) and the RPC/trigger that decide them.';

-- AFTER UPDATE OF relationship: an account can't be a kid or a pet, and
-- suggestions made for the old value are stale.
create or replace function public.family_members_relationship_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.relationship in ('child', 'pet') then
    update public.family_memberships
    set family_member_id = null
    where family_member_id = new.id and family_id = new.family_id;
  end if;

  update public.family_member_suggestions s
  set status = 'dismissed', decided_at = now(), decided_by = auth.uid()
  where s.family_member_id = new.id
    and s.family_id = new.family_id
    and s.status = 'pending'
    and (
      s.field = 'relationship'
      or (
        s.field = 'family_side'
        and (
          new.relationship is null
          or new.relationship not in ('grandparent', 'great_grandparent', 'aunt_uncle', 'cousin')
        )
      )
    );

  return null;
end;
$$;

revoke all on function public.family_members_relationship_changed() from public, anon, authenticated;

create trigger family_members_relationship_changed
  after update of relationship on public.family_members
  for each row
  when (old.relationship is distinct from new.relationship)
  execute function public.family_members_relationship_changed();

-- Service-role-only batch insert. p_rows is a jsonb array of
-- {family_member_id, field, value, side_member_id?, based_on?}. Rows naming a
-- member (or side member) outside p_family_id are dropped; duplicates of an
-- existing suggestion (any status, value compared case-insensitively) are
-- ignored. Returns the number of rows inserted.
create or replace function public.insert_family_member_suggestions(
  p_family_id uuid,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a json array' using errcode = '22023';
  end if;

  with input as (
    select
      (r.value ->> 'family_member_id')::uuid as family_member_id,
      r.value ->> 'field' as field,
      r.value ->> 'value' as value,
      nullif(r.value ->> 'side_member_id', '')::uuid as side_member_id,
      nullif(r.value ->> 'based_on', '') as based_on
    from jsonb_array_elements(p_rows) as r(value)
  ),
  ins as (
    insert into public.family_member_suggestions (
      family_id, family_member_id, field, value, side_member_id, based_on
    )
    select p_family_id, i.family_member_id, i.field, i.value, i.side_member_id, i.based_on
    from input i
    where exists (
      select 1 from public.family_members m
      where m.id = i.family_member_id and m.family_id = p_family_id
    )
    and (
      i.side_member_id is null
      or exists (
        select 1 from public.family_members sm
        where sm.id = i.side_member_id and sm.family_id = p_family_id
      )
    )
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from ins;

  return v_inserted;
end;
$$;

revoke all on function public.insert_family_member_suggestions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.insert_family_member_suggestions(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. resolve_family_member_suggestions
-- ---------------------------------------------------------------------------

-- Accepts and/or dismisses pending suggestions in one transaction. The only
-- path by which AI output ever reaches family_members. Because it runs as the
-- definer, it re-checks everything the "Family members: update" policy would:
-- not anonymous, owner/manager of THIS family, and the same billing predicate.
-- Non-pending or other-family ids are ignored; an id in both arrays is
-- dismissed. Relationship/side rows are compare-and-set on based_on (a manual
-- edit wins -> row dismissed); side rows for a member whose role isn't a side
-- role, or whose side parent is no longer a parent, are dismissed; nickname
-- rows that collide with another member's name/nickname (or the member's own
-- name) are dismissed, and already-present nicknames are accepted as no-ops.
-- Returns {"accepted": n, "dismissed": n} for the rows this call decided.
create or replace function public.resolve_family_member_suggestions(
  p_family_id uuid,
  p_accept uuid[],
  p_dismiss uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_accept uuid[];
  v_dismiss uuid[] := coalesce(p_dismiss, '{}'::uuid[]);
  v_row record;
  v_s public.family_member_suggestions;
  v_m public.family_members;
  v_current_side text;
  v_nick text;
  v_accepted integer := 0;
  v_dismissed integer := 0;
  v_ok boolean;
begin
  if v_uid is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.has_family_role(p_family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Same billing predicate as the "Family members: update" policy.
  if not public.billing_write_allowed_for_current_user(p_family_id) then
    raise exception 'Subscription required' using errcode = '42501';
  end if;

  v_accept := array(
    select a from unnest(coalesce(p_accept, '{}'::uuid[])) as a
    where not (a = any (v_dismiss))
  );

  with d as (
    update public.family_member_suggestions
    set status = 'dismissed', decided_at = now(), decided_by = v_uid
    where family_id = p_family_id
      and status = 'pending'
      and id = any (v_dismiss)
    returning 1
  )
  select v_dismissed + count(*)::integer into v_dismissed from d;

  -- Relationship first, then side, then nicknames: a role accepted in this
  -- call must be in place before its side row is judged.
  for v_row in
    select s.id
    from public.family_member_suggestions s
    where s.family_id = p_family_id
      and s.status = 'pending'
      and s.id = any (v_accept)
    order by
      case s.field when 'relationship' then 0 when 'family_side' then 1 else 2 end,
      s.created_at, s.id
  loop
    -- Re-read under lock: an earlier row in this loop may have decided it
    -- (e.g. the relationship trigger dismissing a second role suggestion).
    select * into v_s
    from public.family_member_suggestions s
    where s.id = v_row.id and s.status = 'pending'
    for update;
    if not found then
      continue;
    end if;

    select * into v_m
    from public.family_members m
    where m.id = v_s.family_member_id and m.family_id = p_family_id
    for update;
    if not found then
      continue;
    end if;

    v_ok := false;

    if v_s.field = 'relationship' then
      if v_s.based_on is not distinct from v_m.relationship then
        update public.family_members
        set relationship = v_s.value
        where id = v_m.id;
        v_ok := true;
      end if;

    elsif v_s.field = 'family_side' then
      v_current_side := coalesce(
        v_m.family_side,
        case when v_m.side_member_id is not null then 'member:' || v_m.side_member_id::text end
      );
      if v_m.relationship in ('grandparent', 'great_grandparent', 'aunt_uncle', 'cousin')
         and v_s.based_on is not distinct from v_current_side then
        if v_s.value = 'member' then
          if exists (
            select 1 from public.family_members p
            where p.id = v_s.side_member_id
              and p.family_id = p_family_id
              and p.relationship = 'parent'
          ) then
            update public.family_members
            set side_member_id = v_s.side_member_id, family_side = null
            where id = v_m.id;
            v_ok := true;
          end if;
        else
          update public.family_members
          set family_side = v_s.value, side_member_id = null
          where id = v_m.id;
          v_ok := true;
        end if;
      end if;

    else -- nickname
      v_nick := btrim(v_s.value);
      if v_nick <> '' then
        if exists (
          select 1 from unnest(coalesce(v_m.nicknames, '{}'::text[])) as n
          where lower(btrim(n)) = lower(v_nick)
        ) then
          -- Already there: nothing to append, but the suggestion is satisfied.
          v_ok := true;
        elsif lower(btrim(v_m.name)) <> lower(v_nick)
          and not exists (
            select 1
            from public.family_members o
            where o.family_id = p_family_id
              and o.id <> v_m.id
              and (
                lower(btrim(o.name)) = lower(v_nick)
                or exists (
                  select 1 from unnest(coalesce(o.nicknames, '{}'::text[])) as n
                  where lower(btrim(n)) = lower(v_nick)
                )
              )
          ) then
          update public.family_members
          set nicknames = array_append(coalesce(nicknames, '{}'::text[]), v_nick)
          where id = v_m.id;
          v_ok := true;
        end if;
      end if;
    end if;

    update public.family_member_suggestions
    set status = case when v_ok then 'accepted' else 'dismissed' end,
        decided_at = now(),
        decided_by = v_uid
    where id = v_s.id;

    if v_ok then
      v_accepted := v_accepted + 1;
    else
      v_dismissed := v_dismissed + 1;
    end if;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'dismissed', v_dismissed);
end;
$$;

revoke all on function public.resolve_family_member_suggestions(uuid, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.resolve_family_member_suggestions(uuid, uuid[], uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Throttle (families.relationship_suggested_at) + signals -- service role
-- ---------------------------------------------------------------------------

alter table public.families
  add column relationship_suggested_at timestamptz;

comment on column public.families.relationship_suggested_at is
  'Throttle for the suggest-family-relationships job. Written only by claim_relationship_suggestion_run / fail_relationship_suggestion_run (service role); clients have no column-level UPDATE on it.';

-- Atomically decides whether this call may run the model: the family row is
-- locked, the old value read, and the marker bumped to now() only when it is
-- null, older than 24h, or older than 1h AND a family member was created
-- after it (memories don't bypass the window: memory_family_members has no
-- timestamp). Returns whether the run was claimed and the previous value.
create or replace function public.claim_relationship_suggestion_run(p_family_id uuid)
returns table (claimed boolean, previous_suggested_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev timestamptz;
begin
  select f.relationship_suggested_at
  into v_prev
  from public.families f
  where f.id = p_family_id and f.deleted_at is null
  for update;

  if not found then
    return query select false, null::timestamptz;
    return;
  end if;

  if v_prev is null
     or v_prev < now() - interval '24 hours'
     or (
       v_prev < now() - interval '1 hour'
       and exists (
         select 1 from public.family_members m
         where m.family_id = p_family_id and m.created_at > v_prev
       )
     ) then
    update public.families
    set relationship_suggested_at = now()
    where id = p_family_id;
    return query select true, v_prev;
  else
    return query select false, v_prev;
  end if;
end;
$$;

revoke all on function public.claim_relationship_suggestion_run(uuid) from public, anon, authenticated;
grant execute on function public.claim_relationship_suggestion_run(uuid) to service_role;

-- Failure backoff: after an OpenAI/validation failure retry in ~1h, never
-- restore the previous value (a persistent failure must not loop on every
-- tab focus).
create or replace function public.fail_relationship_suggestion_run(p_family_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.families
  set relationship_suggested_at = now() - interval '23 hours'
  where id = p_family_id and deleted_at is null;
$$;

revoke all on function public.fail_relationship_suggestion_run(uuid) from public, anon, authenticated;
grant execute on function public.fail_relationship_suggestion_run(uuid) to service_role;

-- Everything the suggestion prompt needs, aggregated in SQL (PostgREST caps
-- reads at 1000 rows). Returned shape:
--   members:  [{id, first_name, nicknames, age_years, gender, relationship,
--               family_side, side_member_id, is_own_child}]
--   accounts: [{family_member_id, display_name, role}]      (linked accounts)
--   co_tags:  [{member_id, child_id, memories}]             (memories where the
--               member and an own-child member are both tagged; own-child rule
--               of plan section 3: explicit role wins, null -> DOB age < 13)
--   snippets: [{text, memory_date, author_member_id, member_ids}] (<= 40, text
--               <= 200 chars, <= 6 per member, newest first) from memories in
--               the newest 400 visible ones where a member is tagged or named
-- Memories hidden by an unresolved (or upheld) content report are excluded,
-- like the Year Film's `reported` exclusion. Text = content, else the audio
-- transcript, else the AI description (memories has no deleted_at: deletes
-- are hard).
create or replace function public.family_relationship_signals(p_family_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  with members as (
    select
      m.id,
      m.created_at,
      split_part(btrim(m.name), ' ', 1) as first_name,
      coalesce(m.nicknames, '{}'::text[]) as nicknames,
      case
        when m.date_of_birth is null then null
        else greatest(0, date_part('year', age(current_date, m.date_of_birth))::integer)
      end as age_years,
      m.gender,
      m.relationship,
      m.family_side,
      m.side_member_id,
      case
        when m.relationship = 'child' then true
        when m.relationship is not null then false
        else m.date_of_birth is not null
          and date_part('year', age(current_date, m.date_of_birth)) < 13
      end as is_own_child,
      -- One regex per member: full name, first name and nicknames as whole
      -- tokens (mirrors _shared/member-mentions.ts isNameMentionedInText).
      (
        select string_agg(
          regexp_replace(nm, '([][\\.^$|?*+(){}-])', '\\\1', 'g'), '|'
        )
        from (
          select btrim(x) as nm
          from unnest(
            array[m.name, split_part(btrim(m.name), ' ', 1)] || coalesce(m.nicknames, '{}'::text[])
          ) as x
          where btrim(x) <> ''
        ) names
      ) as name_alternation
    from public.family_members m
    where m.family_id = p_family_id
  ),
  visible_memories as (
    select
      mem.id,
      mem.user_id,
      mem.memory_date,
      mem.created_at,
      left(
        btrim(regexp_replace(
          coalesce(nullif(btrim(mem.content), ''), nullif(btrim(mem.audio_transcript), ''), nullif(btrim(mem.description), '')),
          '\s+', ' ', 'g'
        )),
        200
      ) as snippet
    from public.memories mem
    where mem.family_id = p_family_id
      and not exists (
        select 1
        from public.content_reports r
        where r.family_id = mem.family_id
          and r.target_type = 'memory'
          and r.target_id = mem.id
          and (r.status <> 'resolved' or r.resolution is distinct from 'dismissed')
      )
  ),
  recent as (
    select *
    from visible_memories
    where snippet is not null and snippet <> ''
    order by memory_date desc, created_at desc, id
    limit 400
  ),
  pairs as (
    select distinct r.id as memory_id, m.id as member_id
    from recent r
    join members m on
      exists (
        select 1 from public.memory_family_members t
        where t.memory_id = r.id and t.family_member_id = m.id
      )
      or (
        m.name_alternation is not null
        and r.snippet ~* ('(^|[^[:alnum:]])(' || m.name_alternation || ')($|[^[:alnum:]])')
      )
  ),
  ranked as (
    select
      p.memory_id,
      p.member_id,
      row_number() over (
        partition by p.member_id
        order by r.memory_date desc, r.created_at desc, r.id
      ) as rn
    from pairs p
    join recent r on r.id = p.memory_id
  ),
  kept as (
    select memory_id, array_agg(member_id order by member_id) as member_ids
    from ranked
    where rn <= 6
    group by memory_id
  ),
  snippets as (
    select
      r.snippet as text,
      r.memory_date,
      fm.family_member_id as author_member_id,
      k.member_ids,
      r.created_at,
      r.id
    from kept k
    join recent r on r.id = k.memory_id
    left join public.family_memberships fm
      on fm.family_id = p_family_id and fm.user_id = r.user_id
    order by r.memory_date desc, r.created_at desc, r.id
    limit 40
  ),
  co_tags as (
    select
      t.family_member_id as member_id,
      c.id as child_id,
      count(*)::integer as memories
    from visible_memories vm
    join public.memory_family_members ct on ct.memory_id = vm.id
    join members c on c.id = ct.family_member_id and c.is_own_child
    join public.memory_family_members t on t.memory_id = vm.id and t.family_member_id <> c.id
    join members tm on tm.id = t.family_member_id
    group by t.family_member_id, c.id
  )
  select jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'first_name', m.first_name,
          'nicknames', to_jsonb(m.nicknames),
          'age_years', m.age_years,
          'gender', m.gender,
          'relationship', m.relationship,
          'family_side', m.family_side,
          'side_member_id', m.side_member_id,
          'is_own_child', m.is_own_child
        )
        order by m.created_at, m.id
      )
      from members m
    ), '[]'::jsonb),
    'accounts', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'family_member_id', fm.family_member_id,
          'display_name', nullif(btrim(up.name), ''),
          'role', fm.role
        )
        order by fm.created_at, fm.id
      )
      from public.family_memberships fm
      left join public.user_profiles up on up.id = fm.user_id
      where fm.family_id = p_family_id and fm.family_member_id is not null
    ), '[]'::jsonb),
    'co_tags', coalesce((
      select jsonb_agg(
        jsonb_build_object('member_id', ct.member_id, 'child_id', ct.child_id, 'memories', ct.memories)
        order by ct.member_id, ct.child_id
      )
      from co_tags ct
    ), '[]'::jsonb),
    'snippets', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'text', s.text,
          'memory_date', s.memory_date,
          'author_member_id', s.author_member_id,
          'member_ids', to_jsonb(s.member_ids)
        )
        order by s.memory_date desc, s.created_at desc, s.id
      )
      from snippets s
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.family_relationship_signals(uuid) from public, anon, authenticated;
grant execute on function public.family_relationship_signals(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. commit_onboarding: kids created during onboarding are 'child'
--    (definition taken verbatim from the live database; only the kid insert
--    changed -- it now sets relationship = 'child').
-- ---------------------------------------------------------------------------

create or replace function public.commit_onboarding(p_commit_id uuid, p_family_name text, p_kid_names jsonb, p_capture jsonb, p_tagged_kid_indexes jsonb, p_memory_date date DEFAULT CURRENT_DATE)
 RETURNS public.onboarding_commits
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  current_user_id uuid := auth.uid();
  existing_commit public.onboarding_commits;
  new_family public.families;
  new_memory public.memories;
  kid_record jsonb;
  kid_index integer := 0;
  tag_index integer;
  tag_member_id uuid;
  capture_text text;
  capture_has_media boolean;
  owned_family_count integer;
  result public.onboarding_commits;
begin
  if current_user_id is null or public.is_anonymous_user() then
    raise exception 'A permanent account is required' using errcode = '42501';
  end if;
  if p_commit_id is null then
    raise exception 'Onboarding commit id is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  select * into existing_commit
  from public.onboarding_commits
  where commit_id = p_commit_id and user_id = current_user_id;
  if found then return existing_commit; end if;

  -- A different id is not a new transaction for the same account. Returning
  -- the original row preserves idempotency without allowing caller-generated
  -- keys to mint more families.
  select * into existing_commit
  from public.onboarding_commits
  where user_id = current_user_id
  order by created_at
  limit 1;
  if found then return existing_commit; end if;

  select count(*) into owned_family_count
  from public.families
  where owner_id = current_user_id and deleted_at is null;
  if owned_family_count >= 5 then
    raise exception 'Maximum 5 owned families' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from public.family_memberships fm
    join public.families f on f.id = fm.family_id
    where fm.user_id = current_user_id and f.deleted_at is null
  ) then
    raise exception 'Onboarding has already been completed for this account' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_kid_names) <> 'array' or jsonb_array_length(p_kid_names) < 1 then
    raise exception 'At least one family member is required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_kid_names) > 20 then
    raise exception 'Too many family members' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(p_kid_names) as kid(value)
    where nullif(trim(kid.value #>> '{}'), '') is not null
  ) then
    raise exception 'At least one family member is required' using errcode = '22023';
  end if;

  insert into public.families (owner_id, name, billing_grace_until)
  values (current_user_id, coalesce(nullif(trim(p_family_name), ''), 'Our Family'), null)
  returning * into new_family;

  insert into public.family_memberships (family_id, user_id, role)
  values (new_family.id, current_user_id, 'owner');

  update public.user_profiles
  set active_family_id = coalesce(active_family_id, new_family.id)
  where id = current_user_id;

  for kid_record in select value from jsonb_array_elements(p_kid_names)
  loop
    if nullif(trim(kid_record #>> '{}'), '') is not null then
      insert into public.family_members (family_id, user_id, name, date_of_birth, relationship)
      values (new_family.id, current_user_id, trim(kid_record #>> '{}'), null, 'child');
    end if;
    kid_index := kid_index + 1;
  end loop;

  select nullif(trim(coalesce(p_capture->>'text', '')), ''),
         coalesce((p_capture->>'hasMedia')::boolean, false)
  into capture_text, capture_has_media;

  if not capture_has_media
     and jsonb_typeof(p_tagged_kid_indexes) = 'array'
     and jsonb_array_length(p_tagged_kid_indexes) > 6 then
    raise exception 'Illustrated memories can tag at most 6 family members' using errcode = '22023';
  end if;

  if p_capture is not null and (capture_has_media or capture_text is not null) then
    insert into public.memories (
      user_id, family_id, content, memory_date, memory_type, illustration_status,
      onboarding_attributed, onboarding_media_pending, onboarding_media_pending_until
    ) values (
      current_user_id, new_family.id, capture_text, p_memory_date,
      case when capture_has_media then 'media' else 'text_illustration' end,
      case when capture_has_media then 'none' else 'pending' end,
      case when capture_has_media then false else true end,
      capture_has_media,
      case when capture_has_media then transaction_timestamp() + interval '24 hours' else null end
    ) returning * into new_memory;

    if jsonb_typeof(p_tagged_kid_indexes) = 'array' then
      for tag_index in select (value #>> '{}')::integer from jsonb_array_elements(p_tagged_kid_indexes)
      loop
        select id into tag_member_id
        from public.family_members
        where family_id = new_family.id
        order by created_at
        offset tag_index limit 1;
        if tag_member_id is not null then
          insert into public.memory_family_members (memory_id, family_member_id)
          values (new_memory.id, tag_member_id)
          on conflict do nothing;
        end if;
      end loop;
    end if;

    if not exists (select 1 from public.memory_family_members where memory_id = new_memory.id) then
      select id into tag_member_id from public.family_members
      where family_id = new_family.id order by created_at limit 1;
      if tag_member_id is not null then
        insert into public.memory_family_members (memory_id, family_member_id)
        values (new_memory.id, tag_member_id);
      end if;
    end if;
  end if;

  insert into public.onboarding_commits (commit_id, user_id, family_id, memory_id, is_new_family)
  values (p_commit_id, current_user_id, new_family.id, new_memory.id, true)
  returning * into result;
  return result;
end;
$function$;

revoke all on function public.commit_onboarding(uuid,text,jsonb,jsonb,jsonb,date) from public, anon;
grant execute on function public.commit_onboarding(uuid,text,jsonb,jsonb,jsonb,date) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. ai_usage_events: allow the 'relationship_chat' operation
--    not valid + validate keeps the exclusive lock short. Forward-only: once
--    relationship_chat rows exist the old constraint can't be restored.
-- ---------------------------------------------------------------------------

alter table public.ai_usage_events
  drop constraint ai_usage_events_operation_check;

alter table public.ai_usage_events
  add constraint ai_usage_events_operation_check
  check (operation in (
    'illustration', 'portrait', 'safety_chat', 'emotion_chat', 'emotion_vision',
    'transcription', 'voice_cleanup', 'relationship_chat'
  )) not valid;

alter table public.ai_usage_events
  validate constraint ai_usage_events_operation_check;
