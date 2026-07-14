-- Text-only memories may retain a hidden illustration so users can turn AI
-- illustration back on without regenerating or deleting the existing asset.

alter table public.memories
  drop constraint if exists memories_type_invariants,
  add constraint memories_type_invariants check (
    (memory_type = 'text_illustration' and content is not null and media_key is null)
    or (memory_type = 'text_only' and content is not null and media_key is null)
    or (memory_type = 'media' and media_key is not null and media_content_type is not null and illustration_status = 'none')
  );
