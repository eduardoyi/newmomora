# Family-sharing E2E flows

Covers `docs/plans/family-sharing.md` §13 / `docs/features/family-sharing.md`
Testing section. **None of these flows have been run** — no simulator/device
was available while authoring them. They're written against the testIDs
that exist in the code (see each file's header comment for the exact
screens/props relied on) but should be treated as a first draft: run them
against a real EAS dev build and fix up selectors/timing before trusting
them in CI.

## Why split into numbered files instead of one flow

A single continuous flow is possible in principle (Maestro keeps
`copyTextFrom`'s captured text and env vars live for the whole process), but
the loop needs a hard "become a different signed-in user" transition twice,
and the post-redeem **waiting screen has no sign-out affordance** while a
redemption is pending (`app/(app)/sharing/waiting.tsx` only renders a button
in the `rejected`/`unavailable` states). `01-04` use
`launchApp: { clearState: true }` between steps as a stand-in for "sign
out" — it clears the local session so the next step's login screen shows
regardless of where the previous step left off. Splitting into numbered
files makes each stage's starting assumption explicit and keeps any one
file re-runnable/debuggable on its own (with the caveats below).

## Run order

Maestro only shares `copiedText` (the invite code from step 1) and
inline `env:` overrides across files when they're passed to **one**
`maestro test` invocation, in order:

```bash
maestro test \
  -e TEST_EMAIL=owner@example.com -e TEST_PASSWORD=... \
  -e TEST_EMAIL_2=invitee@example.com -e TEST_PASSWORD_2=... \
  .maestro/flows/sharing/01-owner-create-invite.yaml \
  .maestro/flows/sharing/02-second-account-redeem.yaml \
  .maestro/flows/sharing/03-owner-approve.yaml \
  .maestro/flows/sharing/04-second-account-sees-timeline.yaml
```

Running a single file (e.g. `maestro test 03-owner-approve.yaml`) skips the
invite-code capture from step 1 and will fail at `inputText:
${maestro.copiedText}` in step 2 -- the four files are a unit, not
independently runnable flows.

`viewer-readonly.yaml` **is** independently runnable, but assumes
`TEST_EMAIL_2`/`TEST_PASSWORD_2` is already a viewer member of a family
with at least one memory (true after 01-04 has run once, since step 1
invites that account as a Viewer).

## Test accounts and TEST_EMAIL_2/TEST_PASSWORD_2

`TEST_EMAIL_2`/`TEST_PASSWORD_2` are not defined in `.maestro/.env.example`
yet -- add them there (a second `__DEV__`-password-enabled Supabase user,
same pattern as `TEST_EMAIL`/`TEST_PASSWORD` in
`docs/features/auth.md`/`.maestro/flows/auth/sign-in.yaml`) before running
this group.

## Known idempotency gap

`redeem-family-invite` rejects an already-member redeemer with
`already_member` (see `supabase/functions/redeem-family-invite/index.ts`).
Re-running `01-04` against the **same** two persistent test accounts a
second time will fail at step 2 once the invitee is already a member of the
owner's family from the first run. There is no reset script in this repo
yet -- either provision fresh test accounts per run, or add a
`supabase/scripts` cleanup step (out of scope for this change) that deletes
the invitee's `family_memberships` row for the owner's family between runs.
