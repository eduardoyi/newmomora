# Voice family setup ("Meet your family") + post-import family invite

## Goal

After purchase, right after the last portrait reveal, a brand-new owner can have a
short live voice conversation with "Momora" (GPT-Live 1, female voice) that fills in
the family: names (with spelling checks), nicknames, birthdays and relationships/
sides. Momora only proposes; the parent reviews and confirms, then adds a photo per
person (portraits start painting). Offered once, during onboarding only. Separately,
a one-time family-invite prompt appears after the parent approves their first
gallery-imported memories or dismisses the timeline's gallery-import card. Ships in
store build 1.4.4 behind a remote kill switch.

## Context

Decisions already made by the owner (memory: `project_voice_family_setup.md`):

- **Model:** OpenAI GPT-Live 1 only (no Gemini). $0.05/min voice, billed per second, plus backend model tokens.
- **Who and when:** owners only. Placed after the LAST portrait reveal (S17), before the gallery-import offer (S18).
- **Offered once:** never offered again after onboarding. If skipped, people are added manually. A dropped connection or crash does not burn the chance: cards persist and the parent can resume until they finish or skip. Tapping "Take me to the journal" while a portrait is still painting counts as a skip.
- **Proposes, never writes:** the AI only proposes. Nothing is written until the parent confirms a review screen, preserving the rule in `docs/features/family-relationships.md` that "the AI never writes a person's details on its own".
- **Scope of the conversation:** as many people as the parent wants. Invites are NOT part of the voice step.
- **Limits:** about 8 minutes per session, one reconnect, then a graceful wrap-up.
- **App brief:** Momora carries a detailed, versioned brief of the app so she can answer feature questions. Billing, prices and cancelling go to Settings → Subscription; export goes to Settings → Account → "Export your memories". She steers back from off-topic requests and can't look anything up.
- **Photos:** asked for every person. Children and parents are pushed for; second-degree relatives and beyond (grandparents, aunts/uncles, cousins…) get a "Later" option.
- **Adult birthdays without a year:** stored as month and day (option a), invisible to the user: one birthday field, with the year optional for adults.
- **Invite trigger:** the invite prompt fires after the first *approved* gallery-import memories, or when the timeline import card is dismissed.

Spike learnings (branch `spike/gpt-live`, worktree `~/Coding/Momora2-spike-gpt-live`; never merged):

- **Native module and timing:** `react-native-webrtc@124.0.8`, `@config-plugins/react-native-webrtc@15.0.2` and `react-native-incall-manager@4.3.0` build on Expo SDK 56 / RN 0.85 (Android verified; iOS untested). Connect takes about 2–3 s. Tool calls reach the app about 1–2.6 s after delegation.
- **API — session creation:** the server POSTs `https://api.openai.com/v1/live/sessions` with this body and gets an SDP answer back (unified interface; no ephemeral key ships):
  - `session.model`: `gpt-live-1`
  - `session.instructions`
  - `session.audio.output.voice`: `marin`
  - `session.delegation`: `{type:'responses', responses:{model:'gpt-5.5', reasoning:{effort:'low'}, text:{verbosity:'low'}, tools, tool_choice:'auto', parallel_tool_calls:true}}`
  - `transport`: `{type:'webrtc', sdp}`
- **API — events:** everything runs over the data channel `oai-events`.
  - Function calls arrive as `response.event` → nested `response.output_item.done` with `item.type === 'function_call'`.
  - The client replies with `response.item.create` (`function_call_output`), then `response.create` when the nested `response.completed` arrives.
  - `session.thinking.append` (quiet) and `session.commentary.append` (spoken) each cap `content` at **500 tokens**.
  - `session.usage.updated` and `session.closed` (with `reason`) report seconds used.
  - `instructions` are immutable after start.
- **Behaviour that worked:**
  - the app sends the spoken opener itself via `session.commentary.append`;
  - known people are passed as binding facts;
  - a compact, app-computed checklist (only missing items) goes out after each card change, de-duplicated;
  - obvious relationships are inferred rather than asked;
  - birthdays: kids are asked their age, then the birthday (year computed); adults need month/day, year optional;
  - tap-to-fix on the card is the main spelling path;
  - a strict scope guardrail.
- **Gotcha:** native WebRTC connections survive a JS reload or screen remount. An orphaned session kept talking and billing. Sessions must close on unmount and on background, and the server must enforce a cap.

Codebase facts the plan relies on:

- **Onboarding flow:**
  - S16 `app/(onboarding)/portrait.tsx`: `goToJournal` at line ~475 is "Take me to the journal" and only does `router.replace(timelineRoute)`. `ensureOwnerFamilyPerson` is a separate fire-and-forget mount effect (~285–295) that can silently skip (`no_name`, `already_set`, `create_failed`), so the owner's person may not exist.
  - S17 `app/(onboarding)/reveal.tsx`: `handleDone` → `onboardingImportOfferRoute` when `isGalleryImportFeatureEnabled`, else `timelineRoute`.
  - S18 `app/(onboarding)/import-offer.tsx`.
  - Routes and the after-auth allow-list live in `src/lib/onboarding-routes.ts` (`POST_AUTH_ONBOARDING_PATHNAMES`, `onboardingAnalyticsStepFromPathname`). The layout is `app/(onboarding)/_layout.tsx`.
