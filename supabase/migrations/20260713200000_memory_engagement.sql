-- Memory likes, comments, and engagement notification preference.

alter table public.user_profiles
  add column notify_engagement boolean not null default true;

create table public.memory_likes (
  memory_id uuid not null references public.memories on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (memory_id, user_id)
);

create table public.memory_comments (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.memories on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  constraint memory_comments_content_length
    check (char_length(trim(content)) between 1 and 1000)
);

create index idx_memory_likes_user_id on public.memory_likes (user_id);
create index idx_memory_comments_memory_created_at
  on public.memory_comments (memory_id, created_at desc);
create index idx_memory_comments_user_id on public.memory_comments (user_id);

alter table public.memory_likes enable row level security;
alter table public.memory_comments enable row level security;

-- Like identities are private: clients may only read their own like row.
-- Aggregate counts are exposed by get_memory_engagement below.
create policy "Memory likes: select own" on public.memory_likes for select
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

create policy "Memory likes: insert own" on public.memory_likes for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

create policy "Memory likes: delete own" on public.memory_likes for delete
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

create policy "Memory comments: select" on public.memory_comments for select
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

create policy "Memory comments: insert own" on public.memory_comments for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.memories m
      where m.id = memory_id and public.is_family_member(m.family_id)
    )
  );

-- Authors may remove their own comments; owner/manager may moderate any
-- comment in the same specific family. Comments are intentionally immutable.
create policy "Memory comments: delete" on public.memory_comments for delete
  using (
    (
      user_id = auth.uid()
      and exists (
        select 1 from public.memories m
        where m.id = memory_id and public.is_family_member(m.family_id)
      )
    )
    or exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
    )
  );

-- Batch-friendly aggregate used by timeline/detail. It returns counts plus
-- the caller's own like state without exposing the family liker roster.
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
    and public.is_family_member(m.family_id);
$$;

-- Idempotent, race-safe set operation for optimistic clients. `changed`
-- distinguishes a real new like from a stale/repeated request so the client
-- only asks the notification function to send once.
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

revoke all on function public.get_memory_engagement(uuid[]) from public;
revoke all on function public.set_memory_like(uuid, boolean) from public;
grant execute on function public.get_memory_engagement(uuid[]) to authenticated;
grant execute on function public.set_memory_like(uuid, boolean) to authenticated;

-- Extend attribution names to former comment authors. Removed household
-- members retain their comments and display name; hard account deletion
-- cascades the comments themselves.
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
    union all
    select mc.user_id, mc.created_at
    from public.memory_comments mc
    join public.memories comment_memory on comment_memory.id = mc.memory_id
    where comment_memory.family_id = fam
  ) src
  join public.user_profiles up on up.id = src.user_id
  where src.user_id not in (
    select fm2.user_id from public.family_memberships fm2 where fm2.family_id = fam
  )
  group by up.id, up.name;
end;
$$;
