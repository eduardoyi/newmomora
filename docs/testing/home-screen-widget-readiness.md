# Home-screen widget readiness

Status: implementation complete; release admission pending. Updated 2026-09-16.
The original widget database migration is live, and both development builds have been tested on user devices. Store submission and production native release remain pending. The latest image-only revision still needs device acceptance.

## Initial verification baseline

| Check | Result |
| --- | --- |
| Full app Jest suite | 247 suites, 2,570 tests passed |
| Edge/Deno suite | 1,568 passed, zero failed, one ignored |
| SQL widget authorization and selection | 44 assertions passed in isolated local database; see [database evidence](widget-database-validation.md) |
| Android native module | `:momora-widget:compileDebugKotlin` and `:momora-widget:testDebugUnitTest` passed with Glance 1.2.0; five parser tests passed |
| iOS native app and widget extension | Unsigned Debug simulator build succeeded; local module autolinking and separate App Groups verified |
| iOS isolated widget runtime | Three tests passed with the actual ExpoWidgets runtime bundle: text, local artwork, and neutral expired/missing-expiry rendering |
| iOS startup smoke | Installed on iPhone 17 Pro / iOS 26.5 simulator; Metro bundled and app reached onboarding |
| Lint | Zero errors, 98 pre-existing warnings |
| Typecheck | Still blocked by 23 pre-existing errors outside widget code; no errors in app/src/modules |
| Diff whitespace | `git diff --check` passed |

The initial baseline was 236 suites / 2,509 Jest tests, the same Edge results,
and the same lint/typecheck failures. Android evidence is a module compile and
unit test run, not a full APK build or launcher acceptance. The simulator binary
was built before the final app-version/content-margin configuration edits and
`@expo/ui` lockfile alignment from 56.0.25 to 56.0.26; final
signed artifacts must be rebuilt from the release commit.

Native builds used temporary generated projects with Expo SDK 56's explicit
`expo-template-bare-minimum@56.0.35` template. The locally installed Expo archive
unexpectedly contained an SDK 57 template, so it was not used for validation.
Local build output and logs are temporary evidence, not committed artifacts.

## Adversarial findings fixed

- Repeated one-memory slots, exact 168-hour leases, and manifest parity.
- Scope changes, logout, opt-out during downloads, cold offline account changes,
  restored auth, and deleted-account manual refresh cannot republish old work.
- Serialized clears cannot be skipped behind an in-flight publish.
- Source downloads are bounded and abortable; decoded images are resized and
  validated; cancelled/stale staging files are cleaned up.
- Retained IDs and persistent report/block state are revalidated before renewal.
- iOS expired text is neutralized as well as artwork; native clear also replaces
  the separately persisted Expo timeline, closing an app-termination window.
- Android refresh updates Glance state so a live composition re-reads its cache.
- Deep links recheck account/family access and safely handle unavailable memories.

## Release gates still open

1. Run the authenticated Maestro flow in `.maestro/flows/widgets/setup-and-open.yaml`
   with a controlled test account and its fixture IDs. It is authored but not run.
   It covers setup and app routing; it does not substitute for launcher testing.
2. Build a complete Android APK and final signed iOS/Android release artifacts.
   Verify widget registration, extension signing, and production App Group entitlements.
3. On physical iPhone and Android devices, add the widget; inspect image/text crops,
   large fonts, dark/tinted modes, empty state, and tap routing. Confirm Android's
   tall footprint and disabled user resizing on supported launchers.
4. Exercise logout, account/family switches, delete/report/block, app kill, offline
   startup, reboot, refresh, midnight/DST rotation, and expiry on the launcher.
   Include an overnight run and a controlled shortened-lease test build.
5. Upgrade from the current store app, including an old binary receiving a
   compatible OTA. Confirm the new 1.4.0 appVersion runtime separates this native
   feature and that incoming-share storage still works.
6. Resolve or explicitly disposition the existing root typecheck failures before
   treating the repository-wide CI check as green. Apply the reviewed migration
   through the normal release process before enabling the new client feature.

No Android emulator or physical phone was available during this run. Native
builds also reduced free disk space to about 2 GB; a further full Android build
was not attempted under that constraint. Task-generated iOS build products were
then cleaned up, recovering about 2 GB while preserving the simulator app. Authenticated
end-to-end acceptance and OS snapshot timing are not proven by mocks or compilation.
Phones can retain rendered pixels and cannot learn remote revocation while offline;
168-hour expiry is an application lease, not a guaranteed screen-erasure deadline.

## Reproduction

- `npm test -- --runInBand`
- `npm run test:edge`
- `npm run lint` and `npm run typecheck`
- `node --test scripts/test-widget-runtime.cjs` after an iOS build generates
  `node_modules/expo-widgets/bundle/build/ExpoWidgets.bundle`
- Generated Android project: `./gradlew :momora-widget:compileDebugKotlin :momora-widget:testDebugUnitTest --no-daemon --max-workers=2`
- Generated iOS project: `xcodebuild -workspace Momora.xcworkspace -scheme Momora -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`

SQL isolation and benchmark reproduction are documented in the linked database report.

## EAS signing follow-up (2026-09-16)

The first iOS device build (`1b34c9d4-6f38-426c-8532-2297ce12b554`)
failed before compilation because its provisioning profiles lacked App Groups.
EAS CLI 18.0.1's capability sync only linked newly created group identifiers;
it did not link already existing identifiers to another bundle. CLI 24.6.0
handles existing identifiers, so `eas.json` now requires at least that version.
Both main-app groups are explicit in `app.json`, along with the existing Sign
in with Apple entitlement, which must not be disabled during capability sync.
The widget extension keeps only the widgets group; sharing keeps only shared.
`plugins/withMomoraWidget.test.ts` covers the main-app signing configuration.
EAS confirmed both missing group links and regenerated the main and widget
profiles with the registered test device. The replacement build must still
complete before signed-build validation can be marked passed.

