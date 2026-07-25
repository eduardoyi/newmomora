# Feature: Onboarding & Paywall

**Status:** `planned`
**Last updated:** 2026-07-23
**PRD reference:** PRD §onboarding (update when implemented)
**Research inputs:** [docs/voice-of-customer.md](../voice-of-customer.md) (VoC) · tasu conversion brain (tasu.ai/library, queried 2026-07-23)
**Design brief:** [docs/plans/onboarding-design-brief.md](../plans/onboarding-design-brief.md) — screen-by-screen layout + copy for design handoff

Design spec agreed 2026-07-23. Nothing in this doc is implemented yet. When implementation starts, fill in the Architecture / Data model / Client integration sections and flip the status.

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
| 8 | **One personalization field: the child's first name.** No DOB, no photo, no multi-kid setup. | Naming is the highest-value single commitment in the tasu library (ownership → responsibility → retention). The name powers all subsequent copy and the aha moment. DOB cut (tedious/intrusive); photo moves into the trial where it's framed as "let's make {name}'s portrait." Additional kids are added in-app. |
| 9 | **Family name defaults to "{name}'s Family", one tap to confirm, editable.** Child's name is asked first (S6 → S7 order is deliberate). | Needed for tenancy anyway; light commitment device. The child's name is the emotional naming moment — this one stays nearly free. Surname-based suggestions ("The Rivera Family") are impossible pre-auth (auth is at step 9), which is why the default derives from the child's name; asking the child first is what makes this screen zero-typing. |
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
4. **Child's first name** (single field; "a nickname works too") → subsequent copy personalizes on it.
5. **Family name confirm** (auto-suggested, one tap).
6. **Recognition story, part 2 / bridge to action** — "the fix isn't a better habit, it's a lighter one" → *"Let's save one right now — something small {name} did this week."*
7. **Guided first capture (the aha)** — voice or type, optional photo/video, instant beautiful layout titled with {name}. No generation, no waiting.
8. **Embedded notification question** → OS permission prompt (decision 12).
9. **Account (OTP auth)** — framed as "so {name}'s first memory is safe" (decision 18). **The routing gate (17) fires here:** new users continue to 10; anyone with an existing family/entitlement is diverted per the Returning-users table, with the captured memory saved to their family.
10. **Trust screen A** (trial timeline) → **Trust screen B** (what unlocks + export-always-free).
11. **Hard paywall** — annual plan, 7-day free trial, founder-family illustration examples, the export policy line. Trial-or-exit.
12. **On trial start:** background-start portrait/illustration generation (existing Cloudflare Workflows pipeline); photo ask happens here, framed as "let's make {name}'s portrait."

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
- **No memory-content logging** in onboarding analytics events (child/family PII rule). Track step completion, not content.
- **Voice capture in onboarding follows the existing no-audio-persistence pipeline** — transcription only.
- Onboarding must be resumable — if the app is killed mid-flow, don't lose the captured memory (text saves first, per AI async flow rules). Pre-auth progress is device-local (decision 18); it syncs on auth and must survive the OTP round-trip through the mail app.
- The lapsed-owner state is part of this feature's contract: view + export always work signed-out-of-billing (decision 4). Never show a lapsed owner a locked archive.
- Apple compliance: no misleading trial toggles; trial terms stated plainly (Apple rejections started early 2026).

## Dependencies

- Depends on: family-profiles, family-sharing (join path), memories (first capture), voice-journaling (voice input), portrait-timeline + cloudflare-illustration-workflows (background generation at trial start), RevenueCat-or-equivalent subscription infra (not yet chosen/implemented).
- Used by: everything — this is the front door.

## Extension guide

**Safe to extend:** story-beat copy, founder-intro content, trust-screen wording, test-backlog variants.

**Do not change without updating this doc:** the paywall model (decisions 1–4), the join-path skip (5), entitlement scoping (6), aha placement before the paywall (10), review-ask timing (15), the no-guilt/no-streaks rule (16), post-auth state routing as the single source of truth (17).

**For future agents:** the mechanics-vs-copy split is the organizing principle. Before weakening a mechanic "because the persona won't like it," check whether the fix is rewording (usually) rather than removal (rarely). The reverse also holds: don't add urgency/guilt mechanics "because they convert" — decisions 3 and 16 document why they're net-negative for this brand.

## Changelog

| Date | Change |
|------|--------|
| 2026-07-23 | Initial design spec (Eduardo + Claude, tasu-sourced) |
