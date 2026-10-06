-- ROLLBACK for 20261006120000_holiday_cards.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/migrations on purpose).
-- Run it in one transaction; it is written to be re-runnable (IF EXISTS).
--
-- Restores every function / policy / CHECK that the migration REPLACED, to the
-- definition in force immediately before it:
--   * year_film_invalidate          <- 20260929120000_year_films.sql
--   * save_year_film_edits          <- 20260930150000_year_film_edit_options.sql
--   * claim_family_deletion_fence   <- 20260929120000_year_films.sql (see the
--       drift warning in the migration: if production's live definition has
--       moved on since, compare with pg_get_functiondef and fold the
--       difference in BEFORE running this)
--   * "Year films: select" policy   <- 20260930180000_year_films_remaking_visibility.sql
--   * year_films_status_check       (drops 'ended')
--   * ai_usage_events_operation_check (drops the six holiday_card_* operations)
-- and drops everything the migration ADDED: holiday_card_orders,
-- holiday_cards (ALL card and order data is lost), the card RPCs and the
-- pg_cron job.
--
-- What it deliberately does NOT do:
--   * It does not delete card films. Forced family_holiday year_films rows
--     created for cards (and their film_share_tokens) stay: a printed QR must
--     keep working, and the owner's dogfood row is never touched. Remove them
--     by hand only if you are sure no card was ever ordered.
--   * Films with status 'ended' are set to 'failed' (their keys are already
--     null and cleanup_needed stays true) so the old CHECK can be restored.
--   * The operation CHECK is re-added NOT VALID and is not validated: ledger
--     rows with the new operations may exist. They stay as history.

begin;

-- 1. Scheduler
do $$
begin
  perform cron.unschedule('invoke-sweep-holiday-card-orders');
exception when others then
  null; -- job not scheduled
end;
$$;

-- 2. The year_films policy must go before holiday_cards (it references it).
drop policy if exists "Year films: select" on public.year_films;
create policy "Year films: select" on public.year_films
  for select
  using (
    public.is_family_member(family_id)
    and ready_at is not null
    and not forced
    and (surface_at <= now() or public.has_family_role(family_id, array['owner', 'manager']))
  );

