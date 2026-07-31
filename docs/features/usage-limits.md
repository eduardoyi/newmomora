# Feature: Usage limits & AI cost observability

**Status:** `implemented — staged rollout required`
**Last updated:** 2026-07-29
**PRD reference:** n/a (unit-economics protection; see [COST_OPTIMIZATION.md](../COST_OPTIMIZATION.md) and [PRICING_STRATEGY.md](../PRICING_STRATEGY.md))

## Overview

Two coupled capabilities that protect margins without degrading the product: (1) a per-call
**AI usage ledger** (`ai_usage_events`) attributing every OpenAI spend to a family or to Momora's
pre-auth onboarding COGS, and (2)
**invisible fair-use limits** on image generation that bound worst-case cost per family. Design
was decided 2026-07-24 and implemented 2026-07-27 behind a staged, disabled-by-default rollout.

## Design principles (decided — do not relitigate without owner)

1. **No visible credit system.** VoC research (docs/voice-of-customer.md) shows visible metering
   is the top competitor rage-trigger (Tinybeans upload caps, Chatbooks credits). Limits are
   invisible until touched; fair-use language lives in ToS, not the UI.
2. **Limits are generous by data, not by guess.** Measured p99-style heavy family ≈ 30
   illustrated memories/mo (~$2.75 AI cost — see COST_OPTIMIZATION.md). Caps sit ~3× above that
   and near the subscription break-even (~76 generations/mo on the worst plan/fee combo, ~118+
   on monthly — see PRICING_STRATEGY.md), so even a family that hits the cap is roughly
   break-even, never a large loss.
3. **A limit never blocks journaling.** Memory text always saves first (existing architecture);
   limits only defer illustration. Copy when hit must reflect that: warm, "your memory is saved."
4. **Enforcement must not depend on the ledger.** Admission/consumption is a durable server-side
   request and reservation protocol; ledger writes are best-effort observability and never block a user flow.
5. **Onboarding voice is Momora cost, not family cost.** A user may transcribe before a real
   family exists. Those two paid calls are recorded honestly as `onboarding`, never assigned to a
   fake family and never charged against a later family's limits.

## Limits (defaults)

