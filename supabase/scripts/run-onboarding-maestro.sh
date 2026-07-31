#!/usr/bin/env bash
# Runs owner and join onboarding E2E against an isolated local Supabase,
# Mailpit, image stack, and hard-delete function only. The owner flow creates
# real image artifacts, so cleanup goes through the production deletion path
# rather than deleting Auth rows directly.
# The app requests each OTP mid-flow, so each Maestro journey is intentionally
# split around that one boundary and resumed without clearing application state.

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

fixture_script="supabase/scripts/onboarding-maestro-fixture.ts"
deno_cmd=(deno run --allow-env --allow-net "$fixture_script")
run_mode="${ONBOARDING_MAESTRO_MODE:-happy}"

if [[ "$run_mode" != "happy" && "$run_mode" != "visual-audit" ]]; then
  echo "ONBOARDING_MAESTRO_MODE must be happy or visual-audit." >&2
  exit 1
fi

if ! command -v maestro >/dev/null 2>&1; then
  echo "Maestro CLI is required. Install it, start a simulator/device, and rerun." >&2
  exit 1
fi

if [[ -z "${MAESTRO_DEVICE_ID:-}" ]]; then
  echo "MAESTRO_DEVICE_ID is required so every staged flow uses the same simulator/device." >&2
  exit 1
fi

if [[ "$run_mode" == "visual-audit" && "$MAESTRO_DEVICE_ID" == *,* ]]; then
  echo "Visual-audit mode accepts exactly one MAESTRO_DEVICE_ID so every capture has the same device geometry." >&2
  exit 1
fi

if [[ "${ONBOARDING_E2E_IMAGE_STACK:-}" != "isolated-local" ]]; then
  echo "Set ONBOARDING_E2E_IMAGE_STACK=isolated-local after configuring local Worker/R2/Edge Functions. Refusing to generate images against an unverified stack." >&2
  exit 1
fi

if [[ -z "${R2_ENDPOINT:-}" ]]; then
  echo "R2_ENDPOINT must name the local object store used by hard-delete cleanup." >&2
  exit 1
fi

read_env_file_value() {
  local env_file="$1"
  local key="$2"
  local value

  value="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*//p" "$env_file" | tail -n 1)"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "$value"
}

validate_local_client_env_file() {
  local env_file=".env.local"
  local configured_value

  if [[ ! -r "$env_file" ]]; then
    echo "$env_file is required so the running development client can be checked before fixtures are created." >&2
    exit 1
  fi

  configured_value="$(read_env_file_value "$env_file" EXPO_PUBLIC_SUPABASE_URL)"
  if [[ -z "$configured_value" || "$configured_value" != "${EXPO_PUBLIC_SUPABASE_URL:-}" ]]; then
    echo "$env_file must set EXPO_PUBLIC_SUPABASE_URL to the matching isolated-local Supabase URL (value withheld). Restart Metro after changing it." >&2
    exit 1
  fi
}

validate_local_function_env_file() {
  local env_file="supabase/.env.local"
  local key
  local configured_value
  local expected_value

  if [[ ! -r "$env_file" ]]; then
    echo "$env_file is required. Start Supabase Edge Functions with this same isolated-local env file." >&2
    exit 1
  fi

  # Do not source this secrets file. Read only the four non-secret endpoints,
  # compare them without printing values, and require the function process to
  # be started with this file. This blocks the common mistake where the app
  # harness is local but `supabase functions serve` still dispatches R2 or a
  # Worker using an old hosted configuration.
  for key in R2_ENDPOINT CLOUDFLARE_ILLUSTRATION_WORKFLOW_URL CLOUDFLARE_PORTRAIT_WORKFLOW_URL MEMORY_ILLUSTRATION_BACKEND PORTRAIT_GENERATION_BACKEND; do
    configured_value="$(read_env_file_value "$env_file" "$key")"
    expected_value="${!key:-}"
    if [[ -z "$configured_value" || "$configured_value" != "$expected_value" ]]; then
      echo "$env_file must set ${key} to the matching isolated-local endpoint (value withheld)." >&2
      exit 1
    fi
  done

  if [[ "${MEMORY_ILLUSTRATION_BACKEND:-}" != "cloudflare" || "${PORTRAIT_GENERATION_BACKEND:-}" != "cloudflare" ]]; then
    echo "Both illustration backends must be cloudflare for this Worker E2E run." >&2
    exit 1
  fi
}

