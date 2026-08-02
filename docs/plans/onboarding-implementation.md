# Onboarding — Implementation Plan

**Status:** WP0–WP7-A and the paid-access cutover are done (see Execution log). WP-SEC's mandatory anonymous-authorization lockdown and cleanup cron have landed.
**Spec:** [docs/features/onboarding.md](../features/onboarding.md) (decisions + routing) · [docs/plans/onboarding-design-brief.md](onboarding-design-brief.md) (layout + copy)
**Design handoff:** Claude Design bundle `Momora screens` (S0–S17, J1–J5). Prototype source is HTML/CSS; recreate the visual output in React Native, do not port its structure.
**Last updated:** 2026-08-01

## Scope of this pass

| In | Out |
|----|-----|
| S0–S8 story arc | `CastWaitingState` unpainted-kid family-tab card -- **dropped by owner decision (WP6), not deferred**: redundant with the existing family tab, which already invites a photo for any unpainted kid |
| S9–S12 capture → aha → account (WP6: S12A also collects the owner's display name) | Attribution screen |
| S13–S16 trust → paywall → portrait, now wired to RevenueCat and server entitlements | |
| S17 portrait reveal + sibling chain (WP6, in-trial moment) | Attribution screen (deliberately deferred, spec §six-jobs) |
| J1–J5 join path | |
| Real illustrations (styled placeholders + documented drop-in point) | |

## Decisions settled before implementation

1. **The owner flow is fully wired.** S6/S7 really create the family and name-only child profiles; S9 really records/transcribes; S10 renders the memory that was really saved; S11 really sets the reminder preference and fires the OS prompt; S12/J4 use the real OTP auth; S15 performs RevenueCat purchase/restore; and S16 really kicks off portrait generation. The paid hand-off and lapsed-owner route are server-enforced.
2. **The new flow is the front door.** Unauthenticated launches land on S0, not `(auth)/login`. The existing login/verify-otp screens survive as the quiet "Log in" branch. J1–J5 is the unauthenticated invited path; `sharing/redeem` + `sharing/waiting` stay for the already-authenticated case (adding a second family, deep link arriving with a session).
3. **Pre-auth server calls ride an anonymous Supabase session.** S9's transcription and J2's invite lookup both need a JWT before the user has an account. `signInAnonymously()` supplies one. **No anonymous client/tenant writes** happen under it — the anonymous session may never create or touch normal application rows. The server *does* create private admission and cost-ledger records on its own behalf (see decision 7). The session is discarded (`signOut()`) at S12/J4 before the real OTP sign-in.

7. **Pre-auth voice is Momora onboarding cost, not family cost — the server contract is settled and shipped.** Use `processOnboardingVoiceMemory(audioBase64, nameHints)` from `src/services/ai.ts`. Contract (canonical: [TECH_SPEC.md](../TECH_SPEC.md) §process-voice-memory, [usage-limits.md](../features/usage-limits.md) "Pre-auth onboarding voice contract"):
   - Requires a verified Supabase user with `is_anonymous === true`.
   - Send **only** `{ mode: 'onboarding', audioBase64, nameHints }`. Never `familyId`, `familyMembers`, synthetic member ids, or user ids.
   - `nameHints`: up to 6 trimmed, non-empty names, ≤50 chars each. **Spelling hints only** — they are not member ids and grant no family access.
   - Response is `{ cleanedText, mentionedMemberIds: [] }`. The server never returns member ids in this mode, so **the locally selected kids in the onboarding draft are the source of truth for tagging** — preserve them across the call.
   - **Two onboarding voice attempts per anonymous account, total.** The third returns HTTP 429 `ONBOARDING_VOICE_LIMIT_REACHED`. A reserved attempt stays consumed even when transcription or cleanup fails, so a retry after failure costs an attempt.
   - Handle: `ONBOARDING_ANONYMOUS_REQUIRED`, `ONBOARDING_VOICE_LIMIT_REACHED`, `ONBOARDING_VOICE_RESERVATION_FAILED`, `ONBOARDING_VOICE_CLEANUP_RESERVATION_FAILED`, plus the existing audio/transcription validation errors.
   - **Do not weaken the normal `processVoiceMemory` family requirement.** These are two separate service functions and stay that way.

8. **`enable_anonymous_sign_ins` stays `false` until WP-SEC lands.** Anonymous users get the normal `authenticated` database role, so today an anonymous user could reach `create_family` (SECURITY DEFINER) and from there normal family and paid-AI functionality. Flipping the flag before the lockdown would be a live authorization hole. WP-SEC is mandatory security work, not abuse hardening, and it gates the entire flow going live.
4. **Pre-auth progress is device-local.** Kid names, family name, the captured memory, and the notification choice live in AsyncStorage until auth, then commit server-side in one idempotent step. This must survive the OTP round trip through the mail app (spec decision 18).
5. **Illustrations are styled placeholders behind one asset map.** No art exists yet. `OnbIllustration` renders the design's watercolor wash; `src/constants/onboarding-illustrations.ts` maps every slot id to its description + tint, with an optional `asset` field. Dropping real art in later touches that one file, never a screen.
6. **Display name is global, not per-family.** The brief calls for per-family display names; the schema has `user_profiles.name` only. Use the global field and do not invent schema. Noted as a divergence in the feature doc.

## Context implementers need

- **Design tokens already exist** in `src/constants/theme.ts` (`colors`, `fonts`, `spacing`, `radius`, `emotionColors`) and match the handoff's `src/tokens.jsx` 1:1. Never hardcode a hex that exists as a token. The handoff's `MOMORA_EMOTIONS` is a 5-key subset of `emotionColors` — use `emotionColors`.
- **Fonts** are loaded via `@expo-google-fonts/*`: `fonts.display` (Newsreader) for headlines, `fonts.displayItalic` for quote bodies, `fonts.sans`/`sansBold` (Plus Jakarta Sans) for UI, `fonts.script` (Caveat) for hand-touches.
- **The handoff's `OnbKeyboard` is a fake iOS keyboard** drawn so the static mockups show keyboard-open layout. Do **not** port it. Use the real keyboard and the project's keyboard-avoidance rule below.
- **Keyboard UX is a hard project rule** (CLAUDE.md high-risk area, AGENTS.md, app/AGENTS.md): every screen with a `TextInput` must keep the focused input *and* its primary action visible with the keyboard open, on both platforms. Follow the existing pattern — `KeyboardAwareScrollView` from `react-native-keyboard-controller` via `src/components/keyboard-aware-form-screen.tsx`, or `src/components/auth-screen.tsx`'s `KEYBOARD_BOTTOM_OFFSET` treatment when the CTA sits directly under the last field. Commit `af2c067` fixed exactly this class of bug on Android; do not regress it.
- **Use `Pressable`**, never Touchables. Functional components, named exports, TypeScript strict.
- **Never log memory content, transcripts, or child names.** Onboarding analytics/telemetry track step completion only.
- **Tests ship in the same change** (AGENTS.md): unit for pure utils, `.integration.test.tsx` for screens/hooks, Maestro for the happy paths. Run `npm test` and `npm run typecheck` (Node 20 via nvm) before reporting done.
- **`family_members.date_of_birth` and `profile_picture_key` are both nullable** in the DB, so name-only child profiles are valid. But `CreateFamilyMemberInput.dateOfBirth` is typed `string` (required) in `src/utils/family-members.ts` — WP0 widens it to `string | null`, and `validateDateOfBirth` keeps its current required-behavior for the add-family-member screen that still needs it.

---

## WP0 — Foundations

Everything else depends on this package's API surface. It lands first, alone.

### 0.1 `src/components/onboarding/` primitives

New directory. Each a named export, styled from theme tokens, mirroring the handoff's `src/primitives.jsx`:

| Component | File | Notes |
|-----------|------|-------|
| `OnbDisplay` | `onb-typography.tsx` | Newsreader, `lineHeight: size * 1.0`, `letterSpacing: -0.018em * size`. Prop `size` (default 32). |
| `OnbTitle` | `onb-typography.tsx` | Newsreader medium, `lineHeight: size * 1.08`. |
| `OnbBody` | `onb-typography.tsx` | Jakarta, `lineHeight: size * 1.5`, `muted` prop → `colors.ink2`. |
| `OnbScript` | `onb-typography.tsx` | Caveat, `lineHeight: size`. |
| `OnbEyebrow` | `onb-typography.tsx` | Jakarta bold 11, `letterSpacing: 0.14 * 11`, uppercase. |
| `OnbButton` | `onb-button.tsx` | Variants `primary` \| `secondary` \| `ghost`; sizes `lg`/`md`/`sm`; pill radius; pressed state → `colors.primaryDark`. Required `testID`. |
| `OnbShell` | `onb-shell.tsx` | `SafeAreaView` + optional scroll body + pinned footer CTA stack (`padding: 0 24 40`, `gap: 10`). Every full-screen onboarding step uses it. |
| `OnbDots` | `onb-dots.tsx` | `n`/`at`; active dot 16×5 in `colors.primary`, rest 5×5 in `colors.border`. |
| `OnbIllustration` | `onb-illustration.tsx` | Takes a `slot` id. Renders the real asset when the map has one, else the watercolor wash (layered `expo-linear-gradient` approximating the handoff's `Illustration`: emotion-soft radial + warm/accent linear + soft horizon). `accessibilityLabel` from the slot's description. |
| `KidChip` | `kid-chip.tsx` | Initial-letter avatar in an emotion tint + name + optional remove affordance. Used by S6 and S9. |

Kid tint cycling matches the handoff: `['tender','wonder','joy','calm','mischief'][i % 5]`, exported as `kidTint(index)` from `onb-illustration.tsx` or a small `onb-tints.ts` — implementer's call, but one home.

### 0.2 `src/constants/onboarding-illustrations.ts`

```ts
export interface OnboardingIllustrationSlot {
  description: string;   // becomes the accessibilityLabel and the placeholder caption in dev
  emotion: EmotionName;  // drives the placeholder wash
  scene: 'window' | 'garden' | 'bedroom' | 'kitchen' | 'park' | 'bath';
  asset?: number;        // require('...') once real art exists
}
export const onboardingIllustrations: Record<OnboardingIllustrationSlotId, OnboardingIllustrationSlot>
```

Slot ids and descriptions come verbatim from the handoff's `image-slot` elements: `welcome`, `story-night`, `story-book`, `story-babble`, `founders`, `kids-doodle`, `family-nest`, `paywall-page-1|3|4`, `portrait-sample`, `join-door`.

### 0.3 `src/utils/onboarding-copy.ts` (pure, unit-tested)

- `kidsPhrase(names: string[])` → `''` \| `'Lila'` \| `'Lila & Miguel'` \| `'Lila, Miguel & Teo'`.
- `defaultFamilyName(names)` → `` `${kidsPhrase(names.slice(0,3))}'s Family` ``; `''` when no names. Possessive handling for names ending in `s` — pick one rule, test it.
- `capturePrompt(names, selectedIndexes)` → single kid: `What's something small {name} did this week that made you smile?`; 2 selected: `…the two of them did…`; 3+: `…all of them did…`; multi-kid with one selected: that kid's name.
- `firstPageCaption(selectedNames)` → `` `${name}'s first page. Imagine a year of these.` `` \| `Their first page. Imagine a year of these.`
- `possessiveHeadline(names)` for S7 → single: `{name}'s stories need a home.`; multi: `Their stories need a home.`

Every copy string in the design brief is deliberate. Copy them exactly, including the no-em-dash rule.

### 0.4 `src/utils/onboarding-progress.ts` (AsyncStorage, unit-tested)

Model on `src/utils/pending-invite-code.ts` — same defensive try/catch-to-null style.

```ts
export const ONBOARDING_DRAFT_STORAGE_KEY = 'momora.onboardingDraft';

export interface OnboardingDraft {
  version: 1;
  step: OnboardingStepId;          // resume point
  kidNames: string[];
  familyName: string;
  capture: {
    text: string;
    mediaUri?: string;
    mediaContentType?: string;
    taggedKidIndexes: number[];
  } | null;
  notificationChoice: 'eve' | 'late' | 'morn' | 'none' | null;
  committedFamilyId?: string;      // set by commitOnboarding — makes the commit idempotent
}
```

`getOnboardingDraft` / `patchOnboardingDraft(partial)` / `clearOnboardingDraft`. Unknown `version` → treat as absent (forward-compat).

**Do not persist audio.** The voice pipeline's no-persistence rule holds here: audio is transcribed in memory and discarded; only the resulting text is stored.

### 0.5 `src/hooks/use-onboarding-flow.tsx`

Context provider mounted by `app/(onboarding)/_layout.tsx`. Hydrates the draft once on mount, exposes `{ draft, isHydrated, patch, clear }`, and debounce-persists on change (~300ms, same spirit as the new-memory draft autosave). Screens read/write through this, never AsyncStorage directly.

### 0.6 `src/lib/anonymous-session.ts`

```ts
/** Ensures a JWT exists for pre-auth server calls. Never used for DB writes. */
export async function ensureAnonymousSession(): Promise<{ error: ServiceError | null }>
/** Drops the anon session so the real OTP sign-in starts clean. No-op when the session isn't anonymous. */
export async function discardAnonymousSession(): Promise<void>
```

`ensureAnonymousSession` is a no-op when a session already exists. Detect "is anonymous" via `session.user.is_anonymous`. Both must be safe to call twice.

### 0.7 `src/lib/onboarding-routing.ts` (pure, unit-tested)

The single source of truth for spec decision 17. Consumed by WP2 (post-OTP), WP4 (post-OTP), and WP5 (front door).

```ts
export type PostAuthDestination =
  | { kind: 'journal' }
  | { kind: 'resume-onboarding'; step: OnboardingStepId }
  | { kind: 'resume-paywall'; mode: 'new-owner' | 'resubscribe' }
  | { kind: 'join-waiting' }
  | { kind: 'ask-invite-code' };

export function resolvePostAuthDestination(input: {
  memberships: readonly { familyId: string; role?: string }[];
  hasPendingInviteCode: boolean;
  draft: OnboardingDraft | null;
  billing?: {
    familyId: string;
    isOwner: boolean;
    hasWriteAccess: boolean;
    hasEverHadAccess: boolean;
    trialEligible: boolean;
  } | null;
  intent: 'owner' | 'join' | 'login';
}): PostAuthDestination
```

Cover the spec's Returning-users table, including the edge case it calls out explicitly: a returning owner who habit-tapped "Start your family's journal", captured a memory, and must land in their existing journal with that memory saved to it — never in a second family or a paywall. The one intentional exception is an authenticated S15 draft explicitly marked with `step: 'paywall'` and its paywall mode; that marker is a resume hint while billing is unavailable, but loaded server billing can correct stale device state. The front door also reads the resolved owner's billing status: a family owner with no store history and no write access gets the first-time trial variant, while an owner with prior store history gets the no-trial resubscribe variant; joiners and owners with write access go to the journal. If S12B reaches an existing family with a capture that cannot be written, it preserves the capture and routes to that same billing-selected variant; after purchase, S15 commits the pending capture before continuing.

### 0.8 `src/lib/onboarding-routes.ts`

`Href` constants for every onboarding route, mirroring `src/lib/routes.ts` conventions.

### 0.9 Widen `CreateFamilyMemberInput.dateOfBirth` to `string | null`

In `src/utils/family-members.ts`. `createFamilyMember` in `src/services/family-members.ts` already writes it straight through to a nullable column. Existing callers pass a validated string and are unaffected; confirm `npm run typecheck` is clean across all call sites.

### WP0 tests

`src/utils/onboarding-copy.test.ts`, `src/utils/onboarding-progress.test.ts`, `src/lib/onboarding-routing.test.ts`, `src/components/onboarding/onb-illustration.test.tsx` (falls back to the wash when no asset; label comes from the slot).

---

## WP-SEC — Anonymous authorization lockdown (mandatory, gates go-live)

Anonymous users receive the normal `authenticated` database role. Until every item here is done and proven, `enable_anonymous_sign_ins` must stay `false` — and while it is `false`, S9 voice and J1–J5 cannot run at all. This is security work: the bar is "proven denied", not "probably fine".

Owns `supabase/**` only. Does not touch any `app/` or `src/` file.

1. **`handle_new_user` must not create normal profiles for anonymous Auth users.** An anonymous user must never acquire a `user_profiles` row that makes it look like a real tenant.
2. **Restrictive anonymous-deny RLS across normal application tables** — families, family_memberships, family_members, memories, memory_family_members, engagement, invites, portrait versions, and anything else a normal tenant touches. Use restrictive policies so they compose with (rather than depend on) the existing permissive family policies.
3. **Revoke default `PUBLIC` execute and add permanent-user guards to normal SECURITY DEFINER RPCs, starting with `create_family`.** Audit every definer RPC in `supabase/migrations/`; each one either rejects anonymous callers or is explicitly documented as anon-safe.
4. **Reject anonymous users from every normal Edge Function**, with exactly two carve-outs: `process-voice-memory`'s `mode: 'onboarding'` branch (already shipped), and the tightly scoped invite-preview endpoint below. The shared `getAuthenticatedUser` helper is the natural chokepoint — prefer one guarded helper over N per-function checks.
5. **Cleanup for abandoned anonymous Auth users.** Per usage-limits.md, deleting an anonymous user removes its live attempt counter and nulls raw-event actor attribution while onboarding cost rollups survive as company accounting data — do not break that.
6. **Tests proving the lockdown holds.** Direct PostgREST reads/writes, direct RPC calls, and direct Edge Function calls as an anonymous JWT must all be denied except the two carve-outs. Follow the existing `supabase/tests/*.sql` and Deno `*.test.ts` patterns.

**Invite-preview endpoint (J2's dependency).** Add the minimal function J2 needs: validates an anonymous JWT, takes a word-code, rate-limits by code, and returns **only** the family name and the inviter's display name. It must never leak membership lists, emails, the invite's role, or family ids. Deno tests required. Reuse the code shape helpers in `src/utils/invites.ts` semantics; do not invent a second code format.

**Only after 1–6 and the endpoint are done and tested:** flip `enable_anonymous_sign_ins = true` in `supabase/config.toml`, in the same change, with a comment pointing at this package.

Out of scope here (explicitly backlog per usage-limits.md): per-IP/per-device onboarding voice limits, CAPTCHA/Turnstile, fraud scoring.

## WP1 — Story arc (S0–S8)

Depends on WP0. Owns `app/(onboarding)/_layout.tsx` and the seven story screens.

- **`_layout.tsx`** — `Stack` with `headerShown: false`, wrapped in `OnboardingFlowProvider`. Renders a spinner until `isHydrated`. Does **not** own front-door redirects (WP5 does) — but if a real session exists and the draft is committed, redirect to the journal as a backstop.
- **S0 `welcome.tsx`** — 46%-height illustration with the `Momora.` wordmark overlaid at top-left (white, soft text shadow); headline `Save the funny little things, before your brain deletes them.`; three actions: primary → S1, secondary "I have an invite" → J1, tertiary text link "Log in" → `/(auth)/login`.
- **S1–S3 `story.tsx`** — one screen, `beat` search param `0|1|2`. 44% illustration, `OnbDots n=3`, headline + body, single affirmation CTA. Copy and CTAs exactly as the brief: `That's me` / `Who approved that homework` / `That's the stuff I want to keep`.
- **S4 `founders.tsx`** — 210×210 rotated `-2deg` portrait slot, Caveat caption `made by tired parents, for tired parents`, centered headline/body, CTA `Sounds familiar`.
- **S5 `artifact.tsx`** — three scattered sample memory cards (rotations `-8/9/-5`, offsets per the handoff), each an illustration wash + caption + mini footer (day label + emotion chip). CTA `Show me how it works`.
- **S6 `kids.tsx`** — the one high-value commitment screen. Big Newsreader input, autofocus, underline turns `colors.primary` when non-empty. `＋ Add another kiddo` converts the typed name into a deletable `KidChip` and clears the field. Continue accepts either the chips or a non-empty field (a parent who typed one name and never tapped add must not be blocked). Helper: `Nicknames welcome. No favorites here, add them all.` Writes `kidNames` to the draft.
- **S7 `family-name.tsx`** — prefilled from `defaultFamilyName(kidNames)`, editable, nest motif, headline switches on kid count. CTA `That's us`. Writes `familyName`.
- **S8 `bridge.tsx`** — Caveat accent `no blank pages here`, headline `You're not behind. There is no behind.`, body personalized on the first kid. CTA `Start with tonight` → S9.

**Keyboard:** S6 and S7 are `TextInput` screens. Both must keep field + CTA visible with the keyboard up on iOS *and* Android.

**Tests:** `src/screen-tests/onboarding.kids.integration.test.tsx` (add two kids, remove one, continue with an un-added typed name), `onboarding.family-name.integration.test.tsx` (prefill for 1/2/3 kids, edit persists to draft).

---

## WP2 — Capture → aha → account (S9–S12)

Depends on WP0. Owns the capture/aha/account screens plus the commit service.

- **S9 `capture.tsx`** — voice-first. Layout per the handoff: prompt in Newsreader, big pink mic with the pulsing radial halo, `Tap and talk` + Caveat `say it like you'd text your best friend`, secondary pills `I'd rather type` and `Add a photo or video`, reassurance line. States: `idle` → `recording` (soft waveform bars, **no countdown**) → `transcribing` → `typed`. Multi-kid families show selectable `KidChip`s above the prompt, first kid preselected, multi-select allowed; the prompt re-personalizes via `capturePrompt`.
  - Voice uses **`processOnboardingVoiceMemory(audioBase64, nameHints)`** per decision 7 — not `processVoiceMemory`, and not `useVoiceInput` as it now stands (that hook hard-requires a `familyId` and will refuse). Call `ensureAnonymousSession()` **before** recording starts so the call has an anonymous JWT. `nameHints` is the draft's kid names, trimmed, non-empty, capped at 6 and 50 chars each. The server returns `mentionedMemberIds: []` by contract, so **tagging comes from the locally selected kid chips** — carry that selection through the call untouched.
  - Recording/duration/permission mechanics can still be reused from `useVoiceInput`, but factor out what you need rather than passing a fake `familyId`. Do not weaken the family requirement on the normal path.
  - **Two attempts per anonymous account, and a failed attempt still burns one.** After the second, the server returns 429 `ONBOARDING_VOICE_LIMIT_REACHED` — fall back to typing with warm copy that never blames the user and never mentions quotas (usage-limits.md design principle 1: limits stay invisible). Handle `ONBOARDING_ANONYMOUS_REQUIRED`, `ONBOARDING_VOICE_RESERVATION_FAILED`, `ONBOARDING_VOICE_CLEANUP_RESERVATION_FAILED` and the existing audio errors the same way: degrade to typing, never dead-end, never crash.
  - Photo/video via `expo-image-picker`, same helper path as `src/components/memory-media-picker.tsx`. Store the local uri in the draft; the real upload happens post-auth in `commitOnboarding`.
  - Typed state: Newsreader textarea, bottom toolbar (`Talk instead`, `Add a photo`), `Keep this one` CTA. **Keyboard rule applies here hardest** — this is the screen the spec calls out by name.
- **S10 `aha.tsx`** — the value moment. Render the captured memory using the real card language from `src/components/memory-card.tsx` (quote treatment for text-only, media treatment when a photo was attached) rather than a bespoke card, so onboarding looks like the app it leads into. Eyebrow `That cost you about 20 seconds of your evening`, card settles in, then the like-heart pops with the same curve as the likes feature (`cubic-bezier(.34,1.56,.64,1)`, ~480ms, ~1.2s delay). Caveat `saved · {name}'s journal` bottom-right. Caption from `firstPageCaption`. CTA `Keep it going`.
- **S10b `year.tsx`** — self-scrolling mocked timeline: the user's real card anchored at the top, then illustrated / photo / video / one-line-quote example cards. Slow auto-scroll (~38s, alternating), masked top and bottom. No interaction required. Body `Talk, type, photos, video. All of it lands in {name}'s journal.` CTA `I could actually do this`.
  - Use `Animated`/Reanimated with a looping translate; respect `AccessibilityInfo.isReduceMotionEnabled()` and hold it still when reduce-motion is on.
- **S11 `notifications.tsx`** — four option cards with emotion-tinted glyph tiles. Selecting one of the first three writes `notificationChoice` and fires the OS prompt via `useNotificationsRegistration().requestRegistration()`; the fourth skips the prompt entirely with no penalty and no re-ask this session. Reassurance line about never sending "Don't forget…". The choice maps to `enableDailyReminder` + `notificationTime` (`20:00` / `22:00` / `08:00`) and is applied post-auth by `commitOnboarding`.
- **S12A `email.tsx` / S12B `code.tsx`** — headline `Let's put {name}'s first memory somewhere safe.` / `Check your inbox.`; 6 large code boxes with auto-advance. Reuse the hidden-input + boxes technique from `app/(auth)/verify-otp.tsx` rather than reinventing it. Before requesting the OTP, call `discardAnonymousSession()`. On success: run `commitOnboarding`, then route via `resolvePostAuthDestination`.
- **`src/services/onboarding.ts`** — `commitOnboarding(draft)`:
  1. If `draft.committedFamilyId` is set, skip to step 5 (idempotent across the OTP round trip and app kills).
  2. `createFamily(draft.familyName)`.
  3. Create one name-only `family_members` row per kid name, in entry order.
  4. Create the first memory with the captured text, today's date, tagged to the selected kids; media path enqueues through the existing pending-upload queue.
  5. Apply `notificationChoice` to the profile; `patchOnboardingDraft({ committedFamilyId })`.
  Return the created family id + memory id. Each step's failure must be recoverable — never leave a family with no kids because step 3 threw; surface an error and allow retry.

**Tests:** `src/screen-tests/onboarding.capture.integration.test.tsx` (typed path saves to draft; keyboard-open assertions in the spirit of `keyboard-aware-form-screen.test.tsx`), `onboarding.notifications.integration.test.tsx` (fourth option never calls `requestRegistration`), `src/services/onboarding.integration.test.ts` (idempotent re-commit creates nothing twice).

---

## WP3 — Trust → paywall → portrait (S13–S16)

Depends on WP0. No shared files with WP1/WP2/WP4.

- **S13 `trial.tsx`** — vertical timeline, three nodes (`Today` / `Day 5` / `Day 7`) with emotion-tinted circular icon tiles and a connecting rule. No prices on this screen. CTA `Sounds fair`.
- **S14 `included.tsx`** — four checklist rows, then **the promise as a signed card**: bordered, rotated `-0.6deg`, Caveat `our promise` tab breaking the top border, title `Your memories are always yours.`, body about free export even after cancelling, Caveat signature `Eduardo & Adriana`. CTA `Almost done`.
- **S15 `paywall.tsx` — live RevenueCat paywall.**
  - Renders the fanned backdrop illustration pages, annual default plan (`7 days free, then $99.99/year` / `That's $8.33/month` — from `docs/PRICING_STRATEGY.md`), optional monthly plan, four trust bullets, `Start my free week`, `Restore purchases · Terms · Privacy`, and quiet X.
  - X opens the close-confirm sheet: `Leave {name}'s first page here for now?` / `It'll be waiting if you come back.` with `Leave` / `Stay`.
  - Purchases and restores use the authenticated RevenueCat App User ID, then call `billing-reconcile` and require the `momora_plus` entitlement before continuing. Wrong-account restores fail explicitly; the close-sheet `Leave` signs out and returns to S0 without granting access.
  - Compliance shape matters even in the placeholder: trial terms in plain sight, no toggle tricks.
- **S16 `portrait.tsx`** — two states. `pick`: photo→portrait before/after cards, headline `Let's make {name}'s portrait.`, CTA `Choose a photo`, plus `The others get their turn next, promise.` when more than one kid exists. `painting`: pulsing framed illustration, Caveat `painting…`, `We're painting.` + the go-do-anything-else body, secondary `Take me to the journal`.
  - Wire the real pipeline: reuse the photo-picking helpers in `src/utils/family-profile-photo-picker.ts` (including the Android `getPendingResultAsync` recovery the add-family-member screen does) and `createPortraitVersion` from `src/services/portrait-versions.ts` against the child row created by `commitOnboarding`. Start with the kid tagged in the first memory, else the first-entered name.
  - Never block on completion — generation is async, the user leaves to the journal.

**Tests:** `src/screen-tests/onboarding.paywall.integration.test.tsx` (close sheet, package selection, purchase/restore and entitlement paths), `onboarding.portrait.integration.test.tsx` (picking a photo calls `createPortraitVersion` for the right member and transitions to `painting`).

**Extended by WP6:** S16's `painting` state above shipped purely decorative (the pulse never stopped, and a failed generation still said "We're painting." forever) — see WP6 below for the fix and for S17. WP6 also widened S16's target-member resolution: the tagged-kid-from-the-draft lookup above only ever worked in the brief window before S12B's `code.tsx` clears the draft, so it now falls back to real `useFamilyMembers()` data once the draft is empty.

---

## WP4 — Join path (J1–J5)

Depends on WP0. Owns `app/(onboarding)/join/*` and its own service module.

- **J1 `code.tsx`** — mono word-code input, prefilled from `getPendingInviteCode()` when a deep link left one. Body explains the `sunny-otter-lake` shape. CTA `Find my family`. Reuse `formatInviteCodeInput` / `isValidInviteCodeShape` / `normalizeInviteCode` from `src/utils/invites.ts` — do not re-derive the code format.
- **J2 `found.tsx`** — overlapping ringed member avatars, `Join the Rivera Family?`, `{inviter} invited you to see and share the family's memories.`, CTA `Yes, that's my family`, quiet `Wrong family? Re-enter code`.
  - Needs the family name **before** auth. `ensureAnonymousSession()`, then look the invite up through `src/services/onboarding-join.ts`'s `previewFamilyInvite(code)`. **The endpoint itself belongs to WP-SEC** (it is an anonymous-facing surface and ships with the lockdown) — WP4 owns only the client service wrapper and the screen. Coordinate on the response shape: family name + inviter display name, nothing else.
- **J3 `name.tsx`** — `What should the family call you?`, placeholder `Grandma Ana, Uncle Rob, Dad…`, helper about where it shows up, CTA `That's me`. Held device-locally (extend the draft or a small sibling store — implementer's call, but one home) because it must survive the OTP trip.
- **J4 `email.tsx`** — same OTP component as S12, reframed: `Last step, promise.` / `Email in, code back. No passwords, ever.` `discardAnonymousSession()` before requesting the code. Post-auth: apply the display name to the profile, then `redeemFamilyInvite(code)` through the existing service.
- **J5 `waiting.tsx`** — calm door-with-warm-light illustration, `One sec. {owner} just needs to wave you in.`, body, quiet `Give them a nudge`. Poll with the existing `useRedeemedInviteStatus` hook and reuse `app/(app)/sharing/waiting.tsx`'s approved/rejected/unavailable handling — that screen already solves a nasty membership-refetch race; read its comments before reimplementing anything.

**Zero selling on this path.** No story beats, no paywall, no notification pitch (spec decision 5).

**Tests:** `src/screen-tests/onboarding.join.integration.test.tsx` (code → found → name flow, invalid code surfaces an error and does not advance), plus Deno tests if the preview function is added.

---

## WP5 — Front-door rewiring + docs

Lands after WP1–WP4, because it points routes at screens that must already exist.

- **`app/index.tsx`** — no session → `/(onboarding)/welcome`. Session → `resolvePostAuthDestination`.
- **`app/(auth)/_layout.tsx`** — currently hard-redirects any session to the timeline, which would strand a user mid-onboarding. Route through the resolver instead.
- **`app/_layout.tsx`** — register the `(onboarding)` group.
- **`app/invite.tsx`** — a deep-linked invite with no session should land on J2 (code already stored) instead of bouncing through the authed redeem screen. With a session, keep today's behavior.
- **`app/(app)/_layout.tsx`** — the no-family guard must not fight a user who is mid-onboarding-commit. Verify the interaction; adjust only if it actually misfires.
- **Docs, in this same change:**
  - `docs/features/onboarding.md` — keep the completed S0–S17 flow, live paywall, lapsed-owner route, and paid-access hand-off documented alongside the remaining attribution-screen deferral.
  - `docs/features/README.md` — index row.
  - This plan — mark completed packages.

**Tests:** `src/lib/onboarding-routing.test.ts` grows to cover the front-door cases. Maestro: `.maestro/flows/onboarding/owner-happy-path.yaml` and `.maestro/flows/onboarding/join-happy-path.yaml`, following the existing flows' style in `.maestro/flows/sharing/`. Add `testID`s as you build, not afterwards.

---

## Risks

1. **Anonymous sign-ins must be enabled** in the Supabase project or S9's voice and J2's lookup fail at runtime. Both must degrade honestly: if `ensureAnonymousSession` fails, S9 falls back to typing with a plain message (never a crash, never a silent dead mic), and J2 asks the user to continue and confirm the family after signing in.
2. **The OTP round trip backgrounds the app.** The draft must be on disk before the mail app opens. Test an app kill between S12A and S12B.
3. **Commit partial failure.** A family created with no kids, or kids with no first memory, is worse than a clean error. `commitOnboarding` must be idempotent and resumable.
4. **Multi-kid copy.** Every downstream headline has a single-kid and a multi-kid form. Getting `{name}` wrong on the aha screen is the most visible possible bug in this flow.
5. **Keyboard regressions** on S6, S7, S9, S12, J1, J3 — six typed screens, the project's most-regressed area.
6. **The auto-scrolling S10b** must not spin a timer forever if the user backgrounds the app, and must hold still under reduce-motion.

## Execution log

### WP0 — done (2026-07-27)

Landed as specified, sections 0.1–0.9 plus tests. 55 onboarding tests pass; project-wide `npm test` 1011 passed, `npm run typecheck` clean (Node 20). Two review fixes were applied before the package was accepted:

- `PostAuthDestination`'s third kind is **`finish-join`**, not `join-waiting`. A stored invite code with no membership covers two device states the resolver cannot distinguish — a code stored by `app/invite.tsx`/J1 that was never redeemed, and a redeemed invite awaiting owner approval. The consuming screen resolves which by checking `useRedeemedInviteStatus`. WP4 and WP5 must both handle both.
- `capturePrompt` falls back to the neutral `What's something small from this week that made you smile?` whenever the resolved name is blank.

Two plan defects WP0 surfaced, both resolved in its favor: §0.6's prose and code block disagreed on `discardAnonymousSession`'s signature (`Promise<void>` is correct — a failed discard cannot matter, the real OTP session supersedes it), and the s-ending possessive rule is now applied uniformly by a shared `possessive()` helper rather than only to the family name.

### Blocked before WP1–WP4 fan-out

A concurrent, uncommitted change in this repo (the usage-limits / AI-cost work: `20260727120000_ai_usage_limits.sql`, `cloudflare/memory-illustration-worker/*`, three `supabase/functions/*`) rewrote `process-voice-memory` to:

1. resolve a `familyId` from `active_family_id` or the caller's sole membership, returning `409 FAMILY_CONTEXT_REQUIRED` when it can't, then `403` unless the caller holds a role in that family; and
2. **stop trusting client-supplied `familyMembers`**, reading the roster server-side instead — deliberately, since that field let a caller aim a transcript at an arbitrary household.

An anonymous pre-auth user has neither a family nor a membership, so **WP2's S9 voice capture cannot call that function**, and this plan's "send synthetic kid ids for name-aware transcription" approach now works against that change's security intent rather than merely being unsupported.

**Unaffected:** J2's invite preview (needs a JWT, not a family) still works over the anonymous session, and S16's portrait kickoff runs after `commitOnboarding` creates the family, so the new image-generation admission control sees a real family.

### Resolved (2026-07-29) — pre-auth voice is Momora onboarding cost

The usage-limits owner extended the ledger with an `onboarding` attribution scope and shipped a discriminated `mode: 'onboarding'` branch on `process-voice-memory`, plus the `processOnboardingVoiceMemory` client function. Pre-auth voice is now supported and honestly accounted for as company COGS rather than family cost. See decision 7 for the client contract; TECH_SPEC.md and usage-limits.md are canonical.

Two consequences folded into this plan:

- The blanket "no DB writes under the anonymous session" line was wrong and is now **"no anonymous client/tenant writes"** — the server does create private admission and cost-ledger records on its own behalf.
- **WP-SEC was added and is mandatory.** Anonymous users get the normal `authenticated` role, and review found existing paths (notably the `create_family` SECURITY DEFINER function) that would let an anonymous user create real families and reach paid AI functionality. `enable_anonymous_sign_ins` stays `false` until that lockdown lands and is proven by test. Because both S9 voice and J1–J5 depend on anonymous sessions, WP-SEC gates go-live for the whole flow — WP1 and WP3 are the only packages that never touch it.

### WP1 — done

Story arc (S0–S8) landed: `app/(onboarding)/_layout.tsx`, `welcome.tsx`, `story.tsx` (S1–S3), `founders.tsx`, `artifact.tsx`, `kids.tsx`, `family-name.tsx`, `bridge.tsx`. Reviewed and accepted before WP2–WP4 fan-out.

### WP2 — done

Capture → aha → account (S9–S12) landed: `capture.tsx`, `aha.tsx`, `year.tsx`, `notifications.tsx`, `email.tsx`, `code.tsx`, plus `src/services/onboarding.ts` (`commitOnboarding`). Ships against the resolved pre-auth-voice contract above (`processOnboardingVoiceMemory`). Reviewed and accepted.

### WP3 — done

Trust → paywall → portrait (S13–S16) landed: `trial.tsx`, `included.tsx`, `paywall.tsx` (RevenueCat purchase/restore with server entitlement verification), `portrait.tsx` (real photo pick + `createPortraitVersion` against the child row `commitOnboarding` created). Reviewed and accepted.

### WP4 — done

Join path (J1–J5) landed under `app/(onboarding)/join/*` plus `src/services/onboarding-join.ts`. Depends on WP-SEC's invite-preview endpoint for J2, which shipped alongside the anonymous-authorization lockdown. Reviewed and accepted.

### WP5 — done (2026-07-29)

Front-door rewiring + docs, landed as specified:

- `app/index.tsx` — no session → `/(onboarding)/welcome`; session → `resolvePostAuthDestination` (`intent: 'login'`, since a cold launch/relaunch is never a fork-button tap). Loaded owner billing state selects the paywall variant; an explicit S15 paywall marker is used as a fallback while billing is unavailable.
- `app/(auth)/_layout.tsx` — the hard "any session → timeline" redirect (which would have stranded a user mid-onboarding) is now the same `resolvePostAuthDestination` routing.
- `app/_layout.tsx` — registered the `(onboarding)` group alongside `(auth)`/`(app)`.
- `app/invite.tsx` — a deep-linked invite with no session now lands on J2 (`onboardingJoinFoundRoute`) instead of the old signup screen; the already-authenticated branch (→ `sharing/redeem`) is unchanged.
- `app/(app)/_layout.tsx` — **one real defect found and fixed.** `commitOnboarding` (WP2) creates a brand-new family through direct service calls, not a query-invalidating mutation, and none of S13–S16 (WP3) ever calls `refetchMemberships()` before handing off to the journal (`portrait.tsx`'s "Take me to the journal" replaces straight to `timelineRoute`). `FamilyProvider`'s cached membership list can therefore still read empty when a brand-new owner reaches `(app)` — nothing refetches it mid-session (no AppState/focus event fires; `refetchOnWindowFocus` never triggers without one), so the no-family guard would misfire and bounce a genuinely-just-onboarded owner to `no-family.tsx`. Fixed with a one-shot confirming refetch in the guard itself before it trusts an empty result: this closes the race for every code path that can land in `(app)` with a stale cache, not only onboarding's, without weakening the guard for a real zero-family account. Not a speculative refactor — verified via code tracing (no invalidation of `familyMembershipsQueryKey` exists anywhere in the onboarding commit path) before changing anything, per this package's brief.
- `src/lib/onboarding-routing.test.ts` extended with front-door-specific cases (the exact `intent: 'login'` call shape both front-door files use).
- `.maestro/flows/onboarding/owner-happy-path.yaml` and `join-happy-path.yaml` authored (not executed — no device available). See each file's header comment for documented gaps (OTP retrieval, S16's missing dev photo-fixture shortcut, rerun-idempotency).
- Docs: this file, `docs/features/onboarding.md` (status flipped to `done`, Architecture/Data model/Client integration/Testing filled in, four implementation decisions recorded, "Not yet shipped" list added), `docs/features/README.md` index row.

### WP6 — done (2026-07-30)

Follow-up package closing three owner-decided gaps after WP0–WP5 review:

- **S12A `email.tsx`** — added a "Your name" field above the email input (register/placeholder style borrowed from J3's `join/name.tsx`, its own headline left untouched), threaded through to `requestSignUpOtp({ name, email })` (previously always called with `name: ''`, leaving every owner's `user_profiles.name` blank). Both fields must be non-empty before "Send my code" enables. **Safety net:** `app/(app)/sharing/members.tsx`'s bare `profile.name` usages (row label, role-change/removal alert copy, the action-sheet header) now fall back to `'This family member'` via a small `memberDisplayName` helper, for any account whose name is still blank.
- **S16 `portrait.tsx`** — `painting` now reads the real status via `usePortraitVersions` (which already polls, `shouldPollPortraitVersions`) instead of a purely decorative `PulsingFrame`: `ready` hands off to S17's reveal; `failed` shows a warm, no-blame retry state (reusing `getPortraitStatusLabel`/`isPortraitInProgress` from `src/utils/family-members.ts`) instead of pulsing forever; the "Take me to the journal" escape stays available in every sub-state. Also **fixed a real defect found while wiring this**: the screen's target-member resolution only ever worked in the brief window before `code.tsx`'s `finishAfterCommit` clears the onboarding draft (`clear()` runs before routing into S13–S16 so the layout's `committedFamilyId` backstop doesn't trap that arc) — by the time S16 normally renders, `draft.kidNames` is already `[]`, so the original "match the tagged/first-entered draft name against a member" resolution silently failed and the "Choose a photo" CTA stayed disabled forever. `resolveTargetMember` now falls back to real `useFamilyMembers()` data (the first member with zero portrait versions ever created — `hasNoPortraitYet`, moved to `src/utils/family-members.ts` so S17 can share the identical definition), which — because `fetchFamilyMembers` sorts by tag count first — still surfaces the kid tagged on the first memory ahead of untagged siblings for free. The screen also now accepts an optional `memberId` search param for S17's sibling chain, keeping the above as the default when no param is passed.
- **S17 `reveal.tsx`** (new) — full-screen reveal of the real finished portrait (`useMediaUrl` + `expo-image`, same as `memory-card.tsx`'s `IllustrationVisual` and `portrait-timeline.tsx`), "Meet {name}." copy, the settle-then-heart-pop animation reusing `memory-engagement-bar.tsx`'s real composition exactly as `aha.tsx` does (not a bezier approximation), respecting `AccessibilityInfo.isReduceMotionEnabled()`. Sibling chain CTA re-enters S16 for the next unpainted kid (`onboardingPortraitRouteForMember`); "Later" and the no-siblings-left CTA both exist. Registered in `app/(onboarding)/_layout.tsx`'s Stack; **deliberately not added to `OnboardingStepId`/`onboardingStepRoute`** — see that function's doc comment (`src/lib/onboarding-routes.ts`) for why a bare step id can't express "which member," and why it's unreachable via the resume path in practice anyway (S17 only ever fires after a family already exists, and `resolvePostAuthDestination` only returns `resume-onboarding` when it doesn't).
- **`CastWaitingState` confirmed dropped, not built** — owner decision: the design brief's unpainted-kid "waiting to be painted" family-tab card is redundant with the existing family tab (`app/(app)/(tabs)/family.tsx`), which already renders every member as a `CastCard` regardless of portrait status and already invites a photo via its own subtitle ("Edit their photo to redraw it."). "Later" on S17 navigates straight to that tab — added as `familyRosterRoute` to `src/lib/routes.ts` (no route constant existed for it before). **Verified working for a name-only kid** (no photo, no DOB, as `commitOnboarding` creates them): family tab → member detail → portrait-timeline "+"-add-a-portrait flow → photo picker → date sheet (defaults to today) → `createPortraitVersion` with `dateOfBirth: null` — no DOB gate anywhere on that path (unlike `family/[id]/edit.tsx`'s info form, which does require one; that screen was not the mechanism this decision relies on).
- Tests: `src/screen-tests/onboarding.email.integration.test.tsx` (new), `src/screen-tests/onboarding.portrait.integration.test.tsx` (extended: ready → reveal navigation, failed → retry), `src/screen-tests/onboarding.reveal.integration.test.tsx` (new: both CTA branches, the in-progress-doesn't-count-as-unpainted case, the unresolvable-memberId bounce), `src/screen-tests/sharing.members.test.tsx` (extended: blank-name fallback in both the row label and the removal confirm copy).
- `.maestro/flows/onboarding/owner-happy-path.yaml` updated for the new S12A name field (still not executed — no device available while authoring, same as WP5).
- Docs: this file, `docs/features/onboarding.md` (S17 moved from "Not yet shipped" to shipped, `CastWaitingState` recorded as a deliberate drop rather than a deferral, S12A/S16/S17 added to Client integration + Testing + Changelog).

### WP7-A — done (2026-07-30)

Closed the testing blind spot behind WP6's S16 fix: `code.tsx`'s `finishAfterCommit` calls `clear()` on the onboarding draft *before* routing into S13–S16 (deliberately, so the layout's `committedFamilyId` backstop doesn't trap that arc), so every screen from S13 onward renders in the real app against a genuinely empty draft — a state no existing onboarding screen test ever exercised, because they all mock `useOnboardingFlow()` with a hand-populated draft. That gap had already let one bug ship (WP6's S16 fix) and a second one go unnoticed:

- **S14 `included.tsx` and S15 `paywall.tsx` fixed** — both carried an identical local `resolveKidPossessive(draft)` that only ever read `draft.kidNames`/`draft.capture.taggedKidIndexes`. Post-clear, both silently collapsed to the neutral "their" phrasing on every real device, losing personalization on the trust and paywall screens (spec decision 8: personalization is the persuasion mechanism on exactly these two screens). Factored into one shared hook, `useOnboardingKidPossessive()` (`src/hooks/use-onboarding-kid-possessive.ts`, new — needs `useFamilyMembers()`, so it can't live in the pure `onboarding-copy.ts`): draft first (unchanged behavior for the pre-commit/test path), then real `useFamilyMembers()` data once the draft is empty (`members[0]` from `fetchFamilyMembers`'s tag-count sort — the same fallback WP6 established for S16's `resolveTargetMember`, reused rather than re-derived), then "their" as the last resort. See `docs/features/onboarding.md` implementation decision 8 for the full priority order and its one known simplification (two kids tied at one tag each can't be distinguished from a single tagged kid once the draft is empty).
- **Membership-freshness assumption verified, not just assumed** — `code.tsx` awaits `queryClient.invalidateQueries({ queryKey: familyMembershipsQueryKey })` before `clear()`/routing; confirmed by test that `useFamily()`'s `familyId` is already correct by the time that resolves (`FamilyProvider` is mounted at the app root, so its membership query is always an active observer). Caveat: `useFamilyMembers()`/`usePortraitVersions()` still run their own first fetch the first time a screen mounts with a real `familyId` (no pre-commit cache entry), so S14–S17 can flash the neutral/loading fallback for one fetch cycle — same tolerance WP6's S16 already built in.
- **New test, the actual point of this package**: `src/screen-tests/onboarding.post-commit-real-data.integration.test.tsx` drives the real `OnboardingFlowProvider`/`FamilyProvider`/`useFamilyMembers()`/`usePortraitVersions()`/`useMediaUrl()` (mocked only at the Supabase-backed service boundary, plus the established `useAuth`/`useMemoriesRealtime` mocking boundary) through the actual sequence: seed a populated draft → real `commitOnboarding` → the same membership invalidation `code.tsx` awaits → real `clear()` → render S13→S17 against the now-empty draft. Asserts S14/S15 render the real kid's name (not the neutral fallback) and S16's CTA is enabled and resolves the correct member, all against server data. Deliberately does not mock `useOnboardingFlow`/`useFamilyMembers` — doing so is exactly what hid this bug.
- **S14 also gained its first-ever screen test** (`onboarding.included.integration.test.tsx`) — there was none before this package, unlike every other owner-path screen.
- **A separate defect found while building this coverage, fixed in the same package (coordinator review pulled it into scope rather than deferring it)**: S16's `resolveTargetMember` wasn't pinned once generation starts. For a multi-kid family's first portrait (no explicit `memberId` param), the moment the chosen kid's portrait version landed in the shared `portrait-versions`/`family-members` cache (which the create-version mutation's own `invalidatePortraitConsumers` triggers), that kid's `hasNoPortraitYet` flipped to `false` and the `useMemo`-derived target would silently shift to an untouched sibling mid-flight — the common path through the sibling chain, so the first multi-kid owner's very first portrait either never resolved or revealed the wrong child. **Fixed**: `resolveTargetMember` takes a `pinnedMemberId` parameter (checked right after the explicit `memberId` param, ahead of the ambiguous `hasNoPortraitYet` search); `PortraitScreen` pins the first target it resolves absent an explicit param, and clears the pin whenever a new explicit param arrives (S17's sibling chain always wins). `usePortraitVersions`, the ready-effect's reveal navigation, and `retryVersion` all inherit stability from keying off `targetMember`, which now holds once pinned. Confirmed via a real (unmocked) reproduction while building the S16 coverage below; invisible to the existing mocked-hook portrait test since its `useFamilyMembers` mock never changes mid-test. Regression test (`onboarding.post-commit-real-data.integration.test.tsx`, extended) verified to fail without the pin before it was restored. See `docs/features/onboarding.md` implementation decision 10.
- Docs: this file, `docs/features/onboarding.md` (implementation decisions 8–10, Client integration hooks row, Testing section, Changelog).

## Follow-ups (not this pass)

- Attribution screen (spec six-jobs table).
- Per-family display names (schema change) if the join path's global-name divergence proves wrong.
- Real illustration assets into `src/constants/onboarding-illustrations.ts`.