- **`family_members` columns:** `name`, `nicknames text[]`, `date_of_birth date null`, `relationship` (`child|parent|grandparent|great_grandparent|aunt_uncle|cousin|family_friend|caregiver|pet|other`), `family_side` (`maternal|paternal|both`), `side_member_id` (FK to a member in the same family; `SIDE_ROLES = grandparent, great_grandparent, aunt_uncle, cousin`), `user_id`, `is_user_profile`, portrait keys/status.
- **Family member writes:** `createFamilyMember` / `updateFamilyMember` / `updateFamilyMemberWithPhoto` (`src/services/family-members.ts`). `useFamilyMembers().updateMember` with `photoUri` starts a portrait version. RLS: inserts and updates require owner/manager plus billing write. `ensureOwnerFamilyPerson` (`src/services/family-relationships.ts`) creates the owner's `parent` person at S16.
- **`isFamilyMemberProfileIncomplete`** (`src/utils/family-members.ts`) flags `!date_of_birth || !photo`. `add-family-member.tsx` and `family/[id]/edit.tsx` require DOB via `DatePickerField` + `validateDateOfBirth`.
- **Edge function conventions** (e.g. `supabase/functions/suggest-family-relationships/index.ts`):
  - `handleCors`, `getAuthenticatedNonAnonymousUser` (`_shared/auth.ts:68`), `createServiceClient`, `getCallerFamilyRole`;
  - `checkBillingFamilyWrite(service, familyId, userId, reason)` from `_shared/billing.ts`;
  - `serveWithSentry`;
  - injectable dependencies for Deno tests.

  AI cost is recorded through the `record_ai_usage_event_detailed` RPC (see `_shared/openai.ts` `recordUsage`). The `ai_usage_events_operation_check` constraint was last redefined in `20260929120000_year_films.sql`.
- **Kill-switch pattern:** single-row service-only settings, like `year_film_settings` (`mode off|canary|all`, `canary_family_ids`).
- **OTA reach:** over-the-air updates reach older binaries (1.4.3/1.4.2) that lack new native modules. `src/lib/sentry.ts` guards a native module with `TurboModuleRegistry.get(...) ?? NativeModules.X` and a lazy `require`. `react-native-webrtc` reads `NativeModules.WebRTCModule` at import time.
- **Gallery import:**
  - An approved candidate is finalized by `finalizeGalleryImportCandidate` (`src/components/gallery-import/gallery-import-approval.tsx`) and becomes a memory with `creation_source = 'gallery_import'`.
  - The timeline import card is `TimelineGalleryImportInvite` in `app/(app)/(tabs)/timeline.tsx`; `handleDismiss` → `dismissGalleryImportInvite`.
- **Invites for a person:** `sharingInviteForMemberRoute(memberId)` in `src/lib/routes.ts` preselects the invitee on `app/(app)/sharing/invite.tsx`. `isInviteTargetEligible` lives in `src/utils/family-relationships.ts`.

## Steps

### Phase 0 — verify before building (blocking)

1. **Confirm GPT-Live server-side controls.** Using the spike server, check each of these and record the answers in the plan:
   - whether `session` accepts a max duration / expiry setting;
   - what `session.started.expires_at` defaults to;
   - whether the sideband attach WebSocket (`/v1/live/sessions/{id}/attach`, which Foundry documents) works on api.openai.com with a server key, and accepts `session.close`;
   - how to read final usage for a session the server didn't close itself.

   The answers decide Step 6's guard design.
2. **iOS spike build.** Make an iOS `development-device` build from the spike branch and test it on an iPhone:
   - audio routing to the speaker (`InCallManager.setForceSpeakerphoneOn`);
   - interplay with `expo-audio` (voice capture at S9 sets `setAudioModeAsync({allowsRecording:true})`);
   - interruptions (phone call, Siri);
   - backgrounding;
   - Bluetooth headphones;
   - **backgrounding on iOS:** with no `UIBackgroundModes: audio`, JS timers freeze within seconds, and the peer likely stops answering ICE consent checks. Measure what happens to the session (does OpenAI close it as `connection_lost`, and how fast?), and decide whether to add the `audio` background mode (Apple scrutinizes it) or accept that iOS backgrounding ends the session. Either way, the client's grace and cap timers are a UX nicety; cost is bounded only by the server.

   Fix the audio-session handling in the spike before Phase 4.

### Phase 0b — fix: adults without a full birth date are painted as young children (ships first, independently)

2b. **Use the role when there's no full birth date.** `generate-portrait-illustration/index.ts:197-202` and `_shared/illustration-references.ts:37-39` describe a null-DOB person as `'young child'` (`isAdult = false` → `CHILD_IDENTITY_BLOCK`). This bug is **already live**: the owner's own person (`ensureOwnerFamilyPerson`, no DOB since 2026-10-02) would be painted as a child if given a photo. This plan makes null-DOB adults common, through year-less birthdays and "not sure" answers.
    - Pass `relationship` into both prompt builders. When DOB is null:
      - `parent` / `aunt_uncle` / `caregiver` / `family_friend` → "adult";
      - `grandparent` / `great_grandparent` → "older adult";
      - `cousin` / `other` → "person" (neutral);
      - `pet` → an animal description;
      - `child` / unsorted → today's behaviour.
    - Add Deno tests and an `npm run eval:illustration` pass.
    - Ship it as an edge-function deploy on its own, before this feature.

### Phase 1 — schema (one migration + types + TECH_SPEC)

