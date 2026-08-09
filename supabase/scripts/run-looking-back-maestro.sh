#!/usr/bin/env bash
# Seed, run, and clean the deterministic Looking Back Maestro fixture.
#
# This script is deliberately fail-closed. It accepts only a loopback Supabase
# stack whose API and Postgres ports are both non-default, plus an explicit
# opt-in. The fixed UUIDs and example.test account make cleanup exact and keep
# personal/staging/production data out of this flow.
set -euo pipefail

readonly fixture_user_id='8e000000-0000-4000-8000-000000000001'
readonly fixture_identity_id='8e000000-0000-4000-8000-000000000002'
readonly fixture_family_id='8e100000-0000-4000-8000-000000000001'
readonly fixture_daily_set_id='8e200000-0000-4000-8000-000000000001'
readonly fixture_package_id='8e300000-0000-4000-8000-000000000001'
readonly fixture_memory_short_id='8e400000-0000-4000-8000-000000000001'
readonly fixture_memory_long_id='8e400000-0000-4000-8000-000000000002'
readonly fixture_memory_illustration_id='8e400000-0000-4000-8000-000000000003'
readonly fixture_memory_photo_id='8e400000-0000-4000-8000-000000000004'
readonly fixture_media_id='8e500000-0000-4000-8000-000000000001'
readonly fixture_video_id='8e500000-0000-4000-8000-000000000002'
readonly fixture_entitlement_id='8e600000-0000-4000-8000-000000000001'
readonly fixture_illustration_generation_id='8e700000-0000-4000-8000-000000000001'
readonly fixture_email='looking-back-maestro@example.test'
readonly fixture_memory_count='4'
readonly fixture_frame_count='5'
readonly fixture_first_frame_text='The red kite waited by the garden gate.'
readonly fixture_illustration_key="$fixture_user_id/memories/$fixture_memory_illustration_id/illustrations/$fixture_illustration_generation_id.webp"
readonly fixture_photo_key="$fixture_user_id/memories/$fixture_memory_photo_id/media/$fixture_media_id.jpg"
readonly fixture_video_key="$fixture_user_id/memories/$fixture_memory_photo_id/media/$fixture_video_id.mp4"
readonly storage_helper='supabase/scripts/looking-back-maestro-storage.ts'
fixture_temp_dir=''

usage() {
  cat >&2 <<'USAGE'
Usage: bash supabase/scripts/run-looking-back-maestro.sh seed|run|cleanup

Required for every action:
  LOOKING_BACK_E2E_ALLOW_ISOLATED=1
  LOOKING_BACK_E2E_R2_ALLOW_ISOLATED=1
  LOOKING_BACK_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:<nondefault>/postgres
  supabase/.env.local with an http://127.0.0.1:<port> R2_ENDPOINT and local R2 credentials

Also required for every action (cleanup authenticates before object deletion):
  EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:<nondefault>
  EXPO_PUBLIC_SUPABASE_ANON_KEY=<matching isolated-project anon key>
  LOOKING_BACK_E2E_PASSWORD=<password used only by the synthetic account>

Every action validates the matching local client/API credentials before it can
touch the fixture. `run` additionally requires an installed dev build connected
to Metro. Restart Metro after changing .env.local.
USAGE
}

fail() {
  echo "Refusing to run: $1" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is unavailable."
}

