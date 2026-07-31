# Feature: Onboarding & Paywall

**Status:** `done` (S0–S17 owner path, J1–J5 join path — see "Not yet shipped" below for what's deliberately deferred)
**Last updated:** 2026-07-31
**PRD reference:** PRD §onboarding (update when implemented)
**Research inputs:** [docs/voice-of-customer.md](../voice-of-customer.md) (VoC) · tasu conversion brain (tasu.ai/library, queried 2026-07-23)
**Design brief:** [docs/plans/onboarding-design-brief.md](../plans/onboarding-design-brief.md) — screen-by-screen layout + copy for design handoff
**Implementation plan:** [docs/plans/onboarding-implementation.md](../plans/onboarding-implementation.md) — work packages, decisions, execution log

Design spec agreed 2026-07-23; implemented in WP0–WP7-A (see the implementation plan's Execution log for package-by-package detail). Real onboarding illustration art shipped in `8555064`; real billing remains deliberately out of scope — see "Not yet shipped."

## Overview

First-run experience for new users, ending in a hard paywall. The flow's job is **conversion** — mechanics come from conversion data; copy and framing come from the VoC research. The persona (guilt-sensitive, subscription-burned parents) shapes *what the screens say*, never *whether a proven mechanic is used*.

## Core decisions

| # | Decision | Rationale (source) |
|---|----------|-------------------|
| 1 | **Hard paywall + free trial. No free plan.** | Hard paywalls convert 10.7% vs 2.1% D35 download-to-paid (RevenueCat SOSA 2026, 115K apps); ~8–9× revenue per install; year-1 retention nearly identical to freemium. Free plan was also a generation-cost leak. |
| 2 | **Annual plan with 7-day trial, trial gated to annual.** | Trial-on-annual filters intent and collects annual cash (Wrestle AI, Moonly, Headspace). Owner chose 7-day over the Headspace-tested 14-day winner — 14-day is a test-backlog variant, not the launch config. |
| 3 | **No weekly plan at launch.** | Weekly converts 2–7× better than annual (Adapty 2026) **but** wins in impulse/utility categories (Gaming 82% weekly); sustained-journey categories are annual-dominant (Health & Fitness 68%). Momora's value compounds over years; $5.99/wk reads as ~$311/yr to the demographic that rage-reviewed Tinybeans at $74.99/yr; weekly churn recreates the archive-hostage pattern on a loop. Weekly may compete later as a paywall A/B variant. |
| 4 | **"Your memories are always yours" — export stays free forever, including after cancellation.** | The archive-hostage pattern is the category's #1 rage trigger (VoC §7.4). This is a *policy line shown on the paywall*, not a free tier. |
| 5 | **Two entry points; invited members skip onboarding entirely.** | Family owners go through the full flow. Managers/viewers arriving via invite (deep link or word-code) get a minimal join flow: code → account → display name → in. No persona questions, no paywall, no notification pitch. |
| 6 | **Subscriptions are owner-scoped (family-scoped entitlements).** | The join path must not be a paywall bypass: joiners get capture/view under the owner's subscription; generation entitlements belong to the family whose owner pays. |
| 7 | **Story-affirmation onboarding, not a quiz.** | Screens narrate the VoC §4 "things they don't say out loud" beats; CTAs are written as affirmations ("That's exactly how it feels"), which *are* the stacked-yes micro-commitment mechanic (YarnPal's 7-yes structure) in narrative form. Every screen must still do one of the six onboarding jobs (personalization, commitment, social proof, permission, paywall, attribution — tasu six-jobs framework); a screen doing none is cut. |
| 8 | **Child names only: first name required, more kids addable on the same screen ("+ add another"), name-only for all.** No DOB, no photo. | Naming is the highest-value single commitment in the tasu library (ownership → responsibility → retention), and the names power all subsequent copy and the aha. Multi-name matters for the primary persona: forcing the guilty second/third-time parent to enter just one kid makes them pick a favorite on screen one, re-enacting the disparity wound. Names entered here become pre-created child profiles when the family is created at auth, so the journal arrives populated. DOB stays cut; photos move into the trial ("let's make {name}'s portrait", one kid at a time). |
| 9 | **Family name defaults from the kids' names, one tap to confirm, editable.** 1 kid → "{name}'s Family"; 2 → "{name1} & {name2}'s Family"; 3+ → "{name1}, {name2} & {name3}'s Family" (editable if unwieldy). Child names are asked first (S6 → S7 order is deliberate). | Needed for tenancy anyway; light commitment device. Surname-based suggestions ("The Rivera Family") are impossible pre-auth (auth is at step 9), which is why the default derives from the kids' names; asking the kids first is what makes this screen zero-typing. |
| 10 | **The aha is a guided first capture, inside onboarding, before the paywall.** Speak or type one memory (+ optional photo), see it instantly in a beautiful layout titled with the child's name. | A hard gate before the value moment is the most consistent conversion leak (SuperChinese ~$800K estimate); ~50% of paid conversions and 55.4% of 3-day-trial cancellations happen Day 0 (SOSA 2026). Illustration generation is too slow to be the aha — the instant layout proves "lighter than opening the camera app" experientially. |
| 11 | **First illustration generation kicks off in the background at trial start** and lands as the first in-trial delight moment (drives Day 0–1 reopen). Paywall sells the illustrated artifact with polished founder-family examples, not the user's own. | Day 0–1 is the churn cliff; the generation needs runway the onboarding can't give it. |
| 12 | **Notification ask is embedded in a question that configures it**, honest purpose (capture reminders): "When do the little moments usually come back to you?" (evenings / weekends / can't predict) → sets reminder schedule → OS prompt confirms the choice. | Embedded asks are the highest-context opt-in (Bend — called its best single conversion screen; Tai Chi for Seniors replicates it for a decline-by-default demographic, which burned-by-Qeepsake parents are). We do NOT notify on illustration completion framing — reminders are the honest purpose. |
| 13 | **Two trust screens before the paywall.** Screen A: trial timeline ("free for 7 days, we'll remind you before it ends, no payment now"). Screen B: what unlocks + the export-is-always-yours line. | Bill-shock fear is the top paywall bounce reason; Brilliant runs this two-screen split at $149.88/yr (Cali, "all top apps" per @stevencravotta study of 200+ flows). Extra-relevant for a subscription-resentful audience. |
| 14 | **Founder-family introduction (1–2 screens), placed mid-flow after the recognition beats.** "Hi — we're Eduardo & Adriana, and these two are why we built this" + illustrated memories of our kids. | Double duty: (a) social proof an indie app can't fake with review walls — "we live this problem too"; (b) shows the illustration style/artifact without generating anything. Placement per tasu evidence-placement rule: mid-flow social proof arrives after partial investment and reads as confirmation; front-loaded it reads as a credentials presentation. Same illustrations reuse on the paywall (decision 11). |
| 15 | **Review ask fires only after the first illustration lands (in-trial success moment)** — never during onboarding. | Rating-before-experience is Bend's documented one-star-review mistake; success-only rule (Catzy, Prayer Lock pull 4.9★). |
| 16 | **No urgency devices, no spin-wheel, no guilt mechanics, no streaks anywhere.** | Spin-wheel suits weekly/revenue-max plays, "not longer-term businesses" (Mobbin 2,995-paywall study); Apple began rejecting misleading trial-toggle patterns early 2026. Guilt mechanics violate the VoC tone rule (§8: guilt-relief, never guilt-manufacture) and anti-requirement #6. |
| 17 | **Routing is decided by server state after auth, not by which entry button was tapped.** The fork's buttons (start / invite / log in) are intent hints only. | Auth is email OTP, so login and signup are the same motion — the client can't know from the button whether this is a new owner, a joiner, or a returning user who reinstalled. Post-auth state routing (see Returning users below) is the single source of truth; it also makes abandoned-mid-onboarding and lapsed-subscription cases fall out naturally instead of being special-cased per entry point. |
| 18 | **Account creation happens after the aha and strictly before the trust screens/paywall — framed as protecting what they just saved.** | Brilliant's pattern: the account ask placed after the user has experienced the product "reads as protecting progress the user already made, not a gate before the product starts." Auth must precede the paywall because the routing gate (17) fires at auth — an existing subscriber must be diverted to their journal before ever seeing a purchase screen. Pre-auth onboarding progress (story position, child's name, the captured memory) is held device-locally and synced on auth. Accepted cost: a reinstalling owner who habit-taps "Start" sees story screens and may capture a memory before routing catches them — acceptable because step 0 covers most returning users, "Log in" is the escape hatch, and the captured memory is saved into their existing family so nothing is wasted. |

## Flow

### Owner path (full onboarding)

0. **Session check** — a valid session on device skips everything below: straight into the journal. The fork only ever renders for unauthenticated launches.
1. **Fork / deep-link detection** — primary "Start your family's journal", secondary "I have an invite", quiet tertiary "Log in". Invite deep links skip the fork. All three converge on the same OTP auth eventually; they differ only in what runs *before* auth (story + capture / invite code / nothing).
2. **Recognition story, part 1** (2–3 screens) — VoC §4 beats in their own language (the 2 a.m. scroll, the bin of onesies, blanking on "when did she first roll over?"). CTAs are affirmations, varied per screen. Opens on the reframe: *"You're not behind. Start exactly where you are."*
3. **Founder-family intro** (1–2 screens) — decision 14. Placed after at least one recognition beat so it lands as "we know this because we live it," and quietly demos the illustration style.
4. **Kid name(s)** — first name required, quiet "+ add another" for siblings, name-only (decision 8). Downstream copy rule: single kid → `{name}` everywhere; multiple kids → the capture screen (7) shows kid chips (first kid pre-selected, multi-select allowed), and downstream copy uses the selected kid's name, or neutral "their/the kids" phrasing when several are tagged.
5. **Family name confirm** (auto-suggested from the kids' names per decision 9, one tap).
6. **Recognition story, part 2 / bridge to action** — "the fix isn't a better habit, it's a lighter one" → *"Let's save one right now — something small {name} did this week."*
7. **Guided first capture (the aha)** — voice or type, optional photo/video, instant beautiful layout titled with {name}. No generation, no waiting.
8. **Embedded notification question** → OS permission prompt (decision 12).
9. **Account (OTP auth)** — framed as "so {name}'s first memory is safe" (decision 18). **The routing gate (17) fires here:** new users continue to 10; anyone with an existing family/entitlement is diverted per the Returning-users table, with the captured memory saved to their family.
10. **Trust screen A** (trial timeline) → **Trust screen B** (what unlocks + export-always-free).
11. **Hard paywall** — annual plan, 7-day free trial, founder-family illustration examples, the export policy line. Trial-or-exit.
12. **On trial start:** background-start portrait/illustration generation (existing Cloudflare Workflows pipeline); photo ask happens here, framed as "let's make {name}'s portrait." Multi-kid families do one portrait at a time, starting with the kid tagged in the first memory (or the first-entered name); siblings chain off each portrait-reveal moment (S17, `app/(onboarding)/reveal.tsx`) — "Meet {name}," then "{next-name}'s turn. Pick a photo" if another kid still needs a photo, else straight to the journal. **"Later" goes to the existing family roster tab, not a bespoke waiting-state card** — the design brief's `CastWaitingState` was deliberately dropped (owner decision, WP6): the family tab already invites the user to add a photo for any kid without one ("Edit their photo to redraw it"), so a second waiting-state surface would be redundant. In-app only, never push. Adults (owner's own portrait, joiner portraits) are explicitly out of the trial sequence.

Post-onboarding: illustration-ready is the first delight; review ask after it lands (decision 15).

### Join path (managers/viewers)

Word-code entry → code validated, family shown by name ("Join the Rivera Family") → display name → account creation (OTP) → owner-approval wait state if approval hasn't happened yet (per family-sharing invite design) → family journal. Display name deliberately precedes auth: all typing happens before the disruptive OTP round trip through the mail app, so post-auth the joiner lands straight in the family (or wait state) with nothing left to do. The name is held device-locally until auth and is needed even for existing accounts (display names are per-family). Nothing else. Optional later, in-app, low-key: "start your own family journal" upsell for managers — never a gate.

**The deep link is only a shortcut that pre-fills the code — the join path must never depend on it.** The common failure is the deferred deep link being lost: the invitee taps the invite link, lands in the App Store, installs, then opens the app directly — arriving at the fork with no invite context. That user taps "I have an invite" and types the word-code manually; the flow from there is identical. This is why the invite affordance is a first-class fork button and the code is a human-typeable word code, not an opaque token.

### Returning users (post-auth state routing)

After any successful OTP auth — regardless of which fork button started it — route on server state. Note that auth (and therefore routing) happens at a different point per path: immediately for "Log in", after code entry for the join path, and at step 9 (post-aha, pre-paywall) for the owner path — the fork itself can never route, because an unauthenticated launch has no state to route on.

| Post-auth state | Destination |
|-----------------|-------------|
| Member of ≥1 family, entitlement active (own sub, trial, or a family whose owner pays) | Journal. No onboarding, no invite flow. |
| Owner whose trial/subscription lapsed | Lapsed state: archive stays viewable and exportable (decision 4 — never hostage); capture/generation gated behind a resubscribe paywall. No trial re-offer (store rules), no trust-screen replay. |
| Account exists, no family, onboarding never completed | Resume owner onboarding at the first incomplete step; restore any device-local captured memory. Don't replay completed story beats. |
| Pending invite attached (code entered or deep link followed pre-auth) | Complete join path: display name → family journal. |
| Account exists, no family, no pending invite, tapped "I have an invite" | Ask for the code (the one case where the intent hint drives UI). |

Edge case worth an explicit test: a returning user who taps "Start your family's journal" out of habit but already owns a family. They will see story screens and may capture a memory before auth (accepted cost, decision 18) — but at step 9 routing must send them to their journal with the captured memory saved to their existing family, never into a second onboarding/family creation or a paywall.

## Architecture

```mermaid
flowchart LR
  A[app/index.tsx\napp/(auth)/_layout.tsx] -->|no session| B[app/(onboarding)/welcome.tsx S0]
  A -->|session| C[resolvePostAuthDestination]
  C -->|journal| D[(app) timeline]
  C -->|resume-onboarding| E[onboardingStepRoute]
  C -->|finish-join| F[join/found.tsx J2]
  C -->|ask-invite-code| G[join/code.tsx J1]
  B --> H[S1-S16 story/capture/trust/paywall/portrait]
  H -->|S9 voice, J2 preview| I[ensureAnonymousSession\nanonymous Supabase JWT]
  H -->|S12/J4| J[real OTP sign-in\ndiscardAnonymousSession first]
  J --> K[commitOnboarding\nsrc/services/onboarding.ts]
  K --> L[(families, family_members,\nmemories rows)]
  H -->|portrait status: ready| M[reveal.tsx S17]
  M -->|sibling still unpainted| H
  M -->|"Later"| N[(app) family roster tab]
```

`app/(onboarding)/_layout.tsx` mounts `OnboardingFlowProvider` (`src/hooks/use-onboarding-flow.tsx`) once for the whole S0–S17 + J1–J5 arc; every screen reads/writes the device-local draft through it rather than touching AsyncStorage directly. The front door (`app/index.tsx`, `app/(auth)/_layout.tsx`) and every post-OTP screen (S12B `code.tsx`, J4 `join/email.tsx`) all resolve where to go next through the single `resolvePostAuthDestination` function (`src/lib/onboarding-routing.ts`) — see spec decision 17 and that file's doc comment for the exact priority order (membership wins over everything, then a stored invite code, then intent, then resume-at-draft-step).

S17 (`reveal.tsx`) is reached only from S16 (`portrait.tsx`) once that screen's own `usePortraitVersions` poll reports the target member's status as `ready`; it is not one of `OnboardingStepId`'s resume steps (see `onboardingStepRoute`'s doc comment in `src/lib/onboarding-routes.ts` for why — reveal always needs a specific member id, which a bare step id can't carry, and it's unreachable via that resume path in practice anyway since it only ever fires after a family already exists).

Pre-auth, two screens need a server round trip before the user has an account: S9 (voice transcription) and J2 (invite preview). Both call `ensureAnonymousSession()` (`src/lib/anonymous-session.ts`) to get a JWT via Supabase anonymous sign-in, and both are discarded (`discardAnonymousSession()`) immediately before the real OTP request at S12A/J4 so the eventual permanent account starts clean. Everything else pre-auth (kid names, family name, the captured memory, the notification choice, the join path's display name) lives only in AsyncStorage (`OnboardingDraft` / the join draft) until `commitOnboarding` (owner path) or `redeemFamilyInvite` (join path) runs post-auth.

## Data model

No new tables. Onboarding writes to existing tables at commit time and otherwise lives entirely on-device until then.

| Table / storage | Role in this feature |
|------------------|----------------------|
| AsyncStorage `momora.onboardingDraft` | Device-local `OnboardingDraft` (kid names, family name, captured memory, notification choice, `committedFamilyId`) — see `src/utils/onboarding-progress.ts`. Never holds audio. |
| AsyncStorage `momora.pendingInviteCode` | Shared with family-sharing (`src/utils/pending-invite-code.ts`) — the same storage `app/invite.tsx`, J1, and the authenticated redeem screen all read/write. |
| Join draft (`src/services/onboarding-join.ts`) | Device-local display name + inviter name for J3/J5, separate from the owner path's draft (the join path never resumes through `OnboardingDraft.step`). |
| `families` / `family_members` | Created by `commitOnboarding`: one family (named from `defaultFamilyName` or the edited S7 value), one name-only `family_members` row per kid name (nullable `date_of_birth`/`profile_picture_key`, per WP0 §0.9). |
| `memories` | The first memory (S9's capture), tagged to the kid chip(s) selected on S9; media path enqueues through the existing pending-upload queue. |
| `user_profiles` | `enableDailyReminder` + `notificationTime` from S11's choice; `name` (global) from J3's display name — see the display-name divergence below. |

## Client integration

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Routes | `app/(onboarding)/*` (S0–S17), `app/(onboarding)/join/*` (J1–J5) | Screens themselves |
| Front door | `app/index.tsx`, `app/(auth)/_layout.tsx`, `app/invite.tsx`, `app/_layout.tsx` | No session → welcome; session → `resolvePostAuthDestination`; deep-linked invite with no session → J2 |
| Routing | `src/lib/onboarding-routing.ts` (`resolvePostAuthDestination`), `src/lib/onboarding-routes.ts` (`Href` constants + `onboardingStepRoute`, `onboardingRevealRoute`, `onboardingPortraitRouteForMember`), `src/lib/routes.ts` (`familyRosterRoute`, the sibling-chain "Later" destination) | Single source of truth for post-auth destination and route paths |
| State | `src/hooks/use-onboarding-flow.tsx` (`OnboardingFlowProvider`/`useOnboardingFlow`), `src/utils/onboarding-progress.ts` (AsyncStorage draft) | Draft hydration, debounced persistence, resume point |
| Auth | `src/lib/anonymous-session.ts` (`ensureAnonymousSession`/`discardAnonymousSession`) | Pre-auth JWT for S9/J2, discarded before real OTP sign-in |
| Services | `src/services/onboarding.ts` (`commitOnboarding`), `src/services/onboarding-join.ts` (join draft + `previewFamilyInvite`), `src/services/ai.ts` (`processOnboardingVoiceMemory`) | Turning the device-local draft into real rows; pre-auth invite preview; pre-auth voice |
| Utils | `src/utils/onboarding-copy.ts` (copy generators), `src/utils/pending-invite-code.ts` (shared with family-sharing) | Pure copy logic; invite-code storage |
| Hooks | `src/hooks/use-onboarding-kid-possessive.ts` (`useOnboardingKidPossessive`) | S14/S15's shared kid-name personalization resolver — draft first, real `useFamilyMembers()` data once the draft is empty (WP7-A) |
| Components | `src/components/onboarding/*` (`OnbShell`, `OnbButton`, `OnbTypography` family, `OnbDots`, `OnbIllustration`, `KidChip`) | Shared onboarding primitives, styled from `src/constants/theme.ts` tokens |
| Illustrations | `src/constants/onboarding-illustrations.ts`, `assets/onboarding/` | One asset map for the shipped bundled WebP artwork and its accessibility descriptions. |

## Implementation decisions (WP0–WP7-A)

Decisions settled during implementation that aren't in the product-decision table above (those are business/UX; these are technical):

1. **Pre-auth server calls ride an anonymous Supabase session.** S9's transcription and J2's invite lookup both need a JWT before the user has an account — `ensureAnonymousSession()` supplies one via `signInAnonymously()`, discarded (`discardAnonymousSession()`) at S12A/J4 before the real OTP sign-in. **The rule is "no anonymous client/tenant writes"**, not "no writes at all": the anonymous session itself may never create or touch normal application rows (families, memories, etc.) — but the server *does* create private admission and cost-ledger records on its own behalf for pre-auth voice (`process-voice-memory`'s `mode: 'onboarding'` branch, attributed as Momora onboarding cost rather than family cost — see [usage-limits.md](./usage-limits.md) "Pre-auth onboarding voice contract"). `enable_anonymous_sign_ins` stays gated behind WP-SEC's authorization lockdown (RLS anonymous-deny policies, SECURITY DEFINER RPC guards, Edge Function auth) — anonymous users get the normal `authenticated` DB role, so this is mandatory security work, not optional hardening.
2. **Pre-auth progress is device-local, not server-side.** Kid names, family name, the captured memory, and the notification choice live in AsyncStorage (`OnboardingDraft`) until auth, then commit server-side in one idempotent step (`commitOnboarding`). This is what lets the flow survive the OTP round trip through the mail app and an app kill mid-flow — the draft rehydrates on relaunch and the front door resumes at `draft.step` via `resolvePostAuthDestination`.
3. **S15 (the paywall) is a deliberately non-functional placeholder.** It renders completely — plan card, trust bullets, the close-confirm sheet — but "Start my free week" only advances to S16 with zero billing side effects; "Restore purchases" and the close-sheet "Leave" are inert-but-visible. `app/(onboarding)/paywall.tsx` has one commented `TODO(paywall)` block naming exactly what a real billing integration (RevenueCat-or-equivalent, not yet chosen) needs to swap in. No entitlement is enforced anywhere yet — every "subscriber" is really just anyone who tapped through S15.
4. **Display name is global (`user_profiles.name`), not per-family**, diverging from the design brief's per-family display name. The schema only has a global field, and widening it was out of scope for this pass — J3's "What should the family call you?" writes the same global field the join path's account uses everywhere else, so for someone who already belongs to another family, completing a second join also renames their display name there. Tracked in the plan's Follow-ups as a schema change to reconsider if this divergence proves wrong in practice.
5. **(WP6) The owner's display name is collected at S12A (`app/(onboarding)/email.tsx`), not a new screen.** Before this, `requestSignUpOtp` was always called with an empty `name`, leaving `user_profiles.name` blank for every owner — the name shown next to their own comments/memories. S12A now has a "Your name" field above the email input (owner-path equivalent of J3's "What should the family call you?"), and both fields must be non-empty before "Send my code" enables. A defensive fallback (`'This family member'`) was also added to `app/(app)/sharing/members.tsx`'s bare `profile.name` usages for any account whose name is still blank (legacy rows predating this fix, or a future path that skips it).
6. **(WP6) S16 (`portrait.tsx`) resolves its target member from real server data, not only the local draft.** `code.tsx`'s `finishAfterCommit` clears the onboarding draft (including `kidNames`/`capture`) *before* routing into S13–S16, specifically so the layout's `committedFamilyId` backstop doesn't redirect that arc back to the journal. That means S16's original "read the tagged kid's name from the draft" resolution was only ever populated in a brief pre-clear window; `resolveTargetMember` now falls back to real `useFamilyMembers()` data — the first member with zero portrait versions ever created (`hasNoPortraitYet`, `src/utils/family-members.ts`) — which, because `fetchFamilyMembers` sorts by tag count first, still surfaces the kid tagged on the first memory ahead of untagged siblings for free. The same function also now accepts an explicit `memberId` search param so S17's sibling chain can target a specific next kid.
7. **(WP6) `CastWaitingState` was deliberately dropped, by owner decision** — not deferred for a future pass, but rejected as redundant. The design brief's S17 spec calls for an unpainted-kid "waiting to be painted" card in the family tab as a fallback for "Later"/never-opened-the-reveal. The owner decided the existing family tab (`app/(app)/(tabs)/family.tsx`) already covers this: every member renders as a `CastCard` regardless of portrait status, and its own subtitle ("Edit their photo to redraw it.") already invites the user to add a photo for any kid without one. "Later" on S17 navigates straight to that tab (`familyRosterRoute`, `src/lib/routes.ts`) instead of building a second, more special-cased "waiting" surface.
8. **(WP7-A) S14 (`included.tsx`) and S15 (`paywall.tsx`) resolve their kid-name personalization from real server data, not only the local draft** — the same class of bug WP6 already fixed on S16's target-member resolution, and for the identical root cause: `code.tsx`'s `finishAfterCommit` clears the draft before routing into S13–S16, so both screens' original local `resolveKidPossessive(draft)` silently collapsed to the neutral "their" phrasing on every real device, losing personalization on the trust and paywall screens — exactly the two screens whose job is persuasion on the kid's name (spec decision 8). Both screens now share one hook, `useOnboardingKidPossessive()` (`src/hooks/use-onboarding-kid-possessive.ts`): draft first (a single tagged kid, or a single-kid family with nothing tagged yet), then real `useFamilyMembers()` data once the draft is empty (a single member resolves unambiguously; multiple members use `members[0]` from `fetchFamilyMembers`' tag-count sort — the same `members[0]` fallback WP6 already established for S16, reused rather than re-derived), then the neutral "their" as the last-resort fallback (member data loading, errored, or empty). Known simplification carried over from WP6's own fix: per-member tag counts aren't exposed past the service layer, so two kids tied at one tag each can't be distinguished from a single tagged kid once the draft is empty — the top of the sort wins the name instead of falling back to "their" in that specific tie case.
9. **(WP7-A) The membership-freshness assumption behind WP6/WP7-A's real-data fallback holds, verified by test.** `code.tsx`'s `finishAfterCommit` awaits `queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey })` before `clear()` and before routing into S13 — `onboarding.post-commit-real-data.integration.test.tsx` proves that by the time that invalidation resolves, `useFamily()`'s `familyId` already reflects the brand-new family (`FamilyProvider` is mounted at the app root, so its membership query is always an active observer and gets refetched by that invalidation). The one caveat: `useFamilyMembers()`/`usePortraitVersions()` themselves still run their *own* first fetch once a screen mounts with a real `familyId` for the first time (no prior cache entry exists pre-commit), so S14–S17 can briefly render the neutral/loading fallback for one fetch cycle before the real name resolves — the same tolerance WP6's S16 already built in (`isLoadingMembers` disabling the CTA).
10. **(WP7-A) `portrait.tsx`'s target-member resolution is now pinned once resolved, closing a multi-kid retargeting defect found while testing S16 for real.** `resolveTargetMember`'s `members.find(hasNoPortraitYet) ?? members[0]` used to rerun on every render (via `useMemo` on `members`), including the re-renders `usePortraitVersions`' own mutation triggers (`invalidatePortraitConsumers` invalidates both `portrait-versions` and `family-members`). For a multi-kid family's *first* portrait (no explicit `memberId` param yet), the instant the chosen kid's portrait version landed in the cache, that kid's `hasNoPortraitYet` flipped to `false` and the resolver would re-target an untouched sibling mid-flight — silently losing track of the in-progress generation (the screen would keep showing "We're painting." for the wrong, untouched kid, never detect the real kid's "ready" transition, or reveal the wrong child). Confirmed via code tracing plus a real (unmocked) reproduction while building this test's S16 coverage; invisible to the existing mocked-hook portrait test because that suite's `useFamilyMembers` mock never changes mid-test. **Fixed**: `resolveTargetMember` now takes a `pinnedMemberId` parameter, checked immediately after the explicit `memberId` param and ahead of the ambiguous `hasNoPortraitYet` search; `PortraitScreen` pins the first target it resolves (when there's no explicit param) via `useState`, and clears the pin whenever a new explicit `memberId` param arrives (S17's sibling chain always wins over a stale pin). `usePortraitVersions` and the ready-effect's reveal navigation both key off `targetMember`, which now stays stable once pinned, so `retryVersion` and the ready-redirect always act on the kid the screen actually started painting. Regression-tested in `onboarding.post-commit-real-data.integration.test.tsx` (verified to fail without the pin, in the same reveal-the-wrong-kid way described above, before the fix was restored).

## Not yet shipped

Deliberately out of scope (see the implementation plan's Scope table and Follow-ups):

- **The design brief's `CastWaitingState` unpainted-kid family-tab card** — deliberately dropped by owner decision (see implementation decision 7 above), not deferred; the existing family tab covers the same job.
- **Real billing** — RevenueCat-or-equivalent, entitlement enforcement, family-scoped subscriptions (product decision 6). S15 is the placeholder described above.
- **Per-IP/per-device onboarding voice limits, CAPTCHA/Turnstile, fraud scoring** on the anonymous-session surfaces (explicit WP-SEC backlog per usage-limits.md).
- **Lapsed-owner resubscribe screen** and the **attribution screen** (spec six-jobs table — deliberately deferred).

## Six-jobs coverage check

| Job | Where |
|-----|-------|
| Personalization | Child's name (4), family name (5), notification question (8) |
| Commitment | Affirmation CTAs throughout (2, 6), naming (4, 5), first capture (7) |
| Social proof | Founder-family intro (3), examples on paywall (10) |
| Permission | Embedded notification ask (8) |
| Paywall | Trust screens (9) + paywall (10) |
| Attribution | **Deliberately deferred** — not in v1; candidate for end-of-flow placement (Bend pattern) if channel data becomes a priority |

## Copy register rules

- Language from VoC §6 only: "it goes so fast," "the little things," "boring stuff," "quick," "no pressure." Never: "preserve," "document," "keepsake journal," "legacy."
- Guilt-relief, never guilt-manufacture. "It's not too late" beats "time is running out." No "18 summers"-genre countdown framing anywhere.
- Verify aggregator-sourced VoC quotes against live threads before using verbatim in shipped copy (VoC provenance note).

## Test backlog (post-launch, paywall-first sequencing)

Per the paywall → onboarding → marketing test order (@stevencravotta), run 5–10 paywall variants before touching flow structure:

1. 7-day vs 14-day trial (Headspace's tested winner was 14-day on annual)
2. Single-option annual vs annual + monthly anchor
3. Weekly plan as a competing variant (only if annual underperforms; mind the brand-trust risk above)
4. Trust-screen copy variants
5. Founder-intro placement (mid-flow vs pre-paywall) and inclusion A/B

Retention gate (VoC §8): if 30-day retention tracks the Qeepsake/Tinybeans churn pattern, the "lightweight/no-guilt" claim is unproven — redesign before scaling acquisition.

## Constraints & gotchas

- **Entitlements must be family-scoped** (decision 6) — enforce server-side, not client-side; joiners inherit capture/view from the owner's subscription.
- **Keyboard UX rule applies to the capture screen (7)** — TextInput + primary actions must stay visible with the keyboard open (CLAUDE.md high-risk area).
- **`OnbShell` owns both IME movement and bottom-action safety.** With the keyboard closed, its footer uses the larger of the design minimum and `bottomSafeAreaInset + 8`, so Android gesture/three-button navigation cannot cover actions or links. With the keyboard open, the keyboard already owns that bottom region, so the shell uses only the 8-point visual gap rather than stacking both insets.
- **Keyboard-aware scrolling is intentionally bounded.** Android uses the keyboard-controller height-resized frame; iOS keeps the footer in the controller's sticky region so the CTA follows the IME instead of being partly covered. `KeyboardAwareScrollView.bottomOffset` represents only the pinned footer/caret clearance. Short centered steps clamp user scrolling to their measured content boundary, so the keyboard spacer cannot become a blank page; long forms retain the keyboard-aware inset needed to reveal lower focused fields. Do not restore the old large offsets or add a second full keyboard-height compensation: they push centered copy/headlines offscreen. Multi-field screens may request a larger measured offset for the next field, but must preserve useful context and restore the previous scroll position when the keyboard closes.
- **Do not remove the shared scroll bounds.** Keep keyboard-open tests for a short input screen on both platforms, including a non-zero Android bottom inset, and verify that dragging cannot expose the implementation-only keyboard spacer. Keep the CTA outside the scroll body so it cannot be scrolled under the IME or intercept a focused field.
- **No memory-content logging** in onboarding analytics events (child/family PII rule). Track step completion, not content.
- **Voice capture in onboarding follows the existing no-audio-persistence pipeline** — transcription only.
- Onboarding must be resumable — if the app is killed mid-flow, don't lose the captured memory (text saves first, per AI async flow rules). Pre-auth progress is device-local (decision 18); it syncs on auth and must survive the OTP round-trip through the mail app.
- The lapsed-owner state is part of this feature's contract: view + export always work signed-out-of-billing (decision 4). Never show a lapsed owner a locked archive.
- Apple compliance: no misleading trial toggles; trial terms stated plainly (Apple rejections started early 2026).

## Dependencies

- Depends on: family-profiles, family-sharing (join path), memories (first capture), voice-journaling (voice input), portrait-timeline + cloudflare-illustration-workflows (background generation at trial start), RevenueCat-or-equivalent subscription infra (not yet chosen/implemented).
- Used by: everything — this is the front door.

### Anonymous onboarding production checklist

S9 voice transcription and J2 invite preview require anonymous Supabase Auth. In each deployed
project, enable **Anonymous sign-ins** only after the anonymous-lockdown migration and its tests
are present. The shipped cleanup function (`cleanup-abandoned-anonymous-users`) and daily 04:00
UTC pg_cron invocation remove anonymous users abandoned for seven days; Auth deletion nulls only
their raw ledger attribution and preserves deidentified onboarding COGS rollups.

Before enabling this path in a production project, verify all of the following without exposing a
secret in a client or repository:

1. Supabase Auth has **Anonymous sign-ins** enabled for the target project.
2. `cleanup-abandoned-anonymous-users` is deployed with `CRON_SECRET` configured.
3. Vault contains `project_url` and `cron_secret`, and the cron job named
   `invoke-cleanup-abandoned-anonymous-users` exists at `0 4 * * *` UTC.
4. Invoke the cleanup endpoint once with its real `x-cron-secret` header, then inspect
   `cron.job_run_details` after the next scheduled run. A successful empty cleanup is valid.

`supabase/config.toml` supplies the local-development setting; it does not turn on anonymous
sign-ins for a hosted project.

## Extension guide

**Safe to extend:** story-beat copy, founder-intro content, trust-screen wording, test-backlog variants.

**Do not change without updating this doc:** the paywall model (decisions 1–4), the join-path skip (5), entitlement scoping (6), aha placement before the paywall (10), review-ask timing (15), the no-guilt/no-streaks rule (16), post-auth state routing as the single source of truth (17).

**For future agents:** the mechanics-vs-copy split is the organizing principle. Before weakening a mechanic "because the persona won't like it," check whether the fix is rewording (usually) rather than removal (rarely). The reverse also holds: don't add urgency/guilt mechanics "because they convert" — decisions 3 and 16 document why they're net-negative for this brand.

## Testing

### Unit tests

| File | Covers |
|------|--------|
| `src/utils/onboarding-copy.test.ts` | `kidsPhrase`, `defaultFamilyName`, `capturePrompt`, `firstPageCaption`, `possessiveHeadline`, `possessive` — including the s-ending possessive rule |
| `src/utils/onboarding-progress.test.ts` | Draft read/write/patch/clear, version/shape forward-compat, storage-hiccup fallbacks |
| `src/lib/onboarding-routing.test.ts` | `resolvePostAuthDestination` — every priority-order branch (membership wins, pending-code, intent, resume-at-step), including the front-door call shape (`intent: 'login'`) added in WP5 |
| `src/components/onboarding/onb-illustration.test.tsx` | Falls back to the watercolor wash when a slot has no asset; `accessibilityLabel` from the slot description |
| `src/components/onboarding/onb-shell.test.tsx` | Android bottom-inset footer protection, keyboard-open inset de-duplication, bounded keyboard movement, and scroll restoration |
| `src/hooks/use-onboarding-kid-possessive.test.tsx` | (WP7-A) `useOnboardingKidPossessive`'s priority order in isolation: single tagged kid / single-kid-nothing-tagged from the draft; "their" for several tagged (without consulting server data); real single/multiple member fallback once the draft is empty; "their" last resort when member data isn't available |

### Integration tests

| File | Scenarios |
|------|-----------|
| `src/screen-tests/onboarding.kids.integration.test.tsx` | Add/remove kid chips; continuing with an un-added typed name; shared keyboard-frame clearance |
| `src/screen-tests/onboarding.welcome.integration.test.tsx` | Welcome actions retain screen-specific breathing room below the opening copy |
| `src/screen-tests/onboarding.family-name.integration.test.tsx` | Prefill for 1/2/3 kids; edits persist to the draft |
| `src/screen-tests/onboarding.capture.integration.test.tsx` | Typed path saves to draft; keyboard-open assertions |
| `src/screen-tests/onboarding.notifications.integration.test.tsx` | The fourth option never calls `requestRegistration` |
| `src/services/onboarding.integration.test.ts` | `commitOnboarding` — idempotent re-commit creates nothing twice; the returning-owner branch (decision 18) |
| `src/screen-tests/onboarding.included.integration.test.tsx` | (WP7-A, new — S14 had no prior coverage) Checklist + signed promise card render; draft-first personalization (single kid, neutral "their" for several tagged); CTA advances to the paywall route |
| `src/screen-tests/onboarding.paywall.integration.test.tsx` | Close-confirm sheet opens/dismisses; CTA advances without touching any billing service |
| `src/screen-tests/onboarding.portrait.integration.test.tsx` | Picking a photo calls `createPortraitVersion` for the right member and transitions to `painting`; (WP6) `ready` navigates to S17's reveal for that member, `failed` surfaces the retry state and calls `retryVersion`, the journal escape stays available in every sub-state |
| `src/screen-tests/onboarding.reveal.integration.test.tsx` | (WP6) S17's two CTA branches — sibling-remaining vs. none — including that a sibling with a portrait version already in progress doesn't count as "unpainted"; "Later" routes to `familyRosterRoute`; an unresolvable `memberId` bounces to the journal |
| `src/screen-tests/onboarding.email.integration.test.tsx` | (WP6) S12A's name field: "Send my code" stays disabled until both name and email are filled; the trimmed name reaches `requestSignUpOtp`; two-field keyboard clearance keeps email tappable below the focused name |
| `src/screen-tests/reviewer-password.integration.test.tsx` | Login and guarded reviewer-password routing, including that "Create an account" enters the current owner onboarding story instead of the retired signup screen |
| `src/screen-tests/onboarding.join.integration.test.tsx` | Code → found → name flow; an invalid code surfaces an error and does not advance |
| `src/screen-tests/onboarding.post-commit-real-data.integration.test.tsx` | **(WP7-A, the blind-spot test)** Drives the real `OnboardingFlowProvider`/`FamilyProvider`/`useFamilyMembers()`/`usePortraitVersions()`/`useMediaUrl()` (mocked only at the Supabase-backed service boundary, plus `useAuth`/`useMemoriesRealtime`) through the actual sequence: seed a populated draft → real `commitOnboarding` → the same membership-query invalidation `code.tsx` awaits (verifying the freshness assumption) → real `clear()` → render S13→S17 against the now-empty draft. Asserts S14/S15 render the real kid's name (not the neutral fallback) and S16's "Choose a photo" CTA is enabled and resolves the correct member — all against server data, since that's the only source that survives the clear. Continues the same two-kid, no-`memberId`-param S16 flow through to a real "ready" transition and asserts the reveal route names the kid who was actually painted (not the untouched sibling) — the regression test for decision 10's pin fix, verified to fail without it. Existing screen tests all mock `useOnboardingFlow()`/`useFamilyMembers()` directly, which is exactly what hid both bugs; this file deliberately does not. |

### E2E (Maestro)

| Flow | Scenario |
|------|----------|
| `.maestro/flows/onboarding/owner-happy-path.yaml` | S0 → story → founders → artifact → kids → family-name → bridge → capture (typed) → aha → year → notifications → account (OTP) → trial → included → paywall (placeholder) → fixture-photo portrait → painting → S17 reveal with the signed image actually loaded → journal. The staged local harness uses synthetic accounts, local Mailpit, an explicitly matched local client/Edge Function/Worker/R2 stack, and the normal deletion-fence cleanup; it refuses a database that already has a due account deletion, so start from an isolated/reset local database. It does **not** exercise a hosted or production image stack. Current-device execution remains a release check. |
| `.maestro/flows/onboarding/join-happy-path.yaml` | Owner creates an invite → fresh device → J1 (code) → J2 (found) → J3 (name) → J4 (OTP) → J5 (waiting). It ends at the approval-wait state by design; the owner approval/timeline continuation remains in the sharing flows. Current-device execution is a release check. |
| `.maestro/flows/onboarding/owner-visual-audit-pre-auth.yaml` | Deterministic, synthetic **owner** S0–S12A visual-review capture set: welcome through the empty email screen, including the kids, family-name, typed-capture, and account-email keyboard-open states. It stops before email entry, therefore cannot create an account, commit onboarding data, or generate images. The runner accepts only an explicit `http://127.0.0.1:<port>` client configuration. |
| `.maestro/flows/onboarding/owner-visual-audit-{pre,post}-otp.yaml` | Full **owner** S0–S17 visual-review capture set. These staged flows run only through the existing isolated-local harness, use its local Mailpit OTP and fixture photo, wait for the signed portrait to decode, and clean up the synthetic account through the deletion fence. The Worker/R2 path is local, but the synthetic portrait still uses the configured OpenAI provider and incurs a real cost; the command requires an explicit acknowledgement. Capture filenames use screen-order prefixes (`00-…` through `27-…`) for later AI review. Join-flow visual audit is not included. |

### Run this feature's tests

```bash
npm test -- --runInBand --testPathPattern=onboarding
npm exec supabase -- start
npm run db:reset
npm run test:db
ONBOARDING_VOICE_CONCURRENCY_TEST=1 npm run test:edge
# Requires MAESTRO_DEVICE_ID and the isolated-local image stack described above.
npm run test:e2e:onboarding
# Safe visual review of owner S0-S12A only; requires http://127.0.0.1:<port> local config.
npm run test:e2e:onboarding:owner-visual-audit:pre-auth
# Full owner visual review of S0-S17; requires the isolated-local image stack above and incurs one real OpenAI portrait cost.
ONBOARDING_VISUAL_AUDIT_ALLOW_REAL_IMAGE_COSTS=1 npm run test:e2e:onboarding:owner-visual-audit
```

## Changelog

| Date | Change |
|------|--------|
| 2026-07-23 | Initial design spec (Eduardo + Claude, tasu-sourced) |
| 2026-07-29 | WP0–WP5 implemented: S0–S16 owner path, J1–J5 join path, front door wired (`app/index.tsx`, `app/(auth)/_layout.tsx`, `app/invite.tsx`), status flipped to `done`. S17, real billing, and real illustration assets remain `planned`. |
| 2026-07-30 | WP6 implemented: S12A now collects the owner's display name (`app/(onboarding)/email.tsx`, plus a blank-name safety net in `app/(app)/sharing/members.tsx`); S16 (`portrait.tsx`) reads the real portrait status instead of a decorative pulse and hands off to the new S17 `reveal.tsx` on `ready`, with a warm retry on `failed`; S17 ships with the sibling chain, and the design brief's `CastWaitingState` cast card is deliberately dropped by owner decision in favour of the existing family tab. Real billing and real illustration assets remain `planned`. |
| 2026-07-30 | WP7-A implemented: closed the testing blind spot that let two post-commit-draft bugs ship (WP6's S16 fix being one; S14/S15 losing kid-name personalization being the other, fixed here). `app/(onboarding)/included.tsx` and `app/(onboarding)/paywall.tsx` now resolve personalization through a new shared hook, `useOnboardingKidPossessive()` (`src/hooks/use-onboarding-kid-possessive.ts`), instead of a duplicated local resolver that only ever read the (post-commit, empty) draft. New `onboarding.post-commit-real-data.integration.test.tsx` drives the real post-commit sequence (`commitOnboarding` → the membership invalidation → `clear()` → S13–S17) with unmocked draft/hook state — the regression test this bug always needed. S14 also gained its first-ever screen test coverage (`onboarding.included.integration.test.tsx`). A separate defect in S16's target-member pinning, found while building this coverage, was also fixed in this pass (pulled into scope on coordinator review) — see implementation decision 10. |
| 2026-07-31 | Corrected release documentation: bundled real onboarding art (`8555064`) and abandoned-anonymous-user cleanup + its daily cron are shipped. Added the hosted-project anonymous Auth/cron verification checklist and repo-pinned local Supabase commands. |
| 2026-07-31 | Hardened `OnbShell` against Android navigation-bar overlap and excessive IME scrolling; documented the shared safe-area/keyboard contract and routed login's "Create an account" link into the current owner onboarding story. |
| 2026-07-31 | Bounded short onboarding forms to their measured content, disabled platform overscroll, and made the iOS footer follow the keyboard independently of Android's edge-to-edge height resize. |
