-- Memory Book V5a: durable generation schema + status row
-- (docs/plans/memory-book.md §"V5 scope" 5a + §8 data-model sketch,
-- docs/durable-ai-generation-workflows.md status-row/compare-and-set
-- conventions). This migration ships the schema + RLS contract only --
-- the Cloudflare Workflow that actually curates/lays out a book is a
-- separate change (see docs/features/memory-book-generation.md).
--
-- One row per book project: family, optionally a specific child, a frozen
-- time-period scope, and generation status. The app inserts a fresh
-- 'queued' row when the parent starts a book from the in-app scope picker;
-- a service-role worker owns every status transition from there
-- (mirrors memory_illustration_jobs / portrait_generation_jobs: the client
-- never writes status, clocks, or attempt identity directly -- see
-- "Core invariants" #2 in the durable-workflow playbook). Unlike the
-- illustration pipeline, there is no separate private job table for V5a:
-- book_document is null until 'ready', so the row itself never exposes
-- work-in-progress content to any peer of the requester it wasn't already
-- visible to (RLS is family-membership, same boundary as the book itself).

create table public.memory_books (
  id uuid primary key default gen_random_uuid(),

  family_id uuid not null references public.families (id) on delete cascade,
  -- Required only for scope_kind = 'age_year' (the age-year boundaries are
  -- computed from this child's date_of_birth). Null for family-wide scopes.
  child_id uuid references public.family_members (id) on delete cascade,
  -- Who started this book. Kept nullable-on-delete (mirrors memories.user_id)
  -- so a departed account doesn't cascade-delete a family's book.
  requested_by uuid references auth.users (id) on delete set null,

  -- Scope: the app resolves a concrete, frozen [scope_start_date,
  -- scope_end_date] window at insert time (age-year from the child's DOB,
  -- calendar-year from Jan 1 - Dec 31, custom-range from the picker) so a
  -- generation run's inputs can't silently drift if memories are added or
  -- a DOB is corrected later. 'everything' is the one open-ended scope --
  -- both dates stay null, meaning "every printable memory at generation
  -- time." scope_label is the parent-facing display string ("Year One",
  -- "2025", "Everything", or a custom gift label).
  scope_kind text not null
    check (scope_kind in ('age_year', 'calendar_year', 'everything', 'custom_range')),
  scope_start_date date,
  scope_end_date date,
  scope_label text not null,

  -- GENERATION status machine (mirrors the illustration workflow's
  -- pending/generating/ready/failed shape; 'queued' replaces 'pending'
  -- per the agreed V5a contract -- no row exists before the app's own
  -- insert, so there's no separate "not yet requested" state to name).
  status text not null default 'queued'
    check (status in ('queued', 'generating', 'ready', 'failed')),
  failure_reason text,

  -- Idempotency / compare-and-set identity for the future worker, mirroring
  -- memory_illustration_jobs: workflow_instance_id is the Cloudflare
  -- Workflow instance (dispatch is idempotent on this), generation_attempt_id
  -- is the narrower token a publish/fail RPC checks so a superseded or
  -- stale attempt can never publish over a newer one. Both are set only by
  -- the service-role dispatcher, never by the client, and are cleared on
  -- terminal states along with the recovery clocks below.
  workflow_instance_id text unique,
  generation_attempt_id uuid,
  -- Dedicated recovery clock, not created_at/updated_at -- unrelated writes
  -- (e.g. a future book-title edit) must not extend or shorten a
  -- generation lease. Mirrors memories.illustration_generation_started_at.
  generation_started_at timestamptz,
  generation_completed_at timestamptz,

  -- Soft page-count target fed to curation (plan §4: ~40-60 soft target,
  -- 122 hard cap -- Prodigi layflat's physical even-count limit). This is
  -- an input to the outline, not the final printed length: round-3 owner
  -- review made 122 a ceiling the content earns its way up to, not a
  -- target: the realized page count lives in book_document once ready.
  page_budget smallint not null
    check (page_budget between 18 and 122),

  -- Null until status = 'ready'. Single-renderer contract (plan §3/§9):
  -- the same JSON document renders both the web preview and, eventually,
  -- the print PDF -- never a second parallel representation.
  book_document jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint memory_books_scope_label_not_blank check (trim(scope_label) <> ''),
  constraint memory_books_scope_dates_ordered check (
    scope_start_date is null or scope_end_date is null or scope_start_date <= scope_end_date
  ),
  -- 'everything' is the only scope allowed to omit both dates -- every
  -- other kind must arrive with a frozen window already resolved.
  constraint memory_books_scope_dates_required check (
    scope_kind = 'everything'
    or (scope_start_date is not null and scope_end_date is not null)
  ),
  constraint memory_books_age_year_requires_child check (
    scope_kind <> 'age_year' or child_id is not null
  ),
  constraint memory_books_book_document_is_object check (
    book_document is null or jsonb_typeof(book_document) = 'object'
  ),
  constraint memory_books_ready_has_document check (
    status <> 'ready' or book_document is not null
  ),
  constraint memory_books_failed_has_reason check (
    status <> 'failed' or failure_reason is not null
  )
);

comment on table public.memory_books is
  'One row per Memory Book project (docs/plans/memory-book.md §8). App inserts queued; a service-role worker owns every status transition (see docs/features/memory-book-generation.md). book_document is null until ready.';
comment on column public.memory_books.child_id is
  'Only set for scope_kind = age_year (drives the birthday-boundary window from this child''s date_of_birth). Null for family-wide scopes.';
comment on column public.memory_books.scope_start_date is
  'Frozen at insert time by the app -- null only when scope_kind = everything.';
comment on column public.memory_books.scope_end_date is
  'Frozen at insert time by the app -- null only when scope_kind = everything.';
comment on column public.memory_books.workflow_instance_id is
  'Cloudflare Workflow instance id, set by the service-role dispatcher. Unique so a replayed dispatch is idempotent (mirrors memory_illustration_jobs).';
comment on column public.memory_books.generation_attempt_id is
  'Compare-and-set token for the current generation attempt. Set at dispatch, checked by the publish/fail RPC, cleared on every terminal transition.';
comment on column public.memory_books.page_budget is
  'Soft page-count target fed to curation (18-122, Prodigi layflat physical range). Not the final printed length -- see book_document once ready.';
comment on column public.memory_books.book_document is
  'Single-renderer book JSON (plan §3/§9). Null until status = ready.';

-- One in-flight (queued or generating) book per exact scope per family --
-- prevents an accidental double-tap (or a retried request) from paying for
-- two outline generations of the same period. A family can still hold any
-- number of *completed* books for the same or overlapping scopes (plan §4:
-- "scopes may overlap"); this index only rules out two simultaneously
-- active runs of the identical scope. child_id/dates are coalesced to
-- fixed sentinels because a unique index cannot compare NULLs as equal.
create unique index memory_books_one_active_per_scope
  on public.memory_books (
    family_id,
    coalesce(child_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scope_kind,
    coalesce(scope_start_date, '0001-01-01'::date),
    coalesce(scope_end_date, '9999-12-31'::date)
  )
  where status in ('queued', 'generating');

create index memory_books_family_id_idx on public.memory_books (family_id);
create index memory_books_child_id_idx on public.memory_books (child_id) where child_id is not null;
-- Worker polling / recovery surface (mirrors the illustration jobs' active-row index).
create index memory_books_status_idx on public.memory_books (status) where status in ('queued', 'generating');

create trigger set_memory_books_updated_at
  before update on public.memory_books
  for each row execute function public.set_updated_at();

alter table public.memory_books enable row level security;

-- Select/insert are family-membership, same shape as the most recent
-- family-scoped table (media_share_tokens, 20260829120000): select via
-- is_family_member, and here an additional insert policy since -- unlike
-- media_share_tokens -- the app itself (not just a server pipeline) is the
-- one starting a book. Insert is restricted to owner/manager, matching
-- every other content-creating policy in this schema ("Memories: insert",
-- "Family members: insert"). The with-check also pins the row to the
-- exact just-queued shape the durable-workflow playbook expects: no
-- client can insert a row that already claims to be generating/ready, or
-- that pre-fills generation identity/clocks/output it should never own.
-- Deliberately NO update or NO delete policy at all for authenticated --
-- mirrors memory_illustration_jobs' "job is service-only" contract: every
-- status transition, generation identity, and the eventual book_document
-- write happens only through a service-role RPC (owned by the worker
-- change, not this one). RLS with zero matching policy denies the
-- operation outright for every non-bypassing role.
create policy "Memory books: select" on public.memory_books for select
  using (public.is_family_member(family_id));

create policy "Memory books: insert" on public.memory_books for insert
  with check (
    requested_by = auth.uid()
    and public.has_family_role(family_id, array['owner', 'manager'])
    -- Cross-family hazard, same lesson as "Memory tags: insert": without
    -- this, a manager of two families could point child_id at family B's
    -- child while family_id claims family A.
    and (
      child_id is null
      or exists (
        select 1 from public.family_members fm
        where fm.id = child_id and fm.family_id = memory_books.family_id
      )
    )
    and status = 'queued'
    and failure_reason is null
    and workflow_instance_id is null
    and generation_attempt_id is null
    and generation_started_at is null
    and generation_completed_at is null
    and book_document is null
  );

revoke all on table public.memory_books from anon;
revoke all on table public.memory_books from authenticated;
grant select, insert on table public.memory_books to authenticated;
