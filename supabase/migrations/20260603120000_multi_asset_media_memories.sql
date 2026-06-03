-- Multi-asset media memories: ordered photo/video assets per media memory.

create table public.memory_media (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.memories on delete cascade,
  object_key text not null,
  content_type text not null
    check (content_type in (
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/heif',
      'image/webp',
      'video/mp4',
      'video/quicktime'
    )),
  duration_ms integer check (duration_ms is null or duration_ms > 0),
  position integer not null check (position >= 0 and position < 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (memory_id, position),
  unique (memory_id, object_key)
);

create index idx_memory_media_memory_id_position
  on public.memory_media (memory_id, position);

alter table public.memory_media enable row level security;

create policy "Users can view own memory media"
  on public.memory_media for select
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and m.user_id = auth.uid()
    )
  );

create policy "Users can insert own memory media"
  on public.memory_media for insert
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and m.user_id = auth.uid()
    )
    and object_key like auth.uid()::text || '/memories/%'
  );

create policy "Users can update own memory media"
  on public.memory_media for update
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
    and object_key like auth.uid()::text || '/memories/%'
  );

create policy "Users can delete own memory media"
  on public.memory_media for delete
  using (
    exists (
      select 1 from public.memories m
      where m.id = memory_id and m.user_id = auth.uid()
    )
  );

create trigger set_memory_media_updated_at
  before update on public.memory_media
  for each row execute function public.set_updated_at();

insert into public.memory_media (memory_id, object_key, content_type, position)
select id, media_key, media_content_type, 0
from public.memories
where memory_type = 'media'
  and media_key is not null
  and media_content_type is not null
  and not exists (
    select 1 from public.memory_media mm
    where mm.memory_id = memories.id
  );

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
  asset_count integer;
  asset jsonb;
  asset_index integer;
  asset_key text;
  asset_content_type text;
  asset_duration_ms integer;
  expected_prefix text;
  first_key text;
  first_content_type text;
begin
  if current_user_id is null then
    raise exception 'Unauthorized' using errcode = '28000';
  end if;

  if jsonb_typeof(assets) <> 'array' then
    raise exception 'assets must be an array' using errcode = '22023';
  end if;

  asset_count := jsonb_array_length(assets);

  if asset_count < 1 or asset_count > 10 then
    raise exception 'Media memories require 1 to 10 assets' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.memories m
    where m.id = target_memory_id
      and m.user_id = current_user_id
      and m.memory_type = 'media'
  ) then
    raise exception 'Memory not found' using errcode = 'P0002';
  end if;

  expected_prefix := current_user_id::text || '/memories/' || target_memory_id::text;

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
      asset_key ~ ('^' || expected_prefix || '/media/[0-9a-fA-F-]{36}\\.(jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
      or asset_key ~ ('^' || expected_prefix || '/media\\.(jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
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
  where id = target_memory_id
    and user_id = current_user_id;
end;
$$;
