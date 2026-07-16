# Store reviewer access runbook

Momora's normal sign-in flow sends a one-time email code. App Store and Google Play review must not depend on the reviewer receiving that email, so each submitted build uses one dedicated, reusable Supabase email/password account. The app exposes **App review access** from the welcome screen, but contains no credentials or reviewer-specific bypass.

## One-time production setup

1. In the production Supabase dashboard, create a dedicated auth user using a role inbox you control. Use a strong, randomly generated password and mark the email confirmed.
2. Store the email and password only in the team's password manager and the secure reviewer-credential fields in App Store Connect and Google Play Console. Never put them in the repository, EAS public variables, release notes, screenshots, chat, or analytics.
3. Sign in through **App review access** and create a synthetic review family. Add at least one synthetic family profile, several memories covering the release's important formats, and any other state a reviewer needs. Do not use a real child's name, image, journal text, or contact details.
4. Confirm the account has a valid `user_profiles.active_family_id` and active `family_memberships` row by signing out, clearing app data, and signing in again. It must open the populated timeline instead of the no-family/onboarding flow. The app intentionally has no hardcoded reviewer-account check; ordinary family/session routing determines the destination.

Account creation, password assignment, family seeding, and store-console entry are manual. No source-code or migration step creates the reviewer account.

## Before every submission

1. Reset the synthetic journal to a stable review-ready state. Remove reviewer-created test content from the prior review if it obscures the seeded examples, and restore any deleted examples.
2. From a clean install of the exact release build, choose **App review access**, enter the stored credentials, and verify the populated timeline and all review-critical flows.
3. Verify the same credentials in both store consoles. Avoid rotating them during an active review. If rotation is necessary, update Supabase, the password manager, and both consoles together, then repeat the clean-install test.
4. After review, inspect the synthetic family for unexpected personal information and remove it. Keep the account active and seeded for follow-up review unless the submission is fully closed.

## App Store Connect wording

Enter the reusable values in App Review Information's sign-in fields. Use this in **Notes**, replacing only the placeholders in the secure console:

> Momora normally uses an email one-time code. For review, tap **App review access** on the Welcome back screen and sign in with email `<REVIEWER_EMAIL>` and password `<REVIEWER_PASSWORD>`. No OTP or account creation is required. The account opens a pre-populated family journal with synthetic data. Please contact `<SUPPORT_EMAIL>` if access needs to be reset.

## Google Play Console wording

Create an **App access** instruction named `Momora reviewer access`. Mark that all functionality is available with the supplied instructions, add the reusable credentials to the console's credential fields, and use:

> From the Welcome back screen, tap **App review access**. Enter email `<REVIEWER_EMAIL>` and password `<REVIEWER_PASSWORD>`, then tap **Sign in for review**. Do not use the normal email-code button. No OTP or account creation is required. The account opens a pre-populated family journal with synthetic data. Contact `<SUPPORT_EMAIL>` if access needs to be reset.

## Troubleshooting

- **No-family screen:** restore the review user's active family membership and `active_family_id`, then retest. Do not add a client-side onboarding bypass.
- **Invalid credentials:** reset the password in Supabase, update both store consoles, and verify from a clean install.
- **Rate limit or email failure:** the reviewer route uses password auth and should not send email. Confirm the reviewer used **App review access**.
- **Review data changed:** restore the synthetic seed state without touching real production families.