3. **Migration `supabase/migrations/20261005120000_voice_family_setup.sql`:**
   - **`family_members` birthdays:**
     - Add `birth_month smallint null check (1..12)` and `birth_day smallint null check (1..31)`, with a check that both are null or both are set, and a check that the month/day combination is a valid calendar day (allow Feb 29).
     - **Month/day are stored only for year-less birthdays.** A BEFORE INSERT/UPDATE normalize trigger (same pattern as `family_members_normalize_relationship`) nulls `birth_month` / `birth_day` whenever `new.date_of_birth` is non-null. Old bundles and binaries (1.4.0–1.4.3) that only ever send `date_of_birth` therefore keep working, and setting a full DOB on a year-less person just upgrades it. A check enforcing `date_of_birth is null or (birth_month is null and birth_day is null)` stays as a backstop. There's still no backfill: a backfill would UPDATE every row and fire `set_family_members_updated_at`, and `updated_at` is used as a portrait media cache version (`reveal.tsx` `portraitCacheVersion`), so a global bump would invalidate everyone's portrait caches.
     - **Reading:** a SQL function `family_member_birthday_md(dob, birth_month, birth_day)` returns month/day as `coalesce(extract(month from dob), birth_month)` etc. The app has a matching TS helper. Every consumer that needs "month and day" uses these.
     - **Three explicit states.** Services always send all three fields together whenever any birthday field changes:
       - **full:** `date_of_birth` set, month/day null;
       - **year-less:** `date_of_birth` null, month/day set;
       - **cleared:** all three null.
   - **`families`:** add `voice_setup_status text null check in ('offered','in_progress','completed','skipped')` and `voice_setup_status_at timestamptz`.
   - **`family_voice_settings`:** single-row, service-only table — `mode off|canary|percent|all` (default `off`), `canary_user_ids uuid[]`, `rollout_percent smallint 0..100`, `max_session_seconds int default 480`, `max_sessions_per_family int default 2`, `backend_model text default 'gpt-5.5'`, `voice text default 'marin'`, `updated_at`.
     - The canary is keyed on the owner's **email**, via `canary_email_patterns text[]` (e.g. `%+momoravoice@%`) checked against `auth.users.email`. Neither a family id nor a user id can be listed in advance for a fresh onboarding: both are created minutes before S17. Testers sign up with a `+momoravoice` address. `canary_user_ids uuid[]` stays as well, for existing test accounts.
     - `percent` uses a deterministic bucket: `abs(hashtext(user_id::text)) % 100 < rollout_percent`.
   - **`family_voice_sessions` ledger:** service-only RLS. Columns:
     - `id`;
     - `family_id uuid not null references families on delete cascade`;
     - `user_id uuid references auth.users on delete set null` (must never block account hard-deletion; same shape as `ai_usage_events`);
     - `openai_session_id`, `brief_version`;
     - `created_at`, `started_at` (client-reported `session.started`), `closed_at`;
     - `close_reason` (including `connect_failed`), `seconds int`;
     - `backend_input_tokens`, `backend_output_tokens`, `estimated_cost_usd numeric`;
     - `guard_status`.
   - **`ai_usage_events_operation_check`:** redefine it to add `'family_voice'`, copying the full current list from `20260929120000_year_films.sql`.
     - Also add `'family_voice'` to the TS `AiUsageOperation` union in `supabase/functions/_shared/openai.ts`.
     - Price constants for `gpt-live-1` ($0.05/min) and the backend model go in `supabase/functions/_shared/ai-pricing.ts`.
     - Ledger usage rows use `cost_basis = 'request_shape_estimate'` (the table also allows `provider_usage` and `unpriced`). The backend model in `family_voice_settings` must have an `ai-pricing.ts` entry, otherwise rows silently go `unpriced`; a Deno test asserts the default model is priced.
   - **RPC `get_family_voice_setup(p_family_id)`:** security definer. Returns `{available boolean, status, sessions_used, sessions_max, max_session_seconds}`. Available only when all of these hold:
     - the caller is the family owner and not anonymous;
     - the mode allows it (`all`; `canary` and the caller's email matches a pattern or their user id is listed; `percent` and the caller's bucket is below `rollout_percent`);
     - status is null, `offered` or `in_progress`;
     - counted sessions `< max` (see Step 6.3 for what counts);
     - `billing_write_allowed`.
   - **RPC `set_family_voice_setup_status(p_family_id, p_status)`:** security definer, owner only. Transitions are monotonic: once `completed` or `skipped`, the status is final. Allowed moves: null→offered→in_progress→completed|skipped, and null|offered→skipped.
   - **Grants:** revoke defaults, grant execute on both RPCs to `authenticated`.
4. **Types and spec:** regenerate `src/types/database.ts` cleanly (see the memory note about stray CLI output), and update `docs/TECH_SPEC.md` (schema, RPCs, the new edge function contract).
5. **pgTAP `supabase/tests/voice_family_setup.sql`:**
   - the birthday check constraint, the three states (full, year-less, cleared) and `family_member_birthday_md`;
   - `reserve_family_voice_session` under concurrency (two reservations, one wins), counted vs uncounted rows, the 5-row ceiling;
   - `finalize_family_voice_session` writes exactly one usage event, and is idempotent;
   - the canary email pattern;
   - availability for owner, manager, viewer, anonymous, lapsed owner, off mode, canary user, percent bucket;
   - monotonic status transitions;
   - service-only settings and ledger.

   Extend `supabase/tests/account_deletion_fences.sql`: a user with `family_voice_sessions` rows hard-deletes cleanly (set null), and family deletion cascades.

   Name the migration `20261005120000_voice_family_setup.sql` (it must sort after `20261001150000`).

### Phase 2 — server