| Limit | Default | Rationale |
|-------|---------|-----------|
| Regenerates per memory per day | 5 | The real abuse vector is regenerate-hammering, not new memories (writing has natural friction) |
| Image generations per family per day | 20 | Allows onboarding bursts (a large family's portraits + first memories in one day); kills scripted abuse |
| Image generations per family per month | 100 | ~3× heavy legit usage; ≈ break-even on the worst plan/fee combo (annual @30% fee) |

Counting rules: illustrations + portraits share the daily/monthly pools; the regenerate limit is
per-memory. **All request intents count, including `recovery`** — recovery/retrigger storms are
precisely the runaway-cost scenario the caps exist to bound (a bug that loops recovery jobs must
hit the ceiling, not the OpenAI invoice).

## Enforcement design

Enforcement uses one logical
`ai_image_generation_request`, immutable admission records, and provider-attempt records. A
pre-provider reservation is released on definite preparation failure; the first provider slot
atomically consumes one fair-use unit. UTC daily/monthly buckets are rechecked at provider time.

- v2 Cloudflare jobs carry `usageRequestId` and `providerProtocolVersion: 2`; only bridge outcome
  `reserved_now` may call OpenAI. `already_reserved`, `denied`, malformed responses, and replayed
  slots fail closed.
- Old queued v1 jobs retain `{ reserved: boolean }` bridge behavior. A v1 preparation already
  underway at the scheduled activation boundary has one five-minute handoff (the promoted-lease
  duration) to stamp its durable service-only job; after that, v2 linkage is mandatory. V2 jobs
  never downgrade to v1.
- Primary retries and fallback attempts get separate deterministic `aiCallId`s but share the one
  logical request unit. Provider/network ambiguity after commitment remains consumed.
- The client never calculates eligibility. It receives HTTP 429 `USAGE_LIMIT_REACHED` with
  `scope` and `retryAfterIso`, renders a warm local-time message, and shows actor-only notices
  from `get_my_ai_usage_limit_notices`. No counts or credits are shown.

Preparation admission is atomic: it holds the family usage lock, checks active reservations plus
consumed requests, installs a fenced preparation claim, and creates an admission before paid
preparation. Claims carry request/token/ordinal/input snapshot; stale workers cannot promote,
clear, or write after a takeover. Expired preparation is re-admitted under current limits.

At the first provider slot, the database rebuckets the admission using the current UTC day/month
and atomically records `reserved_now`; boundary rejections make no provider call. Provider-time,
not device time, decides usage. Definite pre-provider failures cancel holds; post-provider and
ambiguous calls remain consumed.

## Activation and rollback

Enforcement is disabled by default. Deploy schema and v2-compatible bridges first, then Workers,
functions, client, and alert cron. Backfill one usage-lock row per family and preflight missing
locks/request links/protocol stamps before setting a future activation timestamp and new epoch.
At that boundary, a v1 preparation has only the five-minute promoted-lease handoff to stamp its
durable job; after it, v2 linkage is mandatory. Before rollback, disable enforcement first; ledger
collection remains independent and no historical usage is backfilled.

## Data model: `ai_usage_events`

Service-role-only table (RLS enabled, no client policies), one row per external AI call
(including failed calls — failures are still billed):

| Column | Notes |
|--------|-------|
| `id`, `created_at` | |
| `attribution_scope` | `family` (default) or `onboarding` |
| `family_id`, `onboarding_request_id`, `actor_user_id` | Exact attribution. Family events require a real `family_id` and no onboarding request. Onboarding events link to one server-issued opaque attempt request, have `family_id = null`, and actor attribution may become null after anonymous Auth cleanup. |
| `operation` | `illustration` \| `portrait` \| `safety_chat` \| `emotion_chat` \| `emotion_vision` \| `transcription` \| `voice_cleanup` |
| `usage_request_id`, `family_id`, `actor_user_id`, `operation`, `model`, `request_intent`, `provider` | durable attribution and request linkage |
| `success` | boolean |
| `provider_usage`, token/audio dimensions, `pricing_version`, `cost_basis`, `billing_status`, `cost_is_complete`, `estimated_cost_usd` | allowlisted provider data and immutable cost interpretation |

Write points (the two OpenAI chokepoints):
- **Cloudflare worker** (`cloudflare/memory-illustration-worker/src/openai.ts`): parse `usage`
  from the response, report via a new bridge action (`record_usage`) → SECURITY DEFINER RPC.
- **Edge shared module** (`supabase/functions/_shared/openai.ts`): wrap `chatJson`,
  `chatJsonWithVision`, `transcribeAudio`, and the image-edit helpers to insert directly with the
  service client. Fire-and-forget (`waitUntil` / unawaited with error swallow + console.warn).

Cost math must split output tokens: gpt-image-1.5 bills text output at $10/1M vs $32/1M image
output (see the corrected `computeCost` in `supabase/scripts/eval-image-cost.ts` — reuse its
pricing constant shape).

### Pre-auth onboarding voice contract

Only `transcription` and `voice_cleanup` may use `attribution_scope = 'onboarding'`. The
service-role-only ledger RPC is:

```sql
record_ai_usage_event_detailed(
  p_ai_call_id text, p_usage_request_id uuid, p_family_id uuid,
  p_actor_user_id uuid, p_operation text, p_model text, p_success boolean,
  p_provider_usage jsonb default '{}', p_estimated_cost_usd numeric default null,
  p_cost_basis text default 'unpriced', p_billing_status text default 'unknown',
  p_cost_is_complete boolean default false, p_pricing_version text default null,
  p_attribution_scope text default 'family', p_onboarding_request_id uuid default null
) returns boolean
```

Existing family callers retain the default scope and their prior argument shape. An onboarding
caller passes `family_id = null`, `attribution_scope = 'onboarding'`, and the reservation's
`onboarding_request_id`. The ledger derives and validates actor attribution from that private
request; it never accepts a caller-supplied session or persistent per-user identifier. Constraints
and RPC validation reject every other combination.

Before any provider work, `process-voice-memory` must call the service-role-only
`reserve_onboarding_voice_attempt(p_actor_user_id uuid) returns table (reserved boolean,
request_id uuid, attempts_used smallint)`. The RPC verifies `auth.users.is_anonymous` itself,
generates the opaque request ID server-side, returns a request ID for the first two attempts, and
returns `{ reserved: false, request_id: null }` thereafter (also for permanent or unknown users).
An advisory transaction lock makes the count-and-insert atomic; attempts stay consumed when the
provider fails or the response is ambiguous. The Edge Function must fail closed if this RPC errors
or returns an unexpected shape.

After transcription succeeds and immediately before cleanup starts, the Edge Function calls
`mark_onboarding_voice_cleanup_expected(p_request_id uuid, p_actor_user_id uuid) returns boolean`.
It atomically binds the marker to the reserving actor; a false/error/malformed result fails closed.
The marker deliberately does not wait on a detached best-effort transcription ledger write. This
lets observability flag (a) any reserved request missing transcription and (b) any marked request
missing cleanup, without creating cleanup gaps for transcription failures. The ledger also rejects
an onboarding `voice_cleanup` event unless this marker is already true.

The request table is RLS-protected and unreadable to clients. Auth cleanup nulls request and event
actor fields; the opaque request expires with raw data after 90 days and the deidentified company
rollup remains for 13 months.

## Views & alerting

- `family_ai_costs_monthly` view: family_id, month, calls, failed calls, est. cost, by operation.
- `company_ai_costs_monthly` view: separate `family` and `onboarding` totals, including all
  nullable-family onboarding COGS. It is operator-only, like the raw ledger.
- Alert before enforcement ever fires: reuse the existing cron Edge Function pattern to send the
  owner a digest when any family crosses 60% of the monthly cap or >$5 estimated spend in a
  month, plus a global fallback-rate anomaly line (fallback usage spiking = primary model
  degradation = cost + quality signal).

Retention defaults are 90 days for detailed requests/admissions/events and terminal alert outbox
records, 7 days for inactive notices, and 13 completed months for both family rollups and the
separate onboarding-system rollup. Family deletion cascades family data. Anonymous Auth deletion
removes only its live attempt counter and nulls raw-event actor attribution; onboarding cost
rollups remain as company accounting data.

### Scheduled alert delivery

`run-ai-usage-alerts` is a service-only cron endpoint. It requires `CRON_SECRET` in the
`x-cron-secret` header and has `verify_jwt = false` in `supabase/config.toml`; gateway JWT
verification would otherwise reject the scheduler before this check can run. Schedule it once per
environment at **06:00 UTC daily**. Set the server-only `AI_USAGE_ALERT_EMAIL` recipient (it
defaults to `hello@usemomora.com`) and optionally `AI_USAGE_ENVIRONMENT` for an explicit alert
label. The SQL outbox makes enqueueing idempotent: a definite provider rejection can retry up to
its SQL bound, while an unknown delivery outcome is marked terminal and is never automatically
redelivered.

## What we are deliberately NOT building

- Visible credits/quota UI (revisit only if a free tier ever launches — free tiers need visible
  limits for upgrade pressure; a paid product with fair use does not).
- Hard per-dollar billing enforcement, proration, or purchasable top-ups.
- Client-side enforcement (trivially bypassable; server is the only gate).
- Per-IP or per-device onboarding voice limits, CAPTCHA/Turnstile, and fraud scoring. The shipped
  minimum protection is only: a valid anonymous Auth JWT,
  the two-attempt atomic anonymous-user reservation, existing server audio-size/duration
  validation, and tightly bounded local spelling hints. The onboarding owner must enable
  `enable_anonymous_sign_ins` only alongside this Edge integration; this migration deliberately
  does **not** change anonymous-user RLS or Auth configuration. Add stronger controls before
  raising the voice allowance or treating anonymous onboarding as a broad public API.

## Extension guide

**Safe to extend:** new `operation` values as AI features are added (one enum value + one write
call); updating the singleton `ai_usage_settings` through an audited server/operator path; adding columns to the view.

`ai_usage_settings` is the sole settings source: `enforcement_enabled`,
`enforcement_activated_at`, `quota_policy_epoch`, `alert_policy_version`, the 5/20/100 limits,
`family_request_alert_fraction` (0.600), `family_monthly_spend_alert_usd` (5),
`global_fallback_alert_fraction` (0.200), `global_fallback_alert_min_calls` (20), and
`observability_gap_alert_minutes` (10), `family_unpriced_alert_min_calls` (5),
`global_unpriced_alert_fraction` (0.100), `global_unpriced_alert_min_calls` (20),
`max_alert_outbox_attempts` (3), and `updated_at/updated_by`. Changing quota policy increments
its epoch; changing any alert setting increments only `alert_policy_version` so limits never reset usage.

## Local and production procedure

Local: start Supabase with the repo-pinned CLI (`npm exec supabase -- start`), run `npm run db:reset`
and `npm run test:db`, then run `npm run test:edge` and the Worker test suite from
`cloudflare/memory-illustration-worker`. Also run the real local anonymous reservation race with
`ONBOARDING_VOICE_CONCURRENCY_TEST=1 npm run test:edge`; it refuses non-loopback credentials. For
the optional Maestro notice flow, use the
documented `npm run test:e2e:usage-limits` wrapper with explicit local fixture IDs; it refuses any
non-loopback project and does not enable enforcement.

Production: apply the migration while enforcement remains disabled, deploy v2-capable bridges and
Workers, then Edge Functions/client/cron. Verify the preflight queries for family lock backfill,
required request links, and protocol stamps; set a future activation timestamp only after they are
clean. After that boundary, wait the five-minute activation handoff plus the maximum old-job lease,
then verify v1 work has drained. Roll back by disabling enforcement first, then roll back
producers; do not delete ledger data or backfill requests.

For pre-auth onboarding voice, the production checklist in [onboarding.md](./onboarding.md)
also applies: anonymous Auth must be enabled in the hosted Supabase project, and the deployed
`cleanup-abandoned-anonymous-users` function must have a verified daily pg_cron invocation. The
cleanup preserves company COGS rollups while removing abandoned anonymous Auth identities.

Run these read-only preflight checks in the target database before activation: `select count(*)
from public.families f left join public.ai_family_usage_locks l on l.family_id=f.id where l.family_id
is null;`; `select count(*) from public.memory_illustration_jobs where usage_enforcement_required
and usage_request_id is null;`; and the equivalent query on `public.portrait_generation_jobs`.
Each count must be zero. After the scheduled activation boundary, its five-minute handoff, and the
maximum old-job lease, also run
`select count(*) from public.memory_illustration_jobs where status in ('queued', 'running') and
usage_protocol_version = 1;` and the equivalent query on
`public.portrait_generation_jobs`; both active-v1 counts must be zero. This explicitly detects
grandfathered jobs, which are not necessarily marked `usage_enforcement_required`. Also inspect
`ai_usage_settings` to confirm the scheduled activation timestamp was intentionally set.

**Do not change without updating this doc:** counting rules (which intents/statuses count toward
caps), the no-visible-credits principle, ledger-independence of enforcement.

## Testing

- Deno/pgTAP: admission limits, UTC provider-time rebucketing, RLS, reservation lifecycle,
  v1/v2 bridge compatibility, and ledger failure isolation.
- `supabase/tests/usage_limits_onboarding.sql`: two-success/third-denial atomic reservation
  behavior, service-only permissions, allowed/forbidden attribution combinations, family-view
  exclusion, company/global inclusion, 90-day raw versus 13-month system-rollup retention, and
  anonymous Auth cleanup.
- `supabase/scripts/onboarding-voice-reservation-concurrency.test.ts`: local-only real concurrency
  regression. With `ONBOARDING_VOICE_CONCURRENCY_TEST=1` and loopback Supabase credentials, it
  creates an anonymous Auth user and issues three simultaneous independent PostgREST reservation
  RPC requests. It proves exactly two durable rows with ordinals 1/2 and one clean denial; the
  test is intentionally ignored by ordinary `npm run test:edge` runs unless that explicit local
  flag is set.
- Worker: v2 fail-closed reservation responses, v1 grandfathered jobs, deterministic attempts,
  fallback/replay, usage parsing, and a never-resolving ledger call that cannot delay publication.
- Client: typed 429 parsing, local retry rendering, actor-only AsyncStorage dedupe, voice `familyId`,
  and recovery suppression only while canonical server metadata is active.
- Maestro setup is local-only, refuses non-local Supabase URLs, seeds/deletes only known fixture rows,
  and never changes global enforcement settings.
- Deployment verification: invoke `run-ai-usage-alerts` once with the real cron header before
  scheduling it; confirm the response is successful and that a test/threshold alert is delivered
  without names, prompts, transcripts, or memory content.
- Exact client files: `src/services/usage-limits.test.ts`,
  `src/hooks/useAiUsageLimitNotices.integration.test.tsx`,
  `src/services/ai.integration.test.ts`, and `src/services/portrait-versions.integration.test.ts`.

## Changelog

| Date | Change |
|------|--------|
| 2026-07-24 | Initial design recorded. |
| 2026-07-27 | Replaced job-row counting with request/admission/provider-slot protocol and staged v1/v2 rollout. |
| 2026-07-29 | Added family-or-onboarding ledger attribution and the two-attempt pre-auth voice COGS lane. |
