-- Persist display aspect ratios so virtualized timeline rows have their final
-- height before media loads. Existing rows remain nullable until backfilled.

alter table public.memory_media
  add column aspect_ratio double precision;

alter table public.memory_media
  add constraint memory_media_aspect_ratio_range
  check (aspect_ratio is null or aspect_ratio between 0.1 and 10);

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
  target_family_id uuid;
  asset_count integer;
  asset jsonb;
  asset_index integer;
  asset_key text;
  asset_content_type text;
  asset_duration_ms integer;
  asset_aspect_ratio double precision;
  caller_prefix text;
  first_key text;
  first_content_type text;
  existing_keys text[];
  existing_aspect_ratios jsonb;
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

  select m.family_id into target_family_id
  from public.memories m
  where m.id = target_memory_id
    and m.memory_type = 'media';

  if target_family_id is null then
    raise exception 'Memory not found' using errcode = 'P0002';
  end if;

  if not public.has_family_role(target_family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  caller_prefix := current_user_id::text || '/memories/' || target_memory_id::text;

  -- Preserve metadata when an older client edits an existing media memory
  -- without sending the newly added aspectRatio field.
  select
    coalesce(array_agg(object_key), '{}'),
    coalesce(jsonb_object_agg(object_key, aspect_ratio), '{}'::jsonb)
  into existing_keys, existing_aspect_ratios
  from public.memory_media
  where memory_id = target_memory_id;

  delete from public.memory_media
  where memory_id = target_memory_id;

  for asset, asset_index in
    select value, ordinality - 1
    from jsonb_array_elements(assets) with ordinality
  loop
    asset_key := asset->>'objectKey';
    asset_content_type := asset->>'contentType';
    asset_duration_ms := nullif(asset->>'durationMs', '')::integer;
    asset_aspect_ratio := coalesce(
      nullif(asset->>'aspectRatio', '')::double precision,
      nullif(existing_aspect_ratios->>asset_key, 'null')::double precision
    );

    if asset_key is null or asset_content_type is null then
      raise exception 'Each media asset requires objectKey and contentType' using errcode = '22023';
    end if;

    if asset_aspect_ratio is not null
      and not (asset_aspect_ratio between 0.1 and 10)
    then
      raise exception 'Invalid media aspect ratio' using errcode = '22023';
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
      asset_key = any(existing_keys)
      or asset_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
      or asset_key ~ ('^' || caller_prefix || '/media[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
    ) then
      raise exception 'Invalid media object key' using errcode = '22023';
    end if;

    insert into public.memory_media (
      memory_id,
      object_key,
      content_type,
      duration_ms,
      aspect_ratio,
      position
    ) values (
      target_memory_id,
      asset_key,
      asset_content_type,
      asset_duration_ms,
      asset_aspect_ratio,
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
  where id = target_memory_id;
end;
$$;
