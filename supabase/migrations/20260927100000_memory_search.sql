-- Timeline search (docs/features/memory-search.md).
--
-- One weighted, language-neutral search document per memory, plus a
-- search_memories RPC the Timeline's search screen calls. Replaces the
-- unshipped client-side searchMemories (three English-FTS queries merged in
-- the app, with no family filter).
--
--   A  what people wrote       content
--   B  what was said           audio_transcript (never displayed)
--   C  what the AI saw          description, labels, topics
--
-- 'simple' config + unaccent: no English stemming/stopwords (families write
-- in Spanish, English and mixes of both), case- and accent-insensitive
-- ("cafe" finds "café", "nino" finds "niño").

create extension if not exists unaccent with schema extensions;

-- Immutable wrapper: unaccent() itself is only STABLE (its dictionary could
-- in principle change), which index expressions reject. Pinning the
-- dictionary makes the result deterministic.
create or replace function public.search_normalize(value text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, value))
$$;

-- Declared immutable so it can back an index; array_to_string is only
-- STABLE in general but is deterministic for text[].
create or replace function public.memory_search_document(
  p_content text,
  p_audio_transcript text,
  p_description text,
  p_labels text[],
  p_topics text[]
)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    setweight(to_tsvector('simple'::regconfig, public.search_normalize(coalesce(p_content, ''))), 'A')
    || setweight(to_tsvector('simple'::regconfig, public.search_normalize(coalesce(p_audio_transcript, ''))), 'B')
    || setweight(to_tsvector('simple'::regconfig, public.search_normalize(
         coalesce(p_description, '') || ' '
         || coalesce(array_to_string(p_labels, ' '), '') || ' '
         -- topic ids are slugs ("first-steps"); make each word searchable
         || replace(coalesce(array_to_string(p_topics, ' '), ''), '-', ' ')
       )), 'C')
$$;

-- An expression index rather than a stored column: a tsvector column would
-- ride along on every `select *` from memories (timeline pages, widgets...),
-- and adding it would rewrite the table. search_memories repeats this exact
-- expression so the planner uses the index.
create index idx_memories_search_document on public.memories using gin (
  public.memory_search_document(content, audio_transcript, description, labels, topics)
);

-- The per-column English FTS indexes only served the unshipped client
-- search this replaces.
drop index if exists public.idx_memories_content_search;
drop index if exists public.idx_memories_audio_transcript_search;

-- Turns free text into a prefix-matching AND query: every word must match,
-- each as a prefix so results appear while typing ("cumple" finds
-- "cumpleaños"). Punctuation is dropped, so user input can never produce
-- invalid tsquery syntax. At most 8 words. Null when there are no words.
create or replace function public.memory_search_query(p_text text)
returns tsquery
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when count(*) = 0 then null
    else to_tsquery('simple'::regconfig, string_agg(word || ':*', ' & ' order by position))
  end
  from (
    select word, position
    from unnest(regexp_split_to_array(public.search_normalize(coalesce(p_text, '')), '[^[:alnum:]]+'))
      with ordinality as words(word, position)
    where word <> ''
    order by position
    limit 8
  ) words
$$;

-- Returns matching memory ids for one family, best first, a page at a time.
-- Text, person and feeling filters combine with AND; with no text, results
-- are newest first. `matched_in` says why a text search matched:
-- 'text' (what people wrote), 'voice' (the hidden transcript -- the app
-- shows "Matched what was said", never the transcript), or 'details' (AI
-- description/labels/topics). Security invoker: memories RLS applies on
-- top of the explicit membership check. Memories by accounts the caller
-- blocked in this family are excluded, like the timeline.
create or replace function public.search_memories(
  p_family_id uuid,
  p_query text default null,
  p_member_id uuid default null,
  p_emotion text default null,
  p_limit integer default 30,
  p_offset integer default 0
)
returns table (memory_id uuid, matched_in text, score real)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_query tsquery := public.memory_search_query(p_query);
begin
  if auth.uid() is null or not public.is_family_member(p_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_query is null and p_member_id is null and nullif(p_emotion, '') is null then
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
      -- Relevance, gently boosted for recent memories (x1.5 today, fading
      -- over about a year) so equally good matches surface the newer one.
      else (ts_rank_cd(
          public.memory_search_document(m.content, m.audio_transcript, m.description, m.labels, m.topics),
          v_query)
        * (1 + 0.5 * exp(-greatest(current_date - m.memory_date, 0) / 365.0)))::real
    end as score
  from public.memories m
  where m.family_id = p_family_id
    and (v_query is null
      or public.memory_search_document(m.content, m.audio_transcript, m.description, m.labels, m.topics) @@ v_query)
    and (p_member_id is null or exists (
      select 1 from public.memory_family_members t
      where t.memory_id = m.id and t.family_member_id = p_member_id
    ))
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

revoke all on function public.search_memories(uuid, text, uuid, text, integer, integer) from public, anon;
grant execute on function public.search_memories(uuid, text, uuid, text, integer, integer) to authenticated;
