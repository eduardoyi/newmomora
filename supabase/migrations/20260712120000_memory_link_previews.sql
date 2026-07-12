-- Inline links (docs/plans/inline-links.md): cache of fetched link-preview
-- titles for URLs pasted into memory content. Shape:
--   { [url]: { title: string | null, fetchedAt: string } }
-- `title: null` = fetch attempted and failed (client falls back to domain).
-- Rides the existing `memories` RLS policies -- no policy changes needed.
alter table public.memories
  add column link_previews jsonb not null default '{}'::jsonb;
