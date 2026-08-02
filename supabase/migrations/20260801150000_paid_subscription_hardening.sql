-- Paid-subscription hardening found during adversarial review.
-- This migration closes client/UI-only assumptions and keeps onboarding and
-- engagement permissions tied to the server-side billing ledger.

create or replace function public.billing_write_allowed_for_current_user(p_family_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select auth.uid() is not null
    and public.billing_write_allowed(p_family_id, auth.uid());
$$;

revoke all on function public.billing_write_allowed_for_current_user(uuid) from public, anon;
grant execute on function public.billing_write_allowed_for_current_user(uuid) to authenticated;

alter table public.memories
  add column if not exists onboarding_media_pending boolean not null default false,
  add column if not exists onboarding_media_pending_until timestamptz;

alter table public.memories
  drop constraint if exists memories_type_invariants,
  add constraint memories_type_invariants check (
    (memory_type = 'text_illustration' and content is not null and media_key is null)
    or (memory_type = 'text_only' and content is not null and media_key is null)
    or (memory_type = 'media' and media_key is not null and media_content_type is not null and illustration_status = 'none')
    or (
      memory_type = 'media'
      and onboarding_media_pending = true
      and media_key is null
      and media_content_type is null
      and illustration_status = 'none'
    )
  );

-- One authenticated account gets one successful new-family onboarding commit.
-- The advisory lock makes the pre-insert checks race-safe as well as adding a
-- database-level backstop against caller-generated idempotency keys.
create unique index if not exists onboarding_commits_user_id_unique
  on public.onboarding_commits (user_id);

create or replace function public.billing_ai_generation_check(
  p_family_id uuid,
  p_actor_user_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_request_intent text
)
returns table (allowed boolean, scope text, retry_after_iso timestamptz, error_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_scope text;
  v_now timestamptz := transaction_timestamp();
  v_onboarding_memory_id uuid;
begin
  if not public.billing_write_allowed(p_family_id, p_actor_user_id) then
    return query select false, null::text, null::timestamptz, 'SUBSCRIPTION_REQUIRED';
    return;
  end if;

  select owner_id into v_owner_id from public.families where id = p_family_id;
  if v_owner_id is null then
    return query select false, null::text, null::timestamptz, 'FAMILY_NOT_FOUND';
    return;
  end if;

  insert into public.billing_owner_locks (owner_user_id)
  values (v_owner_id)
  on conflict (owner_user_id) do nothing;
  perform 1 from public.billing_owner_locks where owner_user_id = v_owner_id for update;

  -- Consume the one-time onboarding illustration admission atomically.  It is
  -- intentionally limited to the initial request and an illustrated memory;
  -- recovery/regeneration requests must use the normal paid fair-use pool.
  if p_target_kind = 'memory' and p_request_intent = 'initial' then
    update public.memories
    set onboarding_attributed = false, updated_at = v_now
    where id = p_target_id
      and family_id = p_family_id
      and memory_type = 'text_illustration'
      and onboarding_attributed = true
    returning id into v_onboarding_memory_id;

    if v_onboarding_memory_id is not null then
      return query select true, null::text, null::timestamptz, null::text;
      return;
    end if;
  end if;

  v_scope := public.billing_owner_ai_limit_scope(p_family_id, v_now);
  if v_scope is not null then
    return query select false,
      v_scope,
      case v_scope
        when 'daily' then ((v_now at time zone 'UTC')::date + 1)::timestamp at time zone 'UTC'
        else (date_trunc('month', v_now at time zone 'UTC') + interval '1 month')::timestamp at time zone 'UTC'
      end,
      'OWNER_AI_LIMIT_REACHED';
    return;
  end if;

  return query select true, null::text, null::timestamptz, null::text;
end;
$$;

create or replace function public.enqueue_billing_trial_reminders(
  p_now timestamptz default transaction_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  e public.owner_entitlements%rowtype;
begin
  for e in
    select * from public.owner_entitlements
    where environment = 'production'
      and status = 'trial'
      and period_type = 'annual'
      and expires_at is not null
      and expires_at between p_now + interval '47 hours' and p_now + interval '49 hours'
  loop
    insert into public.billing_trial_reminder_outbox (owner_user_id, entitlement_id, channel, due_at)
    values (e.owner_user_id, e.id, 'email', e.expires_at - interval '48 hours'),
           (e.owner_user_id, e.id, 'push', e.expires_at - interval '48 hours')
    on conflict (entitlement_id, channel) do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.cancel_billing_trial_reminders()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'trial' or new.period_type <> 'annual' then
    update public.billing_trial_reminder_outbox
    set status = 'failed',
        last_error = 'trial_no_longer_active',
        updated_at = transaction_timestamp()
    where entitlement_id = new.id
      and status in ('pending', 'sending');
  end if;
  return new;
end;
$$;

drop trigger if exists owner_entitlements_cancel_trial_reminders on public.owner_entitlements;
create trigger owner_entitlements_cancel_trial_reminders
after insert or update of status, period_type on public.owner_entitlements
for each row execute function public.cancel_billing_trial_reminders();

create or replace function public.billing_engagement_allowed(
  p_family_id uuid,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_grace_until timestamptz;
begin
  if p_actor_user_id is null then return false; end if;

  select owner_id, billing_grace_until
  into v_owner_id, v_grace_until
  from public.families
  where id = p_family_id and deleted_at is null;
  if v_owner_id is null then return false; end if;

  if not exists (
    select 1 from public.family_memberships
    where family_id = p_family_id and user_id = p_actor_user_id
  ) then
    return false;
  end if;

  if not public.billing_mode_applies(p_family_id) then return true; end if;
  return public.owner_has_billing_access(v_owner_id)
    or (v_grace_until is not null and v_grace_until > transaction_timestamp());
end;
$$;

grant execute on function public.billing_engagement_allowed(uuid, uuid) to authenticated;

-- Viewers can participate in a paid family without gaining owner/manager
-- content-write privileges. Removing an existing like remains allowed so a
-- lapse cannot trap a user's own engagement state.
drop policy if exists "Memory likes: insert own" on public.memory_likes;
create policy "Memory likes: insert own" on public.memory_likes for insert
  with check (
    user_id = auth.uid() and exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.billing_engagement_allowed(m.family_id, auth.uid())
    )
  );

drop policy if exists "Memory comments: insert own" on public.memory_comments;
create policy "Memory comments: insert own" on public.memory_comments for insert
  with check (
    user_id = auth.uid() and exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.billing_engagement_allowed(m.family_id, auth.uid())
    )
  );

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
  if not exists (
    select 1 from public.family_memberships
    where family_id = target_family_id and user_id = auth.uid()
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if should_like and not public.billing_engagement_allowed(target_family_id, auth.uid()) then
    raise exception 'Subscription required for engagement' using errcode = 'P0001';
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

-- The anonymous-media finalization path is separate from the one-time AI
-- admission. It expires after 24 hours and is cleared atomically once the
-- first asset set is persisted.
drop policy if exists "Memory tags: insert" on public.memory_family_members;
create policy "Memory tags: insert" on public.memory_family_members for insert
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
        and (
          public.billing_write_allowed(m.family_id, auth.uid())
          or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
        )
    )
    and exists (
      select 1 from public.family_members fm
      join public.memories m on m.id = memory_id
      where fm.id = family_member_id and fm.family_id = m.family_id
    )
  );

drop policy if exists "Memory tags: delete" on public.memory_family_members;
create policy "Memory tags: delete" on public.memory_family_members for delete
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed(m.family_id, auth.uid())
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

drop policy if exists "Memory media: insert" on public.memory_media;
create policy "Memory media: insert" on public.memory_media for insert
  with check (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed(m.family_id, auth.uid())
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

drop policy if exists "Memory media: update" on public.memory_media;
create policy "Memory media: update" on public.memory_media for update
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed(m.family_id, auth.uid())
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ))
  with check (exists (
    select 1 from public.memories m
    where m.id = memory_id and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed(m.family_id, auth.uid())
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

drop policy if exists "Memory media: delete" on public.memory_media;
create policy "Memory media: delete" on public.memory_media for delete
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed(m.family_id, auth.uid())
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

create or replace function public.commit_onboarding(
  p_commit_id uuid,
  p_family_name text,
  p_kid_names jsonb,
  p_capture jsonb,
  p_tagged_kid_indexes jsonb,
  p_memory_date date default current_date
)
returns public.onboarding_commits
language plpgsql
security definer
set search_path = public
as $$
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
      insert into public.family_members (family_id, user_id, name, date_of_birth)
      values (new_family.id, current_user_id, trim(kid_record #>> '{}'), null);
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
$$;

revoke all on function public.commit_onboarding(uuid,text,jsonb,jsonb,jsonb,date) from public, anon;
grant execute on function public.commit_onboarding(uuid,text,jsonb,jsonb,jsonb,date) to authenticated;

create or replace function public.replace_memory_media_assets(target_memory_id uuid, assets jsonb)
returns void language plpgsql set search_path = public as $$
declare
  current_user_id uuid := auth.uid();
  target_family_id uuid;
  target_onboarding_media_pending boolean;
  target_onboarding_media_pending_until timestamptz;
  asset_count integer;
  asset jsonb;
  asset_index integer;
  asset_key text;
  asset_content_type text;
  asset_duration_ms integer;
  asset_aspect_ratio double precision;
  asset_preview_object_key text;
  caller_prefix text;
  first_key text;
  first_content_type text;
  existing_keys text[];
  existing_aspect_ratios jsonb;
  existing_preview_object_keys jsonb;
begin
  if current_user_id is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() then raise exception 'Anonymous accounts cannot modify memory media' using errcode = '42501'; end if;
  if jsonb_typeof(assets) <> 'array' then raise exception 'assets must be an array' using errcode = '22023'; end if;
  asset_count := jsonb_array_length(assets);
  if asset_count < 1 or asset_count > 10 then raise exception 'Media memories require 1 to 10 assets' using errcode = '22023'; end if;

  select m.family_id, m.onboarding_media_pending, m.onboarding_media_pending_until
  into target_family_id, target_onboarding_media_pending, target_onboarding_media_pending_until
  from public.memories m where m.id = target_memory_id and m.memory_type = 'media';
  if target_family_id is null then raise exception 'Memory not found' using errcode = 'P0002'; end if;
  if not public.has_family_role(target_family_id, array['owner', 'manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not public.billing_write_allowed_for_current_user(target_family_id)
     and not (target_onboarding_media_pending and target_onboarding_media_pending_until > transaction_timestamp()) then
    raise exception 'Subscription required for media writes' using errcode = 'P0001';
  end if;

  caller_prefix := current_user_id::text || '/memories/' || target_memory_id::text;
  select coalesce(array_agg(object_key), '{}'),
    coalesce(jsonb_object_agg(object_key, aspect_ratio), '{}'::jsonb),
    coalesce(jsonb_object_agg(object_key, preview_object_key), '{}'::jsonb)
  into existing_keys, existing_aspect_ratios, existing_preview_object_keys
  from public.memory_media where memory_id = target_memory_id;
  delete from public.memory_media where memory_id = target_memory_id;

  for asset, asset_index in select value, ordinality - 1 from jsonb_array_elements(assets) with ordinality loop
    asset_key := asset->>'objectKey';
    asset_content_type := asset->>'contentType';
    asset_duration_ms := round(nullif(asset->>'durationMs', '')::numeric)::integer;
    asset_aspect_ratio := coalesce(nullif(asset->>'aspectRatio', '')::double precision, nullif(existing_aspect_ratios->>asset_key, 'null')::double precision);
    asset_preview_object_key := coalesce(nullif(asset->>'previewObjectKey', ''), nullif(existing_preview_object_keys->>asset_key, 'null'));
    if asset_key is null or asset_content_type is null then raise exception 'Each media asset requires objectKey and contentType' using errcode = '22023'; end if;
    if asset_aspect_ratio is not null and not (asset_aspect_ratio between 0.1 and 10) then raise exception 'Invalid media aspect ratio' using errcode = '22023'; end if;
    if asset_content_type not in ('image/jpeg','image/png','image/heic','image/heif','image/webp','video/mp4','video/quicktime') then raise exception 'Unsupported media content type' using errcode = '22023'; end if;
    if not (asset_key = any(existing_keys) or asset_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$') or asset_key ~ ('^' || caller_prefix || '/media[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')) then raise exception 'Invalid media object key' using errcode = '22023'; end if;
    if asset_preview_object_key is not null and not (asset_preview_object_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')) then raise exception 'Invalid preview object key' using errcode = '22023'; end if;
    insert into public.memory_media (memory_id, object_key, content_type, duration_ms, aspect_ratio, preview_object_key, position)
    values (target_memory_id, asset_key, asset_content_type, asset_duration_ms, asset_aspect_ratio, asset_preview_object_key, asset_index);
    if asset_index = 0 then first_key := asset_key; first_content_type := asset_content_type; end if;
  end loop;

  update public.memories
  set media_key = first_key,
      media_content_type = first_content_type,
      onboarding_attributed = false,
      onboarding_media_pending = false,
      onboarding_media_pending_until = null,
      updated_at = now()
  where id = target_memory_id;
end;
$$;

revoke all on function public.replace_memory_media_assets(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.replace_memory_media_assets(uuid,jsonb) to authenticated;

revoke all on function public.billing_ai_generation_check(uuid,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.billing_ai_generation_check(uuid,uuid,text,uuid,text) to service_role;
revoke all on function public.enqueue_billing_trial_reminders(timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_billing_trial_reminders(timestamptz) to service_role;
