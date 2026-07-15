-- Timeline keyset pagination (docs/plans/performance-optimizations.md
-- Workstream A1). fetchMemoriesPage sorts by (memory_date desc, created_at
-- desc) and paginates on that same tuple; the existing
-- idx_memories_family_id_memory_date index only covers (family_id,
-- memory_date desc), leaving the created_at tie-break within a same-date
-- group unindexed. Same-day row counts are small so this was functionally
-- fine, but pagination now leans on this ordering permanently -- extend the
-- index to cover it.

drop index if exists public.idx_memories_family_id_memory_date;

create index idx_memories_family_id_memory_date
  on public.memories (family_id, memory_date desc, created_at desc);
