# PostHog analytics — implementation plan

Status: implemented (2026-08-02) — see [docs/features/analytics.md](../features/analytics.md)
for the living doc; the deviations from this plan and from the tracking spec
found during implementation (e.g. `captureAppLifecycleEvents` vs the
originally-assumed `captureNativeAppLifecycleEvents`) were folded into that
doc rather than left as drift. Spec: [analytics-tracking.md](analytics-tracking.md)
(event list, property vocabulary, privacy rules — normative; this plan is the
build order). Written 2026-08-02.

## Goal

PostHog instrumented across onboarding, paywall, and core loop with the Tier
1 + Tier 2 events from the tracking spec, zero PII in any payload, all tests
and typecheck green, verified on device before commit. Launch-blocking:
promotion starts soon and funnel data only exists from install day.

## Context

- Expo SDK 56 + expo-router app; no analytics of any kind exists today.
- RevenueCat (`react-native-purchases` 10.6.0) already uses the Supabase
  user id as `appUserID` (`src/services/billing.ts`), so PostHog
  `distinct_id` = same id, and RevenueCat's PostHog integration needs no
  aliasing.
- Providers compose in `src/components/app-providers.tsx`; auth session
  lives in `src/hooks/use-auth`.
- Onboarding steps are enumerated (`OnboardingStepId`,
  `src/utils/onboarding-progress.ts`) and routed centrally
  (`src/lib/onboarding-routes.ts`); the `(onboarding)/_layout.tsx` wraps the
  whole S0–S17 + J1–J5 arc.
- Jest mocks native modules via `moduleNameMapper`
  (`react-native-purchases` → `__mocks__/`); same pattern applies to
  posthog-react-native.
- Repo PII rules (AGENTS.md, docs/features/onboarding.md): no memory
  content, child names, or transcripts in analytics events.

## Ground rules

- **No autocapture, no session replay, no screen auto-tracking.** Explicit
  events only (PII: child names in TextInputs/accessibility labels).
- **Never** send: memory content, transcripts, child/member/family names,
  emails, OTP codes, invite word-codes, media URIs, DOB/gender/notes,
  comment bodies. Only counts, booleans, UUIDs, and existing enums.
- Analytics must be **fire-and-forget and crash-proof**: a missing API key or
  a PostHog outage must never block or break any user flow. No `await` on
  capture calls in UI paths.
- All event names/properties defined in one typed module; screens never call
  `posthog.capture` directly.

## WP1 — Infrastructure

1. **Dependencies**: `npx expo install posthog-react-native expo-file-system expo-application expo-device expo-localization`
   (some peers already present — install only what's missing; check
   package.json first).
2. **Env**: `EXPO_PUBLIC_POSTHOG_API_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`
   (default `https://us.i.posthog.com`). PostHog project keys are
   public/write-only by design, so `EXPO_PUBLIC_` is correct (does not
   violate the secrets checklist). Add to `.env.example` — NOTE: `.env*`
   files are permission-blocked for agents in this session; if editing fails,
   list the exact lines for the user to paste instead.
3. **`src/services/analytics.ts`** — the only module that imports
   `posthog-react-native`:
   - Lazily creates a singleton `PostHog` client when the key is present;
     typed helpers: `trackEvent(name, props)`,
     `identifyUser(userId, props?)`, `setPersonProperties(props)`,
     `resetAnalytics()`.
   - **No `PostHogProvider`** — with autocapture/replay/screen-tracking
     all off and screens forbidden from calling posthog directly, the
     provider has no job; the singleton keeps the whole integration in
     one file and out of `app-providers.tsx`.
   - Typed event map (`AnalyticsEventMap`) — every event name and its exact
     property shape from analytics-tracking.md Tier 1 + Tier 2. Property
     values restricted to `string | number | boolean` unions; no free-form
     objects, so PII can't sneak in through a spread.
   - No key (dev without env, tests) → all helpers are silent no-ops.
   - Client options: `captureNativeAppLifecycleEvents: true` (exact option
     name — NOT `captureAppLifecycleEvents`; verify against the installed
     SDK version at build time, since dashboard 2 depends on
     `Application Installed`/`Application Opened` arriving).
   - Register a super property `env: 'dev' | 'prod'` from `__DEV__` at
     client init, so dev/simulator runs are filterable — launch funnels
     are small-N and a few developer onboarding runs would skew them.
     All four dashboards filter on `env = prod`.
