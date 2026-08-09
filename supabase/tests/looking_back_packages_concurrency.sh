#!/usr/bin/env bash
# Two real psql sessions exercise the RPC's advisory-lock boundary. Run this
# against an isolated, freshly reset local database only:
#   LOOKING_BACK_CONCURRENCY_ALLOW_ISOLATED=1 \
#   LOOKING_BACK_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres \
#     bash supabase/tests/looking_back_packages_concurrency.sh
set -euo pipefail

: "${LOOKING_BACK_CONCURRENCY_ALLOW_ISOLATED:?Set to 1 for an isolated local database}"
: "${LOOKING_BACK_TEST_DB_URL:?Set an isolated local Postgres URL}"

if [[ "$LOOKING_BACK_CONCURRENCY_ALLOW_ISOLATED" != '1' ]] \
  || [[ "$LOOKING_BACK_TEST_DB_URL" != postgresql://postgres:postgres@127.0.0.1:* ]] \
  || [[ "$LOOKING_BACK_TEST_DB_URL" == *':54322/'* ]]; then
  echo 'Refusing to run: requires isolated 127.0.0.1 database URL on a non-default port and explicit opt-in.' >&2
  exit 2
fi

user_id='81000000-0000-4000-8000-000000000013'
family_id='82000000-0000-4000-8000-000000000010'
result_a=$(mktemp)
result_b=$(mktemp)

cleanup() {
  PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1 || true
delete from public.families where id = '$family_id';
delete from auth.users where id = '$user_id';
SQL
  rm -f "$result_a" "$result_b"
}
trap cleanup EXIT

PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
insert into auth.users (id, email, is_anonymous)
values ('$user_id', 'looking-back-concurrency@example.test', false);
insert into public.user_profiles (id, name, timezone)
values ('$user_id', 'Looking Back Concurrency', 'UTC')
on conflict (id) do update set timezone = excluded.timezone;
insert into public.families (id, owner_id, name)
values ('$family_id', '$user_id', 'Concurrency Family');
insert into public.family_memberships (family_id, user_id, role)
values ('$family_id', '$user_id', 'owner');
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('8e000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '$family_id', '$user_id', 'Concurrency fixture ' || series,
  current_date - (700 + series * 47), 'text_illustration', 'failed'
from generate_series(1, 4) as series;
SQL

fingerprint_expression="coalesce(string_agg(package_id::text || ':' || \"position\"::text, ',' order by \"position\"), '')"
fingerprint_sql="select $fingerprint_expression from public.get_or_create_looking_back_packages('$family_id')"
lock_sql="with held as materialized (select pg_advisory_xact_lock(hashtextextended('looking-back:$family_id', 0))), paused as materialized (select pg_sleep(2) from held) select $fingerprint_expression from paused, lateral public.get_or_create_looking_back_packages('$family_id')"

PGPASSWORD=postgres PGOPTIONS="-c request.jwt.claim.sub=$user_id" \
  psql "$LOOKING_BACK_TEST_DB_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$lock_sql" >"$result_a" &
pid_a=$!

for _ in {1..30}; do
  lock_held=$(PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -qAt -v ON_ERROR_STOP=1 \
    -c "select pg_try_advisory_xact_lock(hashtextextended('looking-back:$family_id', 0));")
  if [[ "$lock_held" == "f" ]]; then
    break
  fi
  sleep 0.1
done
if [[ "${lock_held:-}" != "f" ]]; then
  echo 'first session never acquired the Looking Back advisory lock' >&2
  exit 1
fi

PGPASSWORD=postgres PGOPTIONS="-c request.jwt.claim.sub=$user_id" \
  psql "$LOOKING_BACK_TEST_DB_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$fingerprint_sql" >"$result_b" &
pid_b=$!
sleep 0.2
if ! kill -0 "$pid_b" 2>/dev/null; then
  echo 'second session did not wait on the Looking Back advisory lock' >&2
  exit 1
fi

wait "$pid_a"
wait "$pid_b"

fingerprint_a=$(<"$result_a")
fingerprint_b=$(<"$result_b")
daily_set_count=$(PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "select count(*) from public.looking_back_daily_sets where family_id = '$family_id';")

if [[ -z "$fingerprint_a" || "$fingerprint_a" != "$fingerprint_b" || "$daily_set_count" != '1' ]]; then
  echo "concurrency regression: a=$fingerprint_a b=$fingerprint_b daily_sets=$daily_set_count" >&2
  exit 1
fi

echo "PASS: one sentinel and stable order ($fingerprint_a) across two concurrent sessions"
