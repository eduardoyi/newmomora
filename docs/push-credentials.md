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

### 1. iOS — link the APNs key — ✅ done 2026-07-12

The legacy team APNs key (`88T397KNVV`, team `67B39P5MPN`) was assigned to
`com.memora.app` via `eas credentials -p ios`. Gotchas hit along the way,
for next time:

- Pick a **device-build profile** (`preview`/`production`) at the profile
  prompt — the `development` profile is `simulator: true`, and simulator
  builds refuse credential setup ("A simulator distribution does not require
  credentials").
- Assign the key to the **Momora app target only**; the
  `expo-sharing-extension` target doesn't receive pushes.

### 2. Rebuild

`eas build --profile development --platform all` — the new build picks up
`google-services.json` (Android token registration currently throws without
it) and the `react-native-compressor` native module added 2026-07-12.
Android done 2026-07-12 (`preview` build 091ffdc5). iOS still pending — use
`--profile preview` to test push (simulator dev builds can't register for
APNs).

## Build signing — two Android keystores, on purpose

There are two signing identities in play; which one signs a build depends on
the EAS profile:

| Profile | Keystore | SHA-256 (cert) | Play accepts? |
|---------|----------|----------------|----------------|
| `preview` / internal APKs | EAS-generated, stored remotely on Expo's servers (created 2026-07-12 during the first family-sharing test build) | `C8:23:EF:8C:DB:21:DC:F9:05:D1:16:1F:6E:1E:C0:D6:D6:B7:04:81:98:0D:F9:85:FE:37:79:61:0D:A6:11:2A` (also the second entry in the marketing repo's `assetlinks.json`) | **No** — test installs only |
| `production` | The **original Memora upload keystore** — `credentials.json` + `credentials/android/keystore.jks` (git-ignored, `credentialsSource: "local"` in `eas.json`) | n/a (Play re-signs releases with its app-signing key) | **Yes** — matches the existing listing's upload key |

Consequences:

- **No Play Console upload-key reset is needed.** (Advice given during the
  family-sharing work — "do a one-time upload-key reset when shipping" —
  predates the keystore carry-over above and is superseded. Production
  builds sign with the original upload key and update the live
  `com.memora.app` listing directly.)
- **Android App Links** (`usemomora.com/invite` → app): the marketing repo's
  `.well-known/assetlinks.json` lists **both** fingerprints — the Play
  app-signing certificate (`1C:85:25:D8:…`) for store-delivered builds and
  the EAS preview keystore (`C8:23:EF:8C:…`) so internal test APKs verify
  too. Keep both; removing the second silently breaks link-opens-app on
  internal builds.
- Do not delete the remote EAS Android keystore or "sync" it with the local
  one — the split is intentional (worst case for the preview keystore is
  reinstalling test builds; the local upload keystore is the
  irreplaceable one).

## How it fits together

- Client registration: `src/hooks/useNotifications.ts` stores the Expo push
  token in `user_profiles.expo_push_token`.
- **Known limitation (accepted for MVP, 2026-07-18):** that column holds ONE
  token per account — last registered device wins, so a user signed in on two
  phones only gets pushes on whichever device most recently opened Settings
  or toggled a notification setting. Verified in practice (Android/iOS on the
  same account). The fix, if it ever matters, is a `user_push_tokens` table
  (one row per device, pruned on `DeviceNotRegistered` receipts) with fan-out
  in the sending Edge Functions.
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
