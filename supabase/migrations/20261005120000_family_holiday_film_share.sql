-- Holiday card film (docs/plans/holiday-cards.md, stage C5): the P1 subset the
-- printed card's QR needs now.
--
--   1. year_films.kind accepts 'family_holiday' (the card film).
--   2. year_film_bed_ids() accepts the two holiday music beds.
--   3. film_share_tokens: revocable, public-link tokens for a film, resolved by
--      workers/memory-viewer (GET /f/:token) -- the twin of media_share_tokens.
--
-- Nothing else enumerates film kinds in SQL, so nothing else changes:
--   * year_film_due / year_film_candidate_rows insert and return hard-coded
--     birthday / family_month / family_year rows only, so the scheduler can
--     never create or return a holiday row. Holiday films are operator/on-demand
--     rows (queue_year_film_forced), always `forced`.
--   * placement_date (P2) is `case kind when 'birthday' ... when 'family_month'
--     ... else Dec 31 of scope_start_date's year`, so a holiday film already
--     sits on Dec 31 of its card year; no change needed.
--   * "Year films: select" requires `not forced`, so holiday rows stay hidden
--     from members until a later phase decides otherwise.
--   * year_film_notifications_due skips forced rows: no push, no drawer event.
--
-- NOT applied automatically -- owner runs `supabase db push`.

-- ---------------------------------------------------------------------------
-- 1. Kind
-- ---------------------------------------------------------------------------

-- The check was declared inline on the column, so Postgres named it
-- year_films_kind_check. Existing rows all satisfy the wider list.
alter table public.year_films
  drop constraint year_films_kind_check;

alter table public.year_films
  add constraint year_films_kind_check
  check (kind in ('birthday', 'family_month', 'family_year', 'family_holiday'));

-- ---------------------------------------------------------------------------
-- 2. Music-bed allow-list
-- ---------------------------------------------------------------------------

-- Same list as 20260929120000_year_films.sql plus winter-bells and
-- fireside-piano (holiday beds, film-renderer/composition/assets/audio/beds).
-- Order mirrors YEAR_FILM_BEDS in _shared/year-film-beds.ts (parity-tested).
-- The app's bed picker does not offer the holiday beds: holiday films are never
-- edited in the app, so src/utils/year-film-beds.ts deliberately omits them.
create or replace function public.year_film_bed_ids()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'bells-and-claps', 'bright-pop', 'bubbly-synth', 'celebration-pop', 'fireside-piano',
    'groovy-keys', 'pizzicato-bop', 'playful-marimba', 'playful-piano', 'sparkle-pop',
    'tender-piano', 'winter-bells'
  ];
$$;

-- ---------------------------------------------------------------------------
-- 3. Film share tokens
-- ---------------------------------------------------------------------------

-- One row per minted token. `token` IS the primary key (looked up directly by
-- the memory-viewer worker's `GET /f/:token`). Opaque, URL-safe, generated
-- application-side (22-char base62, ~131 bits, same generator as
-- media_share_tokens) so the card renderer can embed it in the printed QR
-- before the row exists.
create table public.film_share_tokens (
  token text primary key
    constraint film_share_tokens_token_format check (token ~ '^[A-Za-z0-9]{22}$'),
  film_id uuid not null references public.year_films (id) on delete cascade,
  created_at timestamptz not null default transaction_timestamp(),
  -- null = active. Setting this turns the public page off (HTTP 410) without
  -- touching the film.
  revoked_at timestamptz null
);

comment on table public.film_share_tokens is
  'Revocable public-link tokens for a Year Film (docs/plans/holiday-cards.md C5). token -> film_id; revoked_at null = active. Minted by operator scripts / the holiday-cards pipeline (service role only), resolved by workers/memory-viewer GET /f/:token.';
comment on column public.film_share_tokens.token is
  '22-char base62, application-generated, never derived from the film id.';
comment on column public.film_share_tokens.revoked_at is
  'null = active. Set to turn the public film page off (410) without deleting the film.';

-- At most one ACTIVE token per film; a film may accumulate revoked rows.
create unique index film_share_tokens_active_film_key
  on public.film_share_tokens (film_id)
  where revoked_at is null;

create index idx_film_share_tokens_film_id on public.film_share_tokens (film_id);

-- RLS: select-only for `authenticated`, no write policies at all (service role
-- bypasses RLS) -- same posture as media_share_tokens. The join runs under the
-- caller's own year_films RLS, so a member sees a token only for a film they
-- can see: forced (operator / holiday) films keep their tokens service-role
-- only until a later phase decides members should read them.
alter table public.film_share_tokens enable row level security;

create policy "Film share tokens: select" on public.film_share_tokens
  for select using (
    exists (
      select 1
      from public.year_films f
      where f.id = film_share_tokens.film_id
        and public.is_family_member(f.family_id)
    )
  );

create policy "Film share tokens: deny anonymous" on public.film_share_tokens
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

revoke all on table public.film_share_tokens from anon;
revoke all on table public.film_share_tokens from authenticated;
grant select on table public.film_share_tokens to authenticated;