5. **Identity**: in `AuthProvider` ([use-auth](../../src/hooks/use-auth.tsx)),
   effect on the session. **CRITICAL — anonymous-session guard**: the app
   creates real Supabase sessions via `signInAnonymously()`
   (`src/lib/anonymous-session.ts`) for S9 voice transcription and J2
   invite preview, and that throwaway session lives from S9 until the
   email screen discards it. The rule is:
   - `session.user` non-null AND `!session.user.is_anonymous` →
     `identifyUser(id)` (same id RevenueCat uses).
   - Anonymous session appearing or disappearing → **no-op** (no identify,
     no reset) — otherwise `onboarding_capture_completed` and
     `notification_choice` get attributed to a throwaway person and are
     permanently orphaned from the real user.
   - Non-anonymous session → null (sign-out) or → a *different*
     non-anonymous id → `resetAnalytics()` (then identify if new id).
   This covers owner S12B, joiner J4, login, and the paywall "Leave"
   sign-out. Unit-test the anonymous-session sequence explicitly:
   anon appear → capture events → anon discard → real sign-in must leave
   pre-auth events stitched to the real user.
6. **Person properties**: set `{role, access_reason, membership_count}`
   via `setPersonProperties` from the `app/index.tsx` resolve effect
   (where billing status and memberships are already in hand) and refresh
   `access_reason` when billing status settles on the paywall. These back
   dashboard 3's cohort filters; without them the spec's person-property
   section is dead letter.
7. **Jest**: add `__mocks__/posthog-react-native.ts` + `moduleNameMapper`
   entry (mirror the existing `react-native-purchases` pattern in
   [jest.config.js](../../jest.config.js)); pin/delete
   `EXPO_PUBLIC_POSTHOG_API_KEY` in `jest.setup.ts` (other `EXPO_PUBLIC_`
   vars are already pinned there) so the no-op path is deterministic —
   the singleton reads env lazily once, so tests exercising the keyed
   path need `jest.resetModules()`. Unit test `analytics.test.ts`: no-op
   without key; capture called with exact name/props when keyed.

## WP2 — Onboarding + paywall funnel (Tier 1)

