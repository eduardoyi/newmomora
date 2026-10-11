-- Emoji reactions on memories (docs/plans/emoji-reactions.md).
--
-- A reaction is still exactly one memory_likes row (PK memory_id, user_id), so
-- every existing consumer (like counts, the Memory Book best-of signal, the
-- family-activity insert/delete triggers, old app builds calling
-- set_memory_like) keeps working untouched. This migration only ADDS:
--   * memory_likes.emoji / updated_at (existing rows backfill to the heart)
--   * set_memory_reaction RPC (the only writer of a non-default emoji)
--   * memory_top_reactions helper (internal)
--   * appended outputs on get_memory_engagement / get_family_activity
-- No existing output column is renamed, removed or reordered.

-- ---------------------------------------------------------------------------
-- 1. Columns + constraint
-- ---------------------------------------------------------------------------

alter table public.memory_likes
  add column emoji text not null default U&'\2764\FE0F',
  add column updated_at timestamptz not null default now();

-- Bounds abuse only; the client only offers real emoji. Same rule is applied
-- (after trimming) by set_memory_reaction and by the app's isValidReaction.
alter table public.memory_likes
  add constraint memory_likes_emoji_valid
  check (
    char_length(emoji) between 1 and 16
    and emoji !~ '[[:space:][:cntrl:]]'
  );

-- ---------------------------------------------------------------------------
-- 2. memory_top_reactions: up to 3 distinct emojis, count desc then most
--    recently used. Internal -- only called from security-definer functions.
-- ---------------------------------------------------------------------------

create or replace function public.memory_top_reactions(target_memory_id uuid)
returns text[]
language sql
security definer
stable
set search_path = public
as $$
  select array(
    select ml.emoji
    from public.memory_likes ml
    where ml.memory_id = target_memory_id
    group by ml.emoji
    order by count(*) desc, max(ml.updated_at) desc, ml.emoji
    limit 3
  );
$$;

