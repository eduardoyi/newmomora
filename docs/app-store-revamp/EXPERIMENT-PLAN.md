# Experiment plan — v2 memory-first listing

Primary business question: **understood, useful paid app membership** — do people grasp
what they get for the subscription, use it, and keep paying — not simply installs or first
book orders. Printed-book purchases are an additional, observational outcome, never the
primary success metric.

This plan does not assume any measurement infrastructure exists. Every metric below states
what would need verifying before it could actually be run.

## What would need verifying first (do this before designing any test)

- **Whether a Product Page Optimization (PPO) treatment can be joined to a user in
  analytics.** App Store Connect's PPO reports store-level aggregate conversion by
  treatment; it does not, by default, hand a per-user treatment label to the app's own
  analytics (PostHog, per `__mocks__/posthog-react-native.ts` existing as a test double).
  **Do not assume this join exists.** If it does not, "did the opener-challenger group
  retain differently" cannot be measured directly — only store-level top-of-funnel
  conversion (impression → download) can, decoupled from anything downstream.
- **Whether current analytics instrumentation captures the specific events below at all**
  (first kept memory, gallery-import Keep action, saved-sound playback, return visits,
  invite redemption, subscription renewal/cancellation, refund/support-ticket reason
  codes). This pass did not audit the analytics event schema; that audit is a prerequisite,
  not something to assume is already wired up.
- **Whether the app's subscription/paywall surface can run its own independent test**
  (e.g., a RevenueCat or native A/B experiment) distinct from the App Store Connect
  screenshot/description test. These are different systems with different denominators;
  do not conflate a description-test "win" with a paywall-conversion "win."
- **Attribution.** If gallery-import or another described feature is not admitted in
  production for all users (see `OWNER-SIGNOFF.md`'s gallery-import gate item), any test
  that promises that feature to a sampled cohort needs to confirm the cohort's server-side
  eligibility before results can be trusted.

None of the above is assumed true in this plan. Where a metric below depends on one of
these, that dependency is named again inline.

## Recommended metrics, in rough funnel order

1. **First kept memory.** Time from first app open (post-purchase) to the first memory a
   user actually keeps — via gallery-import "Keep," a typed/dictated note, or a saved-sound
   recording. Depends on: event instrumentation for each of the three memory-creation paths
   existing and being distinguishable from each other.
2. **Time to a useful collection.** A working definition might be "3+ kept memories for at
   least one child" — but this threshold is a hypothesis to validate with real usage
   distributions, not a number picked in advance. Do not pre-commit to "3" as a target.
3. **Saved-sound playback.** Whether a user who keeps a sound memory ever plays it back
   again (distinct from the moment they saved it) — this is the clearest evidence that
   "keep the sound" delivers value a printed book cannot. Depends on: a playback event
   distinct from a save event.
4. **Return to memories.** Repeat visits to the timeline, calendar, or a per-child
   collection after the first session, over a window long enough to be meaningful (e.g.,
   week-over-week for the first month) — the exact window is a decision to make with real
   data, not assumed here.
5. **Invited-family participation.** Whether an invited member (manager or viewer) actually
   redeems their invite and returns to view/engage, not just whether an invite was sent.
6. **Subscription conversion and retention.** Trial-to-paid conversion (once trial
   eligibility is confirmed per `OWNER-SIGNOFF.md`) and month-over-month or renewal-cycle
   retention. This is the metric closest to the actual business question and should be
   weighted most heavily in any go/no-go decision — not app-store impression-to-download
   rate alone.
7. **Expectation-related support tickets and refund requests.** Specifically tickets/refunds
   whose stated reason references the printed book (e.g., "I thought the book was included,"
   "the app is just a way to sell me a book"). This is the most direct signal for the
   expectation risk `COMMERCIAL-CLARITY.md` names. Depends on: support-ticket tagging/reason
   codes existing and being queryable.

**Print orders are recorded as an additional outcome metric alongside the above — not
instead of them, and not weighted as if they were the primary goal.** Book-buyer versus
non-buyer cohorts are observational groups; a difference between them is not automatically
caused by the listing or the app and should not be reported as such without a proper
experiment design.

## Rules this plan follows (from the master brief, restated so they are not lost)

- **No invented uplift numbers.** This document contains none, and none should be added
  until a real test produces them.
- **No fixed stop-after-one-week rule.** Whatever window is eventually chosen must be
  driven by the actual distribution of the metric in question, not an arbitrary calendar
  cutoff picked in advance.
- **Inconclusive is a valid result.** A test that fails to reach significance, or that
  reveals the two things being compared aren't meaningfully different, is a legitimate
  outcome to report and act on (e.g., by not shipping either variant, or extending the
  test), not a failure of the test design.
- Record, for whatever test is eventually run: **scope** (which locale/device/variant),
  **source** (App Store Connect PPO vs. an in-app experiment vs. observational cohort
  analysis), **denominator** (impressions? downloads? installs? trial starts?),
  **uncertainty** (confidence interval, not a bare point estimate), and **whether any other
  release shipped simultaneously** (a confound that would make attribution unreliable).

## Opener challengers — status and scope

The two produced opener-challenger concepts (`existing-photo-first`: "Your camera roll.
Their stories." and `voice-first`: "Their little voice. Yours to hear again.") are both
**currently un-runnable as a real test**: neither has a genuine frame-1 capture (both are
draft-only per `QA-REPORT.md`/`UPLOAD-MANIFEST.md`), so there is nothing to actually upload
to a PPO treatment yet. Once real captures exist, running an opener test still requires the
"whether PPO can be joined to a user" verification above before promising anything beyond
store-level impression-to-download conversion by treatment.

## Deferred tests — explicitly labeled, not defaults, owner decision required

- **Frame-7 ownership-export challenger** ("Your memories / stay yours" — read/export after
  subscription ends). Deferred: it needs the export behavior itself re-verified (family-
  owner-only scope, per `docs/features/data-export.md`) before being claimed in a
  screenshot, and it should not be combined with an opener-headline test per the master
  brief's own instruction.
- **Book-prominence sequence test** (moving the unchanged book frame to slot 3: order
  1,2,5,3,4,6,7). Deferred: this is a sequence test, not a one-frame swap, and the master
  brief is explicit that this requires an owner decision before it is even produced, let
  alone run. Not attempted in this pass.
- **A truly book-first concept** (returning to the pre-v2 positioning as a live hypothesis
  rather than the default). Deferred: explicitly a hypothesis requiring its own owner
  decision, not a presumed winner and not something this pass assumes should ever run.

No test in this plan is scheduled, instrumented, or committed to running. This is a
recommendation for what to measure and how, contingent on the verifications named above and
on an owner decision to proceed.
