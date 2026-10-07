-- ROLLBACK for 20261009120000_keepsakes_overview.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/migrations on purpose).
-- Run it in one transaction; written to be re-runnable (IF EXISTS).
--
-- Drops keepsakes_overview and its internal pool helper. Nothing else
-- references them. Roll the app OTA back FIRST (or accept that the Keepsakes
-- tab degrades: the hook treats an RPC error as "no overview", so the recap
-- tile, order badges and previews simply disappear).

begin;

drop function if exists public.keepsakes_overview(uuid);
drop function if exists public.keepsake_pool(uuid, date, date, uuid, uuid, boolean, integer, boolean);

commit;