Replacement iOS device build: [bc181af2](https://expo.dev/accounts/eduardoyi/projects/momora/builds/bc181af2-077b-467d-8963-f729392e84fb), dispatched with CLI 24.6.0.

### Live migration and second signing repair (2026-09-16)

With explicit user approval, migration `20260915140000` was applied to the
linked app backend. The dry run listed only this migration. Read-back confirmed
its migration-history row, both functions, authenticated execution grants,
no anonymous execution, and invoker security for candidate selection. The
public RPC now returns permission denial for an anonymous probe instead of
missing-function `PGRST202`. Authenticated device refresh remains to be observed.

Build `bc181af2` exposed a second CLI bug: 24.6.0 links existing identifiers but
sends only newly linked IDs in an update that replaces the association list.
This removed the main app's already-linked widgets group when adding shared.
For the repair invocation, its isolated npx-cache `capabilityIdentifiers.js`
was temporarily changed to initialize `capabilityIdOpaqueIds` with
`[...alreadyLinkedOpaqueIds]`, preserving current associations while adding
missing ones. Restore the cached CLI after that invocation. Do not assume
upgrading to 24.6.0 alone prevents this when adding further App Groups.

Repair build: [8b51616e](https://expo.dev/accounts/eduardoyi/projects/momora/builds/8b51616e-be68-419b-8f72-0c42d02243a1). The temporary CLI modification was restored after dispatch.

## Android device feedback: edge-to-edge image, branding, taps (2026-09-16)

The user's device confirmed live memory rendering after migration deployment.
Removed the 14dp outer image padding; only text-only/neutral content retains
that padding. Image cards now fill the rounded widget background with crop.
The existing pink `m.` app asset appears as a 28dp top-right badge with 10dp inset.
The caption remains at the bottom.

Fixed a confirmed native deep-link bug: `getLaunchIntentForPackage` supplies
`ACTION_MAIN`, which React Native's initial-URL and onNewIntent handlers ignore.
Widget memory intents now use `ACTION_VIEW`, retaining the explicit component,
family/memory/media-index URI, and warm-start flags. Neutral cards simply launch.

Validation: full Jest 247 suites / 2,571 tests passed. Android module compilation
and eight native tests passed (five parser tests plus three Robolectric Intent
regressions). Tests cover real Intent action/data/flags, neutral routing, and
separate pending-intent identities for different cards. Physical-device layout
and actual tap acceptance for this revision are still pending the replacement
Android development build. The iOS layout is unchanged by this Android follow-up.

## Image-only revision (2026-09-16)

Supersedes the earlier text-card and caption behavior above. Only photos and
ready, unreported illustrations qualify; mixed media qualifies when it contains
a photo. Text-only, audio-only, video-only, and pending illustrations are excluded
before candidate sampling. Failed image staging uses another valid image or a
neutral prompt, never journal text. Both platforms omit visible dates/captions.
Android retains the edge-to-edge image, badge, and ACTION_VIEW tap fix. iOS now
uses a resizable, aspect-fill image bounded by the widget container.

Current verification: 247 Jest suites / 2,575 tests passed; five actual isolated
iOS widget-runtime tests passed; Android Kotlin compilation and all eight native
tests passed. Lint has zero errors and 98 existing warnings. Typecheck retains
the 23 baseline errors outside widget app/client code. New native artifacts need
physical-device visual and tap acceptance; these checks do not claim that yet.

The follow-up migration `20260916100000_widget_memory_candidate_scope.sql`
passed all 47 isolated SQL assertions and was applied to the linked database.
Read-back confirmed its migration history, new function definition, authenticated
execution, anonymous denial, and invoker security. The current full Edge suite
also passed: 1,568 passed, zero failed, one ignored.

Replacement development builds dispatched with frozen existing credentials:
- Android: [eaf9ac5b](https://expo.dev/accounts/eduardoyi/projects/momora/builds/eaf9ac5b-38c6-4ca8-bcac-383fba1a7792).
- iOS: [663c2308](https://expo.dev/accounts/eduardoyi/projects/momora/builds/663c2308-2322-4e63-b4be-f5bfd39cb13d).

Dispatch is confirmed; completion and device acceptance are not yet verified.

Post-dispatch check: both replacement builds were IN_PROGRESS with no reported
errors. The final tested stale-summary guard missed the earlier deployment, so
it was preserved as a separate follow-up migration
`20260916110000_widget_authoritative_photo_assets.sql` and applied. This keeps
the previously deployed migration unchanged and makes child image assets
authoritative over legacy summary fields.

## Automatic setup and settings layout (2026-09-16)

Luna Max implemented the settings-style Back/header/instructions screen, removed
the toggle, Done button and privacy reminder, and made preparation automatic
for the authenticated active family. Root reviewed the implementation and
strengthened lifecycle fixtures and account/family transition assertions. Legacy
disabled preferences no longer gate preparation. Manual shuffle remains intact.

Validation: 247 Jest suites / 2,583 tests passed; Edge 1,568 passed / one ignored;
full lint zero errors / 98 baseline warnings; typecheck retains 23 unrelated
baseline errors. Focused tests cover real photo preparation without visiting
settings, old disabled preferences, anonymous sessions, logout, in-flight family
switches, deleted profiles and offline cache reconciliation. The Maestro flow
was updated but not run. New layout awaits physical-device visual acceptance.
No native build or OTA deployment was performed for this JavaScript change.
