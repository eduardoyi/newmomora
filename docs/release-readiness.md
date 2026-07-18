# Momora release-readiness tracker

**Last updated:** July 19, 2026

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
- [x] Assign the release operator responsible for the daily private report-queue check and urgent safety escalation: Founder/operator.
  - [x] Queue a metadata-only Bento alert to `hello@usemomora.com` for each new report; daily manual review remains the fallback.
  - [x] 🔒 Configure/verify Bento credentials and one production-like alert delivery.
    - Verified July 17, 2026: the metadata-only alert arrived; the outbox recorded one successful attempt and the report remained open for review.
- 🟡 Owner decision: waive the reporting Maestro happy path for this release along with the other Maestro flows. Direct release-mode verification and the production-like Bento alert verification remain recorded above.

## 2. Legal, support, and public copy

- [x] Update the privacy policy, Terms of Service, FAQ, website copy, and account-deletion page copy.
- [x] 🔒 Deploy and verify the additional reporting/blocking Privacy and Terms additions in the separate `momora-marketing` site.
- [x] Add Terms acknowledgment during account creation.
- [x] Add direct FAQ, privacy, Terms, and support/contact routes in the app.
  - Implemented in the current working tree; include these changes in the release commit.
- [x] 🔒 Disable or remove from sale all old Apple and Google in-app purchase products.
  - [x] Confirm that no subscriber migration is required.
  - [x] Confirm that no refunds are required.
  - [x] Remove remaining monetization references from the store listings and store configuration.
- [x] Keep the public App Store and Google Play name as **UseMomora**.
- [x] Keep the on-device app name as **Momora**.

## 3. Store declarations and reviewer access

- [x] 🔒 Update Apple App Privacy declarations to match the current app.
  - [x] Publish the current Apple data-type declarations, including linked-to-user and non-tracking answers.
  - [x] Add the User Privacy Choices URL (`https://usemomora.com/delete-account/`) in the new iOS version.
- [x] 🔒 Update Google Play Data Safety declarations to match the current app.
- [x] 🔒 Complete Apple’s current age-rating questionnaire.
- [x] 🔒 Complete Google Play’s target-audience and content declarations.
- 🟡 Prepare reviewer access for the email-OTP login flow.
  - [x] Route the dedicated reviewer email from the normal login field to a guarded password step so reviewers do not depend on receiving a live OTP.
  - [x] Create reviewer instructions and the setup/rotation runbook: [reviewer-access.md](./reviewer-access.md).
  - [x] Add focused integration and Maestro flow coverage for the email-triggered reviewer password branch.
  - [x] Provision and backend/fixture-verify the production reviewer account and synthetic data.
    - Backend/account/media verification on July 17, 2026: confirmed email and password authentication; one active owner membership with onboarding complete; two explicitly synthetic adult profiles with ready portraits; one text-only and one ready illustrated memory tagged only to the intended synthetic profile; and authenticated private-media access.
    - The production `get-media-url` function was redeployed and verified active at version 12 after version 11 rejected versioned memory-illustration keys.
  - [x] Enter the stored reviewer credentials securely in both store review consoles.
  - [x] Verify the email-triggered reviewer flow from a clean release-mode build before submission.

## 4. iPad compatibility

🟡 Keep basic iPad compatibility without investing in iPad-specific polish.

- [x] Keep `ios.supportsTablet` enabled.
- [ ] Run the core release smoke test on a supported iPad/iPad simulator.
  - [ ] Sign up and complete email OTP.
  - [ ] Complete onboarding.
  - [ ] View the timeline and memory detail.
  - [ ] Create a text memory and a media memory.
  - [ ] Open Settings and account deletion.
- [x] Replace the old iPad App Store screenshots with current screenshots.
- [ ] Fix only submission blockers or severe layout/usability problems found during the smoke test.

## 4.1 Store listings, descriptions, and screenshots

- [x] 🔒 Review and update the App Store description, promotional text, keywords, and support/marketing URLs for the current release.
  - [x] Remove references to subscriptions, trials, credits, premium access, or purchases.
  - [x] Keep the private, invite-only family-sharing model and AI illustration behavior accurate; do not imply public sharing or discovery.
- [x] 🔒 Review and update the Google Play short description, full description, and privacy-policy link for the current release.
  - [x] Remove references to subscriptions, trials, credits, premium access, or purchases.
  - [x] Keep the private, invite-only family-sharing model and AI illustration behavior accurate; do not imply public sharing or discovery.
- [x] 🔒 Replace outdated App Store and Google Play phone screenshots that show old UI, pricing, or obsolete flows.
- [x] 🔒 Replace the old App Store iPad screenshots with current iPad screenshots.

## 5. Build numbers and release artifacts

- [x] 🔒 Raise and verify the EAS remote build numbers before producing final artifacts.
  - [x] Final Android production artifact: version `1.1.0`, `versionCode` **35**.
  - [x] Final iOS production artifact: version `1.1.0`, `buildNumber` **40**.
  - [x] Confirm both values on the final artifacts, not only in EAS configuration.

🟡 Produce a fresh physical-device iOS build and create or verify all required Apple capabilities and credentials.

- [x] Main-app provisioning profile verified in the July 13 physical-device development IPA; reconfirm on the final production artifact.
- [x] Share-extension provisioning profile verified in the July 13 physical-device development IPA; reconfirm on the final production artifact.
- [x] App Group `group.com.memora.app.shared` verified in both entitlements in the July 13 physical-device development IPA; reconfirm on the final production artifact.
- [ ] Associated Domains entitlement for `applinks:usemomora.com`.
- [x] APNs key linked to the Momora app target in EAS.
- [x] Confirm APNs registration and delivery on a physical iPhone or iPad.
- [ ] Confirm the share extension works in the fresh build.
- [ ] Confirm the universal invite link opens the installed app.

