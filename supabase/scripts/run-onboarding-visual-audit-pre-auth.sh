#!/usr/bin/env bash
# Captures S0-S12A only. It deliberately never enters an email address, so it
# cannot create an Auth user, commit a family, or invoke the image pipeline.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

if ! command -v maestro >/dev/null 2>&1; then
  echo "Maestro CLI is required. Install it, start a simulator/device, and rerun." >&2
  exit 1
fi

if [[ -z "${MAESTRO_DEVICE_ID:-}" ]]; then
  echo "MAESTRO_DEVICE_ID is required so the entire visual review uses one simulator/device." >&2
  exit 1
fi

if [[ "$MAESTRO_DEVICE_ID" == *,* ]]; then
  echo "The visual audit accepts exactly one MAESTRO_DEVICE_ID so every capture has the same device geometry." >&2
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

if [[ ! -r .env.local ]]; then
  echo ".env.local is required so this runner can reject hosted Supabase configurations." >&2
  exit 1
fi

supabase_url="$(read_env_file_value .env.local EXPO_PUBLIC_SUPABASE_URL)"
if [[ ! "$supabase_url" =~ ^http://127\.0\.0\.1:[0-9]+/?$ ]]; then
  echo "EXPO_PUBLIC_SUPABASE_URL must be an explicit http://127.0.0.1:<port> local Supabase URL for the visual audit. Refusing hosted or production configuration." >&2
  exit 1
fi

run_id="${ONBOARDING_VISUAL_AUDIT_RUN_ID:-$(date +%Y%m%d%H%M%S)-$RANDOM}"
output_dir="${ONBOARDING_VISUAL_AUDIT_OUTPUT:-$project_root/.maestro/report/onboarding-visual-audit/pre-auth-$run_id}"

if [[ "$output_dir" != /* ]]; then
  echo "ONBOARDING_VISUAL_AUDIT_OUTPUT must be an absolute path." >&2
  exit 1
fi

if [[ "$output_dir" == "$project_root/"* ]] && ! git check-ignore -q "$output_dir"; then
  echo "In-repository visual-audit output must be ignored by git (use .maestro/report/)." >&2
  exit 1
fi

if [[ -e "$output_dir" ]] && [[ -n "$(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Visual-audit output directory must be new or empty: $output_dir" >&2
  exit 1
fi
mkdir -p "$output_dir"

export MAESTRO_CLI_NO_ANALYTICS=true
maestro test \
  --udid "$MAESTRO_DEVICE_ID" \
  --test-output-dir "$output_dir" \
  .maestro/flows/onboarding/owner-visual-audit-pre-auth.yaml

echo "Pre-auth onboarding visual-audit screenshots: $output_dir"
