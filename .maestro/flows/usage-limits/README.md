# Usage-limit local fixture

Run only against `http://127.0.0.1:54321`. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `USAGE_LIMIT_E2E_FAMILY_ID`, `USAGE_LIMIT_E2E_USER_ID`, and an existing family-owned `USAGE_LIMIT_E2E_TARGET_ID`, then run `npm run test:e2e:usage-limits`. The wrapper seeds, runs Maestro, and cleans in a finally-style shell sequence. The script rejects every non-loopback URL, validates UUIDs/membership/target ownership, requires already-active enforcement, uses its current epoch, and never updates `ai_usage_settings` or another global setting.

The mobile flow verifies only the actor-scoped cold-start durable notice: it asserts the warm copy,
dismisses it, then confirms the timeline is usable. Server-issued 429/capture-first behavior is
covered by Deno and client integration tests, not this Maestro fixture.
