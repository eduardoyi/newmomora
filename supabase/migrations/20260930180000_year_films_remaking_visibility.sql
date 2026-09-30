-- Year Films: a film being remade stays visible to members.
--
-- Until now the client SELECT policy required `video_key is not null and not
-- blocked`, so saving an edit that removes moments (save_year_film_edits
-- blocks the old video, which contains the removed content) made the film
-- vanish from the Timeline and Keepsakes for the ~15 minutes the remake takes.
--
-- The rule is now "has this film EVER been ready": `ready_at` is set by the
-- first publish and never cleared. Members see the row (status, blocked,
-- stale, ready_at are already column-granted) so the app can show a "Remaking
-- your film" placeholder. Nothing else widens:
--   * column grants are unchanged -- video_key, poster_key, scenes_key, the
--     script and the attempt state stay service-role only, so a blocked row
--     leaks no object key;
--   * playback and posters still go through get-year-film-url, which refuses a
--     blocked film (409 single, omitted in a batch) and one without a video;
--   * forced (operator/canary) films and not-yet-surfaced films are still
--     hidden exactly as before (owners/managers see un-surfaced rows early);
--   * a film that never became ready (queued for its first render, failed,
--     skipped) stays invisible.
-- The anonymous-deny restrictive policy ("Year films: deny anonymous") is
-- untouched.

drop policy "Year films: select" on public.year_films;
create policy "Year films: select" on public.year_films
  for select
  using (
    public.is_family_member(family_id)
    and ready_at is not null
    and not forced
    and (surface_at <= now() or public.has_family_role(family_id, array['owner', 'manager']))
  );
