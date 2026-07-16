# Momora release-readiness tracker

**Last updated:** July 16, 2026

**Release version:** 1.1.0

**Public store name:** **UseMomora**

**On-device name:** **Momora**

This is the working must-do list for the next App Store and Google Play release.

## Status key

- [x] Complete
- [ ] Still required
- 🟡 Partially complete — use the nested checkboxes to see what remains
- 🔒 Requires a store, Apple, Google, Firebase, or EAS console

## 1. Safety, reporting, and moderation

- [x] Implement in-app reporting for AI-generated family-member portraits.
- [x] Implement in-app reporting for AI-generated memory illustrations.
- [x] Decide and document the minimum reporting/moderation behavior for family-shared memories and family members.
  - [x] Define what can be reported and by whom.
  - [x] Define what happens immediately after a report.
  - [x] Define who can review or resolve a report.
  - [x] Define whether reported content is hidden, retained, or deleted.
  - [x] Define the minimum audit/support information retained without storing unnecessary child data.
  - Behavior and implementation: [content-reporting.md](./features/content-reporting.md).
  - Private review procedure: [content-reporting-operations.md](./content-reporting-operations.md).
- [ ] Assign the release operator responsible for the daily private report-queue check and urgent safety escalation.
- [ ] Run the reporting Maestro happy path from an installed release candidate with a clean illustrated-memory fixture.

## 2. Legal, support, and public copy

- [x] Update the privacy policy, Terms of Service, FAQ, website copy, and account-deletion page copy.
- [ ] 🔒 Deploy and verify the additional reporting/blocking Privacy and Terms additions in the separate `momora-marketing` site after the implemented behavior is accepted.
  - This is a new reporting-specific deployment task; it does not reopen the completed general copy update above.
- [x] Add Terms acknowledgment during account creation.
- [x] Add direct FAQ, privacy, Terms, and support/contact routes in the app.
  - Implemented in the current working tree; include these changes in the release commit.
- [ ] 🔒 Disable or remove from sale all old Apple and Google in-app purchase products.
  - [x] Confirm that no subscriber migration is required.
  - [x] Confirm that no refunds are required.
  - [ ] Remove remaining monetization references from the store listings and store configuration.
- [x] Keep the public App Store and Google Play name as **UseMomora**.
- [x] Keep the on-device app name as **Momora**.

## 3. Store declarations and reviewer access

- [ ] 🔒 Update Apple App Privacy declarations to match the current app.
- [ ] 🔒 Update Google Play Data Safety declarations to match the current app.
- [ ] 🔒 Complete Apple’s current age-rating questionnaire.
- [ ] 🔒 Complete Google Play’s target-audience and content declarations.
- [ ] Prepare reviewer access for the email-OTP login flow.
  - [x] Use the reusable app-review email/password route so reviewers do not depend on receiving a live OTP.
  - [x] Create reviewer instructions and the setup/rotation runbook: [reviewer-access.md](./reviewer-access.md).
  - [x] Add focused integration and Maestro flow coverage for the reviewer route.
  - [ ] Seed/verify the production reviewer account and enter its credentials securely in the store review consoles.
  - [ ] Verify the flow from a clean install before submission.

## 4. iPad compatibility

🟡 Keep basic iPad compatibility without investing in iPad-specific polish.

- [x] Keep `ios.supportsTablet` enabled.
- [ ] Run the core release smoke test on a supported iPad/iPad simulator.
  - [ ] Sign up and complete email OTP.
  - [ ] Complete onboarding.
  - [ ] View the timeline and memory detail.
  - [ ] Create a text memory and a media memory.
  - [ ] Open Settings and account deletion.
- [ ] Replace the old iPad App Store screenshots with current screenshots.
- [ ] Fix only submission blockers or severe layout/usability problems found during the smoke test.

## 5. Build numbers and release artifacts

- [ ] 🔒 Raise and verify the EAS remote build numbers before producing final artifacts.
  - [x] EAS remote Android `versionCode` is **34**.
  - [x] EAS remote iOS `buildNumber` is **35**.
  - [ ] Confirm both values on the final artifacts, not only in EAS configuration.

🟡 Produce a fresh physical-device iOS build and create or verify all required Apple capabilities and credentials.

- [x] Main-app provisioning profile verified in the July 13 physical-device development IPA; reconfirm on the final production artifact.
- [x] Share-extension provisioning profile verified in the July 13 physical-device development IPA; reconfirm on the final production artifact.
- [x] App Group `group.com.memora.app.shared` verified in both entitlements in the July 13 physical-device development IPA; reconfirm on the final production artifact.
- [ ] Associated Domains entitlement for `applinks:usemomora.com`.
- [x] APNs key linked to the Momora app target in EAS.
- [ ] Confirm APNs registration and delivery on a physical iPhone or iPad.
- [ ] Confirm the share extension works in the fresh build.
- [ ] Confirm the universal invite link opens the installed app.

## 6. Push credentials and delivery testing

🟡 FCM v1 and APNs are configured in the new EAS project; end-to-end release testing remains.

- [x] `google-services.json` matches Firebase project `diesel-bee-460221-p7` and Android package `com.memora.app`.
  - This client configuration is separate from the FCM v1 service-account credential.
