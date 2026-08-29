-- Revocable QR share tokens for the Memory Book viewer worker
-- (docs/plans/memory-book.md §8, workers/memory-viewer/README.md "Privacy
-- model"). Replaces the raw-memoryId URLs the memory-viewer worker and
-- book-renderer's scan marks were built with earlier (V3 Phase 2) with an
-- opaque, revocable token: `media_share_tokens.token -> memory_id`. A lost
-- or stolen printed book can now have its QR pages killed by setting
-- `revoked_at`, without touching the underlying memory.
--
-- NOT applied automatically -- owner runs `supabase db push` for this one,
-- same as every other migration in this repo.

-- One row per minted token. `token` IS the primary key (looked up directly
-- by the memory-viewer worker's `GET /m/:token` route -- no extra id
-- indirection needed). Opaque, URL-safe, generated application-side
-- (supabase/scripts/eval-memory-book-assets.ts's `generateShareToken` --
-- 22-char base62 via crypto.getRandomValues, ~131 bits of entropy) rather
-- than a DB default, so the exporter can mint a token, embed it in the
-- rendered book's QR codes, and persist it in the same operation.
create table public.media_share_tokens (
  token text primary key,
  memory_id uuid not null references public.memories (id) on delete cascade,
  created_at timestamptz not null default transaction_timestamp(),
  -- null = active. Setting this revokes the token: the memory-viewer worker
  -- treats a revoked (or unknown) token as "link no longer active" and
  -- shows the same friendly 404-family page it already shows for a
  -- genuinely unknown token -- see workers/memory-viewer/README.md.
  revoked_at timestamptz null
);

comment on table public.media_share_tokens is
  'Revocable QR-code tokens for the public memory-viewer worker (docs/plans/memory-book.md §8). token -> memory_id; revoked_at null = active. Minted by the book-export pipeline (service-role only), resolved by workers/memory-viewer.';
comment on column public.media_share_tokens.token is
  'Opaque, URL-safe, application-generated (see generateShareToken in supabase/scripts/eval-memory-book-assets.ts) -- never a raw memoryId, never guessable from one.';
comment on column public.media_share_tokens.revoked_at is
  'null = active. Set to revoke a printed book''s QR page without deleting the underlying memory.';

-- At most one ACTIVE token per memory at a time -- the exporter's "ensure a
-- token exists" step (SELECT active by memory_id, INSERT only when absent)
-- relies on this to stay idempotent across repeated book exports for the
-- same memory. A memory CAN accumulate multiple revoked rows over time
-- (revoke + re-mint), just never two active ones simultaneously.
create unique index media_share_tokens_active_memory_key
  on public.media_share_tokens (memory_id)
  where revoked_at is null;

-- Lookup index for the worker's `GET /m/:token` route -- redundant with the
-- primary key for point lookups, but memory_id is also queried directly by
-- the exporter's "does this memory already have an active token" read.
create index idx_media_share_tokens_memory_id on public.media_share_tokens (memory_id);

-- RLS: family members can read their own family's tokens (join through
-- memories, since this table has no denormalized family_id of its own) --
-- same security posture as memory_milestones
-- (20260824100000_analyze_memory.sql): select-only for `authenticated`, no
-- insert/update/delete policies at all. The only writer is the service-role
-- client (book-export pipeline), which bypasses RLS entirely -- minting and
-- revocation are both owner/pipeline-only operations, never client-writable.
alter table public.media_share_tokens enable row level security;

create policy "Media share tokens: select" on public.media_share_tokens
  for select using (
    exists (
      select 1
      from public.memories m
      where m.id = media_share_tokens.memory_id
        and public.is_family_member(m.family_id)
    )
  );

revoke all on table public.media_share_tokens from anon;
revoke all on table public.media_share_tokens from authenticated;
grant select on table public.media_share_tokens to authenticated;
