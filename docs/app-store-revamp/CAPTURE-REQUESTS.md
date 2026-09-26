# Capture requests — v2 memory-first listing

Produced by WP-C (`docs/app-store-revamp/PLAN.md` §5, §1.4). Every request below
is for a gap this work package could not close from the checkout: either the
populated demo content lives in a production-pointed Supabase project behind
OTP email (`the seeded demo account address (in supabase/scripts/, not repeated here)`, PLAN.md §1.4), or the needed screen has
no genuine capture on disk and no offline fixture to substitute. **Do not**
invent, mock up, or AI-generate any of these — they are native-capture
requests only.

General device/target notes (apply to every request unless stated otherwise):

- **iPhone target:** 6.9" portrait, **1260×2736** native capture (PLAN.md §2
  correction; Apple's live spec, not the handoff's original 1320×2868 guess).
  A 1260×2736 capture can additionally be re-exported to the `appstore-alt`
  (1320×2868) and `appstore-65` (1284×2778) buckets by the compositor (WP-D);
  this work package only needs the one native capture per screen.
- **iPad target:** 13" portrait, **2064×2752** native capture (matches the
  existing `store-assets/source/ipad/*.png` captures already on disk).
- **Demo state required:** the same fictional Kim-Ortiz household already
  seeded and captured in `store-assets/source/*` (Maya, Theo, Ari, Nora,
  Gabriel) — reuse those names/dates so new captures stay continuous with the
  crops already prepared in `store-assets/v2/assets/`. Do not seed a new
  family.
