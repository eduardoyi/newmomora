-- The paid-subscription hardening migration intentionally removed direct
-- client UPDATE privileges for server-managed memories columns. The media
-- finalization RPC still needs to publish the canonical media key and clear
-- its onboarding hand-off fields after validating the caller, family role,
-- billing access, and object-key ownership.
--
-- Keep those columns protected from direct PostgREST updates. The RPC already
-- performs its own authorization and input validation, so run only this
-- narrowly scoped operation as its owner instead of restoring broad client
-- column privileges.
alter function public.replace_memory_media_assets(uuid, jsonb) security definer;

-- Keep the RPC callable only through an authenticated JWT. The function body
-- retains the anonymous, family-role, billing, and object-key checks.
revoke all on function public.replace_memory_media_assets(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_memory_media_assets(uuid, jsonb) to authenticated;