-- 3. Replaced functions, restored verbatim.
create or replace function public.year_film_invalidate(p_film_ids uuid[], p_block boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_film_ids is null or cardinality(p_film_ids) = 0 then
    return 0;
  end if;
  set local lock_timeout = '5s';
  update public.year_films
  set content_epoch = content_epoch + 1,
      blocked = blocked or p_block,
      stale = true,
      requeue_after = coalesce(requeue_after, now() + interval '15 minutes'),
      updated_at = now()
  where id = any (p_film_ids)
    and (video_key is not null or status in ('queued', 'curating', 'preparing', 'rendering'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.year_film_invalidate(uuid[], boolean) from public, anon, authenticated;
grant execute on function public.year_film_invalidate(uuid[], boolean) to service_role;

create or replace function public.save_year_film_edits(p_film_id uuid, p_edits jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_film public.year_films;
  v_removed uuid[];
  v_previously_removed uuid[];
  v_quote jsonb;
  v_bed text;
  v_removing boolean;
  v_merged jsonb;
begin
  if v_uid is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_film from public.year_films where id = p_film_id for update;
  if not found or not public.has_family_role(v_film.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.billing_write_allowed_for_current_user(v_film.family_id) then
    raise exception 'Subscription required' using errcode = '42501';
  end if;
  if v_film.status <> 'ready' or v_film.video_key is null then
    raise exception 'film_not_editable' using errcode = '55000', hint = 'film_not_editable';
  end if;
  if jsonb_typeof(p_edits) <> 'object' then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'invalid_edits';
  end if;

  v_previously_removed := coalesce(
    array(select jsonb_array_elements_text(coalesce(v_film.edits -> 'removedMemoryIds', '[]'::jsonb)))::uuid[],
    '{}'
  );
  v_removed := coalesce(array(select jsonb_array_elements_text(coalesce(p_edits -> 'removedMemoryIds', '[]'::jsonb)))::uuid[], '{}');
  if not (v_removed <@ (v_film.referenced_memory_ids || v_previously_removed)) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'removed_memory_not_in_film';
  end if;
  v_quote := p_edits -> 'quote';
  if v_quote is not null and jsonb_typeof(v_quote) <> 'null' and not exists (
    select 1 from jsonb_array_elements(coalesce(v_film.quote_candidates, '[]'::jsonb)) c
    where c ->> 'memoryId' = v_quote ->> 'memoryId' and c ->> 'textHash' = v_quote ->> 'textHash'
  ) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'quote_not_a_candidate';
  end if;
  v_bed := p_edits ->> 'musicBedId';
  if v_bed is not null and not (v_bed = any (public.year_film_bed_ids())) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'unknown_music_bed';
  end if;

  if (select count(*) from public.year_film_render_requests
      where film_id = p_film_id and created_at > now() - interval '1 day') >= 5
     or (select count(*) from public.year_film_render_requests
         where family_id = v_film.family_id and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  v_removing := cardinality(array(
    select unnest(v_removed)
    except
    select unnest(v_previously_removed)
  )) > 0;

  v_merged := v_film.edits
    || jsonb_build_object('removedMemoryIds', to_jsonb(v_removed))
    || case when p_edits ? 'quote' then jsonb_build_object('quote', v_quote) else '{}'::jsonb end
    || case when v_bed is not null then jsonb_build_object('musicBedId', v_bed) else '{}'::jsonb end;

  insert into public.year_film_render_requests (film_id, family_id, requested_by)
  values (p_film_id, v_film.family_id, v_uid);

  update public.year_films
  set edits = v_merged,
      edits_version = edits_version + 1,
      music_bed_id = coalesce(v_bed, music_bed_id),
      stale = true,
      blocked = blocked or v_removing,
      status = 'queued', attempt_count = 0, attempt_id = null,
      next_attempt_at = null, requeue_after = null, updated_at = now()
  where id = p_film_id;

  return jsonb_build_object('ok', true, 'edits_version', v_film.edits_version + 1);
end;
$$;
revoke all on function public.save_year_film_edits(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_year_film_edits(uuid, jsonb) to authenticated;

CREATE OR REPLACE FUNCTION public.claim_family_deletion_fence(p_family_id uuid, p_delete_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  family_row public.families%rowtype;
  stale_token uuid;
begin
  select * into family_row
  from public.families
  where id = p_family_id
  for update;
  if not found then return false; end if;
  if family_row.deletion_fence_token is not null then
    if family_row.deletion_fence_started_at >= now() - interval '10 minutes' then
      raise exception 'Family deletion already in progress' using errcode = '55000';
    end if;
    stale_token := family_row.deletion_fence_token;
    perform 1
    from public.family_members member
    where member.family_id = p_family_id
    order by member.id
    for update;
    update public.family_member_portrait_versions
    set deletion_token = null, deletion_started_at = null
    where family_id = p_family_id and deletion_token = stale_token;
    update public.family_members
    set deletion_fence_token = null, deletion_fence_started_at = null
    where family_id = p_family_id and deletion_fence_token = stale_token;
    update public.families
    set deletion_fence_token = null, deletion_fence_started_at = null
    where id = p_family_id and deletion_fence_token = stale_token;
    family_row.deletion_fence_token := null;
  end if;

  perform 1
  from public.family_members member
  where member.family_id = p_family_id
  order by member.id
  for update;

  if exists (
    select 1 from public.family_members
    where family_id = p_family_id and deletion_fence_token is not null
  ) then
    raise exception 'Family member deletion already in progress' using errcode = '55000';
  end if;

  perform 1
  from public.portrait_generation_jobs job
  where job.family_id = p_family_id
  order by job.id
  for update;

  perform 1
  from public.memory_illustration_jobs job
  where job.family_id = p_family_id
  order by job.id
  for update;

  perform 1
  from public.family_member_portrait_versions version
  where version.family_id = p_family_id
  order by version.id
  for update;

  perform 1
  from public.memories memory
  where memory.family_id = p_family_id
  order by memory.id
  for update;

  if exists (
    select 1 from public.portrait_generation_jobs
    where family_id = p_family_id
      and status in ('queued', 'running')
      and (
        started_at >= now() - interval '5 minutes 30 seconds'
        or (upload_token is not null and upload_started_at >= now() - interval '5 minutes 30 seconds')
      )
  ) or exists (
    select 1 from public.family_member_portrait_versions
    where family_id = p_family_id
      and generation_token is not null
      and generation_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Fresh portrait generation is still active' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.memory_illustration_jobs
    where family_id = p_family_id
      and status in ('queued', 'running')
      and (
        started_at >= now() - interval '5 minutes 30 seconds'
        or (upload_token is not null and upload_started_at >= now() - interval '5 minutes 30 seconds')
      )
  ) or exists (
    select 1 from public.memories
    where family_id = p_family_id
      and illustration_generation_attempt_id is not null
      and illustration_generation_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Fresh illustration generation is still active' using errcode = '55000';
  end if;

  -- Year Film P1: a running film attempt could write film/poster objects
  -- after the deletion sweep; wait for it like portraits/illustrations.
  if exists (
    select 1 from public.year_films
    where family_id = p_family_id
      and status in ('curating', 'preparing', 'rendering')
      and heartbeat_at >= now() - interval '20 minutes'
  ) then
    raise exception 'Fresh year film generation is still active' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.family_member_portrait_versions
    where family_id = p_family_id and deletion_token is not null
  ) then
    raise exception 'Portrait deletion already in progress' using errcode = '55000';
  end if;

  update public.families
  set deletion_fence_token = p_delete_token,
      deletion_fence_started_at = now()
  where id = p_family_id;

  update public.family_members
  set deletion_fence_token = p_delete_token,
      deletion_fence_started_at = now()
  where family_id = p_family_id;

  update public.family_member_portrait_versions
  set deletion_token = p_delete_token,
      deletion_started_at = now()
  where family_id = p_family_id;

  update public.portrait_generation_jobs
  set status = 'superseded', completed_at = now(),
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  where family_id = p_family_id and status in ('queued', 'running');

  update public.memory_illustration_jobs
  set status = 'superseded', completed_at = now(),
      safe_scene_description = null, reference_candidates = '[]'::jsonb,
      illustration_prompt = null, upload_token = null, upload_started_at = null
  where family_id = p_family_id and status in ('queued', 'running');

  update public.memories
  set illustration_generation_attempt_id = null,
      illustration_generation_started_at = null,
      illustration_status = case
        when illustration_key is not null and illustration_generation_id is not null then 'ready'
        when memory_type = 'text_illustration' then 'pending'
        else 'none'
      end
  where family_id = p_family_id
    and illustration_generation_attempt_id is not null;

  return true;
end;
$function$;

-- 4. Functions the migration added.
drop function if exists public.claim_year_film_by_id(uuid);
drop function if exists public.end_holiday_card_film(uuid);
drop function if exists public.create_holiday_card_film(uuid, date, date, text, uuid[]);
drop function if exists public.increment_holiday_card_generation_attempt(uuid, integer);
drop function if exists public.save_holiday_card_edits(uuid, integer, jsonb);
drop function if exists public.create_holiday_card(uuid, uuid, integer, text, text, text);
drop function if exists public.holiday_card_new_share_token();

-- 5. year_films: ended -> failed, then the original status CHECK.
update public.year_films set status = 'failed' where status = 'ended';
alter table public.year_films drop constraint if exists year_films_status_check;
alter table public.year_films
  add constraint year_films_status_check
  check (status in ('queued', 'curating', 'preparing', 'rendering', 'ready', 'skipped', 'failed'));

-- 6. Ledger operations: the previous list (NOT VALID, see the header).
alter table public.ai_usage_events drop constraint if exists ai_usage_events_operation_check;
alter table public.ai_usage_events
  add constraint ai_usage_events_operation_check
  check (operation in (
    'illustration', 'portrait', 'safety_chat', 'emotion_chat', 'emotion_vision',
    'transcription', 'voice_cleanup', 'relationship_chat',
    'year_film_quote', 'year_film_vision', 'year_film_audio'
  )) not valid;

-- 7. Tables (orders first: they reference cards).
drop table if exists public.holiday_card_orders;
drop table if exists public.holiday_cards;

commit;
