-- Memory tags are unlimited for text-only and media memories. Illustrated
-- memories are capped at six because each tagged member can contribute a
-- portrait reference to the image-generation request.

create or replace function public.enforce_memory_tag_limit()
returns trigger as $$
declare
  target_memory_type text;
begin
  -- Lock the parent row so concurrent tag inserts for the same memory are
  -- serialized before counting the already-visible tags.
  select memory_type
  into target_memory_type
  from public.memories
  where id = new.memory_id
  for update;

  if target_memory_type = 'text_illustration' and (
    select count(*)
    from public.memory_family_members
    where memory_id = new.memory_id
  ) >= 6 then
    raise exception 'Maximum 6 family members per illustrated memory'
      using errcode = '23514';
  end if;

  return new;
end;
$$ language plpgsql set search_path = public;

-- Also guard the reverse path: a text-only memory may already have more than
-- six tags when a client tries to switch it back to illustrated.
create or replace function public.enforce_illustrated_memory_tag_limit()
returns trigger as $$
begin
  if new.memory_type = 'text_illustration'
    and old.memory_type is distinct from new.memory_type
    and (
      select count(*)
      from public.memory_family_members
      where memory_id = new.id
    ) > 6 then
    raise exception 'Maximum 6 family members per illustrated memory'
      using errcode = '23514';
  end if;

  return new;
end;
$$ language plpgsql set search_path = public;

create trigger memories_illustration_tag_limit
  before update of memory_type on public.memories
  for each row execute function public.enforce_illustrated_memory_tag_limit();
