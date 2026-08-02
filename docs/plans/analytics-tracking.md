# Analytics tracking plan (PostHog)

Status: implemented (2026-08-02). This document is the original proposal; for
the living reference (exact event shapes, PII rules, dedupe semantics, and how
to extend), see [docs/features/analytics.md](../features/analytics.md) — the
code (`src/services/analytics.ts`'s `AnalyticsEventMap`) is the source of
truth if this doc and the code ever disagree.

## Decision

Use **PostHog** (`posthog-react-native` via `npx expo install`). Reasons:

- Funnel data only exists from the day it's installed; promotion is starting now.
- Free tier (1M events/mo) covers us for a long time at launch scale.
- RevenueCat is already configured with `appUserID = Supabase user id`
  ([billing.ts](../../src/services/billing.ts)), so the RevenueCat → PostHog
  integration works with zero aliasing: PostHog `distinct_id` = Supabase user id
  = RevenueCat appUserID. Revenue events (trial start/convert/churn/renewal)
  arrive server-side from RevenueCat — we never instrument purchases twice.
- DB-state metrics (total users, memories, families) stay in Supabase/SQL;
  PostHog is only for behavioral funnels SQL can't reconstruct.

## Setup rules (non-negotiable)

- **Autocapture OFF. Session replay OFF.** Autocapture would swallow
  `TextInput` values and accessibility labels containing child names
  (`capture.tsx`, `kids.tsx`, `new-memory.tsx`, comments drawer). We track
  explicit events only.
- **Anonymous id pre-auth, `identify()` at OTP verify** (S12B owner /
  J4 joiner) with the Supabase user id, so the pre-paywall funnel stitches
  to the paid user.
- Person properties: `role`, `access_reason`, `paywall_mode`,
  `membership_count`. Nothing else.

## Privacy — never in any event property

Memory content/captions, voice transcripts, **child names / member names /
family name** (derived from kid names), comment bodies, emails, OTP codes,
**invite word-codes** (live credentials), DOB/gender/notes, media URIs/URLs,
illustration prompts, emotion results tied to a child.

Safe substitutes: counts (`kid_count`, `tagged_count`, `attachment_count`),
booleans (`used_voice`, `has_media`, `illustration_enabled`), UUIDs, and
existing enums (`memory_type`, `illustration_status`, `access_reason`,
`paywall_mode`, `role`, `IllustrationRequestIntent`, `notification_choice`).

## Events — Tier 1: launch funnel (ship before promoting)

| Event | Properties | Where |
|---|---|---|
| `onboarding_step_viewed` | `step` (OnboardingStepId or J1–J5), `flow: owner\|joiner` | one hook in `(onboarding)/_layout` — `onboardingStepRoute()` already enumerates every step |
| `onboarding_capture_completed` | `method: voice\|typed`, `has_media`, `transcription_failed` | S9 capture (the aha) |
| `onboarding_committed` | `kid_count`, `is_new_family` | S12B `commitOnboarding` success (returning owners re-commit; filter on `is_new_family`) |
| `paywall_viewed` | `mode: new-owner\|resubscribe`, `trial_eligible`, `has_monthly`, `source: onboarding\|new_memory_bounce\|resume` | paywall mount |
| `paywall_purchase_started` | `plan: annual\|monthly` | CTA tap |
| `paywall_purchase_completed` | `plan` | client-side success (RevenueCat webhook is source of truth for revenue) |
| `paywall_purchase_failed` | `code: store_cancel\|wrong_account_restore\|billing_confirmation_pending\|other` | purchase catch block |
| `paywall_error_shown` | `code: unavailable\|offerings_unavailable\|generic` | paywall error UIs (load-time failures, not purchase failures) |
| `paywall_abandoned` | `mode` | "Leave" confirm (signs out — this is the bounce metric) |
| `post_auth_destination_resolved` | `kind` (journal/resume-onboarding/resume-paywall/finish-join/ask-invite-code), `access_reason` | `app/index.tsx` — explains "where did users end up" |

## Events — Tier 2: activation & retention (ship same PR if easy)

| Event | Properties | Where |
|---|---|---|
| `memory_saved` | `memory_type`, `used_voice`, `has_media`, `tagged_count`, `illustration_enabled`, `source: fab_timeline\|fab_calendar\|share_sheet\|notification\|other` | **THE activation/retention event** |
| `memory_save_failed` | `code` | validation/network failures |
| `illustration_completed` | `outcome: ready\|failed` | polling hooks — the product promise (no `intent`: not client-observable without a schema change) |
| `illustration_retry_requested` | `intent: recovery\|manual_regenerate` | memory-detail retry/regenerate buttons |
| `invite_created` | `role`, `family_id` | sharing/invite |
| `invite_redeemed` | `family_id` | J4 / redeem |
| `invite_resolved` | `outcome: approved\|rejected`, `family_id` | approvals — `family_id` is the join key across inviter/joiner persons; dashboard 4 is impossible without it |
| `notification_choice` | `choice: eve\|late\|morn\|none`, `os_granted` | S11 |
| `notification_opened` | `target: memory\|new-memory\|approvals\|timeline` (literal `PushRouteData.route` values) | `useNotifications.ts` tap handler |

`memory_save_failed {code: 'media_upload_failed'}` also fires from the
background upload queue's terminal failure (the save gesture and the upload
outcome are separate moments — `memory_saved` means the gesture completed).

`app_opened` / session events come free from the SDK
(`captureNativeAppLifecycleEvents`). Every event carries a super property
`env: 'dev'|'prod'` — all dashboards filter `env = prod`. **Do not add more
events until a specific question demands one** — event sprawl is the
failure mode.

`billing_confirmation_pending` purchase failures mean payment was taken but
server reconcile hadn't confirmed — exclude from both success and failure
funnel steps.

## Dashboards (build these four, nothing else at first)

1. **Day-0 funnel**: `onboarding_step_viewed(welcome)` → `capture_completed`
   → `paywall_viewed` → `purchase_completed`. Filter to first session —
   RevenueCat SOSA 2026 (115k apps): 78–90% of trial starts and ~50% of paid
   conversions happen Day 0.
2. **Install → paywall-view rate** — Adapty (20k apps): revenue moves almost
   linearly with this number; it's the top KPI above the paywall itself.
3. **Activation**: % of new subscribers with ≥1 post-onboarding `memory_saved`
   in week 1, and ≥1 `illustration_completed(ready)` seen.
4. **Weekly retention** on `memory_saved` (weekly, not daily — journaling
   cadence) + illustration success rate + % of families with ≥2 approved
   members by week 2 (social lock-in ≈ renewal predictor).

## Benchmarks to compare against (RevenueCat SOSA 2026, hard-paywall apps)

- D35 download-to-paid: median 10.7%, P90 38.7%, floor 4.2%.
- 17–32-day trials convert 42.5% vs 25.5% for ≤4-day; ours is 7-day (annual).
- If Day-0 paywall-view→purchase is far below ~10%, suspect the paywall;
  if paywall-view rate itself is low, the leak is upstream in onboarding.

## Explicitly out of scope

Session replay, autocapture, A/B testing infra, scroll/engagement-time
tracking, per-button events outside the lists above, server-side event
forwarding from Edge Functions (revisit only if client gaps appear).
