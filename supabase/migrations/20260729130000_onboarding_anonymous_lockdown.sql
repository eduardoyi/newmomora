-- WP-SEC: Anonymous authorization lockdown (docs/plans/onboarding-implementation.md
-- "WP-SEC -- Anonymous authorization lockdown").
--
-- Threat: the onboarding flow needs anonymous Supabase sessions for two
-- pre-auth calls (S9 voice transcription, J2 invite preview). An anonymous
-- Auth user receives the normal `authenticated` Postgres role -- the SAME
-- role a real signed-up user has. Before this migration, that role could
-- reach `create_family` (SECURITY DEFINER) and become the real owner of a
-- real family, then use every normal family/paid-AI surface as that family's
-- owner. This migration closes that hole with two independent layers so
-- direct PostgREST access and direct RPC calls are both denied on their own:
--
--   1. RESTRICTIVE "deny anonymous" RLS policies on every normal
--      application table an anonymous session's `authenticated` role could
--      otherwise reach directly via PostgREST. RESTRICTIVE policies AND
--      with the table's existing PERMISSIVE policies rather than replacing
--      them, so this lands without touching a single existing policy body.
--   2. An explicit anonymous-caller guard inside every mutating normal
--      SECURITY DEFINER RPC, plus an execute revoke from `public, anon,
--      authenticated` (then a fresh `grant ... to authenticated` for the
--      permanent-user path) on every one of them. Revoking from `public`
--      alone is NOT sufficient in this project: Supabase's local/hosted
--      bootstrap grants `EXECUTE` to the `anon` and `authenticated` roles
--      directly via `ALTER DEFAULT PRIVILEGES`, independent of the PUBLIC
--      pseudo-role, so the fully-unauthenticated `anon` role keeps calling a
--      function that only revoked PUBLIC. SECURITY DEFINER functions run as
--      their owner and bypass RLS entirely, so layer 1 does NOT protect
--      them -- this layer is not redundant with it.
--
-- Every other SECURITY DEFINER function already shipped in supabase/migrations
-- is audited in the big comment block below and is either already
-- anon-unreachable (trigger functions, service_role-only grants) or is
-- documented here as deliberately anon-safe by construction (family/ownership
-- gated, so an anonymous caller with no real membership gets nothing).
--
-- `handle_new_user` is also fixed here (item 1): an anonymous Auth user no
-- longer gets a `public.user_profiles` row, so it never looks like a real
-- tenant and never accumulates orphaned profile rows if abandoned (item 5 --
-- see the note near the bottom of this file).
--
-- Do NOT flip `enable_anonymous_sign_ins` before this migration is applied
-- and its tests pass -- see supabase/config.toml.

-- ---------------------------------------------------------------------------
-- 0. Helper: is the calling session an anonymous Auth user?
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because `authenticated` has no direct SELECT on
-- auth.users (matches the existing pattern in get_invite_redeemer /
-- resolve-family-invite, which already read auth.users.email the same way).
-- A null auth.uid() (no session) or an id auth.users no longer has (already
-- hard-deleted) both coalesce to `false` -- this function only ever answers
-- "is this a currently-anonymous signed-in session", never "is this caller
-- unauthenticated". Deliberately left PUBLIC-executable (like
-- is_family_member/has_family_role): it is a pure boolean predicate with no
-- side effects and no sensitive output, called from RLS policies evaluated
-- under every client role.
create or replace function public.is_anonymous_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select au.is_anonymous from auth.users au where au.id = auth.uid()),
    false
  );
$$;

comment on function public.is_anonymous_user() is
  'True only for a currently-anonymous signed-in Auth session (auth.users.is_anonymous). WP-SEC anonymous-lockdown predicate -- see 20260729130000_onboarding_anonymous_lockdown.sql.';

