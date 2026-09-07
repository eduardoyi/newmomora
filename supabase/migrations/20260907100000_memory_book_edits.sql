-- Memory Book V5b: v1 edit-surface storage (plans/memory-book-5b-web-preview.md
-- Design Decision 4). One row per book holding every parent-made edit
-- (text overrides, image replace/reposition) as a single jsonb blob keyed
-- by stable, non-positional edit keys (Decision 6) -- never by array
-- index, so an edit can never silently mis-target a slot after the book's
-- outline/manifest is regenerated.
--
-- Trust boundary (round-3 plan hardening, Design Decision 4): clients
-- NEVER write this table directly. The `memory-book-edits` Edge Function
-- (service-role) is the only writer -- it resolves `mediaId` ownership and
-- measures original-photo dimensions SERVER-SIDE before merging an edit
-- into `edits`, so 5c's service-role print path can trust every key/
-- dimension already stored here without re-validating it. RLS therefore
-- mirrors `memory_books`' "job is service-only" shape (20260901100000):
-- family-membership SELECT only, zero write policies, and a table grant
-- that only ever hands `authenticated` `select`.
--
-- Concurrency: single-row last-write-wins for v1 (stated in the plan;
-- per-field merge is a v2 follow-up) -- there is exactly one row per book,
-- and `save_edit` always reads-merges-writes the whole `edits` object.

create table public.memory_book_edits (
  -- PK = book_id: at most one edits row per book, matching the
  -- read-merge-write ("single-row last-write-wins") concurrency model
  -- Decision 4 accepts for v1.
  book_id uuid primary key references public.memory_books (id) on delete cascade,
  -- Denormalized (not joined through memory_books on every read) so the
  -- SELECT RLS policy below can check family membership directly, the same
  -- shape `memory_books` itself uses -- and unlike media_share_tokens
  -- (which joins through memories because it never denormalized family_id),
  -- this table's writer (the Edge Function) always already has the book's
  -- family_id in hand from its own book-ownership check, so keeping it in
  -- sync costs nothing extra at write time.
  family_id uuid not null references public.families (id) on delete cascade,
  -- Keyed by stable edit target (Decision 6): text targets
  -- ('dedication' | 'closing' | 'backCover' | 'sectionTitle:<elementId>' |
  -- 'eyebrow:<elementId>' | 'caption:<memoryId>'), image slots
  -- ('<memoryId>:<mediaId-or-assetFileKey>'), and focal points
  -- (same slot keying). Each image-replace/cover-photo entry is
  -- self-contained per Decision 5's save_edit contract: { slot | 'cover',
  -- mediaId, file, originalFile, aspectRatio, originalWidth?,
  -- originalHeight? } -- originalWidth/Height are ABSENT (never fabricated)
  -- when server-side measurement (memory-book-edits' ranged-GET +
  -- image-size probe) couldn't read them, mirroring
  -- `ManifestAsset.originalWidth/Height`'s same absent-not-null contract
  -- (`_shared/memory-book-manifest.ts`).
  edits jsonb not null default '{}'::jsonb,
  -- Who last wrote this row (the authenticated caller of `save_edit`, not
  -- the service-role identity that executed the write). Nullable-on-delete
  -- like `memory_books.requested_by` -- a departed account must not
  -- cascade-delete a family's saved edits.
  updated_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint memory_book_edits_edits_is_object check (jsonb_typeof(edits) = 'object')
);

comment on table public.memory_book_edits is
  'V1 edit surface for a Memory Book (plans/memory-book-5b-web-preview.md Design Decision 4). One row per book (book_id PK). Client SELECT-only via family-membership RLS; every write goes through the memory-book-edits Edge Function (service-role) -- see docs/features/memory-book-generation.md.';
comment on column public.memory_book_edits.family_id is
  'Denormalized from memory_books.family_id at write time (by the service-role Edge Function) so SELECT RLS can check family membership without a join.';
comment on column public.memory_book_edits.edits is
  'jsonb object keyed by stable, non-positional edit target (Decision 6) -- text targets, image slots (<memoryId>:<mediaId-or-assetFileKey>), and focal points. Image entries carry server-resolved keys/dimensions only -- never client-supplied.';
comment on column public.memory_book_edits.updated_by is
  'Caller who last saved an edit (auth.uid() at save_edit time), not the service-role identity that executed the write. Null after account deletion -- mirrors memory_books.requested_by.';

create index memory_book_edits_family_id_idx on public.memory_book_edits (family_id);

create trigger set_memory_book_edits_updated_at
  before update on public.memory_book_edits
  for each row execute function public.set_updated_at();

alter table public.memory_book_edits enable row level security;

-- Select-only, family-membership -- same shape as memory_books' own select
-- policy and media_share_tokens' precedent for a service-role-only-write
-- table (20260829120000). Deliberately NO insert/update/delete policy at
-- all: RLS with zero matching policy denies every client write outright,
-- and the missing table grant below blocks it a second, independent way
-- even if a future migration accidentally added a permissive policy.
create policy "Memory book edits: select" on public.memory_book_edits for select
  using (public.is_family_member(family_id));

revoke all on table public.memory_book_edits from anon;
revoke all on table public.memory_book_edits from authenticated;
grant select on table public.memory_book_edits to authenticated;
