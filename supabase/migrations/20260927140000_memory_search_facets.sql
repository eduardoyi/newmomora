-- Timeline search, round 2 (docs/features/memory-search.md):
--   * several people at once: p_member_ids uuid[] -- a memory must tag ALL
--     of them ("memories where Enzo and Mara are both tagged");
--   * chip counts (search_memory_facets) so the app can hide people/feelings
--     with no memories at all and dim ones that would give zero results
--     under the current text + filters.
--
-- search_memories keeps its old p_member_id parameter (deprecated) so app
-- builds still running the previous update keep working. It is replaced,
-- not overloaded: two overloads sharing p_family_id/p_query would make
-- PostgREST's call resolution ambiguous for text-only searches.

-- True when memory `p_memory_id` tags every member in `p_member_ids`
-- (vacuously true for null/empty).
create or replace function public.memory_tags_all_members(p_memory_id uuid, p_member_ids uuid[])
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(cardinality(p_member_ids), 0) = 0
    or (
      select count(distinct t.family_member_id)
      from public.memory_family_members t
      where t.memory_id = p_memory_id
        and t.family_member_id = any(p_member_ids)
    ) = cardinality(array(select distinct unnest(p_member_ids)))
$$;

drop function if exists public.search_memories(uuid, text, uuid, text, integer, integer);

create function public.search_memories(
  p_family_id uuid,
  p_query text default null,
  p_member_id uuid default null,
  p_emotion text default null,
  p_limit integer default 30,
  p_offset integer default 0,
  p_member_ids uuid[] default null
)
returns table (memory_id uuid, matched_in text, score real)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_query tsquery := public.memory_search_query(p_query);
  -- p_member_id is the pre-multi-select parameter; fold it in.
  v_member_ids uuid[] := coalesce(p_member_ids, '{}'::uuid[])
    || case when p_member_id is null then '{}'::uuid[] else array[p_member_id] end;
begin
  if auth.uid() is null or not public.is_family_member(p_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_query is null and cardinality(v_member_ids) = 0 and nullif(p_emotion, '') is null then
    return;
  end if;

  return query
  select
    m.id,
    case
      when v_query is null then null
      when to_tsvector('simple'::regconfig, public.search_normalize(coalesce(m.content, ''))) @@ v_query then 'text'
      when to_tsvector('simple'::regconfig, public.search_normalize(coalesce(m.audio_transcript, ''))) @@ v_query then 'voice'
      when to_tsvector('simple'::regconfig, public.search_normalize(
        coalesce(m.content, '') || ' ' || coalesce(m.audio_transcript, ''))) @@ v_query then 'text'
      else 'details'
    end,
    case
      when v_query is null then 0::real
      else (ts_rank_cd(
          public.memory_search_document(m.content, m.audio_transcript, m.description, m.labels, m.topics),
          v_query)
        * (1 + 0.5 * exp(-greatest(current_date - m.memory_date, 0) / 365.0)))::real
    end as score
  from public.memories m
  where m.family_id = p_family_id
    and (v_query is null
      or public.memory_search_document(m.content, m.audio_transcript, m.description, m.labels, m.topics) @@ v_query)
    and public.memory_tags_all_members(m.id, v_member_ids)
    and (nullif(p_emotion, '') is null or m.emotion = p_emotion)
    and not exists (
      select 1 from public.blocked_family_accounts b
      where b.family_id = p_family_id
        and b.blocker_user_id = auth.uid()
        and b.blocked_user_id = m.user_id
    )
  order by score desc, m.memory_date desc, m.created_at desc, m.id
  limit least(greatest(coalesce(p_limit, 30), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.search_memories(uuid, text, uuid, text, integer, integer, uuid[]) from public, anon;
grant execute on function public.search_memories(uuid, text, uuid, text, integer, integer, uuid[]) to authenticated;

-- Chip counts for the search screen. One row per feeling and per family
-- member that has at least one visible memory in the family:
--   total_count    memories overall (the app hides chips where this is 0)
--   matching_count memories that would match if this chip were (also)
--                  chosen, given the current text and the OTHER filters:
--     feeling  -> text + all selected people (feelings are single-select,
--                 so the current feeling is ignored: its siblings stay
--                 comparable alternatives)
--     person   -> text + feeling + all selected people + this person
--                 (for a selected person that's simply the result count)
-- Same visibility rules as search_memories (family, blocked accounts).
create or replace function public.search_memory_facets(
  p_family_id uuid,
  p_query text default null,
  p_member_ids uuid[] default null,
  p_emotion text default null
)
returns table (facet text, value text, total_count integer, matching_count integer)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_query tsquery := public.memory_search_query(p_query);
  v_member_ids uuid[] := coalesce(p_member_ids, '{}'::uuid[]);
begin
  if auth.uid() is null or not public.is_family_member(p_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  with visible as (
    select m.id, m.emotion, m.content, m.audio_transcript, m.description, m.labels, m.topics
    from public.memories m
    where m.family_id = p_family_id
      and not exists (
        select 1 from public.blocked_family_accounts b
        where b.family_id = p_family_id
          and b.blocker_user_id = auth.uid()
          and b.blocked_user_id = m.user_id
      )
  ),
  text_matched as (
    select v.id, v.emotion
    from visible v
    where v_query is null
      or public.memory_search_document(v.content, v.audio_transcript, v.description, v.labels, v.topics) @@ v_query
  ),
  with_people as (
    select tm.id, tm.emotion
    from text_matched tm
    where public.memory_tags_all_members(tm.id, v_member_ids)
  ),
  emotion_totals as (
    select v.emotion, count(*)::integer as total
    from visible v
    where v.emotion is not null
    group by v.emotion
  ),
  emotion_matches as (
    select wp.emotion, count(*)::integer as matching
    from with_people wp
    where wp.emotion is not null
    group by wp.emotion
  ),
  member_totals as (
    select t.family_member_id, count(*)::integer as total
    from visible v
    join public.memory_family_members t on t.memory_id = v.id
    group by t.family_member_id
  ),
  member_matches as (
    select t.family_member_id, count(*)::integer as matching
    from with_people wp
    join public.memory_family_members t on t.memory_id = wp.id
    where nullif(p_emotion, '') is null or wp.emotion = p_emotion
    group by t.family_member_id
  )
  select 'emotion'::text, et.emotion, et.total, coalesce(em.matching, 0)
  from emotion_totals et
  left join emotion_matches em on em.emotion = et.emotion
  union all
  select 'member'::text, mt.family_member_id::text, mt.total, coalesce(mm.matching, 0)
  from member_totals mt
  left join member_matches mm on mm.family_member_id = mt.family_member_id;
end;
$$;

revoke all on function public.search_memory_facets(uuid, text, uuid[], text) from public, anon;
grant execute on function public.search_memory_facets(uuid, text, uuid[], text) to authenticated;
