# App Review guidance — v2 memory-first listing

For the App Review team. **No credentials appear in this file or anywhere in this
repository's tracked files.** Sign-in credentials for the demo/review account must be
supplied separately through App Store Connect's "App Review Information" → "Sign-in
required" fields, not committed here. A Maestro flow already exists at
`.maestro/flows/auth/app-review-access.yaml` for automated sign-in during internal testing;
reviewers do not need to run it, but it confirms a documented, repeatable sign-in path
exists for this app if that is useful context.

## How to find gallery import

1. From the timeline or onboarding, look for the entry point into "Add from your photos" /
   gallery import (`app/(app)/gallery-import/index.tsx`).
2. Grant photo-library permission when prompted. The app requests access to review
   existing photos; it does not modify the camera roll.
3. The app groups recent photos into suggested moments and shows a review deck
   (`app/(app)/gallery-import/review.tsx`) with an AI-drafted caption per group.
4. Use the **Keep** control to accept a suggestion into the memory composer, or **Set
   aside** to skip it for this pass. Nothing is auto-approved.
5. Small (512px) previews of photos under review are uploaded to a private storage bucket
   for the AI captioning step before you approve anything; only approved photos retain
   their full-resolution original in the app's storage. This is disclosed in-app and in the
   app's privacy documentation.

**Note for reviewers:** whether the server-side admission gate for this feature is
currently enabled for all production accounts is a separate control from the client build
flag, and its live status was not independently confirmed by the team preparing this
listing (see the app's own internal `BLOCKERS.md`, not part of the review package). If the
reviewer's test account does not see the gallery-import entry point, that is the likely
reason, not a broken build.

## How to find audio memories

1. Open the memory composer (the same entry used for a text memory).
2. Choose to add a memory by voice. Two distinct paths exist:
   - **Dictation**: speaking a note that gets transcribed to text. The audio itself is
     discarded after transcription — only the text is kept. This is the default voice
     input path.
   - **"Keep the sound"**: an explicit, separate action that keeps the actual audio
     recording as the memory artifact itself, not just its transcript.
3. A kept-sound memory appears in the timeline as a playable sound card/tile
   (`src/components/memory-card.tsx`, `SoundCard`) and in its own memory-detail view
   (`app/(app)/memory/[id]/index.tsx`, `SoundStage`) with visible elapsed/total duration and
   an editable caption. Tap to play it back.

## How to find the book online-review and order flow

1. From a child's collection (`app/(app)/family/[id]/index.tsx`), open the memory-book
   entry point (`app/(app)/family/[id]/memory-books.tsx`).
2. Choose a child and a time scope (a specific age-year, a calendar year, or "everything").
   The app assembles an AI-curated outline and lays out pages automatically — no manual
   page design is required.
3. Reviewing the generated book, making any permitted edits, and completing the purchase
   all happen in the device's **system browser**, at `shop.usemomora.com`, with its own
   separate login — **this is deliberately not an in-app WebView or a native page editor.**
   Reviewers should expect to be handed off out of the app at this point; that hand-off is
   the intended, documented design, not a broken deep link.
4. The printed book is a separate purchase (Stripe Checkout) from the app subscription —
   reviewers should not expect it to be included in, or unlockable via, the subscription
   alone. Whether *generating and reviewing* the book online itself requires an active
   subscription is a detail the team preparing this listing could not verify from the
   codebase alone (see `OWNER-SIGNOFF.md`); if the reviewer's test account behaves
   differently than expected here, please note the exact behavior observed.

## General notes for the reviewer

- All screenshots in this submission use a documented fictional demo household (a family
  named Kim-Ortiz in this repository's own seed data) — no real customer data appears in
  any listing asset.
- The listing's screenshots and description deliberately do not reference and should never
  be compared against: an in-app search feature, a "Looking Back" recap/resurfacing
  carousel, or a home-screen widget. None of these are part of the current store release,
  regardless of what internal development branches may contain.
- If a described feature (gallery import, audio memories, or the book flow) is not visible
  to the specific review account provided, please flag which one and at what step — this
  listing's own internal QA process (see `docs/app-store-revamp/BLOCKERS.md`) already
  flagged the same open question about production feature-flag state ahead of submission,
  so a reviewer report confirming or denying it would resolve a currently-open item.