6. **Edge function `supabase/functions/create-family-voice-session/index.ts`.** It takes `POST {familyId, sdp, localDate, locale, draftCards?}` and runs these steps (`locale` is the device locale, a hint for the language Momora opens in; she still follows the parent's language):
   1. Authenticate with `getAuthenticatedNonAnonymousUser`, then require the owner role and `checkBillingFamilyWrite(..., 'voice_family_setup')`.
   2. Load settings and check the mode.
   3. **Reserve the attempt atomically** with a definer RPC `reserve_family_voice_session(p_family_id, p_user_id)`. It takes `pg_advisory_xact_lock(hashtextextended(p_family_id::text, 0))`, following the precedent of `reserve_onboarding_voice_attempt` in `20260727120000_ai_usage_limits.sql` (~939–965). Under the lock it:
      - re-checks availability (mode, owner, status, billing);
      - closes this family's **stale** open rows (`closed_at is null` and older than `max_session_seconds + 60`) as `superseded`, and flags them for the sweep's sideband close (Step 6.7);
      - refuses `SESSION_ACTIVE` if a non-stale open row remains. The app shows "Momora is still finishing the last conversation, try again in a moment" and retries once after 10 s. On resume or reconnect, the client first calls `end-family-voice-session` for the draft's `lastSessionId`, so this normally never fires;
      - refuses `limit_reached` on the counted-session limit or the 5-row ceiling;
      - otherwise inserts the ledger row (status `reserved`) and returns its id.

      A partial unique index on `family_voice_sessions(family_id) where closed_at is null` backs this up. There is no `resume` flag. "Resume" just means calling again after the previous row closed; the client sends the draft cards (Step 6.5).
   4. **Build the roster server-side**, never from the client: `family_members` for the family (id, name, nicknames, relationship, family_side, side_member_id, DOB / month/day), plus the owner's linked person (via `family_memberships.family_member_id`) and the owner's profile name. The owner's person may not exist; then the owner is described by profile name only, and the commit (Step 15) creates and links it.
   5. **Draft cards on reconnect or resume.** `draftCards` from the client's AsyncStorage draft are validated and sanitized: names ≤ 50 characters, known enums only, at most 25 cards. They're injected into `instructions` as a non-binding "proposed so far in this conversation" section, so session 2 continues instead of re-asking. This is separate from the binding DB roster.
      - The parent's `localDate` (`YYYY-MM-DD` from the device) replaces server UTC for every date the model sees.
      - Then build the instructions from a versioned module `supabase/functions/_shared/family-voice-brief.ts`. It exports `FAMILY_VOICE_BRIEF_VERSION`, `buildFamilyVoiceInstructions(roster, ownerName, todayIso, locale)`, `FAMILY_VOICE_TOOLS` (the propose/update/remove schemas, ported from the spike with `birth_month/birth_day/birth_year/age_years`) and `buildBackendInstructions(todayIso)`.
   6. POST to OpenAI `/v1/live/sessions` with the `OPENAI_API_KEY` secret and a timeout. On 201, update the reserved row with `openai_session_id` and set the family status to `in_progress`. On failure, close the reserved row as `connect_failed` so it doesn't count.
      - **One definition of what counts as a session,** implemented only in SQL (a function `family_voice_session_counts(row)` used by both RPCs; the client only displays what the server says). A row counts when its seconds — authoritative if finalized, otherwise `max(provisional client seconds, wall-clock from started_at to closed_at or now)` — are ≥ 45 and its `close_reason` isn't `connect_failed`.
      - So failed connects, quick drops, and the short `background` / `ice_failed` closes iOS will produce (see Phase 0 Step 2) don't burn the parent's chance.
      - A hard ceiling of 5 rows per family, counted or not, stops abuse.
   7. **Start the guard.** This depends on what Phase 0 found:
      - **Preferred:** pass a server-side max duration if the API supports one.
      - **Next preference (simpler):** a `pg_cron` job every minute invokes a cron-secret edge function, `sweep-family-voice-sessions`. For every open row past `max_session_seconds` (or flagged `superseded`), it attaches the sideband briefly, sends `session.close`, reads `session.closed.usage`, and finalizes. That's one component, using the existing cron pattern (e.g. `cleanup-abandoned-anonymous-users`); use it if Phase 0 shows the sideband attach works from an edge function within its time limit.
      - **Only if an edge function can't hold the sideband:** a new Workflow class `FamilyVoiceGuardWorkflow` in the existing `cloudflare/memory-illustration-worker`. That worker already owns Workflows, the dispatch/bridge HMAC secrets and Sentry; a new worker would add a deploy target for one sleep-and-close job.
        - It `step.sleep`s `max_session_seconds + 30`, attaches the sideband, sends `session.close`, and reads `session.closed.usage`.
        - It reports through a new bridge edge function, `supabase/functions/workflow-family-voice-bridge/index.ts`, registered in `supabase/config.toml` with `verify_jwt = false` like `workflow-year-film-bridge` and HMAC-verified. The bridge updates the ledger and writes the usage event.
        - Config: add the Workflow binding and dispatch/bridge secrets to `wrangler.jsonc` (prod + staging), plus the matching Supabase secrets.
      - **Fail closed:** if guard dispatch fails after OpenAI returned 201, the function attaches the sideband itself, sends `session.close`, marks the ledger row `guard_failed`, and returns `503 VOICE_GUARD_UNAVAILABLE`. The app shows "Try again" and the attempt doesn't count.
      - **If Phase 0 finds no sideband at all,** the guard falls back to the session's own `expires_at` plus the client cap. That residual risk must be explicitly accepted before building.
   8. Return `{sdp, sessionId, maxSessionSeconds, briefVersion}`.

   Logs and Sentry carry no names or transcript (PII rule). Add Deno tests with injected dependencies covering auth, role, billing, mode, limits, the OpenAI error mapping, roster building, and the instruction-length budget.
7. **Edge function `supabase/functions/end-family-voice-session/index.ts`.** It takes `POST {familyId, sessionId, seconds, startedAt, closeReason}`.
   - Owner-only. It verifies the ledger row belongs to that family and user.
   - It stores only **provisional** values: client seconds (capped at `max_session_seconds`), `started_at`, `closed_at`, `close_reason`.
   - **Single source of truth.** `family_voice_sessions` is authoritative, and exactly one `ai_usage_events` row is written per session, by a definer RPC `finalize_family_voice_session(p_session_id, p_seconds, p_source)` under a row lock.
     - `record_ai_usage_event_detailed` does `on conflict (ai_call_id) do nothing` (`20260727120000_ai_usage_limits.sql` ~930), so whoever writes first wins. A second write would therefore be ignored or double-count.
     - **When the guard exists:** the client path never finalizes. The guard/bridge finalizes with authoritative `session.closed.usage.seconds`, using a deterministic `ai_call_id` = session id.
     - **Without a guard:** `end-family-voice-session` finalizes with `max(client seconds, wall-clock from started_at to now)`, capped, and `cost_basis 'request_shape_estimate'`. Under-reporting gains nothing, because wall-clock is the floor.
     - Rows never finalized after 1 h are swept by the existing `run-ai-usage-alerts` cadence, or a small cleanup, at wall-clock cost.
8. **Secrets and deploy.** `OPENAI_API_KEY` already exists for edge functions; guard secrets per Step 6.7.
   - **Deploy order:** migration → `create-family-voice-session` + `end-family-voice-session` + `workflow-family-voice-bridge` → the worker with `FamilyVoiceGuardWorkflow` → store build.
   - The owner pushes the migration and deploys. Everything ships with `mode = 'off'`.
   - Deno tests cover the bridge too: HMAC, idempotent finalize, and a missing family or ledger row (the family was hard-deleted while the Workflow slept) being a **terminal no-op**, never an infinite retry.

### Phase 3 — native + session client (app)

9. **Dependencies.** Add `react-native-webrtc`, `@config-plugins/react-native-webrtc` and `react-native-incall-manager` to `package.json` / `app.json`.
   - **Microphone purpose string.** The current one ("…to record voice memories, which are transcribed into journal entries", set by the expo-audio plugin) doesn't cover a live AI conversation (App Store 5.1.1 accuracy).
     - Write one string covering both uses, e.g. "Momora uses your microphone to record voice memories and, if you choose, to talk with Momora when setting up your family."
     - Set it in BOTH plugins, since both write `NSMicrophoneUsageDescription`.
   - **Android permissions.** The WebRTC plugin adds `CAMERA`, `SYSTEM_ALERT_WINDOW`, `WAKE_LOCK`, `BLUETOOTH` and `ACCESS_NETWORK_STATE`.
     - Add `android.permission.SYSTEM_ALERT_WINDOW` to `app.json` `android.blockedPermissions`: it's the Play-flagged "draw over apps" permission and audio doesn't need it.
     - Keep `CAMERA` only if the image picker's camera path already requires it, and verify whether headsets on Android 12+ need `BLUETOOTH_CONNECT`.
     - `react-native-webrtc`'s own manifest declares `MediaProjectionService` with `foregroundServiceType="mediaProjection"`, and `app.json` already blocks `FOREGROUND_SERVICE` permissions. Add a small config plugin (`plugins/with-remove-webrtc-media-projection.js`) that removes that `<service>` with `tools:node="remove"`; screen sharing isn't used.
     - **Plugin order:** the WebRTC plugin's `withPermissions` keeps an existing `NSMicrophoneUsageDescription`. Pin the order in `app.json` (expo-audio first, carrying the new string; WebRTC given the same string).
     - After a `npx expo prebuild --no-install` in a scratch copy, inspect the merged `AndroidManifest.xml` (permissions **and services**) and `Info.plist`. The camera string from expo-image-picker must survive.
10. **`src/lib/live-voice/availability.ts`.** `isLiveVoiceAvailable()` returns `TurboModuleRegistry.get('WebRTCModule') ?? NativeModules.WebRTCModule` != null (the same pattern as `src/lib/sentry.ts`). All `react-native-webrtc` / `incall-manager` imports live behind a lazy `require` inside the session client, so OTA bundles on 1.4.3/1.4.2 never import them.
11. **`src/lib/live-voice/session.ts`: `FamilyVoiceSession` class** (ported from the spike screen):
    - **Connect:** getUserMedia, then an `RTCPeerConnection` + `oai-events` channel, then the offer, waiting for ICE gathering (≤2.5 s), then the edge function, then `setRemoteDescription`.
    - **Event handling:** `session.started`, transcript deltas, `session.delegation.created`, `response.event` function calls → handler → `function_call_output`, plus `response.create` on nested `response.completed`; usage, close and error.
    - **Controls:** `mute()`, `sendQuietContext()` and `sendSpoken()` (each enforcing a ≤1,600-character cap), `end()`.
    - **Safety:**
      - single-instance guard (a module-level singleton: a second `start()` throws);
      - **On AppState background:** mute input (`session.input_audio.mute`) and start a 45 s grace timer. Returning within it unmutes and continues. After the grace period, `end()` with reason `background`. On iOS the timer may never fire (Phase 0 Step 2), so a session that dropped while backgrounded is reported on return as `ice_failed`. Short ones don't count (Step 6.3), so the parent can reconnect.
      - `end()` on the screen's unmount and from the client cap timer (`maxSessionSeconds`);
      - sessions that ended with < 20 s of conversation don't count toward the limit;
      - on `end()`, call `end-family-voice-session`;
      - InCallManager start and stop.
12. **`src/utils/voice-family-cards.ts`: pure, unit-tested card model.** Birthday handling:
    - The tool schema takes `age_years` + `birth_month` + `birth_day` from the model; any model-supplied `birth_year` is advisory only. The **app computes the year** from age and month/day using the device's local date, and rejects:
      - future dates;
      - impossible days;
      - ages that disagree with a stated year.
    - An infant ("zero", birthday later this year) resolves to last year.
    - Invalid values mark the card's birthday as "needs a check" instead of guessing.

    The card model's API: Card type; `applyToolCall(cards, name, args)` → `{cards, output}`; `missingFor(card)`; `buildChecklist(cards)` (compact, ≤1,600 chars, complete people collapsed); `buildOpener(cards, ownerFirstName)`; `cardsFromRoster(members, ownerMemberId)`. Duplicate guard: a propose whose name matches an existing card case-insensitively, with a compatible role, becomes an update.
13. **`src/utils/voice-family-draft.ts`: AsyncStorage draft** keyed by user+family (`momora.voiceFamilyDraft.{userId}.{familyId}`): cards, the last session id, a `committedIds` map for idempotent confirm. Cleared after a successful confirm, or on skip. Also cleared for the user on sign-out and account deletion, in the same path that clears per-user gallery checkpoints (`src/hooks/use-auth.tsx` ~134–137). It holds kids' names and birthdays.

### Phase 4 — onboarding screens

14. **Routes** under `app/(onboarding)/`, each registered in `_layout.tsx`, added to `POST_AUTH_ONBOARDING_PATHNAMES` and to `onboardingAnalyticsStepFromPathname` / `OnboardingAnalyticsStep`.
    - Talk, review and photos set `gestureEnabled: false`, so a back swipe can't return to an ended talk screen. Android's hardware back does the same as the screen's own exit.
    - Every screen with a `TextInput` (talk's tap-to-edit, the review fields) uses `OnbShell`'s keyboard handling and bottom-inset contract (CLAUDE.md high-risk area; AGENTS.md keyboard rules).
    - **`meet-family.tsx` (intro):**
      - Copy: "Let's meet the rest of the family". It explains the parent talks for a few minutes, Momora fills in names, birthdays and who's who, and the parent checks everything before it's saved.
      - The AI and privacy disclosure (Apple 5.1.2(i)): the conversation is processed by OpenAI and the audio isn't stored.
      - Microphone denied (a parent may have denied it at S9): show "Momora needs the microphone for this" with **Open Settings** and the manual path. Never a dead end.
      - Actions: **Start talking**, which requests the microphone; **I'll add them myself**, which sets `skipped`, clears the draft, then continues to S18 or the journal; no text-chat mode (decided 2026-10-05). Parents who won't talk use **I'll add them myself** and add people in the app as today. On a binary without the WebRTC module, the step isn't offered at all (Step 16).
      - It shows "This is a one-time offer".
    - **`meet-family-talk.tsx`:**
      - live cards (tap a name to edit, which sends quiet context), captions, Mute, "I'm done";
      - a calm "about N minutes left" hint at T-60s;
      - reconnect UI ("Reconnect", using the one extra session) when the connection drops;
      - "Continue to review" after `session.closed`.
    - **`meet-family-review.tsx`:**
      - Cards grouped like the Family tab (`groupByRelationship`), editable: name, nickname, role, side, and one `BirthdayField`. Removable.
      - "That's our family" → commit (Step 15) → status `completed` → photos.
      - "Start over" isn't offered; the parent edits instead.
    - **`meet-family-photos.tsx`:**
      - A grid of members without a portrait (`hasNoPortraitYet`).
      - Kids and parents are pushed for: no Later on the tile, and continuing shows "Add {name}'s photo?" once. Second-degree relatives and beyond get "Later".
      - Picking a photo calls `useFamilyMembers().updateMember({memberId, photoUri, photoContentType, photoReferenceDate, photoDateSource})`, which starts the portrait in the background. Tiles show painting / ready.
      - **Daily image cap.** Portraits and illustrations share 20 generations per family per day, retries included (`docs/features/usage-limits.md`), and an onboarding day already spends some. A large family can hit `USAGE_LIMIT_REACHED` (429) partway through the grid. Handle it per tile with warm, resumable copy ("We'll paint {name} tomorrow"), never a stuck "painting" tile. The cap is **not** raised for onboarding (decided 2026-10-05). The member keeps their photo. The tile says "We'll paint {name} tomorrow", and the parent can retry from the member's page in the Family tab.
      - This reverses the documented onboarding rule that adults are out of the trial sequence (`docs/features/onboarding.md`). Update that decision in the docs step.
      - Continue → S18 (`onboardingImportOfferRoute`) when gallery import is enabled, else the journal.
15. **`src/services/voice-family-commit.ts`:**
    - **Order:**
      1. `ensureOwnerFamilyPerson(familyId)` — idempotent; the owner's person may be missing (see Context).
      2. Create new `parent` cards.
      3. Resolve every `side_of` name to a `side_member_id`: a parent card created in step 2, an existing parent, or the owner person, matched by name. When unresolved, leave the side empty for Who's who.
      4. Update existing members.
      5. Create everyone else.
    - `updateFamilyMember` nulls `family_side` / `side_member_id` whenever `relationship` is sent without them, so every update or create that sends a role also sends its resolved side.
    - **Writes:**
      - Full birthdays → `date_of_birth`.
      - Year-less → `birth_month` / `birth_day` with a null DOB.
      - Nicknames go to `nicknames`.
    - **Idempotency without a crash window:** generate each new person's UUID client-side and persist it in the draft *before* inserting. Insert with that explicit `id` — verify the insert policy and `createFamilyMember` allow a client-supplied id; extend the service if not. A retry then hits a primary-key conflict (treated as done), never a duplicate.
    - **DOB vs portrait dates:** a DOB later than an existing portrait version's date raises `Date of birth cannot be after a portrait date` (23514, `20260715120000_portrait_timeline.sql`:411). By S17 every onboarding kid has a portrait.
      - Match on that **message text**, not the code. 23514 is also raised by `side_member_must_be_parent` (`20260928120000_family_relationships.sql`:91), the side checks, the new birthday checks and portrait-version checks.
      - Map each case to its own per-card inline copy (e.g. "That birthday is after {name}'s portrait photo date — check it?", or "{side} isn't a parent in the family — pick a side"), instead of failing the commit.
    - **Owner person:** commit step 1 and the S16 mount effect can race on `ensureOwnerFamilyPerson` (both read-then-create). Commit awaits any in-flight S16 call, then re-reads the membership link before creating. `applyToolCall` routes a proposal whose name matches the owner's profile name (or "me") to the owner's card, never a new parent card.
    - `remove_person` only drops a card from the draft. It never deletes an existing member; for roster-backed cards it just reverts unsaved changes.
    - Return per-card errors for inline retry.
16. **Routing changes:**
    - `reveal.tsx` `handleDone`: if `isLiveVoiceAvailable()` and `get_family_voice_setup().available`, go to `meet-family`; otherwise use today's routing.
      - The RPC is prefetched when the reveal mounts, not on press. On press it waits at most 1.5 s; any error or timeout falls through to today's routing.
      - Existing Maestro onboarding flows that tap `onb-reveal-done-button` keep passing (mode `off` locally means today's routing). `handleLater` (sibling chain "Later") does **not** count as a skip (decided 2026-10-05). When it's pressed on the last remaining reveal, it routes to `meet-family` like `handleDone`, if the step is available.
    - `portrait.tsx` `goToJournal`: call `set_family_voice_setup_status('skipped')` (fire-and-forget) before routing.
    - **Front-door resume on a cold launch mid-step.** `resolvePostAuthDestination` (`src/lib/onboarding-routing.ts`) is pure and returns `journal` for any paid owner, so:
      - Extend its input with `voiceSetup?: { hasDraft: boolean; status: string | null; available: boolean }`, and add a `resume-voice-setup` destination: `meet-family-review` when the draft has cards, else `meet-family`.
      - `app/index.tsx` reads the local draft first (cheap AsyncStorage). Only when a draft exists for the active family does it call `get_family_voice_setup`, with its own loading gate next to the existing ones and a 3 s timeout that falls through to today's routing.
      - Add routing tests for the new branch.
    - **The draft is created at "Start talking"**, even with zero cards, and its status marker is `talking`. A kill before the first card still resumes at `meet-family`, so the chance isn't lost.
      - **Order on confirm:** status `completed` is set only after **every** card is in `committedIds` (idempotent; a repeat is a no-op); the draft is cleared after that.
      - A draft found with server status `completed` / `skipped` and **no uncommitted cards** is deleted silently. One that still holds uncommitted cards routes to review.
    - The new `resume-voice-setup` kind sits inside `resolvePostAuthDestination`'s `billing && billingMembership` branch, **after** the owner-lapsed paywall check.
    - **Exhausted or unavailable while a draft exists** (limit reached, kill switch flipped, billing lapsed mid-step): never strand the parent.
      - With draft cards, go to `meet-family-review`; writes still need billing write, which a just-subscribed owner has.
      - With no cards, show the intro's manual path only ("Add people yourself" → Family tab) and set `skipped`.

### Phase 5 — birthdays without a year (invisible)

17. **`src/components/birthday-field.tsx`:** one field — date picker plus an "I'm not sure of the year" toggle, shown only for non-child roles. It emits `{dateOfBirth} | {birthMonth, birthDay}`. Use it in `add-family-member.tsx`, `family/[id]/edit.tsx` and the review screen.
    - **Validation:** `validateDateOfBirth` becomes role-aware; year-less is valid for non-children.
    - **Plumbing:** `CreateFamilyMemberInput`, `UpdateFamilyMemberInput`, `UpdateFamilyMemberWithPhotoInput` and `useFamilyMembers().updateMember`'s input (`dateOfBirth?: string` today) gain `birthMonth` / `birthDay` and allow `dateOfBirth: null`. `createFamilyMember` / `updateFamilyMember` always send all three birthday fields together (the three states in Step 3).
18. **Audit `date_of_birth` consumers** and leave year-less people correctly unaged:
    - `isFamilyMemberProfileIncomplete` (a month/day birthday counts as complete);
    - age helpers (`getAgePartsFromDob`);
    - `isOwnChild` (a year-less adult with an explicit role is unaffected);
    - Year Film eligibility (DOB required — unchanged);
    - memory-analysis deterministic birthday match (extend it to month/day via `family_member_birthday_md` — optional, in review);
    - the caption context age lines.

    - **The export:** `cloudflare/momora-export-worker/src/plan.ts:96` selects `family_members` columns by name. Add `birth_month,birth_day`, plus the export types and docs, so "Export your memories" includes year-less birthdays.

    Grep `date_of_birth` across `src/`, `supabase/functions/_shared/` and the workers.

### Phase 6 — post-import family invite

19. **`src/components/invite-family-prompt.tsx` + `src/utils/invite-family-prompt.ts` + one hook, `useInviteFamilyPrompt()`:** a one-time sheet on the timeline, for owners/managers. Its "shown" flag is persisted **server-side** (a `family_memberships.invite_prompt_shown_at timestamptz`, set through a small owner/manager RPC, same migration), so a reinstall or second device doesn't re-prompt. It's mirrored in AsyncStorage as a cache.
    - The hook is mounted once at the `TimelineScreen` level, not in the two places `TimelineGalleryImportInvite` renders (`timeline.tsx` ~1014 and ~1241).
    - **Triggers:**
      - (a) On Timeline focus (`useFocusEffect`), a head/count query on `memories` returns ≥1 for `family_id = ?`, `creation_source = 'gallery_import'`, `user_id = me` and `created_at > <1.4.4 release cutoff>` (limit 1). That means this parent approved an imported memory after the update and came back. The cutoff stops every existing importer being prompted en masse on update.
      - The query is skipped entirely once the flag says shown.
      - (b) `TimelineGalleryImportInvite` (a separate component, `timeline.tsx` ~229–264) gets an `onDismissed` prop from `TimelineScreen`, which tells the hook directly. An AsyncStorage write alone wouldn't re-render the screen.
      - Query (a) runs at most once per app session per family, and only for families where this device has used gallery import (the existing checkpoint), so it doesn't poll every focus forever.
    - **Content:** "Who else should see {kid}'s journal?" with roster adults who pass `isInviteTargetEligible` and aren't linked yet. Tapping one → `sharingInviteForMemberRoute(id)`. Also "Someone else" → `sharingInviteRoute`, and "Not now".

### Phase 7 — analytics, docs, tests, release

20. **Analytics** (`src/services/analytics.ts`), with no names or content:
    - `voice_setup_offered`;
    - `voice_setup_started {resume}`;
    - `voice_setup_session_closed {seconds, reason, tool_calls, cards_proposed}`;
    - `voice_setup_skipped {where: intro|portrait}`;
    - `voice_setup_committed {people_added, people_updated}`;
    - `voice_setup_photos {added, later}`;
    - `invite_family_prompt_shown {trigger}` and `invite_family_prompt_action`.
21. **Docs:**
    - new `docs/features/voice-family-setup.md` (how to extend: brief versioning, tools, guard, kill switch);
    - updates to `docs/features/onboarding.md` (flow S17 → S17b–e → S18), `family-relationships.md` (year-less birthdays, AI proposals via voice), `family-sharing.md` (invite prompt), `analytics.md`, `TECH_SPEC.md`;
    - privacy policy and store privacy labels (third-party AI audio processing) — flag for the owner.
22. **Tests:**
    - **Unit:** voice-family-cards, draft, BirthdayField validation, invite prompt triggers, availability guard.
    - **Service:** commit ordering and idempotency.
    - **Screen:** intro skip / start, review edit and confirm, photos push vs Later, reveal routing with available / unavailable / RPC error, portrait-journal skip.
    - **Keyboard:** open and closed assertions with a non-zero Android bottom inset for talk (card edit) and review, per `app/AGENTS.md`.
    - **Deno:** every edge function (create, end, and the guard sweep/bridge).
    - **pgTAP:** Step 5.
    - The WebRTC session client is tested with a fake peer-connection injected through the lazy-require seam.
    - Maestro: only the skip path, since voice can't be automated.
23. **Release:**
    - Bump `app.json` `version` to **1.4.4**. The runtime policy is `appVersion`, so this is also a new OTA runtime: later updates go to 1.4.4, 1.4.3 and 1.4.2.
    - Store build iOS + Android with `family_voice_settings.mode = 'off'`.
    - Then `canary` (fresh test sign-ups with `+momoravoice` emails), then `percent` (10 → 50), then `all`.
    - Over-the-air updates to 1.4.3/1.4.2 never show the step (`isLiveVoiceAvailable()` is false).
    - Daily cost watch via `ai_usage_events` (`operation = 'family_voice'`) and the ledger.
    - The spike branch and worktree are deleted afterwards.

## Risks & mitigations

- **Orphaned or long sessions billing:** handled at four levels — client single-instance guard, end on unmount and background, a client cap timer, and a server guard (Phase 0 / Step 6). The ledger lets daily alerts catch anomalies. Kill switch.
- **OTA bundle importing WebRTC on old binaries → crash:** lazy require behind `isLiveVoiceAvailable()`; a unit test asserts no top-level import.
- **iOS audio-session conflicts** (expo-audio vs WebRTC, earpiece routing): Phase 0 Step 2 is blocking; release only after iOS device QA.
- **Mishearing names and languages:** tap-to-fix is primary, review before write, follow the parent's language. Spelling confirmation only for unusual names.
- **Duplicates of existing people:** a server-built binding roster, `applyToolCall` duplicate guard, review screen.
- **Partial commit failures:** ordered, idempotent commit with `committedIds`; per-card retry.
- **Low reach:** S16's "Take me to the journal" (the copy invites wandering off) permanently skips the step. The S17 sibling "Later" doesn't. Track `voice_setup_offered` against onboarding completions. If reach is low, revisit whether "Take me to the journal" mid-paint should skip, or instead offer the step once on the first journal visit while still in onboarding.
- **Cost overrun:** about $0.15–0.40 per family plus about $0.07 per portrait. Two-session cap, owner-only, onboarding-only, kill switch, alerts.
- **Instruction drift as the app changes:** a versioned brief in `_shared/family-voice-brief.ts` with an extension-guide rule — update it with feature changes. `briefVersion` is logged per session.
- **Apple review (third-party AI disclosure, microphone):** an explicit disclosure on the intro screen; a microphone purpose string rewritten to cover the conversation (Step 9); the privacy policy is updated before release.
- **Play review:** `SYSTEM_ALERT_WINDOW` blocked; the merged manifest is reviewed before the build.
- **Child PII:** names and birthdays go to OpenAI (already true for captions). Audio is never stored; no transcripts persisted; logs carry counts only.

## Out of scope

- Using the voice setup outside onboarding (the Family tab, later re-entry).
- Gemini or other voice vendors; a text-chat version of the conversation (decided 2026-10-05).
- A record-once monologue fallback (see the design note; live voice first, decided 2026-10-05).
- Invites inside the voice conversation.
- Streaming portrait previews.
- Changing the gallery-import flow itself.

## Design note: keep the core transport-agnostic

The card model (Step 12), commit (Step 15), review/photos screens and birthday work (Steps 17–18) don't depend on WebRTC. Keep them that way, so a record-once fallback (one recording → the existing `process-voice-memory` transcription → a text model proposing cards), can reuse them. That fallback would also ship over the air and cost about 10× less, if live voice ever disappoints.

## Decisions (owner, 2026-10-05)

1. **No text-chat mode.** Skipping means adding people manually in the app, as today.
2. **The sibling-chain "Later" on S17 isn't a skip** (Step 16).
3. **The 20/day image cap is not raised** for onboarding. The photos step handles 429 per tile (Step 14).
4. **Live duplex voice first.** Record-once stays out of scope; the transport-agnostic core keeps it possible later.
