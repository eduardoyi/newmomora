-- Memory types: text_illustration, text_only, media

-- 1. Make content nullable; update empty-check to allow NULL
alter table public.memories
  alter column content drop not null,
  drop constraint if exists memories_content_not_empty,
  add constraint memories_content_not_empty
    check (content is null or trim(content) <> '');

-- 2. New columns
alter table public.memories
  add column memory_type text not null default 'text_illustration'
    check (memory_type in ('text_illustration', 'text_only', 'media')),
  add column media_key text,
  add column media_content_type text;

-- 3. Extend illustration_status to allow 'none'; change default to 'none'
alter table public.memories
  drop constraint if exists memories_illustration_status_check,
  alter column illustration_status set default 'none',
  add constraint memories_illustration_status_check
    check (illustration_status in ('none', 'pending', 'generating', 'ready', 'failed'));

-- 4. Cross-type invariants
alter table public.memories
  add constraint memories_type_invariants check (
    (memory_type = 'text_illustration' and content is not null and media_key is null)
    or (memory_type = 'text_only' and content is not null and media_key is null and illustration_status = 'none')
    or (memory_type = 'media' and media_key is not null and media_content_type is not null and illustration_status = 'none')
  );
