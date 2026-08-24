-- Memory Book V1 exit: production `analyze-memory` schema foundation
-- (docs/plans/memory-book.md §5 Stage A, §9 V1 exit criteria).
--
-- Adds the enrichment columns analyze-memory writes to `memories` (topics,
-- labels, description -- the open-vocabulary axes -- plus analysis
-- bookkeeping) and a new `memory_milestones` table for the explicit-text-only
-- milestone axis (docs/plans/milestone-catalog.md). Both ride the existing
-- `memories` RLS policies / family tenancy model; no policy changes to
-- `memories` itself.

-- 1. Enrichment columns on `memories`. All system-written (like `emotion`):
-- no column grants are added for `authenticated`, so these stay writable
-- only via the service-role client, consistent with the existing
-- `revoke insert, update on public.memories from public, anon, authenticated`
-- + narrow-grant pattern from 20260801170000_paid_subscription_sol_hardening.sql
-- (a newly added column is inaccessible until explicitly granted).
alter table public.memories
  add column topics text[] not null default '{}',
  add column topic_details jsonb not null default '{}',
  add column labels text[] not null default '{}',
  add column description text,
  add column analysis_version integer,
  add column analyzed_at timestamptz;

comment on column public.memories.topics is
  'Controlled book-vocabulary topic ids (docs/plans/topic-vocabulary.md), 0-3 per memory, precision-first. Written by analyze-memory only.';
comment on column public.memories.topic_details is
  'Map of topic id -> detail string, populated only for the four detail topics (other-holiday, national-holiday, ceremony, mothers-fathers-day).';
comment on column public.memories.labels is
  'Open-vocabulary descriptive labels (objects/scenes/actions) for future search. Not used by book curation.';
comment on column public.memories.description is
  'One dense neutral sentence, search-only (future semantic search embedding source). Never rendered client-side.';
comment on column public.memories.analysis_version is
  'The TOPICS_VERSION (supabase/functions/_shared/memory-topics.ts) this row was analyzed against.';
comment on column public.memories.analyzed_at is
  'When the full analyze-memory pass last wrote this row (distinct from emotion-only legacy writes, which do not set this).';

-- Topic search/filter (future in-app browsing by topic + book curation).
create index idx_memories_topics on public.memories using gin (topics);

-- 2. `memory_milestones`: candidate milestone matches for a memory, per the
-- explicit-text-only rule (docs/plans/milestone-catalog.md principle 1). One
-- row per (memory, milestone) pair -- a memory can explicitly claim more
-- than one milestone (e.g. "she rolled over AND said her first word today"
-- is rare but not impossible). `birthday` recurs across a child's life as
-- one row per birthday MEMORY (milestone_id stays 'birthday'; `detail`
-- carries the age turned -- see memory-milestones.ts).
create table public.memory_milestones (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  memory_id uuid not null,
  -- Plain single-column FK (not composite with family_id, unlike memory_id
  -- below): the brief calls for a simple nullable-on-delete relationship,
  -- and the only writer is the service-role Edge Function, which always
  -- resolves family_member_id from members already scoped to the memory's
  -- own family -- so the extra composite-FK tenancy guarantee other tables
  -- use (e.g. looking_back_packages_subject_family_fkey) isn't load-bearing
  -- here the way it is for a client-writable table.
  family_member_id uuid references public.family_members(id) on delete set null,
  milestone_id text not null,
  detail text,
  out_of_band boolean not null default false,
  status text not null default 'candidate' check (status in ('candidate', 'confirmed', 'dismissed')),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint memory_milestones_memory_family_fkey
    foreign key (memory_id, family_id)
    references public.memories (id, family_id)
    on delete cascade,
  constraint memory_milestones_memory_milestone_key unique (memory_id, milestone_id)
);

create index idx_memory_milestones_family_id on public.memory_milestones (family_id);
create index idx_memory_milestones_family_member_id on public.memory_milestones (family_member_id)
  where family_member_id is not null;

comment on table public.memory_milestones is
  'Candidate/confirmed milestone matches, explicit-text-only (docs/plans/milestone-catalog.md). Celebration, never developmental tracking -- no "missing milestone" surface may ever read this table for absence.';

create or replace function public.memory_milestones_set_updated_at()
returns trigger as $$
begin
  new.updated_at := transaction_timestamp();
  return new;
end;
$$ language plpgsql set search_path = public;

create trigger memory_milestones_updated_at
  before update on public.memory_milestones
  for each row execute function public.memory_milestones_set_updated_at();

-- RLS: family members can read; no insert/update/delete policies -- only the
-- service-role client (which bypasses RLS entirely) writes these rows.
-- Mirrors the looking_back_packages family of tables exactly
-- (20260808110000_looking_back_packages.sql).
alter table public.memory_milestones enable row level security;

create policy "Memory milestones: select" on public.memory_milestones
  for select using (public.is_family_member(family_id));

revoke all on table public.memory_milestones from anon;
revoke all on table public.memory_milestones from authenticated;
grant select on table public.memory_milestones to authenticated;
