# Momora release-readiness tracker

**Last updated:** July 14, 2026

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

- [ ] Implement in-app reporting for AI-generated family-member portraits.
- [ ] Implement in-app reporting for AI-generated memory illustrations.
- [ ] Decide and document the minimum reporting/moderation behavior for family-shared memories and family members.
  - [ ] Define what can be reported and by whom.
  - [ ] Define what happens immediately after a report.
  - [ ] Define who can review or resolve a report.
  - [ ] Define whether reported content is hidden, retained, or deleted.
  - [ ] Define the minimum audit/support information retained without storing unnecessary child data.

## 2. Legal, support, and public copy

- [x] Update the privacy policy, Terms of Service, FAQ, website copy, and account-deletion page copy.
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
  - [ ] Decide how reviewers will receive or obtain the OTP reliably.
  - [ ] Create reviewer instructions and any required test account.
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
  - [ ] Android `versionCode` is at least **34**.
  - [ ] iOS `buildNumber` is at least **35**.
  - [ ] Confirm both values on the final artifacts, not only in EAS configuration.

🟡 Produce a fresh physical-device iOS build and create or verify all required Apple capabilities and credentials.

- [ ] Main-app provisioning profile.
- [ ] Share-extension provisioning profile.
- [ ] App Group: `group.com.memora.app.shared`.
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

- [ ] Fix the current lint error in `src/components/memory-media-carousel.tsx`.
- [ ] Review the remaining lint warnings and distinguish release risks from cleanup that can follow the release.
- [ ] Investigate and resolve the Jest open-handle warning.
  - All **574 tests pass**, but Jest currently reports that it does not exit promptly.
- [ ] From the final clean release commit, rerun:
  - [ ] `npm run typecheck`
  - [ ] `npm run lint`
  - [ ] `npm test -- --runInBand`
  - [ ] `npm run test:edge`
  - [ ] Required Maestro flows
- [ ] Confirm the final release commit has no secrets or untracked release inputs that the build depends on unexpectedly.

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

- [ ] Decide how long the old backend must remain available for users stuck on iOS **15.1–16.3**.
  - [ ] Estimate or measure the number of affected active users.
  - [ ] Choose a support end date.
  - [ ] Define what the old app should show after that date.
  - [ ] Document the shutdown and rollback plan.

## Release exit criteria

The release is ready to submit only when:

- [ ] All required reporting/moderation behavior is implemented and documented.
- [ ] Store declarations, ratings, reviewer access, listings, and IAP cleanup are complete.
- [ ] Android build number is at least 34 and iOS build number is at least 35.
- [ ] Physical-device push delivery works on Android and iOS/iPadOS.
- [ ] Typecheck, lint, Jest, Edge tests, and required Maestro flows pass from the final clean commit.
- [ ] TestFlight and Google Play internal-testing smoke tests pass, including the basic iPad pass.
- [ ] The legacy-backend support window has an owner and end date.
