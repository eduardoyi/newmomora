-- Supabase Realtime for generation status (Workstream D, performance-optimizations
-- plan). Adds public.memories to the supabase_realtime publication so
-- postgres_changes UPDATE/INSERT/DELETE events reach useMemoriesRealtime
-- (src/hooks/useMemoriesRealtime.ts). No existing migration or
-- supabase/config.toml section touches publications -- this is the first.
--
-- Default REPLICA IDENTITY (primary key only on `old`) is fine here: the
-- UPDATE handler only reads `payload.new` (a full row) plus whatever it
-- already has cached for the previous state, never `payload.old`'s
-- non-key columns.
--
-- Prod verification (run against the database itself, not config.toml):
--   select * from pg_publication_tables where pubname = 'supabase_realtime';
-- Confirm a row with schemaname = 'public' and tablename = 'memories' is
-- present in both local and prod after this migration is applied. The A5
-- generation-status poll is the fallback if it's ever missing in prod.

alter publication supabase_realtime add table public.memories;
