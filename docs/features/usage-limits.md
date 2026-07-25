# Feature: Usage limits & AI cost observability

**Status:** `planned`
**Last updated:** 2026-07-24
**PRD reference:** n/a (unit-economics protection; see [COST_OPTIMIZATION.md](../COST_OPTIMIZATION.md) and [PRICING_STRATEGY.md](../PRICING_STRATEGY.md))

## Overview

Two coupled capabilities that protect margins without degrading the product: (1) a per-call
**AI usage ledger** (`ai_usage_events`) attributing every OpenAI spend to a family, and (2)
**invisible fair-use limits** on image generation that bound worst-case cost per family. Design
decided 2026-07-24; not yet implemented.

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
4. **Enforcement must not depend on the ledger.** Enforcement counts rows in the existing jobs
   tables at job-creation time; the ledger is fire-and-forget observability. A logging failure
   can never block a user flow.

## Limits (proposed defaults)

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

Enforce in the two Edge Functions at job-creation time, **before** dispatch/spend:

- `generate-illustration` and `generate-portrait-illustration` count this-day/this-month rows in
  `memory_illustration_jobs` + `portrait_generation_jobs` by `family_id` (add a composite index
  on `(family_id, started_at)` if missing). Regenerate limit counts jobs for the `memory_id`
  today with intent `manual_regenerate`.
- On limit: return a structured error (`code: 'USAGE_LIMIT_REACHED'`, `scope: 'daily' | 'monthly'
  | 'memory'`, `retryAfterIso`). Client maps it to warm copy (never the word "credits"); the
  memory stays saved with illustration deferred/failed-retryable, matching existing status flows.
- Limits configurable via env/config so values can be tuned without redeploying logic.

## Data model: `ai_usage_events`

Service-role-only table (RLS enabled, no client policies), one row per external AI call
(including failed calls — failures are still billed):

| Column | Notes |
|--------|-------|
| `id`, `created_at` | |
| `family_id`, `actor_user_id` (nullable) | attribution |
| `operation` | `illustration` \| `portrait` \| `safety_chat` \| `emotion_chat` \| `emotion_vision` \| `transcription` \| `voice_cleanup` |
| `model`, `quality`, `reference_count` | request shape |
| `job_id`, `memory_id`, `request_intent` (nullable) | joins to jobs tables |
| `success` | boolean |
| `input_text_tokens`, `input_image_tokens`, `output_image_tokens`, `output_text_tokens`, `audio_seconds` | raw units from the provider `usage` object |
| `estimated_cost_usd` | computed at write time from a pricing constant; store the number, not just the rate — pricing changes must not rewrite history |

Write points (the two OpenAI chokepoints):
- **Cloudflare worker** (`cloudflare/memory-illustration-worker/src/openai.ts`): parse `usage`
  from the response, report via a new bridge action (`record_usage`) → SECURITY DEFINER RPC.
- **Edge shared module** (`supabase/functions/_shared/openai.ts`): wrap `chatJson`,
  `chatJsonWithVision`, `transcribeAudio`, and the image-edit helpers to insert directly with the
  service client. Fire-and-forget (`waitUntil` / unawaited with error swallow + console.warn).

Cost math must split output tokens: gpt-image-1.5 bills text output at $10/1M vs $32/1M image
output (see the corrected `computeCost` in `supabase/scripts/eval-image-cost.ts` — reuse its
pricing constant shape).

## Views & alerting

- `family_ai_costs_monthly` view: family_id, month, calls, failed calls, est. cost, by operation.
- Alert before enforcement ever fires: reuse the existing cron Edge Function pattern to send the
  owner a digest when any family crosses 60% of the monthly cap or >$5 estimated spend in a
  month, plus a global fallback-rate anomaly line (fallback usage spiking = primary model
  degradation = cost + quality signal).

## What we are deliberately NOT building

- Visible credits/quota UI (revisit only if a free tier ever launches — free tiers need visible
  limits for upgrade pressure; a paid product with fair use does not).
- Hard per-dollar billing enforcement, proration, or purchasable top-ups.
- Client-side enforcement (trivially bypassable; server is the only gate).

## Extension guide

**Safe to extend:** new `operation` values as AI features are added (one enum value + one write
call); tuning limit values via config; adding columns to the view.

**Do not change without updating this doc:** counting rules (which intents/statuses count toward
caps), the no-visible-credits principle, ledger-independence of enforcement.

## Testing (when implemented)

- Deno tests: limit boundary (at/over daily, monthly, per-memory), error contract shape,
  recovery-intent counting, ledger write failure does not fail the request.
- Worker test: bridge `record_usage` call shape; usage parse of both models' responses.
- Client: `USAGE_LIMIT_REACHED` mapping to copy; memory remains saved/retryable.

## Changelog

| Date | Change |
|------|--------|
| 2026-07-24 | Design written (limits values, ledger schema, enforcement points); implementation pending |