validate_database_target() {
  [[ "${LOOKING_BACK_E2E_ALLOW_ISOLATED:-}" == '1' ]] \
    || fail 'set LOOKING_BACK_E2E_ALLOW_ISOLATED=1 for an isolated local stack.'
  [[ -n "${LOOKING_BACK_TEST_DB_URL:-}" ]] \
    || fail 'LOOKING_BACK_TEST_DB_URL is required.'

  if [[ ! "$LOOKING_BACK_TEST_DB_URL" =~ ^postgresql://postgres:postgres@127\.0\.0\.1:([0-9]+)/postgres$ ]]; then
    fail 'the database URL must be the exact 127.0.0.1 local Postgres URL shape.'
  fi

  local database_port="${BASH_REMATCH[1]}"
  [[ "$database_port" != '54322' ]] \
    || fail 'the default Supabase Postgres port 54322 is never accepted.'
}

validate_api_target() {
  [[ -n "${EXPO_PUBLIC_SUPABASE_URL:-}" ]] || fail 'EXPO_PUBLIC_SUPABASE_URL is required.'
  [[ -n "${EXPO_PUBLIC_SUPABASE_ANON_KEY:-}" ]] || fail 'EXPO_PUBLIC_SUPABASE_ANON_KEY is required.'
  [[ -n "${LOOKING_BACK_E2E_PASSWORD:-}" ]] || fail 'LOOKING_BACK_E2E_PASSWORD is required.'
  [[ ${#LOOKING_BACK_E2E_PASSWORD} -ge 8 ]] || fail 'LOOKING_BACK_E2E_PASSWORD must be at least 8 characters.'

  EXPO_PUBLIC_SUPABASE_URL="${EXPO_PUBLIC_SUPABASE_URL%/}"
  export EXPO_PUBLIC_SUPABASE_URL
  if [[ ! "$EXPO_PUBLIC_SUPABASE_URL" =~ ^http://127\.0\.0\.1:([0-9]+)$ ]]; then
    fail 'the Supabase API URL must be an http://127.0.0.1 local URL.'
  fi

  local api_port="${BASH_REMATCH[1]}"
  [[ "$api_port" != '54321' ]] \
    || fail 'the default Supabase API port 54321 is never accepted.'
}

validate_r2_target() {
  [[ "${LOOKING_BACK_E2E_R2_ALLOW_ISOLATED:-}" == '1' ]] \
    || fail 'set LOOKING_BACK_E2E_R2_ALLOW_ISOLATED=1 for the isolated local object store.'
  [[ -r supabase/.env.local ]] \
    || fail 'supabase/.env.local is required for the isolated local object store.'

  local configured_endpoint
  configured_endpoint="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?R2_ENDPOINT[[:space:]]*=[[:space:]]*//p' supabase/.env.local | tail -n 1)"
  configured_endpoint="${configured_endpoint%\"}"
  configured_endpoint="${configured_endpoint#\"}"
  configured_endpoint="${configured_endpoint%\'}"
  configured_endpoint="${configured_endpoint#\'}"
  if [[ ! "$configured_endpoint" =~ ^http://127\.0\.0\.1:([0-9]+)/?$ ]]; then
    fail 'supabase/.env.local R2_ENDPOINT must be an explicit local http://127.0.0.1:<port> URL.'
  fi
}

env_file_value() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" .env.local 2>/dev/null | tail -n 1)"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

validate_dev_environment() {
  [[ -f .env.local ]] || fail '.env.local is required so the dev build cannot target another Supabase project.'

  local configured_url configured_anon_key
  configured_url="$(env_file_value EXPO_PUBLIC_SUPABASE_URL)"
  configured_url="${configured_url%/}"
  configured_anon_key="$(env_file_value EXPO_PUBLIC_SUPABASE_ANON_KEY)"

  [[ "$configured_url" == "$EXPO_PUBLIC_SUPABASE_URL" ]] \
    || fail '.env.local EXPO_PUBLIC_SUPABASE_URL does not match the isolated API URL.'
  [[ -n "$configured_anon_key" && "$configured_anon_key" == "$EXPO_PUBLIC_SUPABASE_ANON_KEY" ]] \
    || fail '.env.local EXPO_PUBLIC_SUPABASE_ANON_KEY does not match the isolated API key.'
}

assert_no_fixture_collision() {
  local collision
  collision="$(PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -A -t -q -v ON_ERROR_STOP=1 <<SQL
select case
  when exists (
    select 1 from auth.users
    where id = '$fixture_user_id' and email is distinct from '$fixture_email'
  ) then 'fixed-user-id-has-another-email'
  when exists (
    select 1 from auth.users
    where lower(email) = lower('$fixture_email') and id <> '$fixture_user_id'
  ) then 'fixed-email-has-another-user-id'
  when exists (
    select 1 from public.families
    where id = '$fixture_family_id' and owner_id <> '$fixture_user_id'
  ) then 'fixed-family-id-has-another-owner'
  else ''
end;
SQL
)"
  [[ -z "$collision" ]] || fail "fixture identifier collision ($collision)."
}

fixture_exists() {
  [[ "$(PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -A -t -q -v ON_ERROR_STOP=1 \
    -c "select exists(select 1 from auth.users where id = '$fixture_user_id' and lower(email) = lower('$fixture_email'));" | tr -d '[:space:]')" == 't' ]]
}

authenticate_fixture() {
  local auth_response auth_status access_token
  auth_response="$(mktemp)"
  auth_status="$(curl --silent --show-error --output "$auth_response" --write-out '%{http_code}' \
    --request POST "$EXPO_PUBLIC_SUPABASE_URL/auth/v1/token?grant_type=password" \
    --header "apikey: $EXPO_PUBLIC_SUPABASE_ANON_KEY" \
    --header 'Content-Type: application/json' \
    --data "$(jq -cn --arg email "$fixture_email" --arg password "$LOOKING_BACK_E2E_PASSWORD" '{email:$email,password:$password}')")"
  if [[ "$auth_status" != '200' ]]; then
    rm -f "$auth_response"
    echo "Isolated Auth password verification failed with HTTP $auth_status." >&2
    return 1
  fi
  if ! access_token="$(jq -er '.access_token' "$auth_response")"; then
    rm -f "$auth_response"
    echo 'Isolated Auth response did not include an access token.' >&2
    return 1
  fi
  rm -f "$auth_response"
  printf '%s' "$access_token"
}

cleanup_temp_files() {
  if [[ -z "$fixture_temp_dir" ]]; then return; fi
  if [[ "$fixture_temp_dir" != "${TMPDIR:-/tmp}"/looking-back-e2e.* ]]; then
    echo 'Refusing to remove an unexpected fixture temp path.' >&2
    return 1
  fi
  rm -f "$fixture_temp_dir/fixture-photo.jpg"
  rm -f "$fixture_temp_dir/fixture-video.mp4"
  rmdir "$fixture_temp_dir" 2>/dev/null || true
  fixture_temp_dir=''
}

mutate_fixture_storage() {
  local action="$1"
  shift
  local allowed_reads='supabase/.env.local'
  if [[ "$action" == 'upload' ]]; then
    allowed_reads+=",assets/onboarding/year-fort-hallway.webp,$1,$2"
  fi
  # The AWS client receives explicit credentials/endpoint from the guarded
  # env file. It needs environment reads, loopback network access and the
  # exact upload inputs only -- never subprocess, FFI, broad filesystem write,
  # or a managed node_modules tree. --frozen prevents lockfile drift.
  deno run --frozen --node-modules-dir=none \
    --allow-env \
    --allow-net=127.0.0.1 \
    --allow-read="$allowed_reads" \
    --env-file=supabase/.env.local \
    "$storage_helper" "$action" "$@"
}

cleanup_fixture() {
  assert_no_fixture_collision
  cleanup_temp_files

  # If fixture rows exist, prove the fixed password still authenticates
  # against the matching local API before touching its exact R2 objects.
  if fixture_exists; then
    local access_token
    access_token="$(authenticate_fixture)" \
      || fail 'fixture authentication failed; storage and database rows were left intact.'
    [[ -n "$access_token" ]] \
      || fail 'fixture authentication produced an empty access token.'
  fi

  # R2 cleanup is exact and must succeed before the rows that authorize media
  # reads are removed. A failure deliberately leaves DB/Auth intact so cleanup
  # can be retried safely.
  mutate_fixture_storage cleanup >/dev/null \
    || fail 'exact fixture object cleanup failed; database and Auth rows were left intact.'

  PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
begin;
delete from public.families
where id = '$fixture_family_id' and owner_id = '$fixture_user_id';
delete from auth.users
where id = '$fixture_user_id' and lower(email) = lower('$fixture_email');
commit;
SQL
  echo 'LOOKING_BACK_FIXTURE_CLEANED=1'
}

seed_fixture() {
  assert_no_fixture_collision
  cleanup_fixture >/dev/null

  PGPASSWORD=postgres psql "$LOOKING_BACK_TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 \
    -v fixture_password="$LOOKING_BACK_E2E_PASSWORD" <<SQL
begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at,
  is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000',
  '$fixture_user_id',
  'authenticated',
  'authenticated',
  '$fixture_email',
  extensions.crypt(:'fixture_password', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"name":"Looking Back Maestro","timezone":"UTC","email_verified":true}'::jsonb,
  false,
  now(),
  now(),
  false
);

insert into auth.identities (
  id, provider_id, user_id, identity_data, provider, last_sign_in_at,
  created_at, updated_at
) values (
  '$fixture_identity_id',
  '$fixture_user_id',
  '$fixture_user_id',
  jsonb_build_object(
    'sub', '$fixture_user_id',
    'email', '$fixture_email',
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(),
  now(),
  now()
);

update public.user_profiles
set name = 'Looking Back Maestro', timezone = 'UTC',
  has_completed_onboarding = true, deleted_at = null,
  scheduled_hard_delete_at = null
where id = '$fixture_user_id';

insert into public.families (id, owner_id, name, illustration_style)
values ('$fixture_family_id', '$fixture_user_id', 'Looking Back Maestro Family', 'default');

insert into public.family_memberships (family_id, user_id, role)
values ('$fixture_family_id', '$fixture_user_id', 'owner');

update public.user_profiles
set active_family_id = '$fixture_family_id'
where id = '$fixture_user_id';

insert into public.owner_entitlements (
  id, owner_user_id, app_user_id, environment, store, product_id,
  entitlement_id, period_type, status, purchased_at, expires_at,
  will_renew, last_event_at
) values (
  '$fixture_entitlement_id', '$fixture_user_id', '$fixture_user_id',
  'production', 'app_store', 'momora_annual', 'momora_plus', 'annual',
  'active', now(), now() + interval '30 days', false, now()
);

insert into public.memories (
  id, family_id, user_id, content, memory_date, emotion, memory_type,
  illustration_status, illustration_key, illustration_generation_id,
  media_key, media_content_type
) values
  (
    '$fixture_memory_short_id', '$fixture_family_id', '$fixture_user_id',
    '$fixture_first_frame_text', current_date - 401, 'wonder',
    'text_only', 'none', null, null, null, null
  ),
  (
    '$fixture_memory_long_id', '$fixture_family_id', '$fixture_user_id',
    'After the rain we followed the little paper boats past every puddle on the lane, counting each one as it turned around stones, slipped beneath leaves, and carried our bright chalk marks toward the corner where the afternoon sun finally found us laughing together beside the old blue fence.',
    current_date - 367, 'joy', 'text_only', 'none', null, null, null, null
  ),
  (
    '$fixture_memory_illustration_id', '$fixture_family_id', '$fixture_user_id',
    'We remembered the blanket fort in one bright illustrated chapter.',
    current_date - 331, 'tender', 'text_illustration', 'ready',
    '$fixture_illustration_key',
    '$fixture_illustration_generation_id', null, null
  ),
  (
    '$fixture_memory_photo_id', '$fixture_family_id', '$fixture_user_id',
    'A synthetic local-only photo and video chapter for the deterministic viewer fixture.',
    current_date - 295, 'bittersweet', 'media', 'none', null, null,
    '$fixture_photo_key',
    'image/jpeg'
  );

insert into public.memory_media (
  id, memory_id, object_key, content_type, duration_ms, aspect_ratio, position
) values
  (
    '$fixture_media_id',
    '$fixture_memory_photo_id',
    '$fixture_photo_key',
    'image/jpeg', null, 1.3333333333, 0
  ),
  (
    '$fixture_video_id',
    '$fixture_memory_photo_id',
    '$fixture_video_key',
    'video/mp4', 1000, 1.0, 1
  );

insert into public.looking_back_daily_sets (
  id, family_id, package_date, timezone_name, refresh_after, created_at
) values (
  '$fixture_daily_set_id', '$fixture_family_id', current_date, 'UTC',
  ((current_date + 1)::timestamp at time zone 'UTC'), now()
);

insert into public.looking_back_packages (
  id, daily_set_id, family_id, package_date, package_type,
  subject_family_member_id, display_kind, display_title, display_subtitle,
  display_era, tint, recipe_identity, signature, position
) values (
  '$fixture_package_id', '$fixture_daily_set_id', '$fixture_family_id',
  current_date, 'archive_mix', null, 'A little archive',
  'Four kinds of remembering', 'A deterministic local-only package',
  'A while ago', 'bittersweet', 'e2e:known-mixed-package', repeat('e', 64), 0
);

insert into public.looking_back_package_memories (
  package_id, family_id, memory_id, position
) values
  ('$fixture_package_id', '$fixture_family_id', '$fixture_memory_short_id', 0),
  ('$fixture_package_id', '$fixture_family_id', '$fixture_memory_illustration_id', 1),
  ('$fixture_package_id', '$fixture_family_id', '$fixture_memory_photo_id', 2),
  ('$fixture_package_id', '$fixture_family_id', '$fixture_memory_long_id', 3);

do \$fixture_check\$
begin
  if (select count(*) from public.looking_back_package_memories where package_id = '$fixture_package_id') <> $fixture_memory_count then
    raise exception 'Looking Back fixture package cardinality mismatch';
  end if;
  if (
    select sum(
      case when m.memory_type = 'media'
        then greatest((select count(*) from public.memory_media mm where mm.memory_id = m.id), 1)
        else 1
      end
    )
    from public.looking_back_package_memories lbpm
    join public.memories m on m.id = lbpm.memory_id
    where lbpm.package_id = '$fixture_package_id'
  ) <> $fixture_frame_count then
    raise exception 'Looking Back fixture frame count mismatch';
  end if;
  if not exists (
    select 1 from public.memories
    where id = '$fixture_memory_illustration_id'
      and memory_type = 'text_illustration'
      and illustration_status = 'ready'
      and illustration_key is not null
      and illustration_generation_id = '$fixture_illustration_generation_id'
  ) then
    raise exception 'Looking Back fixture illustration contract mismatch';
  end if;
  if (
    select array_agg(content_type order by position)
    from public.memory_media
    where memory_id = '$fixture_memory_photo_id'
  ) <> array['image/jpeg', 'video/mp4']::text[] then
    raise exception 'Looking Back fixture ordered media contract mismatch';
  end if;
  if exists (select 1 from public.looking_back_package_views where package_id = '$fixture_package_id') then
    raise exception 'Looking Back fixture must start unviewed';
  end if;
end
\$fixture_check\$;

commit;
SQL

  # The transaction is now durable and gives the exact private keys a family
  # owner plus referenced memory rows. Upload real, non-personal fixture bytes
  # before verifying the same paths the device will use.
  trap 'cleanup_fixture >/dev/null || true' EXIT
  fixture_temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/looking-back-e2e.XXXXXX")"
  ffmpeg -loglevel error -i assets/images/icon.png -frames:v 1 \
    -vf 'scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=white' \
    -q:v 2 "$fixture_temp_dir/fixture-photo.jpg"
  ffmpeg -loglevel error -loop 1 -i assets/images/icon.png -t 1 \
    -vf 'scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=white' \
    -r 24 -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
    "$fixture_temp_dir/fixture-video.mp4"
  mutate_fixture_storage upload \
    "$fixture_temp_dir/fixture-photo.jpg" \
    "$fixture_temp_dir/fixture-video.mp4" >/dev/null
  cleanup_temp_files
  verify_local_auth_and_rls
  trap - EXIT
  print_fixture_contract
}

verify_local_auth_and_rls() {
  local package_response media_response package_status media_status access_token key media_url media_http_status
  package_response="$(mktemp)"
  media_response="$(mktemp)"
  trap 'rm -f "$package_response" "$media_response"' RETURN
  access_token="$(authenticate_fixture)" || fail 'isolated fixture authentication failed.'

  package_status="$(curl --silent --show-error --output "$package_response" --write-out '%{http_code}' \
    "$EXPO_PUBLIC_SUPABASE_URL/rest/v1/looking_back_packages?select=id&id=eq.$fixture_package_id" \
    --header "apikey: $EXPO_PUBLIC_SUPABASE_ANON_KEY" \
    --header "Authorization: Bearer $access_token")"
  [[ "$package_status" == '200' ]] || fail "isolated RLS verification failed with HTTP $package_status."
  [[ "$(jq -r 'length' "$package_response")" == '1' ]] \
    || fail 'the isolated API and Postgres URL do not expose the same fixture package.'

  media_status="$(curl --silent --show-error --output "$media_response" --write-out '%{http_code}' \
    --request POST "$EXPO_PUBLIC_SUPABASE_URL/functions/v1/get-media-url" \
    --header "apikey: $EXPO_PUBLIC_SUPABASE_ANON_KEY" \
    --header "Authorization: Bearer $access_token" \
    --header 'Content-Type: application/json' \
    --data "$(jq -cn \
      --arg illustration "$fixture_illustration_key" \
      --arg photo "$fixture_photo_key" \
      --arg video "$fixture_video_key" \
      '{keys:[$illustration,$photo,$video]}')")"
  [[ "$media_status" == '200' ]] \
    || fail "isolated get-media-url verification failed with HTTP $media_status."

  for key in "$fixture_illustration_key" "$fixture_photo_key" "$fixture_video_key"; do
    media_url="$(jq -er --arg key "$key" '.urls[$key]' "$media_response")" \
      || fail 'isolated get-media-url response omitted a fixture object.'
    media_http_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$media_url")"
    [[ "$media_http_status" == '200' ]] \
      || fail "isolated fixture object read verification failed with HTTP $media_http_status."
  done

  rm -f "$package_response" "$media_response"
  trap - RETURN
}

print_fixture_contract() {
  printf 'TEST_EMAIL=%s\n' "$fixture_email"
  printf 'LOOKING_BACK_PACKAGE_ID=%s\n' "$fixture_package_id"
  printf 'LOOKING_BACK_MEMORY_COUNT=%s\n' "$fixture_memory_count"
  printf 'LOOKING_BACK_FRAME_COUNT=%s\n' "$fixture_frame_count"
  printf 'LOOKING_BACK_FIRST_FRAME_TEXT=%s\n' "$fixture_first_frame_text"
}

run_maestro() {
  validate_dev_environment
  require_command maestro

  seed_fixture
  local test_status=0
  trap 'cleanup_fixture >/dev/null || true' EXIT
  maestro test \
    -e TEST_EMAIL="$fixture_email" \
    -e TEST_PASSWORD="$LOOKING_BACK_E2E_PASSWORD" \
    -e LOOKING_BACK_PACKAGE_ID="$fixture_package_id" \
    -e LOOKING_BACK_FRAME_COUNT="$fixture_frame_count" \
    -e LOOKING_BACK_FIRST_FRAME_TEXT="$fixture_first_frame_text" \
    .maestro/flows/looking-back/package-viewer.yaml || test_status=$?
  cleanup_fixture >/dev/null
  trap - EXIT
  return "$test_status"
}

main() {
  local action="${1:-}"
  [[ $# -eq 1 ]] || { usage; exit 2; }
  [[ "$action" == 'seed' || "$action" == 'run' || "$action" == 'cleanup' ]] \
    || { usage; exit 2; }

  require_command psql
  require_command curl
  require_command jq
  require_command deno
  validate_database_target
  validate_api_target
  validate_r2_target
  validate_dev_environment

  case "$action" in
    cleanup)
      cleanup_fixture
      ;;
    seed)
      require_command ffmpeg
      [[ -r assets/onboarding/year-fort-hallway.webp ]] \
        || fail 'the non-personal illustration fixture is missing.'
      [[ -r assets/images/icon.png ]] \
        || fail 'the non-personal app icon fixture is missing.'
      seed_fixture
      ;;
    run)
      require_command ffmpeg
      [[ -r assets/onboarding/year-fort-hallway.webp ]] \
        || fail 'the non-personal illustration fixture is missing.'
      [[ -r assets/images/icon.png ]] \
        || fail 'the non-personal app icon fixture is missing.'
      run_maestro
      ;;
  esac
}

main "$@"