- **Safety line (applies to every request, especially #06):** no live invite
  tokens, no real customer media, no real email addresses, no real
  addresses. Any invite code shown must be fictional, expired, or redacted.

---

## 01 — Timeline with photo + story + sound together (or confirmed separate)

**Frame:** 01 (Keep more than the photos)
**Route:** `app/(app)/(tabs)/timeline.tsx`
**Device:** iPhone 6.9", 1260×2736
**Demo state:** a timeline day/week that contains a real photo memory, a real
text story memory, AND a real saved-sound memory, close enough together to
either fit one viewport or to make an honest partial-scroll case clear.
**Missing input:** none of the four genuine iPhone captures on disk
(`IMG_0908/0909/0910/0912`) contain a saved-sound card — only photo and text
story cards. Whether a sound card fits naturally into this same
timeline/week is unverified.
**Expected filename/destination:** `store-assets/v2/raw/crops/timeline-with-sound-candidate.png`
(raw), then a tight crop to `store-assets/v2/assets/timeline-sound-card.png`
if a genuine `SoundCard` is visible; otherwise confirm in state.json that the
"honest separate inset" path (already partly covered by the frame-04 capture
below, request #04) is the one actually used for frame 01, per
MASTER-BRIEF.md §01's explicit allowance ("use a separate honest inset for
the saved sound; do not manufacture an all-in-one memory card").
**Replacement step:** once delivered, replace the frame-01 composition's sound
element with the real `SoundCard` crop; do not alter frame 01's story/photo
elements, which are already covered by `timeline-story-card.png` and
`timeline-photo-card.png`.

---

## 01b — Complete-text detail view of the crackers story (truncation fix)

**Frame:** 01 (Keep more than the photos) / 07 (Here when you want to look back)
**Route:** `app/(app)/memory/[id]/index.tsx`
**Device:** iPhone 6.9", 1260×2736
**Demo state:** the memory-detail view for the SAME "Maya packed three
crackers…" text story already cropped in `store-assets/v2/assets/timeline-story-card.png`,
opened to its full untruncated text.
**Missing input:** the only capture of this story on disk
(`store-assets/source/IMG_0908.PNG`) shows it as a TIMELINE CARD, which
truncates it: "Maya packed three crackers in her little purse 'in case the
playground gets hungry.' Theo ate the emergency crackers be…". MASTER-BRIEF.md
requires a COMPLETE short story for frames 01 and 07 and explicitly says
truncated rows do not establish the value — this specific capture cannot
satisfy that requirement on its own. `illustration-detail.png` (the ladybug
memory) already satisfies the complete-story requirement and can be used in
the meantime; this request exists so the SAME crackers story — already
established as a continuity anchor across `timeline-story-card.png` and
`day-list.png` — can also appear complete somewhere in the set.
**Expected filename/destination:** `store-assets/v2/raw/crackers-story-detail.png`
→ crop to `store-assets/v2/assets/crackers-story-detail.png`.
**Replacement step:** once delivered, this becomes an alternate/additional
complete-story asset alongside `illustration-detail.png`; no existing asset
needs to be removed.

---

## 02 — Gallery import suggestion deck (Keep / Set aside)

**Frame:** 02 (Start with the photos you have)
**Route:** `app/(app)/gallery-import/review.tsx`
**Device:** iPhone 6.9", 1260×2736
**Demo state:** the actual suggestion-deck screen showing a cluster of older
accessible photos, one complete grounded AI-drafted caption (not a
placeholder ellipsis), and the current Keep / Set aside controls visible and
tappable.
**Missing input:** no capture of this screen exists anywhere in the checkout
(`store-assets/source/`, repo root, or `marketing/assets/`). Reaching this
screen requires either:
  (a) the `gallery-import-e2e` EAS build profile with camera-roll test photos
      loaded on a real device/simulator, or
  (b) the production flag path (`eas.json:49`, `src/utils/gallery-import-flags.ts:7`)
      PLUS the separate server-side admission gate documented at
      `docs/features/gallery-import.md:151` (PLAN.md §4 owner gate #1 — unresolved
      whether admission is enabled in production).
Both paths need owner action; neither is available from this checkout.
**Expected filename/destination:** `store-assets/v2/raw/gallery-import-deck.png`
→ crop to `store-assets/v2/assets/gallery-import-deck.png`.
**Replacement step:** once delivered, this becomes the frame-02 hero image.
Its approved/Kept output should reuse the SAME source event already shown in
frame 01 or revisited in frame 07 (MASTER-BRIEF.md §02) — coordinate the demo
photos used here with whichever event `timeline-photo-card.png` represents
(the blanket-fort photo, 18 Jul 2026) if that continuity is wanted, or pick a
new consistent event and note the change in state.json.

---

## 03 — Composer entry for the ladybug story (input/output correspondence)

**Frame:** 03 (For the things a photo missed)
**Route:** `app/(app)/new-memory.tsx`
**Device:** iPhone 6.9", 1260×2736
**Demo state:** the composer screen with the SAME short text already typed
in that produced the existing ladybug illustration — i.e. literally
"Maya found a ladybug on the windowsill and asked if it had a mommy who knew
where it was." (the exact caption text on `store-assets/v2/assets/illustration-detail.png`,
sourced from `store-assets/source/IMG_0912.PNG`) — visible as composer input,
not yet saved.
**Missing input:** no capture of the composer mid-entry exists. `composer2.png`
at the repo root is rejected (error state, see ASSET-MANIFEST.json). No
demo-video frame shows this exact text being typed for the ladybug memory
either (the voice-capture/overview cuts show a different sample line, "Today,
Maya decided to play with the LEGOs...").
**Expected filename/destination:** `store-assets/v2/raw/composer-ladybug.png`
→ crop to `store-assets/v2/assets/composer-ladybug-input.png`.
**Replacement step:** once delivered, pair it with the already-prepared
`illustration-detail.png` as frame 03's input/output pair — no other changes
needed since the illustration half is already done.

---

## 04 — Saved sound memory (SoundStage playback with duration)

**Frame:** 04 (Keep their little voice, too)
**Route:** `app/(app)/memory/[id]/index.tsx` (SoundStage playback view) and
`src/components/memory-card.tsx` (`SoundCard`, for the timeline card half)
**Device:** iPhone 6.9", 1260×2736
**Demo state:** a genuinely KEPT sample recording (not a dictation-then-discard
note) open in its detail view, showing a visible elapsed/total duration and
its editable caption; plus, separately, the same memory's `SoundCard` as it
appears on the timeline.
**Missing input — evaluated, not assumed:** this task exhaustively reviewed
every ~0.5s frame (102 frames total, kept as evidence in
`store-assets/v2/raw/video-frames/`) of all four named demo-video cuts
(`demo-voice-capture.mp4`, `demo-overview.mp4`, `demo-timeline-stories.mp4`,
`demo-family-feed.mp4`). **None of them show a `SoundStage` player, a
waveform, or a visible duration anywhere.** `demo-voice-capture.mp4` and
`demo-overview.mp4` both show the DICTATION flow instead — a "Tell me what
happened" recording prompt → "Transcribing…" → the transcript is inserted as
plain TYPED TEXT ("Today, Maya decided to play with the LEGOs and not share
with her brother and sister.") into the composer. Per PLAN.md §1.1, dictation
audio is transcribed and then discarded — it is explicitly NOT the
retained-audio ("keep the sound") feature this frame needs to prove. No
capture of the retained-audio flow exists anywhere in this checkout.
**Expected filename/destination:** `store-assets/v2/raw/soundstage-detail.png`
and `store-assets/v2/raw/timeline-sound-card.png` → crop to
`store-assets/v2/assets/soundstage-detail.png` and
`store-assets/v2/assets/timeline-sound-card.png`.
**Replacement step:** once delivered, this becomes the sole real evidence for
frame 04 (currently frame 04 has NO genuine asset — see acceptance-test note
below) and can also supply the "separate honest inset" for frame 01 (request
#01).

---

## 05 — In-app book shelf/scope picker + genuine shop.usemomora.com browser capture

**Frame:** 05 (And a book to hold, too)
**Route:** `app/(app)/family/[id]/memory-books.tsx` (in-app shelf/scope
picker) and a real browser navigation to `shop.usemomora.com`'s review page
**Device:** iPhone 6.9", 1260×2736 for the in-app shelf; any real mobile
Safari/Chrome capture showing true browser chrome (address bar, tab UI) for
the web half
**Demo state:** the in-app shelf showing the child + scope (age-year /
calendar-year / everything) picker in its real state; separately, an actual
browser session at `shop.usemomora.com` reviewing a generated book (real
login required — MASTER-BRIEF.md is explicit that this is a separate login,
not an in-app WebView).
**Missing input:** no capture of `memory-books.tsx` exists in this checkout.
The `shop.usemomora.com` review flow requires a live account and a generated
book order to review — neither is available from this checkout, and per this
task's constraints, no order may be placed and no login may be performed.
**What this work package DID produce instead:** four renders from the
`sample` book slug, all now resolved after two rounds of coordinator visual
review at full size (2026-09-20). **`book-cover-sample.png`,
`book-spread-sample.png`, AND `book-spread-text-sample.png` (pages 16/17)
are all reclassified `draft-placeholder` in `ASSET-MANIFEST.json` and moved
to `store-assets/v2/raw/rejected/` — none are usable frame-05 evidence.** The
cover shows a literal "cover photo 2400x1600" placeholder label baked into
the sample book's own data; the pages-10/11 spread's left page shows a
literal "portrait 480x600" placeholder label; the pages-16/17 spread's left
page (page 16) prints a QR/scan-mark element whose short code is FABRICATED
(`book-renderer/src/model/fitter.ts:1180`'s `placeholderShortCode()`) and
which implies the printed book plays audio — a non-functional link and a
banned implication (see `ASSET-MANIFEST.json`'s `audioQrFinding` for the
full write-up; this is also a real, useful correction to
MASTER-BRIEF.md's audio product-boundary row, which turns out to be
factually out of date). **`store-assets/v2/assets/book-page-text-sample.png`
(page 11 alone, a single page, not a spread) is the one usable renderer
asset for this frame's interior half** — confirmed by direct inspection to
have neither a placeholder-dimension label nor any ScanMark/QR element, and
it carries a complete, untruncated story. Frame 05 still has **no usable
cover**, since every cover this task is authorized to render (`sample` only)
is placeholder art by construction (the sample book's own manifest has no
real cover photo to lay out).

### 05a — HIGHEST-VALUE UNBLOCK: real-photo book render (owner approval required)

**RESOLVED for enzo-year-three, 2026-09-20.** The owner granted explicit
approval to use `enzo-year-three` specifically — it is the book they already
rendered and printed — and NOT `enzo-year-one`, `enzo-year-two`,
`mara-year-one`, or `mara-year-two`, which remain gated exactly as described
below. A follow-up task re-confirmed `book-renderer/scripts/lib/renderBookPdfs.ts`
was still offline/loopback-only, ran `cd book-renderer && npm run book:pdf --
slug enzo-year-three --spine-mm 12` to a scratch `--out-dir` (the committed
`book-data/enzo-year-three/print/cover.pdf` was backed up and never
overwritten), converted both outputs to PNG with `pdftoppm -r 200 -png`, and
screened candidate pages using `fitBookForPrint`'s own page-fit output to
target 122 pages without brute-force converting all of them. Result: two new
`renderer-export` assets, both real photographs of Enzo's family, neither
carrying any ScanMark/QR element or placeholder-dimension text —
`store-assets/v2/assets/book-cover-enzo.png` (1655×1653, the real front
cover) and `store-assets/v2/assets/book-spread-enzo.png` (3306×1653, pages
56–57, two anchor-media pages with real photos and complete readable
captions). Full provenance, the exact render command/checksums, and the
page-survey method (which pages were rejected and why) are in
`store-assets/v2/ASSET-MANIFEST.json`. Frame 05 in
`store-assets/manifest.v2.json` now uses `book-spread-enzo.png` as its
dominant card asset. **What still remains, unchanged:** the in-app book
shelf (`app/(app)/family/[id]/memory-books.tsx`) and the
`shop.usemomora.com` browser review are still uncaptured (see the main #05
request above and the "Expected filename/destination (in-app shelf +
browser…)" paragraph below, both still open), and a cleared photograph of
the physical printed copy is still an equally-acceptable alternative per
MASTER-BRIEF.md that nobody has taken. Frame 05 therefore **stays `draft`**
in the manifest — its draft reason was shortened to "In-app shelf and
browser review not yet captured." (also fixing a pre-existing bug where the
draft banner's reason text overflowed the canvas edge on all four buckets).

**UPDATE 2026-09-20 (same day, follow-up review):** a coordinator review
found the spread's embedded caption text illegible (a few pixels tall at
spread scale) and asked for the enlarged-callout technique (already used on
frames 02/04/06) applied with a TRUE crop of the real page, never a
retypeset/recreated caption. Separately, the owner decided the store
caption must read in English — done by re-rendering from a translated,
derived copy of the book data (`book-renderer/book-data/enzo-year-three-en/`,
`manifest.language: "en"`, only the 7 real photo captions in the whole book
translated, none containing a child's own quoted words), never by editing
pixels. Frame 05 now uses `book-spread-enzo-en.png` (dominant spread,
English) plus a new `book-callout-enzo-en.png` enlarged callout (a real
crop of page 56's photo and caption, English, placed larger in the dead
space below the spread). The original Spanish-language
`book-spread-enzo.png`/`book-cover-enzo.png` remain in the manifest as the
accurate record of the real printed (Spanish) book — the printed copy on
the owner's shelf and this store image intentionally will not match
word-for-word; see `ASSET-MANIFEST.json` for the full Spanish→English
caption table and legibility measurements per bucket. Frame 05 still stays
`draft` — only the book-evidence half changed.

The original (now historical) request follows, describing the state before
this approval:

`book-renderer/book-data/enzo-year-one/` and `book-renderer/book-data/mara-year-one/`
contain **real JPEG photographs of the owner's own family**
(verified on disk, e.g. `enzo-year-one/assets/c1f85a19-ad02-5da8-96b3-3c75588e2164-1.jpg`).
`mara-year-one/print/cover.pdf` and `enzo-year-three/print/cover.pdf` are
already-committed real covers built from these photos; `enzo-year-one` has
the same real photo assets but no committed `print/` output yet. Rendering
either one is **the exact same one-command, offline, free render this task
already ran for `sample`** — only the `--slug` changes:

```
cd book-renderer && npm run book:pdf -- --slug enzo-year-one --spine-mm <n>
cd book-renderer && npm run book:pdf -- --slug mara-year-one --spine-mm <n>
```

This task did **not** run either command and did not open, render, or
convert the already-committed `enzo-year-three`/`mara-year-one` cover PDFs,
because PLAN.md §4 gates any marketing use of the owner's real family photos
on **explicit owner approval** — that gate is not this task's to clear.
**This is the single highest-value unblock for frame 05**: once approved, a
real cover + real interior spread (both with actual family photographs, real
generated layout, real captions) becomes available from a command that is
already known to work, with no new capture, login, or purchase needed. The
alternative — a cleared photograph of the physical printed sample book — is
equally acceptable per MASTER-BRIEF.md but requires an existing printed copy
and a camera, not a render.
**Missing input:** explicit owner sign-off to use `enzo-year-one`,
`enzo-year-three`, or `mara-year-one`'s real family photos in marketing
material (PLAN.md §4, owner gate #4).
**Expected filename/destination:** once approved, render, convert with the
same `pdftoppm` method used for `sample`, and save to
`store-assets/v2/assets/book-cover-real.png` and either
`store-assets/v2/assets/book-spread-real.png` or a single-page equivalent —
apply the SAME QR/ScanMark and placeholder-dimension screening used for
`book-page-text-sample.png` before picking a page/spread, since a real book
with real photos can still contain a real (now genuinely resolving) audio
QR that would need the owner-verification questions in `ASSET-MANIFEST.json`'s
`audioQrFinding` answered first.

**Expected filename/destination (in-app shelf + browser, still needed either
way):** `store-assets/v2/raw/memory-books-shelf.png` → crop to
`store-assets/v2/assets/memory-books-shelf.png`; and
`store-assets/v2/raw/shop-review-browser.png` → crop to
`store-assets/v2/assets/shop-review-browser.png`.
**Replacement step (superseded — see the RESOLVED note above):** the plan
described here was to pair the in-app shelf capture with (a) an
owner-approved real cover/spread once cleared, (b) a cleared photograph of
the physical printed sample, or (c) `book-page-text-sample.png` alone as a
last resort. Path (a) is now done — `book-cover-enzo.png` and
`book-spread-enzo.png` are real, owner-approved, and in use — but frame 05
still needs the in-app shelf capture and the browser review before the
draft banner can come off, so it remains in that state meanwhile.
`book-cover-sample.png`, `book-spread-sample.png`, and
`book-spread-text-sample.png` remain withdrawn to
`store-assets/v2/raw/rejected/` and must still never be used.

---

## 06 — Member roster with real role differences + invite screen

**Frame:** 06 (For your family. Not a public feed.)
**Route:** `app/(app)/sharing/members.tsx` (roster showing owner/manager/viewer
role differences) and `app/(app)/sharing/invite.tsx` (invite flow)
**Device:** iPhone 6.9", 1260×2736
**Demo state:** the actual member list showing at least two different roles
(e.g. an owner and a viewer) with visibly different affordances, plus the
invite screen with a FICTIONAL, EXPIRED, or REDACTED invite code — never a
live, redeemable code, and no real email address anywhere in the shot.
**Missing input:** no capture of either screen exists in this checkout.
`store-assets/v2/assets/family-roster.png` (prepared by this task) is the
**character-portrait roster** from `app/(app)/(tabs)/family.tsx` ("Your
people") — a different screen that does not show roles or invite controls.
Do not conflate the two; frame 06 needs the actual sharing/roles screen.
**What this work package DID produce instead:** `family-comments-inset.png`,
a genuine small inset (native 720×1280 source, cropped to 560×900) pulled
from `marketing/assets/ugc/demo-cuts/demo-family-feed.mp4`, showing 4 real
extended-family names (Lucia Ortiz, Rafael Ortiz, Gabe Ortiz, Eunji Kim)
commenting on a shared memory about Maya and Ari. This can serve as
MASTER-BRIEF §06's *optional* "separately captured shared memory" element,
but it is NOT a substitute for the actual member/invite controls this
request is for, and its low source resolution means it must stay a small
inset, never a full-bleed device image (see this task's report for the full
legibility verdict).
**Expected filename/destination:** `store-assets/v2/raw/sharing-members.png`
→ crop to `store-assets/v2/assets/sharing-members.png`; and
`store-assets/v2/raw/sharing-invite.png` → crop to
`store-assets/v2/assets/sharing-invite.png` (invite code must be
fictional/expired/redacted before this file is created — verify before
capture, not after).
**Replacement step:** once delivered, these become frame 06's primary
evidence; `family-comments-inset.png` can remain as the optional secondary
element or be dropped if the primary roster/invite captures are strong
enough alone.
**Safety line:** no live invite tokens, no real customer media, no real
email addresses, no real addresses — this applies to the capture itself, not
just this write-up.

---

## Cross-cutting note for the phase-4/5 implementers

Per MASTER-BRIEF.md's acceptance test #4 ("All seven default frames … exist
for each required device family, or have precise blockers"): as of this
work package, frames **02, 03 (input half), 04, 05 (in-app + web halves
only — the cover half is RESOLVED, see below), and 06 (roster/invite
halves)** have NO genuine, usable asset and must either wait for the above
captures/approvals or ship with a visible draft banner and be excluded from
the upload manifest per PLAN.md §6. **UPDATE 2026-09-20:** frame 05's cover
half is no longer a decision gate — the owner granted explicit approval for
`enzo-year-three` specifically (request #05a above), and a follow-up task
rendered it and prepared `book-cover-enzo.png` and `book-spread-enzo.png`
(real photographs, real captions, no QR/placeholder content), now wired into
`store-assets/manifest.v2.json` as frame 05's dominant asset. Frame 05
remains `draft` regardless, because its in-app shelf and browser-review
halves are still uncaptured — only the cover/interior half moved from
"blocked on owner approval" to "done." Frames **01 (photo/story halves, with
the story half's completeness caveat in request #01b), 07, and 05's
book-evidence half (now `book-cover-enzo.png` + `book-spread-enzo.png`, real
photographs — superseding the earlier `book-page-text-sample.png` single-page
fallback, which remains a legitimate but no-longer-used renderer-export)**
have genuine, inspection-passing prepared assets in `store-assets/v2/assets/`
as of this task. `book-cover-sample.png`, `book-spread-sample.png`, AND
`book-spread-text-sample.png` remain on disk under
`store-assets/v2/raw/rejected/` for documentation purposes only (the first
two prove the renderer runs; the third additionally documents a real
product finding — fabricated placeholder audio-QR short codes, see
`ASSET-MANIFEST.json`'s `audioQrFinding`) — all three are reclassified
`draft-placeholder` and must NOT be promoted to any frame composition or
upload manifest. `enzo-year-one`, `enzo-year-two`, `mara-year-one`, and
`mara-year-two` remain unapproved for marketing use — the owner's approval
was for `enzo-year-three` only — and were not opened, rendered, or used.
Owner-export / post-lapse trust evidence (for the
description and the optional frame-7 challenger) was not captured by this
task either — no route for it was named
in scope; flag separately if needed for `docs/features/data-export.md`'s
owner-only export
flow.
