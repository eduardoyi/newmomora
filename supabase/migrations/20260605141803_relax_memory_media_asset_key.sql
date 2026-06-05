-- Relax ordered media asset key validation so the RPC matches storage upload
-- validation and does not depend on client UI ids being UUIDs.

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
      asset_key ~ ('^' || expected_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
      or asset_key ~ ('^' || expected_prefix || '/media[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
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