revoke all on function public.memory_top_reactions(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. set_memory_reaction (guards copied from set_memory_like,
--    20260801150000_paid_subscription_hardening.sql)
--
-- reaction null  -> remove the caller's reaction
-- reaction text  -> set/replace it (one reaction per person per memory)
--
-- The OUT column for the caller's current emoji is named my_reaction, not
-- reaction: Postgres rejects an OUT parameter that shares a name with an input
-- parameter, and the input must stay `reaction`.
-- ---------------------------------------------------------------------------

create or replace function public.set_memory_reaction(target_memory_id uuid, reaction text)
returns table (
  my_reaction text,
  changed boolean,
  inserted boolean,
  like_count bigint,
  top_reactions text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_family_id uuid;
  affected_rows integer;
  cleaned text;
  was_inserted boolean := false;
  was_changed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.is_anonymous_user() then
    raise exception 'Anonymous accounts cannot react to memories' using errcode = '42501';
  end if;

  select m.family_id into target_family_id
  from public.memories m
  where m.id = target_memory_id;
  if target_family_id is null then
    raise exception 'Memory not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.family_memberships fm
    where fm.family_id = target_family_id and fm.user_id = auth.uid()
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if reaction is not null then
    cleaned := regexp_replace(reaction, '^[[:space:]]+|[[:space:]]+$', '', 'g');
    if char_length(cleaned) not between 1 and 16
       or cleaned ~ '[[:space:][:cntrl:]]' then
      raise exception 'Invalid reaction' using errcode = '22023';
    end if;
    if not public.billing_engagement_allowed(target_family_id, auth.uid()) then
      raise exception 'Subscription required for engagement' using errcode = 'P0001';
    end if;

    -- A change is an UPDATE, so the insert-only memory_liked activity trigger
    -- does not fire again; xmax = 0 identifies a freshly inserted row.
    insert into public.memory_likes as ml (memory_id, user_id, emoji)
    values (target_memory_id, auth.uid(), cleaned)
    on conflict (memory_id, user_id) do update
      set emoji = excluded.emoji, updated_at = now()
      where ml.emoji is distinct from excluded.emoji
    returning (ml.xmax = 0) into was_inserted;
    was_changed := found;
    was_inserted := coalesce(was_inserted, false);
  else
    delete from public.memory_likes ml
    where ml.memory_id = target_memory_id and ml.user_id = auth.uid();
    get diagnostics affected_rows = row_count;
    was_changed := affected_rows > 0;
  end if;

  return query
  select
    (select ml.emoji from public.memory_likes ml
      where ml.memory_id = target_memory_id and ml.user_id = auth.uid()),
    was_changed,
    was_inserted,
    (select count(*) from public.memory_likes ml where ml.memory_id = target_memory_id),
    public.memory_top_reactions(target_memory_id);
end;
$$;

revoke all on function public.set_memory_reaction(uuid, text) from public, anon, authenticated;
grant execute on function public.set_memory_reaction(uuid, text) to authenticated;

-- set_memory_like is intentionally NOT recreated: should_like = true inserts
-- with the column default (heart) and `on conflict do nothing` leaves an
-- existing reaction (e.g. a laugh) untouched; should_like = false deletes.

-- ---------------------------------------------------------------------------
-- 4. get_memory_engagement: append my_reaction + top_reactions. Body and
--    guards from 20260729130000_onboarding_anonymous_lockdown.sql.
-- ---------------------------------------------------------------------------

drop function if exists public.get_memory_engagement(uuid[]);

create function public.get_memory_engagement(memory_ids uuid[])
returns table (
  memory_id uuid,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean,
  my_reaction text,
  top_reactions text[]
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
    ),
    (
      select mine.emoji from public.memory_likes mine
      where mine.memory_id = m.id and mine.user_id = auth.uid()
    ),
    public.memory_top_reactions(m.id)
  from public.memories m
  where m.id = any(memory_ids)
    and not public.is_anonymous_user()
    and public.is_family_member(m.family_id);
$$;

revoke all on function public.get_memory_engagement(uuid[]) from public, anon, authenticated;
grant execute on function public.get_memory_engagement(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. get_family_activity (v1, old builds) and get_family_activity_v2 (current
--    app): append reaction_emoji. Everything else is byte-identical to
--    20260930120000_year_films_p2.sql (v1 and v2 are both defined there;
--    20261014120000_artwork_memories.sql left both unchanged).
-- ---------------------------------------------------------------------------

drop function if exists public.get_family_activity(uuid);

create function public.get_family_activity(target_family_id uuid)
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
  memory_media_preview_key text,
  memory_type text,
  memory_emotion text,
  memory_illustration_generation_id uuid,
  comment_id uuid,
  comment_snippet text,
  invite_id uuid,
  reaction_emoji text
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
    (
      select mm.preview_object_key
      from public.memory_media mm
      where mm.memory_id = m.id and mm.position = 0
    ) as memory_media_preview_key,
    m.memory_type,
    m.emotion as memory_emotion,
    m.illustration_generation_id as memory_illustration_generation_id,
    e.comment_id,
    left(c.content, 120) as comment_snippet,
    e.invite_id,
    ml.emoji as reaction_emoji
  from public.family_activity_events e
  left join public.user_profiles up on up.id = e.actor_id
  left join public.memories m on m.id = e.memory_id
  left join public.memory_comments c on c.id = e.comment_id
  left join public.memory_likes ml
    on e.kind = 'memory_liked'
    and ml.memory_id = e.memory_id
    and ml.user_id = e.like_user_id
  where e.family_id = target_family_id
    and e.kind <> 'film_ready'
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

drop function if exists public.get_family_activity_v2(uuid);

create function public.get_family_activity_v2(target_family_id uuid)
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
  memory_media_preview_key text,
  memory_type text,
  memory_emotion text,
  memory_illustration_generation_id uuid,
  comment_id uuid,
  comment_snippet text,
  invite_id uuid,
  film_id uuid,
  film_kind text,
  film_member_id uuid,
  film_age_year integer,
  film_scope_start date,
  reaction_emoji text
)
language plpgsql
security definer
stable
set search_path = ''
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
    (
      e.actor_id is not null
      and not exists (
        select 1 from public.family_memberships fm
        where fm.family_id = target_family_id and fm.user_id = e.actor_id
      )
    ) as actor_is_former,
    e.memory_id,
    m.creation_source as memory_creation_source,
    left(coalesce(nullif(btrim(m.content), ''), nullif(btrim(m.audio_transcript), '')), 80) as memory_excerpt,
    m.illustration_key as memory_illustration_key,
    m.media_key as memory_media_key,
    m.media_content_type as memory_media_content_type,
    (
      select mm.preview_object_key
      from public.memory_media mm
      where mm.memory_id = m.id and mm.position = 0
    ) as memory_media_preview_key,
    m.memory_type,
    m.emotion as memory_emotion,
    m.illustration_generation_id as memory_illustration_generation_id,
    e.comment_id,
    left(c.content, 120) as comment_snippet,
    e.invite_id,
    yf.id as film_id,
    yf.kind as film_kind,
    yf.family_member_id as film_member_id,
    yf.age_year as film_age_year,
    yf.scope_start_date as film_scope_start,
    ml.emoji as reaction_emoji
  from public.family_activity_events e
  left join public.user_profiles up on up.id = e.actor_id
  left join public.memories m on m.id = e.memory_id
  left join public.memory_comments c on c.id = e.comment_id
  left join public.year_films yf on yf.id = e.film_id
  left join public.memory_likes ml
    on e.kind = 'memory_liked'
    and ml.memory_id = e.memory_id
    and ml.user_id = e.like_user_id
  where e.family_id = target_family_id
    and e.actor_id is distinct from auth.uid()
    and (
      e.kind <> 'member_pending'
      or public.has_family_role(target_family_id, array['owner', 'manager'])
    )
    and (
      e.kind <> 'film_ready'
      or (
        yf.id is not null
        and yf.video_key is not null
        and not yf.blocked
        and not yf.forced
        and yf.surface_at <= now()
      )
    )
    -- Recipients who blocked the actor never see that actor's events
    -- (see get_family_activity). A NULL actor (film_ready) matches nothing.
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

revoke all on function public.get_family_activity_v2(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activity_v2(uuid) to authenticated;
