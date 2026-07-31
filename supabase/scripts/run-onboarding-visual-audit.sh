#!/usr/bin/env bash
# Delegates the full S0-S17 visual audit to the existing guarded local
# onboarding harness. That harness validates local Supabase, Edge Functions,
# Worker, and R2 before the synthetic account is created and later cleans it
# up through the normal hard-delete path.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

if [[ "${ONBOARDING_VISUAL_AUDIT_ALLOW_REAL_IMAGE_COSTS:-}" != "1" ]]; then
  echo "Set ONBOARDING_VISUAL_AUDIT_ALLOW_REAL_IMAGE_COSTS=1 to acknowledge that the full audit sends one synthetic portrait request to the configured OpenAI provider." >&2
  exit 1
fi

run_id="${ONBOARDING_VISUAL_AUDIT_RUN_ID:-$(date +%Y%m%d%H%M%S)-$RANDOM}"
output_dir="${ONBOARDING_VISUAL_AUDIT_OUTPUT:-$project_root/.maestro/report/onboarding-visual-audit/full-$run_id}"

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

export ONBOARDING_MAESTRO_MODE=visual-audit
export ONBOARDING_MAESTRO_TEST_OUTPUT_DIR="$output_dir"
export ONBOARDING_E2E_RUN_ID="${ONBOARDING_E2E_RUN_ID:-visual-audit-$run_id}"

bash supabase/scripts/run-onboarding-maestro.sh

echo "Full onboarding visual-audit screenshots: $output_dir"
