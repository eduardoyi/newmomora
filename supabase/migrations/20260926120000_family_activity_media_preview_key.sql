-- Family activity sheet thumbnails load the list-sized preview instead of
-- the full-resolution original (same Workstream C preview variant the
-- timeline MemoryCard already prefers, see
-- 20260715140000_memory_media_preview_key.sql). Adds
-- `memory_media_preview_key`: the cover asset's (position 0)
-- `preview_object_key` -- a <=1280px JPEG for photos, the first-frame
-- poster JPEG for videos -- or null for legacy rows without one. The client
-- falls back to the original `memory_media_key` only for image content types.
--
-- The return table changes shape, so the function must be dropped and
-- recreated (create or replace cannot alter OUT columns). Body is otherwise
-- identical to 20260822100000_family_activity.sql.

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
    (
      select mm.preview_object_key
      from public.memory_media mm
      where mm.memory_id = m.id and mm.position = 0
    ) as memory_media_preview_key,
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
