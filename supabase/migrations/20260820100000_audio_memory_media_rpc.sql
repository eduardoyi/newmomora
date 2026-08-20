-- Fix: replace_memory_media_assets rejects every audio memory save.
--
-- 20260819120000_audio_memories.sql widened memory_media.content_type's
-- CHECK constraint to admit 'audio/mp4', 'audio/m4a', 'audio/x-m4a', but
-- this SECURITY DEFINER RPC (the only write path for memory_media rows --
-- see createAudioMemory / continueCreateMemoryWithMedia in
-- src/services/memories.ts) was not updated to match. Three separate
-- hardcoded enumerations inside it independently reject an audio save:
--
--   1. The initial ownership/authorization lookup only recognizes
--      memory_type = 'media', so an audio memory's row is invisible to the
--      RPC and it raises 'Memory not found' (P0002).
--   2. The content-type allow-list only admits image/video MIME types, so
--      even once (1) is fixed it raises 'Unsupported media content type'.
--   3. The object-key shape regexes only admit
--      jpg/jpeg/png/heic/heif/webp/mp4/mov extensions, so a real client
--      object key ending in .m4a (see createAudioMemory's object key
--      convention, {userId}/memories/{memoryId}/media/{assetId}.m4a) would
--      still fail with 'Invalid media object key' after (1) and (2) are
--      fixed.
--
-- This is a complete recreation of the current production definition from
-- 20260815120000_fix_retained_foreign_media_preview_keys.sql, widened in
-- exactly those three places to also admit audio. The preview-object-key
-- regex is deliberately left untouched: audio memories have no preview
-- concept (memories_type_invariants requires the audio arm's media_key to
-- be the clip itself, and previewObjectKey is never sent by
-- createAudioMemory). Everything else, including the SECURITY DEFINER /
-- grant semantics, is byte-identical to that definition.
--
-- Sweep for siblings (per docs/plans/audio-memories-v1.md P2.4 follow-up):
-- grepped every SECURITY DEFINER function across supabase/migrations/*.sql
-- that touches memory_media or memories.media_content_type.
-- replace_memory_media_assets is the only one on the general client write
-- path. The gallery-import functions
-- (register_gallery_import_assets/record_gallery_import_approval_upload/
-- finalize_gallery_import_candidate in
-- 20260809130000_gallery_import_foundation.sql) also hardcode an
-- image-only content-type allow-list, but that is by design, not a bug:
-- gallery import sources originals from the device photo library, which
-- cannot contain audio clips, and docs/features/audio-memories.md /
-- docs/plans/audio-memories-v1.md do not scope audio into gallery import.
-- Left unchanged.

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
  caller_prefix text;
  first_key text;
  first_content_type text;
  existing_keys text[];
  existing_aspect_ratios jsonb;
  existing_preview_object_keys jsonb;
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
    coalesce(jsonb_object_agg(object_key, preview_object_key), '{}'::jsonb)
  into existing_keys, existing_aspect_ratios, existing_preview_object_keys
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
    insert into public.memory_media (memory_id, object_key, content_type, duration_ms, aspect_ratio, preview_object_key, position)
    values (target_memory_id, asset_key, asset_content_type, asset_duration_ms, asset_aspect_ratio, asset_preview_object_key, asset_index);
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