validate_local_worker_env_file() {
  local env_file="cloudflare/memory-illustration-worker/.dev.vars"
  local local_supabase_url="${EXPO_PUBLIC_SUPABASE_URL%/}"
  local illustration_bridge_url
  local portrait_bridge_url

  if [[ ! -r "$env_file" ]]; then
    echo "$env_file is required. Start the Worker with its local dev vars and --local mode." >&2
    exit 1
  fi

  # The Edge Functions dispatch to the local Worker, which then bridges its
  # result back to Supabase. Validate that reverse direction too: otherwise a
  # locally addressed dispatch URL could still let a Worker call a hosted
  # bridge. Only URLs are read and no configuration value is printed.
  illustration_bridge_url="$(read_env_file_value "$env_file" SUPABASE_BRIDGE_URL)"
  portrait_bridge_url="$(read_env_file_value "$env_file" PORTRAIT_SUPABASE_BRIDGE_URL)"
  if [[ "$illustration_bridge_url" != "$local_supabase_url/functions/v1/workflow-illustration-bridge" ]]; then
    echo "$env_file must set SUPABASE_BRIDGE_URL to the matching local bridge (value withheld)." >&2
    exit 1
  fi
  if [[ "$portrait_bridge_url" != "$local_supabase_url/functions/v1/workflow-portrait-bridge" ]]; then
    echo "$env_file must set PORTRAIT_SUPABASE_BRIDGE_URL to the matching local bridge (value withheld)." >&2
    exit 1
  fi
}

validate_local_client_env_file
validate_local_function_env_file
validate_local_worker_env_file

if [[ "$run_mode" == "visual-audit" && ! "${EXPO_PUBLIC_SUPABASE_URL:-}" =~ ^http://127\.0\.0\.1:[0-9]+/?$ ]]; then
  echo "Visual-audit mode requires EXPO_PUBLIC_SUPABASE_URL to be an explicit http://127.0.0.1:<port> local URL." >&2
  exit 1
fi

run_id="${ONBOARDING_E2E_RUN_ID:-local-$(date +%Y%m%d%H%M%S)-$RANDOM}"
setup_output="$("${deno_cmd[@]}" setup --run-id "$run_id")"

read_value() {
  local key="$1"
  local value
  value="$(printf '%s\n' "$setup_output" | sed -n "s/^${key}=//p")"
  if [[ -z "$value" ]]; then
    echo "Fixture setup did not return ${key}." >&2
    exit 1
  fi
  printf '%s' "$value"
}

owner_email="$(read_value OWNER_EMAIL)"
joiner_email="$(read_value JOINER_EMAIL)"

cleanup() {
  local status="$1"
  if ! "${deno_cmd[@]}" cleanup --run-id "$run_id"; then
    echo "Local fixture cleanup failed; rerun: ${deno_cmd[*]} cleanup --run-id $run_id" >&2
    status=1
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT

export MAESTRO_CLI_NO_ANALYTICS=true
maestro_cmd=(maestro test --udid "$MAESTRO_DEVICE_ID")

if [[ "$run_mode" == "visual-audit" ]]; then
  if [[ -z "${ONBOARDING_MAESTRO_TEST_OUTPUT_DIR:-}" ]]; then
    echo "ONBOARDING_MAESTRO_TEST_OUTPUT_DIR is required for visual-audit mode." >&2
    exit 1
  fi
  maestro_cmd+=(--test-output-dir "$ONBOARDING_MAESTRO_TEST_OUTPUT_DIR")
  owner_pre_otp_flow=".maestro/flows/onboarding/owner-visual-audit-pre-otp.yaml"
  owner_post_otp_flow=".maestro/flows/onboarding/owner-visual-audit-post-otp.yaml"
else
  owner_pre_otp_flow=".maestro/flows/onboarding/owner-happy-path-pre-otp.yaml"
  owner_post_otp_flow=".maestro/flows/onboarding/owner-happy-path-post-otp.yaml"
fi

"${maestro_cmd[@]}" \
  -e TEST_ONBOARDING_OWNER_EMAIL="$owner_email" \
  "$owner_pre_otp_flow"

owner_otp="$("${deno_cmd[@]}" otp --email "$owner_email")"
"${maestro_cmd[@]}" \
  -e TEST_ONBOARDING_OWNER_OTP="$owner_otp" \
  "$owner_post_otp_flow"

if [[ "$run_mode" == "visual-audit" ]]; then
  echo "Local owner onboarding visual-audit journey completed."
  exit 0
fi

invite_code="$("${deno_cmd[@]}" invite --owner-email "$owner_email")"
"${maestro_cmd[@]}" \
  -e TEST_ONBOARDING_INVITE_CODE="$invite_code" \
  -e TEST_ONBOARDING_JOINER_EMAIL="$joiner_email" \
  .maestro/flows/onboarding/join-happy-path-pre-otp.yaml

joiner_otp="$("${deno_cmd[@]}" otp --email "$joiner_email")"
"${maestro_cmd[@]}" \
  -e TEST_ONBOARDING_JOINER_OTP="$joiner_otp" \
  .maestro/flows/onboarding/join-happy-path-post-otp.yaml

echo "Local owner and join onboarding Maestro journeys completed."