1. **`onboarding_step_viewed`** — single hook in
   [app/(onboarding)/_layout.tsx](<../../app/(onboarding)/_layout.tsx>):
   `usePathname()` (+ `beat` via `useGlobalSearchParams()` — NOT
   `useLocalSearchParams`, which at layout level may not surface a leaf
   screen's params) → map to an analytics step string. **Pathname shape
   warning**: Expo Router strips group segments — `usePathname()` returns
   `/welcome`, `/story`, `/join/code`, NEVER `/(onboarding)/welcome`. Do
   not match against the Href constants in onboarding-routes.ts; write the
   switch on bare pathnames and unit-test the mapping for at least one
   grouped and one nested route. Map to: every `OnboardingStepId`, plus
   `reveal` (S17 — deliberately NOT
   in `OnboardingStepId`, see onboarding-routes.ts comment; the analytics
   step union is a superset) and
   `join-code|join-found|join-name|join-email|join-waiting`; props
   `{step, flow: 'owner'|'joiner'}`. Fire on change, dedupe consecutive
   repeats (portrait re-entry via the S17 sibling chain counts as a new
   view — that's correct). Pre-auth events ride the anonymous distinct_id
   and stitch at identify (PostHog default behavior).
2. **capture.tsx**: `onboarding_capture_completed {method: 'voice'|'typed',
   has_media, transcription_failed}` on "Keep it". NOTE: today `mode`
   collapses to `'compose'` regardless of how text got there — add two
   pieces of tracked state (`usedVoice`, `voiceFailed`) set in the
   transcription success/failure paths so the event can distinguish
   voice-succeeded / voice-failed-then-typed / typed-only.
3. **`onboarding_committed {kid_count, is_new_family}`** after
   `commitOnboarding` succeeds — at BOTH call sites: `code.tsx` (primary)
   and `paywall.tsx` (~line 219, the pending-capture commit after
   purchase for owners whose code.tsx commit deferred). `is_new_family`
   from the commit result's `isNewFamily` — returning owners re-entering
   onboarding (decision 18) commit too, and the funnel must be able to
   filter them out.
4. **notifications.tsx**: `notification_choice {choice, os_granted}` (choice
   `eve|late|morn|none`; `os_granted` from `requestRegistration` result,
   null-safe when choice is `none`).
5. **paywall `source` plumbing** — no `source` param exists today; add it:
   - `paywall.tsx` reads `source` from `useLocalSearchParams` (alongside
     `mode`), defaulting to `'onboarding'`.
   - `app/(app)/new-memory.tsx` (~line 98) bounce: add
     `params: { mode: 'resubscribe', source: 'new_memory_bounce' }` (it
     bypasses `onboardingPaywallRouteForMode` with a raw `router.replace`).
   - `app/index.tsx` `resume-paywall` branch: pass `source: 'resume'`
     (extend `onboardingPaywallRouteForMode` with an optional source arg;
     other callers keep the `'onboarding'` default).
6. **paywall.tsx events**:
   - `paywall_viewed {mode, trial_eligible, has_monthly, source}` — fire
     once per mount when **`serverPaywallMode !== null`** (this single
     gate excludes entitled pass-throughs/access handoffs — for whom
     `shouldRenderSubscriptionOptions` is misleadingly true and `mode`
     would be null — and guarantees the settled mode, never the URL's
     guess). Never fire from the render path.
   - **Purchase event placement is load-bearing**: `handleStartTrial`'s
     single try block wraps `purchase()`, the entitlement check, AND
     `finishPaidOnboarding()` — and both of the latter can throw AFTER
     money was taken (`BillingConfirmationPendingError` from reconcile;
     capture-commit/media errors from finish). Naively instrumenting the
     catch block logs paid users as failures. Rules:
     - `paywall_purchase_completed {plan}` fires immediately after
       `purchase()` returns with the entitlement active — BEFORE
       `finishPaidOnboarding()`.
     - `paywall_purchase_failed {code}` fires only for throws originating
       from the purchase call itself (own try scope or flag):
       `userCancelled`/`PURCHASE_CANCELLED` (check the RC error's
       `userCancelled` boolean, not message strings — NEW detection, not
       present in billing.ts today) → `store_cancel`;
       `WrongAccountRestoreError` → `wrong_account_restore`; else `other`.
     - `BillingConfirmationPendingError` = payment taken, confirmation
       pending → its own code `billing_confirmation_pending`, excluded
       from both the success and failure funnel steps in dashboards.
     - Restores are deliberately untracked (no started/completed events).
   - `paywall_purchase_started {plan}` on CTA tap; `paywall_abandoned
     {mode}` on the Leave confirm; `paywall_error_shown {code:
     'unavailable'|'offerings_unavailable'|'generic'}` when the error UIs
     render (`offerings_unavailable` is unreachable from the purchase
     catch — CTA is disabled without a package).
   - Purchase-completed also arrives via RevenueCat→PostHog server-side;
     the client event exists only to tie it to the session funnel.
   - **Integration tests required** (extend
     `src/screen-tests/onboarding.paywall.integration.test.tsx`, mocking
     `@/services/analytics`): entitled pass-through fires no
     `paywall_viewed`; loading→settled fires exactly one with the settled
     mode; user-cancel → `store_cancel`; post-purchase
     `finishPaidOnboarding` failure still fires `purchase_completed` and
     no `purchase_failed`.
7. **app/index.tsx**: `post_auth_destination_resolved {kind, access_reason}`.
   The destination is computed synchronously in the render body, so fire
   from a `useEffect` keyed on the resolved kind (dedupe per mount) — never
   from the render path, or re-renders while billing/memberships settle
   will double-count. `access_reason` is NOT on the destination type — it
   comes separately from `useBilling().billingStatus` and is nullable
   (absent for `ask-invite-code` / `finish-join` / pre-billing resolves).

## WP3 — Core loop, family, notifications (Tier 2)

1. **`memory_saved` source plumbing** — no param exists today; extend
   `newMemoryRoute` (src/lib/routes.ts) to accept an optional
   `source` param and update its callers: timeline FAB
   (`fab_timeline`), calendar FAB (`fab_calendar`), incoming-share router
   (`share_sheet`), push-notification route in useNotifications.ts
   (`notification`). `new-memory.tsx` reads the param, defaults `other`.
2. **new-memory.tsx**: `memory_saved {memory_type, used_voice, has_media,
   tagged_count, illustration_enabled, source}`, `memory_save_failed
   {code}`. Fire on both save paths (text `createMemory` success, media
   enqueue accepted). Semantics note (goes in the feature doc):
   `memory_saved` means "user completed the save gesture" — the media
   path is enqueue-then-background-upload. Add `memory_save_failed
   {code: 'media_upload_failed'}` at the queue's terminal-failure
   transition in `src/hooks/use-pending-memory-uploads.tsx` (mirrors the
   illustration-outcome pattern); otherwise the most failure-prone path
   never reports failures and the retention dashboard overcounts.
3. **Illustration outcome**: `illustration_completed {outcome:
   'ready'|'failed'}` — NEW transition logic in BOTH observation sites:
   `useGenerationStatusPolling.ts` (~line 120) and `useMemoriesRealtime.ts`
   (~line 126) each currently special-case only `'ready'`; add `'failed'`
   branches to both. **Dedupe across modules**: the poll and the realtime
   handler can independently observe the same transition (realtime forces
   a poll tick on SUBSCRIBED), so the seen-set must be ONE module-level
   singleton imported by both hooks — not per-hook state. House it in a
   tiny separate module (e.g. `src/lib/illustration-outcome-dedupe.ts`),
   not inside the SDK wrapper, so `analytics.ts` stays pure transport. Once per memory per terminal transition; cross-launch
   duplicates acceptable (note in feature doc). NO `intent` property: the
   polled row (`MemoryGenerationStatusRow`) does not carry
   `request_intent` and surfacing it would need a schema change — out of
   scope. Instead add `illustration_retry_requested {intent:
   'recovery'|'manual_regenerate'}` at the two client-initiated buttons in
   memory detail, where intent IS known.
4. **Family loop**: `invite_created {role, family_id}` (sharing/invite),
   `invite_redeemed {family_id}` (J4 + sharing/redeem), `invite_resolved
   {outcome, family_id}` (approvals screen). `family_id` (UUID, allowed
   by the privacy rules) is REQUIRED on all three: inviter and joiner are
   different persons, and without a join key PostHog cannot compute
   dashboard 4's "% of families with ≥2 approved members" at all —
   impossible to backfill later.
5. **notification_opened {target}** in `routeFromPushData` /
   `handleNotificationResponse` (src/hooks/useNotifications.ts — plain
   functions, not the hook body; they're also called directly in tests).
   `target` = the literal `PushRouteData.route` values
   (`memory | new-memory | approvals | timeline` — note `new-memory` is
   hyphenated in code; use the literals verbatim, no renaming layer).
   Never ids beyond UUIDs.

## WP4 — Docs + verification

1. `docs/features/analytics.md`: event catalog, property vocabulary, PII
   rules, how future agents add an event (extend the typed map; never call
   posthog directly; never add free-form strings).
2. Update `analytics-tracking.md` status → implemented; update AGENTS.md
   analytics line to point at the feature doc.
3. Verify: `npm test`, `npx tsc --noEmit` (Node 20 via nvm). Manual device
   pass against a real PostHog project before commit: complete onboarding in
   dev, confirm events land with correct distinct_id stitching (pre-auth
   events merged into the identified person), confirm
   `Application Installed` / `Application Opened` lifecycle events arrive
   (dashboard 2 depends on them), confirm every event carries
   `env: 'dev'`, and confirm no PII in any captured payload (inspect
   PostHog activity view).

## Risks & mitigations

- **PII leakage** — the top risk. Mitigations: no autocapture/replay; typed
  event map with scalar-only property types; PII checklist in the feature
  doc; manual payload inspection in PostHog before commit.
- **Analytics breaking a user flow** — all capture calls are synchronous
  fire-and-forget wrappers that never throw; missing key → no-ops; provider
  omitted entirely when unconfigured, so dev/test behavior is unchanged.
- **Double-counting purchases** — RevenueCat integration also sends
  subscription events; client `paywall_purchase_completed` is a distinct
  event name used only for session-funnel stitching, never for revenue.
- **Event dedup** — `onboarding_step_viewed` dedupes consecutive repeats;
  `illustration_completed` keeps a session-scoped seen-set per memory.
- **Anonymous→identified stitching** — pre-auth onboarding events use the
  SDK's anonymous id; `identify()` at session creation merges them
  (PostHog default). Verified explicitly during device pass.

## Out of scope

Session replay, A/B flags, server-side/Edge Function events, dashboards
(built by hand in PostHog after events flow), RevenueCat→PostHog integration
toggle (user does this in the PostHog UI; document in WP4).

## Manual steps for Eduardo

1. Create PostHog project (US cloud), copy the project API key into
   `.env.local` (`EXPO_PUBLIC_POSTHOG_API_KEY=phc_…`) and EAS env for builds.
2. After merge: enable the RevenueCat → PostHog integration (RevenueCat
   dashboard → Integrations → PostHog, send subscriber events).
3. Build the four dashboards from analytics-tracking.md.
