-- Audio memories v2: store each clip's real loudness contour.
--
-- docs/plans/audio-trim-import.md ("Data model"). Audio surfaces (card,
-- detail, composer chip, calendar stamp, ...) draw a decorative seeded line
-- today; v2 draws the clip's real waveform. The contour is measured on the
-- device (or by the backfill script for existing clips) and stored here as
-- 16-256 loudness buckets, each an integer 0-255 (the app writes 64).
--
-- 1. memory_media.waveform smallint[] (nullable; NULL = no contour known, the
--    UI falls back to the seeded line). The CHECK is the real guard:
--    `authenticated` holds a table-level UPDATE grant on memory_media gated
--    only by RLS (TECH_SPEC §2), so the RPC is not the sole writer. The
--    array_position guard matters because `0 <= all(waveform)` evaluates to
--    NULL -- i.e. passes a CHECK -- when an element is NULL.
--
-- 2. replace_memory_media_assets is recreated from
--    20260820100000_audio_memory_media_rpc.sql (the latest definition; no
--    later migration redefines it) with every existing check, the
--    SECURITY DEFINER switch and the grants unchanged. It additionally:
--      * reads asset->'waveform' and stores it only when it is a jsonb array
--        of 16-256 integers in 0-255 AND the asset is an audio content type;
--      * stores NULL for anything else and NEVER raises for a bad waveform.
--        The field is cosmetic; the client upload queue retries an
--        identical payload forever, so raising would permanently fail a
--        child's clip save over a decoration;
--      * when the incoming waveform is absent/null and the object_key
--        matches an existing row, keeps that row's waveform (the RPC deletes
--        and re-inserts every row, same preservation pattern as
--        aspect_ratio / preview_object_key via an existing_waveforms map).
--        An old client that re-saves an unchanged clip without a waveform
--        therefore cannot erase the contour.
--
-- Backward compatible: new nullable column; payloads from older clients
-- carry no `waveform` key and behave exactly as before.

alter table public.memory_media add column waveform smallint[];

alter table public.memory_media add constraint memory_media_waveform_valid check (
  waveform is null or (
    cardinality(waveform) between 16 and 256
    and array_position(waveform, null) is null
    and 0 <= all(waveform)
    and 255 >= all(waveform)
  )
);

create or replace function public.replace_memory_media_assets(target_memory_id uuid, assets jsonb)
returns void language plpgsql set search_path = public as $$
declare
  current_user_id uuid := auth.uid();
  target_family_id uuid;
  target_onboarding_media_pending boolean;
  target_onboarding_media_pending_until timestamptz;
  asset_count integer;
  asset jsonb;
  asset_index integer;
  asset_key text;
  asset_content_type text;
  asset_duration_ms integer;
  asset_aspect_ratio double precision;
  asset_preview_object_key text;
  asset_waveform_json jsonb;
  asset_waveform smallint[];
  caller_prefix text;
  first_key text;
  first_content_type text;
  existing_keys text[];
  existing_aspect_ratios jsonb;
  existing_preview_object_keys jsonb;
  existing_waveforms jsonb;
