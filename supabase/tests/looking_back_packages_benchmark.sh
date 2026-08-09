#!/usr/bin/env bash
# Measure first materialization and frozen-set retrieval with 10,000 synthetic
# memories. This script only permits the explicit isolated local URL shape;
# it creates then removes a fixed test household. Never point it at shared,
# staging, or production data.
#
# Example:
#   LOOKING_BACK_BENCHMARK_ALLOW_ISOLATED=1 \
#   LOOKING_BACK_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres \
#     bash supabase/tests/looking_back_packages_benchmark.sh
set -euo pipefail

: "${LOOKING_BACK_BENCHMARK_ALLOW_ISOLATED:?Set to 1 for an isolated local database}"
: "${LOOKING_BACK_TEST_DB_URL:?Set the isolated local Postgres URL}"

if [[ "$LOOKING_BACK_BENCHMARK_ALLOW_ISOLATED" != '1' ]] \
  || [[ "$LOOKING_BACK_TEST_DB_URL" != postgresql://postgres:postgres@127.0.0.1:* ]] \
  || [[ "$LOOKING_BACK_TEST_DB_URL" == *':54322/'* ]]; then
  echo 'Refusing to run: requires isolated 127.0.0.1 database URL on a non-default port and explicit opt-in.' >&2
  exit 2
fi

user_id='8f000000-0000-4000-8000-000000000001'
family_id='8f100000-0000-4000-8000-000000000001'

cleanup() {
  PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1 || true
delete from public.families where id = '$family_id';
delete from auth.users where id = '$user_id';
SQL
}
trap cleanup EXIT

PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
delete from public.families where id = '$family_id';
delete from auth.users where id = '$user_id';
insert into auth.users (id, email, is_anonymous)
values ('$user_id', 'looking-back-perf@example.test', false);
insert into public.user_profiles (id, name, timezone)
values ('$user_id', 'Looking Back Performance', 'UTC')
on conflict (id) do update set timezone = excluded.timezone;
insert into public.families (id, owner_id, name)
values ('$family_id', '$user_id', 'Looking Back Performance Family');
insert into public.family_memberships (family_id, user_id, role)
values ('$family_id', '$user_id', 'owner');
insert into public.memories (family_id, user_id, content, memory_date, memory_type, illustration_status)
select '$family_id', '$user_id', 'Synthetic performance fixture ' || series,
  current_date - (100 + series), 'text_illustration', 'failed'
from generate_series(1, 10000) as series;
set role authenticated;
select set_config('request.jwt.claim.sub', '$user_id', false);
set jit = off;
\echo 'First materialization (10,000 synthetic memories)'
explain (analyze, buffers, summary on, timing on)
select count(*) from public.get_or_create_looking_back_packages('$family_id');
\echo 'Existing frozen set retrieval'
explain (analyze, buffers, summary on, timing on)
select count(*) from public.get_or_create_looking_back_packages('$family_id');
SQL
