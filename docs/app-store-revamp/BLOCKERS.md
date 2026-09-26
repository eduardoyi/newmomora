# Blockers

Only items that genuinely cannot be resolved from this checkout. Sourced from PLAN.md §1.4
and §4, re-verified in this pass, plus one new finding (the `demo-looking-back.mp4` video).
Unfinished-but-doable work (e.g. "extend the SIZES map," "render the sample book PDF") is
**not** listed here — it belongs in the relevant phase's own file, not this one.

## 1. Book generation / online-review entitlement

**Blocked:** whether generating and reviewing a book online is included in the subscription
or gated/charged separately.
**Why:** neither `docs/features/memory-book-generation.md` nor `memory-book-orders.md`
states this; `approved-listing-copy.json`'s own `commercial_context` field for this question
is set to `"verify_before_claiming_included_or_free"`, i.e. the brief itself already flags
it as open.
**What exactly is needed:** an explicit owner statement of whether generation/review
requires an active subscription, and if so what specifically is gated.
**Who can resolve it:** the product owner — this is a business-model fact, not something
derivable from code, since the code paths that would enforce it were not found to assert
either answer.

## 2. Gallery-import server-side admission gate status in production

**Blocked:** whether the server-side admission gate (distinct from the client
`EXPO_PUBLIC_GALLERY_IMPORT_ENABLED` flag, which is confirmed `true` in the `production`
build profile at `eas.json:49`) is currently enabled for the production database.
**Why:** `docs/features/gallery-import.md:151` documents that a separate database singleton
`enabled` field controls server admission, but this checkout has no way to query the live
production database's value for that field without production access, which is out of scope
for this pass (no production mutation or read was performed).
**What exactly is needed:** the owner or an operator with production database access
confirming the singleton's current value.
**Who can resolve it:** the product owner / an operator with Supabase production access.
**Why this matters for the listing specifically:** frames 01/02, the subtitle, promotional
text, and the description all lead with gallery import — if server admission is off in
production, screenshots and copy describing it as a live feature would misrepresent the
shipped product, which is an App Review risk (per PLAN.md §4 gate 1).

## 3. Native captures for blocked frames

**Blocked:** frames 02 (gallery-import deck), 04 (saved-sound player), the in-app book-shelf
half of frame 05, the sharing/roles/invite screens for frame 06, the `existing-photo-first`
and `voice-first` opener challengers, and the optional slot-7 ownership-export test all
require a screenshot of a screen state that does not exist anywhere in this checkout's
asset inventory (`store-assets/source/`, repo-root PNGs, or `marketing/assets/ugc/
demo-cuts/`).
**Why:** per PLAN.md §1.4, there is no runtime demo/fixture mode (`__mocks__/` is Jest-only,
confirmed by direct inspection — it contains only `expo-media-library.ts`,
`posthog-react-native.ts`, `react-native-purchases.ts`), no `ios/` directory (confirmed
absent), and no cached native build to launch. The populated demo content lives behind OTP
email auth in a production-pointed Supabase project. The demo seeders
(`supabase/scripts/seed-demo-*.ts`) are dry-run by default and `--apply` performs real
production writes and paid OpenAI/fal.ai calls, which PLAN.md §6 and this pass's own
constraints forbid running.
**What exactly is needed:** the owner (or someone with the seeded demo account's OTP
access) running the app on a real device or simulator, navigating to each specific screen
state, and capturing it — one exact request per gap belongs in `CAPTURE-REQUESTS.md`
(owned by a different work package, not created in this pass).
**Who can resolve it:** the product owner or another agent with device/simulator access and
the seeded demo account's OTP.

## 4. Owner-only commercial and rights facts

**Blocked:** exact localized annual SKU/offer and trial eligibility; currency code; whether
the $99 print reference amount is fixed or varies by book/page count; taxes; supported
shipping territories; explicit marketing-use approval for the `enzo-*`/`mara-*` book
material (which uses the owner's own family photographs, distinct from the fictional
`sample` slug and the fictional Kim-Ortiz demo household used everywhere else).
**Why:** these are business decisions and personal-rights approvals, not facts present in
code or docs. `approved-listing-copy.json`'s `commercial_context.currency_code_verified` is
already `false`, confirming the brief treats this as unresolved.
**Who can resolve it:** the product owner.

## 5. New finding this pass: a video demonstration of the unreleased Looking Back feature

**Blocked (as a usable asset, not as a product fact):**
`marketing/assets/ugc/demo-cuts/demo-looking-back.mp4` exists in the repository and, per its
own `README.md` in that same directory, explicitly shows the Looking Back sequence
("Rediscovering forgotten moments... memories resurfaced at the right time," with the
timestamp "The Looking Back sequence appears around 00:07–00:10 in the source demo"). This
is the same unreleased feature (`docs/features/looking-back.md:3`, status `in-progress`)
that `back-on-timeline.png` shows as a still image. PLAN.md §1.3 and §2.4 already flag
`back-on-timeline.png`; this pass additionally flags the video, which PLAN.md's file list
did not name.
**Why it is a blocker rather than just a "do not use" note:** it means the demo-cuts library
cannot be treated as a uniformly safe source — each of the six clips in that directory must
be checked against the never-claim list individually before any is used, since at least one
of the six is not safe.
**Who can resolve it:** no resolution needed beyond exclusion; recorded here so a later work
package does not rediscover this by accident and so the exclusion is traceable to evidence.
