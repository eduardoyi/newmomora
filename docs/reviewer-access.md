# Store reviewer access runbook

Momora normally signs users in with a one-time email code. App Store and Google
Play review must not depend on code delivery, so each submitted build has one
dedicated, reusable Supabase email/password account. A reviewer enters the
provided email in the normal Welcome back email field. The app recognizes only
that exact email (after trimming and case normalization), opens a generic
password screen, and never sends an OTP for it. The app contains no password
or review-specific visible affordance. The dedicated email is an intentionally
committed non-secret route classifier; the reusable credential pair is kept
operationally only in the team's password manager and secure store-console
fields.

## One-time production setup

1. In the production Supabase dashboard, create a dedicated auth user using a
   role inbox you control. Use a strong, randomly generated password and mark
   the email confirmed.
2. Store the reusable credential pair only in the team's password manager and
   the secure reviewer-credential fields in App Store Connect and Google Play
   Console. The dedicated email is also a non-secret classifier in app source;
   never put the password or any other secret in the repository, EAS public
   variables, release notes, screenshots, chat, or analytics.
3. Enter the dedicated email through the normal login field, sign in with its
   password, and create a synthetic review family. Add at least one synthetic
   family profile, several memories covering the release's important formats,
   and any other state a reviewer needs. Do not use a real child's name, image,
   journal text, or contact details.
4. Confirm the account has a valid `user_profiles.active_family_id` and active
   `family_memberships` row by signing out, clearing app data, and signing in
   again. It must open the populated timeline instead of the no-family/onboarding
   flow. The app intentionally has no onboarding bypass.

Account creation, password assignment, family seeding, and store-console entry
are manual release operations. No source-code or migration step creates the
reviewer account.

## Current production-fixture verification

Backend/account/media verification completed July 17, 2026. This does **not**
replace the pending clean-install verification of the exact submitted build's
email-triggered UI.

- The dedicated production reviewer account is confirmed and its stored
  password works through production authentication.
- Its synthetic fixture has one active owner membership, a selected active
  family, and completed onboarding.
- The fixture contains two explicitly synthetic adult profiles with ready
  portraits, plus one text-only and one ready illustrated memory. The
  illustrated example is tagged only to its intended synthetic profile.
- Authenticated private-media access works for the fixture. `get-media-url` was
  redeployed and is active at version 12 after the prior deployed version
  rejected versioned illustration keys.

The credential fields in App Store Connect and Google Play Console, and a
clean-install check of the exact submitted release build, remain required before
submission. Do not add the actual reviewer email, password, identifiers, keys,
URLs, or journal text to this document.

## Before every submission

1. Reset the synthetic journal to a stable review-ready state. Remove
   reviewer-created test content from the prior review if it obscures the seeded
   examples, and restore any deleted examples.
2. From a clean install of the exact release build, enter the provided reviewer
   email on Welcome back, then enter the stored password on the password screen.
   Verify the populated timeline and all review-critical flows.
3. Verify the same credentials in both store consoles. Avoid rotating them
   during an active review. If rotation is necessary, update Supabase, the
   password manager, and both consoles together, then repeat the clean-install
   test.
4. After review, inspect the synthetic family for unexpected personal
   information and remove it. Keep the account active and seeded for follow-up
   review unless the submission is fully closed.

## App Store Connect wording

Enter the reusable values in App Review Information's sign-in fields. Use this
in **Notes**, replacing only the placeholders in the secure console:

> Momora normally uses an email one-time code. For review, enter
> `<REVIEWER_EMAIL>` on the Welcome back screen, tap **Continue**, then enter
> `<REVIEWER_PASSWORD>` and tap **Sign in**. No OTP or account creation is
> required. The account opens a pre-populated family journal with synthetic
> data. Please contact `<SUPPORT_EMAIL>` if access needs to be reset.

## Google Play Console wording

Create an **App access** instruction named `Momora reviewer access`. Mark that
all functionality is available with the supplied instructions, add the reusable
credentials to the console's credential fields, and use:

> On the Welcome back screen, enter `<REVIEWER_EMAIL>` and tap **Continue**.
> Enter `<REVIEWER_PASSWORD>` on the next screen and tap **Sign in**. Do not use
> another email address or create a new account. No OTP is required. The account
> opens a pre-populated family journal with synthetic data. Contact
> `<SUPPORT_EMAIL>` if access needs to be reset.

## Troubleshooting

- **No-family screen:** restore the review user's active family membership and
  `active_family_id`, then retest. Do not add a client-side onboarding bypass.
- **Invalid credentials:** reset the password in Supabase, update both store
  consoles, and verify from a clean install.
- **Rate limit or email failure:** confirm the exact dedicated email was entered
  in the normal login field. Its password branch should not send email.
- **Review data changed:** restore the synthetic seed state without touching
  real production families.
