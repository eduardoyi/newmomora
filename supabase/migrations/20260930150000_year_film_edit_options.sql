-- Year Film edit sheet (docs/plans/year-film-p2.md Step 11).
--
--   1. get_year_film_edit_options: what the owner/manager edit sheet shows
--      (moments actually in the film, the current bed, sticky quote
--      candidates, what is already removed).
--   2. save_year_film_edits: same contract as 20260929120000_year_films.sql
--      with one fix -- a removal set may keep moments removed by an EARLIER
--      edit. After the re-render those ids are no longer in
--      referenced_memory_ids (the new script never uses them), so the
--      "removed <@ referenced" check rejected every later save that
--      re-sent the full set.
--
-- Security definer with an empty search_path and fully qualified names, like
-- the P1/P2 migrations. Authenticated execute only.

-- ---------------------------------------------------------------------------
-- 1. Edit options
-- ---------------------------------------------------------------------------

-- Returns jsonb:
--   { editable: false, reason: 'not_ready' | 'blocked' | 'subscription_required' }
-- or
--   { editable: true, kind, editsVersion, musicBedId,
--     removedMemoryIds: uuid[],
--     chosenQuote: { memoryId, textHash } | null,
--     frames: [{ memoryId, date, kind }],          -- shown moments in film
--                                                  -- order, then removed ones
--     quoteCandidates: [{ memoryId, textHash, text, speakerName, isCurrent }] }
-- Frames come from the stored film_script (never granted to clients):
-- montage/sound/line/award/chapter/firsts/starring/title/cold-open frames,
-- de-duplicated by memory in film order. The counters backdrop and end-card
-- grid are mosaics of frames the other scenes already show, so they are not
-- repeated. Portraits (no memory) are skipped. Owner/manager only; forced
-- (operator) films are denied like any film the caller cannot see.
create or replace function public.get_year_film_edit_options(p_film_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_film public.year_films;
  v_removed uuid[];
  v_chosen jsonb;
  v_shown_quote uuid;
  v_frames jsonb;
  v_candidates jsonb;
begin
  if v_uid is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_film from public.year_films where id = p_film_id;
  if not found or v_film.forced or not public.has_family_role(v_film.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.billing_write_allowed_for_current_user(v_film.family_id) then
    return jsonb_build_object('editable', false, 'reason', 'subscription_required');
  end if;
  if v_film.status <> 'ready' or v_film.video_key is null then
    return jsonb_build_object('editable', false, 'reason', 'not_ready');
  end if;
  if v_film.blocked then
    return jsonb_build_object('editable', false, 'reason', 'blocked');
  end if;

  v_removed := coalesce(
    array(select jsonb_array_elements_text(coalesce(v_film.edits -> 'removedMemoryIds', '[]'::jsonb)))::uuid[],
    '{}'
  );
  v_chosen := case when jsonb_typeof(v_film.edits -> 'quote') = 'object' then v_film.edits -> 'quote' else null end;

  -- Frames per scene, in scene order (see the header for what is skipped).
  with scenes as (
    select s.value as scene, s.ordinality as si
    from jsonb_array_elements(coalesce(v_film.film_script -> 'scenes', '[]'::jsonb)) with ordinality s
  ), scene_frames as (
    select si,
      case scene ->> 'type'
        when 'cold_open' then jsonb_build_array(scene -> 'from', scene -> 'to')
        when 'title' then coalesce(scene -> 'cards', '[]'::jsonb)
        when 'burst' then coalesce(scene -> 'frames', '[]'::jsonb)
        when 'close' then coalesce(scene -> 'frames', '[]'::jsonb)
        when 'chapter' then coalesce(scene -> 'frames', '[]'::jsonb)
        when 'sound' then jsonb_build_array(scene -> 'frame')
        when 'line' then jsonb_build_array(scene -> 'frame')
        when 'award' then jsonb_build_array(scene -> 'frame')
        when 'starring' then coalesce((
          select jsonb_agg(m.value order by p.ordinality, m.ordinality)
          from jsonb_array_elements(coalesce(scene -> 'people', '[]'::jsonb)) with ordinality p,
               jsonb_array_elements(coalesce(p.value -> 'moments', '[]'::jsonb)) with ordinality m
        ), '[]'::jsonb)
        when 'firsts' then coalesce((
          select jsonb_agg(i.value -> 'frame' order by i.ordinality)
          from jsonb_array_elements(coalesce(scene -> 'items', '[]'::jsonb)) with ordinality i
          where jsonb_typeof(i.value -> 'frame') = 'object'
        ), '[]'::jsonb)
        else '[]'::jsonb
      end as frames
    from scenes
  ), flat as (
    select sf.si, f.ordinality as fi,
           f.value ->> 'memoryId' as memory_id,
           f.value ->> 'date' as frame_date,
           f.value ->> 'kind' as frame_kind
    from scene_frames sf,
         jsonb_array_elements(sf.frames) with ordinality f
    where jsonb_typeof(f.value) = 'object'
      and jsonb_typeof(f.value -> 'memoryId') = 'string'
      and coalesce(f.value ->> 'kind', '') <> 'portrait'
      and (f.value ->> 'memoryId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), first_use as (
    select distinct on (memory_id) memory_id, frame_date, frame_kind, si, fi
    from flat
    order by memory_id, si, fi
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('memoryId', memory_id, 'date', frame_date, 'kind', frame_kind)
    order by si, fi
  ), '[]'::jsonb)
  into v_frames
  from first_use;

  -- Previously removed moments stay listed (hidden) so they can be restored.
  v_frames := v_frames || coalesce((
    select jsonb_agg(jsonb_build_object(
      'memoryId', m.id,
      'date', m.memory_date,
      'kind', case
        when m.memory_type = 'audio' then 'audio'
        when m.media_content_type like 'video/%'
          or exists (select 1 from public.memory_media mm where mm.memory_id = m.id and mm.content_type like 'video/%')
          then 'video'
        when m.memory_type = 'media' then 'photo'
        else 'illustration'
      end
    ) order by m.memory_date, m.id)
    from public.memories m
    where m.family_id = v_film.family_id
      and m.id = any (v_removed)
      and not exists (
        select 1 from jsonb_array_elements(v_frames) fr where fr ->> 'memoryId' = m.id::text
      )
  ), '[]'::jsonb);

  -- The line-of-the-year scene the current film shows (when no quote was
  -- chosen yet, that is the candidate to check).
  select (s.value ->> 'memoryId')::uuid
  into v_shown_quote
  from jsonb_array_elements(coalesce(v_film.film_script -> 'scenes', '[]'::jsonb)) s
  where s.value ->> 'type' = 'line'
    and (s.value ->> 'memoryId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  limit 1;

  select coalesce(jsonb_agg(candidate order by ord), '[]'::jsonb)
  into v_candidates
  from (
    select c.ordinality as ord,
           jsonb_build_object(
             'memoryId', c.value ->> 'memoryId',
             'textHash', c.value ->> 'textHash',
             'text', c.value ->> 'quote',
             'speakerName', fm.name,
             'isCurrent', case
               when v_chosen is not null
                 then c.value ->> 'memoryId' = v_chosen ->> 'memoryId' and c.value ->> 'textHash' = v_chosen ->> 'textHash'
               else v_shown_quote is not null and c.value ->> 'memoryId' = v_shown_quote::text
             end
           ) as candidate
    from jsonb_array_elements(
           case when jsonb_typeof(v_film.quote_candidates) = 'array' then v_film.quote_candidates else '[]'::jsonb end
         ) with ordinality c
    left join public.family_members fm
      on fm.family_id = v_film.family_id
     and fm.id::text = c.value ->> 'speakerId'
    where jsonb_typeof(c.value) = 'object'
      and c.value ->> 'memoryId' is not null
      and c.value ->> 'textHash' is not null
      and coalesce(c.value ->> 'quote', '') <> ''
      and not ((c.value ->> 'memoryId') = any (v_removed::text[]))
    order by c.ordinality
    limit 3
  ) capped;

  return jsonb_build_object(
    'editable', true,
    'kind', v_film.kind,
    'editsVersion', v_film.edits_version,
    'musicBedId', coalesce(v_film.music_bed_id, v_film.edits ->> 'musicBedId'),
    'removedMemoryIds', to_jsonb(v_removed),
    'chosenQuote', v_chosen,
    'frames', v_frames,
    'quoteCandidates', v_candidates
  );
end;
$$;
revoke all on function public.get_year_film_edit_options(uuid) from public, anon, authenticated;
grant execute on function public.get_year_film_edit_options(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. save_year_film_edits: allow re-sending earlier removals
-- ---------------------------------------------------------------------------

-- p_edits: { removedMemoryIds?: uuid[], quote?: {memoryId, textHash} | null,
-- musicBedId?: text }. Owner/manager; billing; fair use (5/film/day,
-- 20/family/day); CAS ready -> queued. Removing content blocks the current
-- video until the new film publishes. removedMemoryIds is the FULL set: each
-- id must be referenced by the current film OR already removed by an earlier
-- edit (the re-rendered film no longer references those).
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