begin
  if current_user_id is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() then raise exception 'Anonymous accounts cannot modify memory media' using errcode = '42501'; end if;
  if jsonb_typeof(assets) <> 'array' then raise exception 'assets must be an array' using errcode = '22023'; end if;
  asset_count := jsonb_array_length(assets);
  if asset_count < 1 or asset_count > 10 then raise exception 'Media memories require 1 to 10 assets' using errcode = '22023'; end if;

  select m.family_id, m.onboarding_media_pending, m.onboarding_media_pending_until
  into target_family_id, target_onboarding_media_pending, target_onboarding_media_pending_until
  from public.memories m where m.id = target_memory_id and m.memory_type in ('media', 'audio');
  if target_family_id is null then raise exception 'Memory not found' using errcode = 'P0002'; end if;
  if not public.has_family_role(target_family_id, array['owner', 'manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not public.billing_write_allowed_for_current_user(target_family_id)
     and not (target_onboarding_media_pending and target_onboarding_media_pending_until > transaction_timestamp()) then
    raise exception 'Subscription required for media writes' using errcode = 'P0001';
  end if;

  caller_prefix := current_user_id::text || '/memories/' || target_memory_id::text;
  select coalesce(array_agg(object_key), '{}'),
    coalesce(jsonb_object_agg(object_key, aspect_ratio), '{}'::jsonb),
    coalesce(jsonb_object_agg(object_key, preview_object_key), '{}'::jsonb),
    coalesce(jsonb_object_agg(object_key, waveform), '{}'::jsonb)
  into existing_keys, existing_aspect_ratios, existing_preview_object_keys, existing_waveforms
  from public.memory_media where memory_id = target_memory_id;
  delete from public.memory_media where memory_id = target_memory_id;

  for asset, asset_index in select value, ordinality - 1 from jsonb_array_elements(assets) with ordinality loop
    asset_key := asset->>'objectKey';
    asset_content_type := asset->>'contentType';
    asset_duration_ms := round(nullif(asset->>'durationMs', '')::numeric)::integer;
    asset_aspect_ratio := coalesce(nullif(asset->>'aspectRatio', '')::double precision, nullif(existing_aspect_ratios->>asset_key, 'null')::double precision);
    asset_preview_object_key := coalesce(nullif(asset->>'previewObjectKey', ''), nullif(existing_preview_object_keys->>asset_key, 'null'));
    if asset_key is null or asset_content_type is null then raise exception 'Each media asset requires objectKey and contentType' using errcode = '22023'; end if;
    if asset_aspect_ratio is not null and not (asset_aspect_ratio between 0.1 and 10) then raise exception 'Invalid media aspect ratio' using errcode = '22023'; end if;
    if asset_content_type not in ('image/jpeg','image/png','image/heic','image/heif','image/webp','video/mp4','video/quicktime','audio/mp4','audio/m4a','audio/x-m4a') then raise exception 'Unsupported media content type' using errcode = '22023'; end if;
    if not (asset_key = any(existing_keys) or asset_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov|m4a)$') or asset_key ~ ('^' || caller_prefix || '/media[.](jpg|jpeg|png|heic|heif|webp|mp4|mov|m4a)$')) then raise exception 'Invalid media object key' using errcode = '22023'; end if;
    if asset_preview_object_key is not null and not (
      coalesce(asset_preview_object_key = nullif(existing_preview_object_keys->>asset_key, 'null'), false)
      or asset_preview_object_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')
    ) then raise exception 'Invalid preview object key' using errcode = '22023'; end if;

    -- Waveform: audio only; invalid input degrades to NULL, never an error.
    asset_waveform := null;
    if asset_content_type in ('audio/mp4', 'audio/m4a', 'audio/x-m4a') then
      asset_waveform_json := asset->'waveform';
      if asset_waveform_json is null or jsonb_typeof(asset_waveform_json) = 'null' then
        -- Absent/null in the payload: keep the contour already stored for this key.
        asset_waveform_json := nullif(existing_waveforms->asset_key, 'null'::jsonb);
      end if;
      begin
        if jsonb_typeof(asset_waveform_json) = 'array'
           and jsonb_array_length(asset_waveform_json) between 16 and 256
           and not exists (
             select 1 from jsonb_array_elements(asset_waveform_json) as el
             where case
               when jsonb_typeof(el) <> 'number' then true
               else (el #>> '{}')::numeric <> trunc((el #>> '{}')::numeric)
                 or (el #>> '{}')::numeric < 0
                 or (el #>> '{}')::numeric > 255
             end
           ) then
          select array_agg((el #>> '{}')::numeric::smallint order by ord)
          into asset_waveform
          from jsonb_array_elements(asset_waveform_json) with ordinality as t(el, ord);
        end if;
      exception when others then
        asset_waveform := null;
      end;
    end if;

    insert into public.memory_media (memory_id, object_key, content_type, duration_ms, aspect_ratio, preview_object_key, waveform, position)
    values (target_memory_id, asset_key, asset_content_type, asset_duration_ms, asset_aspect_ratio, asset_preview_object_key, asset_waveform, asset_index);
    if asset_index = 0 then first_key := asset_key; first_content_type := asset_content_type; end if;
  end loop;

  update public.memories
  set media_key = first_key,
      media_content_type = first_content_type,
      onboarding_attributed = false,
      onboarding_media_pending = false,
      onboarding_media_pending_until = null,
      updated_at = now()
  where id = target_memory_id;
end;
$$;

alter function public.replace_memory_media_assets(uuid, jsonb) security definer;
revoke all on function public.replace_memory_media_assets(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_memory_media_assets(uuid, jsonb) to authenticated;
