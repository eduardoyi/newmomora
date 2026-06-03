-- Momora initial schema: tables, indexes, RLS, triggers

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.user_profiles (
  id uuid references auth.users primary key,
  name text not null,
  timezone text not null default 'UTC',
  illustration_style text not null default 'default',
  enable_daily_reminder boolean not null default false,
  notification_time time,
  expo_push_token text,
  has_completed_onboarding boolean not null default false,
  deleted_at timestamptz,
  scheduled_hard_delete_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.family_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  name text not null,
  nicknames text[] default '{}',
  date_of_birth date,
  gender text,
  profile_picture_key text,
  illustrated_profile_key text,
  illustrated_profile_status text not null default 'pending'
    check (illustrated_profile_status in ('pending', 'generating', 'ready', 'failed')),
  additional_info text,
  is_user_profile boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  content text not null,
  memory_date date not null default current_date,
  emotion text,
  illustration_key text,
  illustration_status text not null default 'pending'
    check (illustration_status in ('pending', 'generating', 'ready', 'failed')),
  illustration_prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memories_content_not_empty check (trim(content) <> '')
);

create table public.memory_family_members (
  memory_id uuid references public.memories on delete cascade,
  family_member_id uuid references public.family_members on delete cascade,
  primary key (memory_id, family_member_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index idx_family_members_user_id on public.family_members (user_id);
create index idx_memories_user_id on public.memories (user_id);
create index idx_memories_memory_date on public.memories (user_id, memory_date desc);
create index idx_memories_content_search on public.memories using gin (to_tsvector('english', content));
create index idx_user_profiles_scheduled_delete on public.user_profiles (scheduled_hard_delete_at)
  where scheduled_hard_delete_at is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.user_profiles enable row level security;
alter table public.family_members enable row level security;
alter table public.memories enable row level security;
alter table public.memory_family_members enable row level security;

create policy "Users can view own profile"
  on public.user_profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on public.user_profiles for update using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.user_profiles for insert with check (auth.uid() = id);

create policy "Users can CRUD own family members"
  on public.family_members for all using (auth.uid() = user_id);

create policy "Users can CRUD own memories"
  on public.memories for all using (auth.uid() = user_id);

create policy "Users can CRUD own memory tags"
  on public.memory_family_members for all
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and m.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and m.user_id = auth.uid()
    )
    and exists (
      select 1 from public.family_members fm
      where fm.id = family_member_id and fm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

create trigger set_family_members_updated_at
  before update on public.family_members
  for each row execute function public.set_updated_at();

create trigger set_memories_updated_at
  before update on public.memories
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_profiles (id, name, timezone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', 'Parent'),
    coalesce(new.raw_user_meta_data->>'timezone', 'UTC')
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.enforce_memory_tag_limit()
returns trigger as $$
begin
  if (
    select count(*)
    from public.memory_family_members
    where memory_id = new.memory_id
  ) >= 4 then
    raise exception 'Maximum 4 family members per memory';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger memory_family_members_tag_limit
  before insert on public.memory_family_members
  for each row execute function public.enforce_memory_tag_limit();
