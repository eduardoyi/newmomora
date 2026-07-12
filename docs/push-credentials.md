# Push notification credentials

**Last updated:** 2026-07-12

Momora2 replaces the original Memora app (`/Users/eduardoyi/Coding/Memora`) in
both stores. Both apps use the same identifiers — iOS bundle ID and Android
package `com.memora.app` — so the old app's credentials carry over. This doc
records what was migrated and what remains manual.

## Already done (2026-07-12)

| Item | Where | Notes |
|------|-------|-------|
| `google-services.json` | repo root (git-ignored) | Firebase project `diesel-bee-460221-p7`, registered to `com.memora.app`. Referenced from `app.json` → `android.googleServicesFile`. Copied from the old repo. |
| `.easignore` | repo root (committed) | Mirror of `.gitignore` minus `google-services.json`, so EAS Build uploads it while git never sees it. **Keep the two files in sync when editing ignore rules.** |
| Android upload keystore | `credentials.json` + `credentials/android/keystore.jks` (both git-ignored) | Copied from the old repo. Required to update the existing Play Store listing — do not lose or regenerate. `eas.json` production profile sets `android.credentialsSource: "local"` so release builds sign with it. |
| Notification icons | `assets/images/notification-icon*.png` (committed) | White-on-transparent Android status-bar icons from the old app; wired into the `expo-notifications` plugin in `app.json`. |
| Version continuity | EAS remote counters | Old app shipped v1.0.16 / versionCode 10. Remote counters initialized: **Android versionCode 11, iOS buildNumber 11** (`eas build:version:get`), app version set to `1.1.0` in `app.json`. `appVersionSource: remote` + `autoIncrement` handle future bumps. |
| FCM V1 service account key | EAS credential store | Uploaded 2026-07-12 via `eas credentials -p android`: `firebase-adminsdk-fbsvc@diesel-bee-460221-p7.iam.gserviceaccount.com` (key id `281f1a2af7…`), assigned to `com.memora.app` for FCM V1. Must belong to the **same Firebase project as `google-services.json`** (`diesel-bee-460221-p7`) or Android pushes fail with sender-mismatch errors. NB: a second Firebase project `momora-460221` exists — its keys are NOT interchangeable with this setup. |

## Remaining manual steps (need your Apple login)

### 1. iOS — link the APNs key

APNs keys are scoped to the Apple Developer team, not the app. Run
`eas credentials -p ios` (or just the first `eas build -p ios`) and sign in
with the Apple account that owns `com.memora.app` — choose **reuse** the
existing push key rather than creating a new one (Apple caps teams at 2 keys).

### 2. Rebuild

`eas build --profile development --platform all` — the new build picks up
`google-services.json` (Android token registration currently throws without
it) and the `react-native-compressor` native module added 2026-07-12.

## How it fits together

- Client registration: `src/hooks/useNotifications.ts` stores the Expo push
  token in `user_profiles.expo_push_token`.
- Sending: Edge Functions call the Expo push API via
  `supabase/functions/_shared/expo-push.ts` — unauthenticated, which is fine
  unless "enhanced push security" is enabled on the Expo account (then add an
  `EXPO_ACCESS_TOKEN` bearer header + Edge Function secret).
- Expo push tokens are scoped to the EAS project (`6e6727aa…`); tokens minted
  by the old app are unusable and need no migration.

## Never commit

`google-services.json` (policy: treated as sensitive here even though Google
considers it client config), `credentials.json`, `credentials/` (keystore),
any `service-account*.json`, `.p8`/`.p12` files. All are git-ignored — keep
them that way. `.easignore` deliberately re-includes only
`google-services.json` for EAS uploads.