-- ---------------------------------------------------------------------------
-- 1. handle_new_user: never provision a normal profile for an anonymous user
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger as $$
begin
  -- An anonymous Auth user (S9/J2's ensureAnonymousSession()) must never
  -- acquire a user_profiles row -- that row is what makes an id "look like"
  -- a real tenant to the rest of the schema (active_family_id, notification
  -- prefs, etc.), and it would otherwise persist forever if the session is
  -- abandoned (no cron ever sweeps user_profiles the way
  -- hard-delete-expired-accounts sweeps profiles that opted into deletion).
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;

  insert into public.user_profiles (id, name, timezone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', 'Parent'),
    coalesce(new.raw_user_meta_data->>'timezone', 'UTC')
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ---------------------------------------------------------------------------
-- 2. RESTRICTIVE anonymous-deny RLS -- every normal application table a
--    signed-in `authenticated` role (real or anonymous) can reach directly
--    via PostgREST. ANDs with the existing permissive policies below; does
--    not replace or depend on any of them.
-- ---------------------------------------------------------------------------

create policy "User profiles: deny anonymous" on public.user_profiles
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Families: deny anonymous" on public.families
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Family memberships: deny anonymous" on public.family_memberships
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Family members: deny anonymous" on public.family_members
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Memories: deny anonymous" on public.memories
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Memory tags: deny anonymous" on public.memory_family_members
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Memory media: deny anonymous" on public.memory_media
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Memory likes: deny anonymous" on public.memory_likes
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Memory comments: deny anonymous" on public.memory_comments
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Family invites: deny anonymous" on public.family_invites
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Portrait versions: deny anonymous" on public.family_member_portrait_versions
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

-- blocked_family_accounts and content_reports already have zero grants to
-- anon/authenticated at the table-privilege level (content_reporting.sql),
-- so no client role -- anonymous or not -- can reach them at all today.
-- These two restrictive policies are pure defense in depth against a future
-- change that widens those grants without re-reviewing anonymous exposure.
create policy "Blocked family accounts: deny anonymous" on public.blocked_family_accounts
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create policy "Content reports: deny anonymous" on public.content_reports
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

-- Not covered above, and why that's correct:
--   * invite_code_words, invite_redemption_attempts, family_activity_log,
--     content_report_email_alerts, and every ai_usage_limits /
--     memory_illustration_workflow_jobs / portrait_generation_workflow_jobs
--     table: RLS is enabled with NO policies at all (see their own
--     migrations), which is already a default-deny for every client role,
--     anonymous or not. Adding a restrictive policy to an already-zero-policy
--     table would be a no-op.

-- ---------------------------------------------------------------------------
-- 3. SECURITY DEFINER RPC guards -- layer 2. RLS above does not apply to
--    these (they run as their owner and bypass RLS), so each mutating
--    client-facing RPC gets its own explicit anonymous check, plus a
--    `revoke ... from public, anon, authenticated` + fresh
--    `grant ... to authenticated` pair so the fully-unauthenticated `anon`
--    role loses access too (revoking PUBLIC alone leaves `anon` with
--    execute here, since Supabase's bootstrap grants it directly -- see the
--    file header). `create or replace function` with an unchanged argument
--    list preserves any grants already on the function, so these
--    revoke/grant pairs are self-documenting, not merely defensive.
-- ---------------------------------------------------------------------------

-- create_family: THE headline fix -- see the threat note at the top of this
-- file. Everything else in this migration exists because this function
-- could mint a real family + owner membership for an anonymous caller.
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

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot create a family' using errcode = '42501';
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

revoke all on function public.create_family(text) from public, anon, authenticated;
grant execute on function public.create_family(text) to authenticated;

-- create_family_invite: mutating, would otherwise let an anonymous
-- "owner" of a hole-created family (or any hypothetical future privilege
-- escalation) mint invite codes.
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

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot create an invite' using errcode = '42501';
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

revoke all on function public.create_family_invite(uuid, text) from public, anon, authenticated;
grant execute on function public.create_family_invite(uuid, text) to authenticated;

-- delete_family: owner-only already, but a mutating RPC gets the same
-- explicit guard as every other one in this section rather than relying
-- solely on "no real family can be anonymously owned".
create or replace function public.delete_family(fam uuid)
returns public.families
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_owner_id uuid;
  updated_family public.families;
begin
  if current_user_id is null then
    raise exception 'Unauthorized' using errcode = '28000';
  end if;

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot delete a family' using errcode = '42501';
  end if;

  select owner_id into target_owner_id
  from public.families
  where id = fam
    and deleted_at is null;

  if target_owner_id is null then
    raise exception 'Family not found' using errcode = 'P0002';
  end if;

  if target_owner_id <> current_user_id then
    raise exception 'Only the family owner can delete this family' using errcode = '42501';
  end if;

  update public.families
  set deleted_at = now()
  where id = fam
  returning * into updated_family;

  return updated_family;
end;
$$;

revoke all on function public.delete_family(uuid) from public, anon, authenticated;
grant execute on function public.delete_family(uuid) to authenticated;

-- replace_memory_media_assets: mutating, family-role gated.
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

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot modify memory media' using errcode = '42501';
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

  update public.memories
  set
    media_key = first_key,
    media_content_type = first_content_type,
    updated_at = now()
  where id = target_memory_id;
end;
$$;

revoke all on function public.replace_memory_media_assets(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_memory_media_assets(uuid, jsonb) to authenticated;

-- set_memory_like: already revoke/grant-scoped (memory_engagement.sql); adds
-- the explicit anonymous guard next to its existing `auth.uid() is null`
-- check.
create or replace function public.set_memory_like(target_memory_id uuid, should_like boolean)
returns table (
  liked boolean,
  changed boolean,
  like_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_family_id uuid;
  affected_rows integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot like memories' using errcode = '42501';
  end if;

  select m.family_id into target_family_id
  from public.memories m
  where m.id = target_memory_id;

  if target_family_id is null then
    raise exception 'Memory not found' using errcode = 'P0002';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if should_like then
    insert into public.memory_likes (memory_id, user_id)
    values (target_memory_id, auth.uid())
    on conflict (memory_id, user_id) do nothing;
    get diagnostics affected_rows = row_count;
  else
    delete from public.memory_likes
    where memory_id = target_memory_id and user_id = auth.uid();
    get diagnostics affected_rows = row_count;
  end if;

  return query
  select
    exists (
      select 1 from public.memory_likes ml
      where ml.memory_id = target_memory_id and ml.user_id = auth.uid()
    ),
    affected_rows > 0,
    (select count(*) from public.memory_likes ml where ml.memory_id = target_memory_id);
end;
$$;

revoke all on function public.set_memory_like(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_memory_like(uuid, boolean) to authenticated;

-- create_content_report: already revoke/grant-scoped (content_reporting.sql);
-- adds the explicit anonymous guard next to its existing `caller_id is null`
-- check.
create or replace function public.create_content_report(
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_note text default null,
  p_target_version_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  resolved_family_id uuid;
  resolved_target_version_id uuid;
  resolved_target_user_id uuid;
  normalized_note text := nullif(trim(p_note), '');
  recent_report_count integer;
  report_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot file a report' using errcode = '42501';
  end if;

  if p_target_type not in (
    'memory',
    'memory_illustration',
    'comment',
    'household_member',
    'family_member_profile',
    'family_member_portrait'
  ) then
    raise exception 'Unsupported report target' using errcode = '22023';
  end if;

  if p_reason not in (
    'unsafe_or_sexual',
    'harassment_or_abuse',
    'privacy',
    'misleading_ai_depiction',
    'other'
  ) then
    raise exception 'Invalid report reason' using errcode = '22023';
  end if;

  if p_reason = 'misleading_ai_depiction'
    and p_target_type not in ('memory_illustration', 'family_member_portrait') then
    raise exception 'Invalid reason for this report target' using errcode = '22023';
  end if;

  if (p_target_type = 'memory_illustration' and p_target_version_id is null)
    or (p_target_type <> 'memory_illustration' and p_target_version_id is not null) then
    raise exception 'Report target is unavailable' using errcode = 'P0002';
  end if;

  if normalized_note is not null and char_length(normalized_note) > 500 then
    raise exception 'Report note must be 500 characters or fewer' using errcode = '22023';
  end if;

  case p_target_type
    when 'memory' then
      select m.family_id, m.user_id
      into resolved_family_id, resolved_target_user_id
      from public.memories m
      where m.id = p_target_id;

    when 'memory_illustration' then
      select m.family_id, m.illustration_generation_id, m.user_id
      into resolved_family_id, resolved_target_version_id, resolved_target_user_id
      from public.memories m
      where m.id = p_target_id
        and m.memory_type = 'text_illustration'
        and m.illustration_status = 'ready'
        and m.illustration_key is not null
        and m.illustration_generation_id = p_target_version_id;

    when 'comment' then
      select m.family_id, c.user_id
      into resolved_family_id, resolved_target_user_id
      from public.memory_comments c
      join public.memories m on m.id = c.memory_id
      where c.id = p_target_id;

    when 'household_member' then
      select fm.family_id, fm.user_id
      into resolved_family_id, resolved_target_user_id
      from public.family_memberships fm
      where fm.id = p_target_id and fm.user_id <> caller_id;

    when 'family_member_profile' then
      select fm.family_id, fm.user_id
      into resolved_family_id, resolved_target_user_id
      from public.family_members fm
      where fm.id = p_target_id;

    when 'family_member_portrait' then
      select pv.family_id, coalesce(pv.user_id, fm.user_id)
      into resolved_family_id, resolved_target_user_id
      from public.family_member_portrait_versions pv
      join public.family_members fm on fm.id = pv.family_member_id
      where pv.id = p_target_id
        and pv.illustrated_profile_status = 'ready'
        and pv.illustrated_profile_key is not null
        and pv.deletion_token is null;
  end case;

  if resolved_family_id is null
    or not exists (
      select 1
      from public.family_memberships fm
      join public.families f on f.id = fm.family_id and f.deleted_at is null
      where fm.family_id = resolved_family_id and fm.user_id = caller_id
    ) then
    raise exception 'Report target is unavailable' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(caller_id::text, 0));

  select r.id into report_id
  from public.content_reports r
    where r.reporter_user_id = caller_id
      and r.target_type = p_target_type
      and r.target_id = p_target_id
      and r.target_version_id is not distinct from resolved_target_version_id
      and r.status in ('open', 'reviewing')
  limit 1;

  if report_id is not null then
    return report_id;
  end if;

  select count(*) into recent_report_count
  from public.content_reports r
  where r.reporter_user_id = caller_id
    and r.created_at > now() - interval '1 hour';

  if recent_report_count >= 10 then
    raise exception 'Report limit reached. Try again later' using errcode = 'P0001';
  end if;

  insert into public.content_reports (
    family_id,
    reporter_user_id,
    target_type,
    target_id,
    target_version_id,
    target_user_id,
    reason,
    note
  ) values (
    resolved_family_id,
    caller_id,
    p_target_type,
    p_target_id,
    resolved_target_version_id,
    resolved_target_user_id,
    p_reason,
    normalized_note
  )
  returning id into report_id;

  return report_id;
exception
  when unique_violation then
    select r.id into report_id
    from public.content_reports r
    where r.reporter_user_id = caller_id
      and r.target_type = p_target_type
      and r.target_id = p_target_id
      and r.target_version_id is not distinct from resolved_target_version_id
      and r.status in ('open', 'reviewing')
    limit 1;
    if report_id is not null then
      return report_id;
    end if;
    raise;
end;
$$;

revoke all on function public.create_content_report(text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_content_report(text, uuid, text, text, uuid) to authenticated;

-- set_family_account_block: already revoke/grant-scoped (content_reporting.sql);
-- adds the explicit anonymous guard next to its existing `caller_id is null`
-- check.
create or replace function public.set_family_account_block(
  p_should_block boolean,
  p_membership_id uuid default null,
  p_block_id uuid default null
)
returns public.blocked_family_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  target_family_id uuid;
  target_user_id uuid;
  result public.blocked_family_accounts;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot manage blocked accounts' using errcode = '42501';
  end if;

  if p_should_block then
    if p_membership_id is null or p_block_id is not null then
      raise exception 'An active household membership is required' using errcode = '22023';
    end if;

    select fm.family_id, fm.user_id
    into target_family_id, target_user_id
    from public.family_memberships fm
    where fm.id = p_membership_id and fm.user_id <> caller_id;

    if target_family_id is null or not exists (
      select 1
      from public.family_memberships caller_membership
      join public.families f
        on f.id = caller_membership.family_id and f.deleted_at is null
      where caller_membership.family_id = target_family_id
        and caller_membership.user_id = caller_id
    ) then
      raise exception 'Account is unavailable' using errcode = 'P0002';
    end if;

    insert into public.blocked_family_accounts (
      family_id,
      blocker_user_id,
      blocked_membership_id,
      blocked_user_id
    ) values (
      target_family_id,
      caller_id,
      p_membership_id,
      target_user_id
    )
    on conflict (blocker_user_id, family_id, blocked_user_id)
    do update set blocked_membership_id = excluded.blocked_membership_id
    returning * into result;
  else
    if p_block_id is null or p_membership_id is not null then
      raise exception 'A hidden-account id is required' using errcode = '22023';
    end if;

    delete from public.blocked_family_accounts b
    using public.families f
    where b.id = p_block_id
      and b.blocker_user_id = caller_id
      and f.id = b.family_id
      and f.deleted_at is null
      and exists (
        select 1 from public.family_memberships caller_membership
        where caller_membership.family_id = b.family_id
          and caller_membership.user_id = caller_id
      )
    returning * into result;

    if result.id is null then
      raise exception 'Account is unavailable' using errcode = 'P0002';
    end if;
  end if;

  return result;
end;
$$;

revoke all on function public.set_family_account_block(boolean, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_family_account_block(boolean, uuid, uuid) to authenticated;

-- create_family_member_portrait_version: already revoke/grant-scoped
-- (portrait_timeline.sql); adds the explicit anonymous guard next to its
-- existing `auth.uid() is null` check.
create or replace function public.create_family_member_portrait_version(
  version_id uuid,
  target_family_member_id uuid,
  portrait_reference_date date,
  portrait_date_source text,
  source_profile_picture_key text
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  member_row public.family_members%rowtype;
  result public.family_member_portrait_versions%rowtype;
  expected_key text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'P0001';
  end if;

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot create a portrait version' using errcode = '42501';
  end if;

  select * into member_row
  from public.family_members
  where id = target_family_member_id;

  if not found then
    raise exception 'Family member not found' using errcode = 'P0002';
  end if;
  if not public.has_family_role(member_row.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if portrait_date_source not in ('exif', 'manual', 'default_today') then
    raise exception 'Invalid portrait date source' using errcode = '22023';
  end if;
  if portrait_reference_date is null
    or portrait_reference_date > public.current_user_local_date()
    or (member_row.date_of_birth is not null and portrait_reference_date < member_row.date_of_birth)
  then
    raise exception 'Portrait date is outside the allowed range' using errcode = '22023';
  end if;

  expected_key := format(
    '%s/family/%s/portraits/%s/photo.jpg',
    auth.uid(), target_family_member_id, version_id
  );
  if source_profile_picture_key is distinct from expected_key then
    raise exception 'Invalid portrait source key' using errcode = '22023';
  end if;

  insert into public.family_member_portrait_versions (
    id, family_id, family_member_id, user_id, reference_date, date_source,
    profile_picture_key
  ) values (
    version_id, member_row.family_id, member_row.id, auth.uid(),
    portrait_reference_date, portrait_date_source, source_profile_picture_key
  ) returning * into result;

  return result;
end;
$$;

revoke all on function public.create_family_member_portrait_version(uuid, uuid, date, text, text) from public, anon, authenticated;
grant execute on function public.create_family_member_portrait_version(uuid, uuid, date, text, text) to authenticated;

-- update_family_member_portrait_version_date: already revoke/grant-scoped
-- (portrait_timeline.sql). Previously had no explicit `auth.uid() is null`
-- check at all (it relied transitively on has_family_role); this adds both
-- that check and the anonymous guard for parity with its siblings.
create or replace function public.update_family_member_portrait_version_date(
  target_version_id uuid,
  portrait_reference_date date
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  version_row public.family_member_portrait_versions%rowtype;
  member_dob date;
  result public.family_member_portrait_versions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'P0001';
  end if;

  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot update a portrait version' using errcode = '42501';
  end if;

  select * into version_row
  from public.family_member_portrait_versions
  where id = target_version_id;

  if not found then
    raise exception 'Portrait version not found' using errcode = 'P0002';
  end if;
  select date_of_birth into member_dob
  from public.family_members
  where id = version_row.family_member_id;
  if not public.has_family_role(version_row.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if version_row.generation_token is not null or version_row.deletion_token is not null then
    raise exception 'Portrait version is busy' using errcode = '55000';
  end if;
  if portrait_reference_date is null
    or portrait_reference_date > public.current_user_local_date()
    or (member_dob is not null and portrait_reference_date < member_dob)
  then
    raise exception 'Portrait date is outside the allowed range' using errcode = '22023';
  end if;

  update public.family_member_portrait_versions
  set reference_date = portrait_reference_date, date_source = 'manual'
  where id = target_version_id
  returning * into result;
  return result;
end;
$$;

revoke all on function public.update_family_member_portrait_version_date(uuid, date) from public, anon, authenticated;
grant execute on function public.update_family_member_portrait_version_date(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3b. NOT part of this migration's original threat model -- found while
--     auditing every definer RPC per item 3. Five service-role-only
--     portrait-attempt functions in 20260715120000_portrait_timeline.sql
--     used the same narrow `revoke all ... from public;` (no anon/
--     authenticated follow-up) that §3 above explains is insufficient in
--     this project. Verified directly against the running local database:
--
--       has_function_privilege('anon', 'public.claim_family_member_portrait_generation(uuid,uuid,text,uuid)', 'EXECUTE') = true
--       -- and the same for finish_family_member_portrait_generation,
--       -- fail_family_member_portrait_generation,
--       -- claim_family_member_portrait_deletion, and
--       -- finish_family_member_portrait_deletion.
--
--     That means the fully UNAUTHENTICATED `anon` Postgres role -- not just
--     an anonymous Auth session, literally any caller of the public API --
--     could call these directly. Each trusts a caller-supplied
--     `actor_user_id` parameter (validated only against that family's real
--     membership, never against `auth.uid()`, because they were written
--     assuming only the trusted service-role Edge Function calls them after
--     doing its own auth) and mutates portrait generation/deletion
--     attempt-token state using attacker-controlled `attempt_token`/
--     `attempt_key`/`delete_token` values. A caller who can discover (not
--     necessarily authenticate as) a real `family_member_portrait_versions`
--     id and a real manager/owner's user id for that family could claim,
--     finish, or fail a portrait generation/deletion attempt on their
--     behalf with no login at all. No body change needed -- these were
--     always meant to be service_role-only; this is grant hygiene only,
--     exactly like current_user_local_date below.
-- ---------------------------------------------------------------------------

revoke all on function public.claim_family_member_portrait_generation(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.finish_family_member_portrait_generation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_family_member_portrait_generation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_family_member_portrait_deletion(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_family_member_portrait_deletion(uuid, uuid) from public, anon, authenticated;

grant execute on function public.claim_family_member_portrait_generation(uuid, uuid, text, uuid) to service_role;
grant execute on function public.finish_family_member_portrait_generation(uuid, uuid, text) to service_role;
grant execute on function public.fail_family_member_portrait_generation(uuid, uuid) to service_role;
grant execute on function public.claim_family_member_portrait_deletion(uuid, uuid, uuid) to service_role;
grant execute on function public.finish_family_member_portrait_deletion(uuid, uuid) to service_role;

-- Same narrow-revoke pattern, but current_user_local_date is harmless
-- regardless (see §4 below) -- grant hygiene only, no body change.
revoke all on function public.current_user_local_date() from public, anon, authenticated;
grant execute on function public.current_user_local_date() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Read-only RPCs -- each of these is already membership/ownership-gated,
--    so an anonymous caller who can never hold a real membership row (once
--    §3 above closes create_family) gets nothing today. Rather than resting
--    on that transitive argument alone, each gets the same explicit
--    is_anonymous_user() guard as the mutating RPCs above -- so a caller
--    stays rejected even under a hypothetical future bug that let an
--    anonymous session's row into family_memberships some other way. This
--    is "proven denied by test", not "probably fine".
-- ---------------------------------------------------------------------------

-- get_invite_redeemer: manager+ of THAT invite's family (resolved
-- internally) -- returns a redeemer's name + email, so it is worth guarding
-- explicitly rather than relying only on has_family_role.
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
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

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

revoke all on function public.get_invite_redeemer(uuid) from public, anon, authenticated;
grant execute on function public.get_invite_redeemer(uuid) to authenticated;

-- get_my_redeemed_invite_status: scoped by `redeemed_by = auth.uid()`. An
-- anonymous session never redeems an invite (redeem-family-invite now
-- rejects anonymous callers -- see _shared/auth.ts), so this already always
-- returns zero rows for one; the guard makes that unconditional.
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
    and not public.is_anonymous_user()
  order by fi.redeemed_at desc nulls last
  limit 1;
$$;

revoke all on function public.get_my_redeemed_invite_status() from public, anon, authenticated;
grant execute on function public.get_my_redeemed_invite_status() to authenticated;

-- get_family_member_profiles: names/roles for attribution + the Settings
-- member list. Already revoke(public)/grant(authenticated)-scoped
-- (content_reporting.sql); this keeps its exact current shape (the
-- membership_id-returning version) and adds the same explicit guard.
create or replace function public.get_family_member_profiles(fam uuid)
returns table (
  membership_id uuid,
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
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(fam) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    fm.id as membership_id,
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
    null::uuid as membership_id,
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
    union all
    select c.user_id, c.created_at
    from public.memory_comments c
    join public.memories cm on cm.id = c.memory_id
    where cm.family_id = fam
    union all
    select b.blocked_user_id, b.created_at
    from public.blocked_family_accounts b
    where b.family_id = fam and b.blocker_user_id = auth.uid()
  ) src
  join public.user_profiles up on up.id = src.user_id
  where src.user_id not in (
    select fm2.user_id from public.family_memberships fm2 where fm2.family_id = fam
  )
  group by up.id, up.name;
end;
$$;

revoke all on function public.get_family_member_profiles(uuid) from public, anon, authenticated;
grant execute on function public.get_family_member_profiles(uuid) to authenticated;

-- get_memory_engagement: batch like/comment counts + the caller's own like
-- state. Already revoke(public)/grant(authenticated)-scoped
-- (memory_engagement.sql); adds the explicit guard.
create or replace function public.get_memory_engagement(memory_ids uuid[])
returns table (
  memory_id uuid,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select
    m.id,
    (select count(*) from public.memory_likes ml where ml.memory_id = m.id),
    (select count(*) from public.memory_comments mc where mc.memory_id = m.id),
    exists (
      select 1 from public.memory_likes mine
      where mine.memory_id = m.id and mine.user_id = auth.uid()
    )
  from public.memories m
  where m.id = any(memory_ids)
    and not public.is_anonymous_user()
    and public.is_family_member(m.family_id);
$$;

revoke all on function public.get_memory_engagement(uuid[]) from public, anon, authenticated;
grant execute on function public.get_memory_engagement(uuid[]) to authenticated;

-- get_my_open_content_reports: the caller's own open/reviewing reports for
-- one family. Already revoke(public)/grant(authenticated)-scoped
-- (content_reporting.sql); adds the explicit guard.
create or replace function public.get_my_open_content_reports(p_family_id uuid)
returns table (
  id uuid,
  family_id uuid,
  target_type text,
  target_id uuid,
  target_version_id uuid,
  status text,
  created_at timestamptz
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

  if not exists (
    select 1
    from public.family_memberships fm
    join public.families f on f.id = fm.family_id and f.deleted_at is null
    where fm.family_id = p_family_id and fm.user_id = auth.uid()
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.family_id,
    r.target_type,
    r.target_id,
    r.target_version_id,
    r.status,
    r.created_at
  from public.content_reports r
  where r.reporter_user_id = auth.uid()
    and r.family_id = p_family_id
    and r.status in ('open', 'reviewing')
  order by r.created_at desc;
end;
$$;

revoke all on function public.get_my_open_content_reports(uuid) from public, anon, authenticated;
grant execute on function public.get_my_open_content_reports(uuid) to authenticated;

-- current_user_local_date: grant hygiene fixed in §3b above (its original
-- revoke was the same narrow "from public" pattern). Returns only "today"
-- in the caller's timezone (or UTC) -- no membership, ownership, or PII of
-- any kind, for anyone -- so its body is left unguarded and unchanged
-- deliberately: it is safe regardless of any other fix in this migration,
-- not merely "safe transitively".
--
-- is_family_member, has_family_role: intentionally left PUBLIC-executable,
-- like is_anonymous_user() above -- pure boolean predicates with no side
-- effects, called from RLS policies evaluated under every client role
-- (including the fully-unauthenticated `anon` role, which must get `false`
-- back rather than a permission-denied error). Adding an is_anonymous_user()
-- branch to either would be redundant with §2/§3 above and would risk
-- breaking their use inside every other policy in the schema, for no
-- additional protection.

-- ---------------------------------------------------------------------------
-- 5. Audit note for every other SECURITY DEFINER function shipped in
--    supabase/migrations/ as of this migration (item 3's "audit every
--    definer RPC" requirement). None of these need a code change here:
-- ---------------------------------------------------------------------------
--
-- * Trigger functions (`returns trigger`) -- set_updated_at,
--   enforce_memory_tag_limit, enforce_family_membership_limit,
--   enforce_family_content_immutable_columns, enforce_membership_immutable_columns,
--   enforce_families_restricted_columns, enforce_family_member_dob_portrait_dates,
--   enforce_legacy_family_portrait_cutoff, enforce_portrait_version_immutable_columns,
--   invalidate_memory_illustration_attempt_on_input_change,
--   invalidate_memory_illustration_attempt_on_tag_change, clear_orphaned_report_note,
--   and every `protect_*`/`cancel_ai_usage_for_*` trigger in
--   20260727120000_ai_usage_limits.sql -- Postgres refuses to execute a
--   trigger function outside trigger context ("trigger functions can only be
--   called as triggers"), so no GRANT can make one directly RPC-callable.
--   Structurally anon-unreachable regardless of PUBLIC execute.
-- * Already `revoke ... from public, anon, authenticated` + `grant ... to
--   service_role` only, so no client role (anonymous or not) can invoke them
--   at all -- every RPC in 20260721120000_memory_illustration_workflow_jobs.sql,
--   20260722130000_portrait_generation_workflow_jobs.sql, and
--   20260727120000_ai_usage_limits.sql (including
--   reserve_onboarding_voice_attempt and mark_onboarding_voice_cleanup_expected,
--   which additionally verify `auth.users.is_anonymous` themselves per
--   docs/features/usage-limits.md), plus claim/finish/fail_family_member_portrait_*
--   in 20260715120000_portrait_timeline.sql, and
--   claim/mark/release_content_report_email_alert in
--   20260717120000_content_report_email_alerts.sql /
--   20260717130000_content_report_email_alert_redrive.sql.
-- * get_my_ai_usage_limit_notices() (20260727120000_ai_usage_limits.sql,
--   already granted to `authenticated` only, not touched by this migration):
--   filters on `public.is_family_member(n.family_id)`, so an anonymous caller
--   with no real family membership always gets zero rows.

-- ---------------------------------------------------------------------------
-- 6. Item 5 -- cleanup for abandoned anonymous Auth users. This migration
--    does not itself add the cleanup cron -- see the separate
--    20260729150000_abandoned_anonymous_cleanup.sql migration and
--    supabase/functions/cleanup-abandoned-anonymous-users/index.ts, which
--    ship alongside this one in the same package. (An earlier draft of this
--    comment argued the cron could be deferred as a follow-up, reading
--    onboarding-implementation.md's "cleanup cron" follow-up line and
--    usage-limits.md's "anonymous account cleanup scheduling" deferral as
--    covering it. On review, item 5 is one of the owner's enumerated
--    pre-conditions for `enable_anonymous_sign_ins`, and was not part of the
--    explicit backlog carve-out -- only per-IP/per-device limits and
--    CAPTCHA/Turnstile were. usage-limits.md deferring cleanup scheduling
--    from ITS OWN package does not remove it from this one. The cron is
--    built, not deferred.)
--
--    What THIS migration contributes to that cron: before it, an abandoned
--    anonymous user accumulated a real public.user_profiles row (via
--    handle_new_user) that no existing cron ever swept
--    (hard-delete-expired-accounts only sweeps profiles that opted into
--    deletion via schedule_account_deletion). After §1 above, an anonymous
--    Auth user has zero normal-tenant footprint: no user_profiles row, and
--    therefore (transitively) no families, no family_memberships, no
--    family_members, no memories it could own -- which is exactly what
--    makes the cleanup cron cheap and safe (no storage or family cascade to
--    run; see that function's own header). Deleting its auth.users row is
--    then exactly as clean as usage-limits.md already documents and already
--    tests (supabase/tests/usage_limits_onboarding.sql): the
--    `on delete set null` FKs on ai_onboarding_voice_requests.actor_user_id
--    and ai_usage_events.actor_user_id null out actor attribution, while the
--    deidentified company rollups (ai_system_usage_monthly_rollups) are
--    untouched, because they carry no user FK at all. Nothing added here
--    changes that cascade.

-- ---------------------------------------------------------------------------
-- 7. Invite-preview endpoint (J2's dependency) -- rate-limit-by-code log.
--    The `preview-family-invite` Edge Function validates a JWT (anonymous
--    OR permanent -- both carve-outs of item 4), looks up a word-code, and
--    returns ONLY the family name + inviter display name -- never a
--    membership list, email, invite role, or family id. Same shape as
--    `invite_redemption_attempts` (service-role/Edge-Function-only, no
--    client-visible policy, pruned opportunistically inline), but keyed by
--    the normalized CODE rather than the caller: an attacker can mint
--    unlimited anonymous sessions for near-zero cost once
--    enable_anonymous_sign_ins is on, so a per-user/per-account limit alone
--    would not bound hammering one guessed code the way it does for
--    redemption (a real account signup).
-- ---------------------------------------------------------------------------

create table public.invite_preview_attempts (
  code text not null,
  ip text,
  attempted_at timestamptz not null default now()
);

create index idx_invite_preview_attempts_code on public.invite_preview_attempts (code, attempted_at);

alter table public.invite_preview_attempts enable row level security;
-- RLS enabled with NO policies -- same "default-deny for every client role"
-- shape as invite_redemption_attempts/family_activity_log. Only the
-- service-role client inside preview-family-invite ever touches this table.