## 6. Push credentials and delivery testing

🟡 FCM v1 and APNs are configured in the new EAS project; end-to-end release testing remains.

- [x] `google-services.json` matches Firebase project `diesel-bee-460221-p7` and Android package `com.memora.app`.
  - This client configuration is separate from the FCM v1 service-account credential.
- [x] Upload and assign the FCM v1 service-account key to `com.memora.app` in EAS.
- [x] Link the Apple APNs key to the Momora app target in EAS.
- [x] Produce an Android preview build containing the new Firebase/native configuration.
- [x] Produce an iOS physical-device preview or production build.
- [x] Test Android token registration and notification delivery.
- [x] Test iPhone/iPad token registration and notification delivery.
- [x] Test notification taps and confirm they open the intended app route.

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
- [x] From the final clean release commit, rerun:
  - [x] `npm run typecheck`
  - [x] `npm run lint`
  - [x] `npm test -- --runInBand`
  - [x] `npm run test:edge`
  - 🟡 Owner decision: waive Maestro flows for this release. Maestro supports iOS simulators, not physical iPhones; the founder has extensively performed direct release-mode testing on both platforms. This waiver does not waive final production-artifact checks.
  - Final-clean-commit validation on July 18, 2026: typecheck passed; lint passed (0 errors, existing warnings only); Jest passed **103 suites / 883 tests** and exited normally; Edge tests passed **333 / 333**.
- [ ] Confirm the final release commit has no secrets or untracked release inputs that the build depends on unexpectedly.
  - The current diff passes `git diff --check` and the secret-pattern scan found no keys or credentials.
  - Expected ignored local release inputs are `.env.local` (Expo public Supabase configuration), `google-services.json` (referenced by `app.json`), and `credentials.json` (required by the production Android profile's `credentialsSource: local`). They must be supplied securely to the final build and must not be committed.
  - No unexpected untracked file is currently required by Jest, Expo, EAS, or the release build.

## 8. Release-channel smoke testing

- [x] Submit final iOS build `1.1.0 (40)` to App Store review — awaiting review as of July 19, 2026.
- [x] Submit final Android build `1.1.0 (35)` to Google Play production review — awaiting review as of July 19, 2026.
- [x] Run release-mode smoke tests on iPhone.
- [x] Run release-mode smoke tests on iPad.
- [x] Run release-mode smoke tests on Android.
- 🟡 Owner decision: waive a separate TestFlight and Google Play internal-testing smoke pass; the founder has extensively tested release-mode builds directly on Android and iPhone/iPad devices. This does not waive the final production-artifact and store-submission checks.
- [ ] Cover at minimum:
  - [ ] Email OTP signup and login.
  - [ ] Family onboarding and portrait generation.
  - [ ] Text, voice, photo, and video memory creation.
  - [ ] Illustration generation and retry behavior.
    - [x] Investigate and retest normal Edge illustration generation without an operator fallback. During reviewer-fixture seeding, two production attempts remained `generating` beyond the app's three-minute stale threshold and required the fixture-only local fallback.
      - On July 18, 2026, `generate-illustration` v33 completed a controlled regeneration against the synthetic reviewer fixture in 85.3 seconds, published a new generation, left the memory `ready`, and cleared its attempt token. Privacy-safe phase telemetry attributed 73.7 seconds to OpenAI image generation and 6.9 seconds to publication.
      - The deployed function now applies a request-wide 120-second cancellable pre-finalization deadline, preserving intended headroom under Supabase's 150-second request-idle limit. A preceding timeout-path check restored the retained illustration and cleared the attempt token instead of leaving the row stuck in `generating`.
  - [ ] Family invite, redeem, and approval.
  - [ ] Likes and comments.
  - [ ] Push registration, delivery, and notification routing.
  - [ ] Incoming media share extension/share target.
  - [ ] Account-deletion scheduling and cancellation.

## 9. Legacy backend decision

- [x] Decide how long the old backend must remain available for users stuck on iOS **15.1–16.3**.
  - [x] No active-user compatibility window is required: there are no real active users on the legacy backend, and the two relevant accounts were migrated to the new database.
  - [x] Owner: the release operator keeps the old backend available only as a short rollback path through successful production verification.
  - [x] End condition: after successful production verification and the rollback path is no longer needed, decommission the old backend. No invented calendar date is required.
  - [ ] Decommission the old backend after that end condition is met and record completion here.

## Release exit criteria

The release is ready to submit only when:

- [x] All required reporting/moderation behavior is implemented and documented, the daily queue owner is assigned, and release-mode verification is complete. Maestro is waived by the founder for this release.
- [x] Store declarations, ratings, reviewer access, listings, and IAP cleanup are complete.
- [x] Android build number is at least 34 and iOS build number is at least 35.
- [x] Physical-device push delivery works on Android and iOS/iPadOS.
- [x] Typecheck, lint, Jest, and Edge tests pass from the final clean commit. Maestro is waived by the founder for this release; final production-artifact checks remain required.
- [ ] Final production-artifact smoke tests pass on iPhone, iPad, and Android. A separate TestFlight/Google Play internal-testing smoke pass is waived by the founder; Apple build processing and store-submission checks still apply.
- [x] The legacy-backend rollback-only window has an owner and a production-verification end condition.
