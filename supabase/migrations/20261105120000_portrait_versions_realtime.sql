-- Supabase Realtime for portrait readiness. Adds
-- public.family_member_portrait_versions to the supabase_realtime publication
-- so postgres_changes events reach usePortraitVersionsRealtime
-- (src/hooks/usePortraitVersionsRealtime.ts), which replaces the always-on 3s
-- portrait poll with a push (the poll stays as the fallback while the channel
-- is not SUBSCRIBED). Same approach as 20260715150000_memories_realtime_publication.sql.
--
-- Access control: Realtime evaluates RLS for each subscriber on INSERT/UPDATE.
-- The existing "Portrait versions: select" policy
-- (public.is_family_member(family_id), 20260715120000_portrait_timeline.sql),
-- the restrictive "Portrait versions: deny anonymous" policy, and the
-- `grant select ... to authenticated` (20260731110000) already scope rows to
-- the same users that can read them through select('*') today. The client
-- uses the event only as a signal to refetch, never as row data.
--
-- Default REPLICA IDENTITY is sufficient: the handler reads only `payload.new`
-- (full row on INSERT/UPDATE) and never `payload.old`'s non-key columns. Not
-- changed here: FULL would bloat WAL for no benefit.
--
-- Idempotent (safe to re-run; skips when already published).
--
-- Verify against the database:
--   select * from pg_publication_tables
--   where pubname = 'supabase_realtime' and tablename = 'family_member_portrait_versions';

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'family_member_portrait_versions'
     ) then
    alter publication supabase_realtime add table public.family_member_portrait_versions;
  end if;
end
$$;