- [x] Upload and assign the FCM v1 service-account key to `com.memora.app` in EAS.
- [x] Link the Apple APNs key to the Momora app target in EAS.
- [x] Produce an Android preview build containing the new Firebase/native configuration.
- [ ] Produce an iOS physical-device preview or production build.
- [ ] Test Android token registration and notification delivery.
- [ ] Test iPhone/iPad token registration and notification delivery.
- [ ] Test notification taps and confirm they open the intended app route.

Useful inspection commands:

```bash
eas credentials -p android  # FCM v1 and Android signing credentials
eas credentials -p ios      # APNs and iOS signing/provisioning credentials
eas build:version:get -p android
eas build:version:get -p ios
eas build:list
```

Do not commit `google-services.json`, service-account keys, `.p8` files, provisioning profiles, or signing credentials.

## 7. Code quality and automated tests

- [x] Fix the current lint error in `src/components/memory-media-carousel.tsx`.
  - The native `VideoPlayer` remains intentionally imperative, while mute updates now go through a small adapter instead of directly mutating an object held in React state.
  - Regression coverage verifies mute changes apply without recreating the native player; the existing deferred-release test still protects the Android surface-recycling workaround.
- [x] Review the remaining lint warnings and distinguish release risks from cleanup that can follow the release.
  - `npm run lint` currently exits successfully with **0 errors and 33 warnings**.
  - No remaining warning is a known blocker for the current release. React Compiler is not enabled in `app.json`.
  - Remaining warnings are React hook/compiler-readiness cleanup in existing calendar/list/animation/data-hydration patterns.
  - These should be handled in focused behavior-preserving changes with their existing screen/hook tests, especially before enabling React Compiler, rather than refactored during release stabilization.
- [x] Investigate and resolve the Jest open-handle warning.
  - Root cause: test-local TanStack Query clients scheduled five-minute query and mutation garbage-collection timers.
  - All Jest QueryClient configurations now use test-only `gcTime: Infinity`; production cache settings are unchanged.
  - `npm test -- --runInBand` now exits normally: **94 suites and 773 tests pass** with no open-handle warning.
  - Some hook suites still print React `act(...)` console warnings from deferred TanStack Query notifications. They do not keep Jest alive and are post-release test-hygiene cleanup.
- [ ] From the final clean release commit, rerun:
  - [ ] `npm run typecheck`
  - [ ] `npm run lint`
  - [ ] `npm test -- --runInBand`
  - [ ] `npm run test:edge`
  - [ ] Required Maestro flows
  - Current reporting-slice validation on July 16, 2026: typecheck passed; lint passed with 0 errors/33 warnings; full Jest passed 869/869 and exited normally; database pgTAP passed 54/54; the full Edge suite passed 295/295. Every command above still requires the final clean-commit rerun.
  - Maestro 2.6.0 is installed. A physical iPhone is paired but does not have the app installed; no iOS simulator is booted, no Android device is attached, and test credentials/fixtures are unavailable. Maestro was not runnable in this pass.
- [ ] Confirm the final release commit has no secrets or untracked release inputs that the build depends on unexpectedly.
  - The current diff passes `git diff --check` and the secret-pattern scan found no keys or credentials.
  - Expected ignored local release inputs are `.env.local` (Expo public Supabase configuration), `google-services.json` (referenced by `app.json`), and `credentials.json` (required by the production Android profile's `credentialsSource: local`). They must be supplied securely to the final build and must not be committed.
  - No unexpected untracked file is currently required by Jest, Expo, EAS, or the release build.

## 8. Release-channel smoke testing

- [ ] Upload the final iOS build to TestFlight.
- [ ] Upload the final Android build to Google Play internal testing.
- [ ] Run release-mode smoke tests on iPhone.
- [ ] Run release-mode smoke tests on iPad.
- [ ] Run release-mode smoke tests on Android.
- [ ] Cover at minimum:
  - [ ] Email OTP signup and login.
  - [ ] Family onboarding and portrait generation.
  - [ ] Text, voice, photo, and video memory creation.
  - [ ] Illustration generation and retry behavior.
  - [ ] Family invite, redeem, and approval.
  - [ ] Likes and comments.
  - [ ] Push registration, delivery, and notification routing.
  - [ ] Incoming media share extension/share target.
  - [ ] Account-deletion scheduling and cancellation.

## 9. Legacy backend decision

- [x] Decide how long the old backend must remain available for users stuck on iOS **15.1–16.3**.
  - [x] No active-user compatibility window is required: there are no real active users on the legacy backend, and the two relevant accounts were migrated to the new database.
  - [x] Owner: the release operator keeps the old backend available only as a short rollback path through successful production verification.
  - [x] End condition: after TestFlight and Google Play production-candidate verification succeeds and rollback is no longer needed, decommission the old backend. No invented calendar date is required.
  - [ ] Decommission the old backend after that end condition is met and record completion here.

## Release exit criteria

The release is ready to submit only when:

- [ ] All required reporting/moderation behavior is implemented and documented, the daily queue owner is assigned, and the release-candidate reporting flow passes.
- [ ] Store declarations, ratings, reviewer access, listings, and IAP cleanup are complete.
- [ ] Android build number is at least 34 and iOS build number is at least 35.
- [ ] Physical-device push delivery works on Android and iOS/iPadOS.
- [ ] Typecheck, lint, Jest, Edge tests, and required Maestro flows pass from the final clean commit.
- [ ] TestFlight and Google Play internal-testing smoke tests pass, including the basic iPad pass.
- [x] The legacy-backend rollback-only window has an owner and a production-verification end condition.
