# Asset checklist — seven default frames + two opener challengers + optional slot-7 test

Source: `momora-listing-handoff-v2/approved-listing-copy.json` `screenshots`,
`opener_challengers`, and `optional_ownership_replacement`. Routes are PLAN.md §1.2,
re-verified to exist on disk in this pass. Candidate assets are PLAN.md §1.3, re-verified
(see INVENTORY.md §2).

## Seven default frames

| Frame | Headline | Job | Route / state needed | Candidate genuine source asset | Status |
|---|---|---|---|---|---|
| 01 `01-more-than-photos` | "Keep more than the photos." | Make the digital experience valuable without a print purchase | `app/(app)/(tabs)/timeline.tsx` populated with a real photo memory, a complete text story, and a sound card visible or insetable | `store-assets/source/IMG_0908.PNG` (timeline: text-only "crackers" story card + blanket-fort photo card) is genuine and covers the photo+story half. **No genuine sound-card capture exists on disk** — `SoundCard` (`src/components/memory-card.tsx`) has never been screenshotted in this checkout's asset inventory. | **partial** — confirmed. Photo+story real; sound evidence must come from a new capture (see below) or the frame ships as photo+story only, which the brief allows ("use a separate honest inset for the saved sound... do not manufacture an all-in-one memory card" or "prioritize the readable photo/story collection"). |
| 02 `02-existing-photos` | "Start with the photos you have." | Show an easier start and immediate value inside the app | `app/(app)/gallery-import/{index,review}.tsx` — the actual suggestion deck, a complete draft caption, current Keep/Set aside controls | **NO GENUINE ASSET — BLOCKED.** Nothing in `store-assets/source/`, repo-root PNGs, or `marketing/assets/ugc/demo-cuts/` shows this specific screen (the review deck). `demo-timeline-stories.mp4`/`demo-overview.mp4` are broader product cuts, not confirmed to contain this deck. | **blocked** — confirmed. Requires a new native capture (see BLOCKERS.md / CAPTURE-REQUESTS.md, owned by another WP). |
| 03 `03-unphotographed-stories` | "For the things a photo missed." | Demonstrate short capture and the illustrated-story difference | `app/(app)/new-memory.tsx` composer input + `app/(app)/memory/[id]/index.tsx` matching illustration output | `store-assets/source/IMG_0912.PNG` (ladybug watercolor illustration memory detail, `wonder` emotion) is genuine **output** evidence. The matching **composer input** (the actual short text/voice entry that produced it) is not on disk in any form found in this inventory. | **partial** — confirmed. Illustration output real; composer-input half missing. |
| 04 `04-little-voice` | "Keep their little voice, too." | Show a valuable digital outcome a printed book cannot provide | `app/(app)/memory/[id]/index.tsx` rendering `SoundStage` playback, or the timeline `SoundCard` (`src/components/memory-card.tsx`) | **NO GENUINE ASSET — BLOCKED.** No screenshot of an audio-memory player, elapsed/total duration display, or its caption exists in `store-assets/source/` or the repo-root PNGs. | **blocked** — confirmed. |
| 05 `05-optional-book` | "And a book to hold, too." | Give automatic book creation a substantial, clearly optional role | `book-renderer` sample PDF pages (offline-renderable) + `app/(app)/family/[id]/memory-books.tsx` in-app book shelf + `shop.usemomora.com` web-review context | `book-renderer/book-data/sample/...` is renderable offline for free (`npm run book:pdf -- --slug sample --spine-mm <n>`) and would give genuine page/cover imagery once rendered and converted to PNG (not done in this pass — phase 3 scope). **No in-app book-shelf screenshot and no web-review-page context exist on disk.** Committed real cover PDFs for `enzo-year-three`/`mara-year-one` exist but require the owner-photo rights gate (PLAN.md §4 gate 4) before any marketing use, so `sample` is the only immediately safe source. | **partial** — confirmed. Book pages are producible offline; in-app shelf and web-review context are missing captures. |
| 06 `06-private-family` | "For your family. Not a public feed." | Show connection and audience control inside the app | `app/(app)/sharing/{members,invite,pending-invites,approvals,redeem}.tsx` — actual invitation/member controls | `store-assets/source/IMG_0909.PNG` and `store-assets/source/ipad/s4-family.png` are genuine, but they show the **character-portrait roster** (who has an AI illustration character), which is a materially different UI from the sharing/roles/invite screens the frame's `proof` field requires. Roster ≠ roles/invites. | **partial** — confirmed, and the owner's framing is exactly right: the existing capture is real but proves the wrong claim if used to imply role/invite controls. A caption honestly describing "your family, together" over the roster is defensible; a caption implying invite/role management is not, without a new capture of `sharing/*`. |
| 07 `07-look-back` | "Here when you want to look back." | End with returning to a useful digital collection, not buying something else | `app/(app)/family/[id]/index.tsx` per-child collection, or a complete saved-memory view | `store-assets/source/ipad/spare-person-detail.png` ("Memories with Nora") is a genuine per-child collection capture on the **iPad**. `store-assets/source/IMG_0910.PNG` (reverse-chronological day list, Calendar tab) is a genuine **iPhone** capture of a real saved-memory view. Neither is the Looking Back carousel — confirmed distinct from `back-on-timeline.png`, which must stay excluded. | **ready** — confirmed on both counts: the iPad per-child collection and the iPhone day-list are both genuine, on-disk, and conceptually distinct from the excluded Looking Back asset. |

## Opener challengers (replace frame 01 only; frames 2–7 unchanged)

| Challenger | Headline | Route / state needed | Candidate genuine source asset | Status |
|---|---|---|---|---|
| `existing-photo-first` | "Your camera roll.\nTheir stories." | Same gallery-import deck as frame 02 | Same gap as frame 02 — **NO GENUINE ASSET — BLOCKED**. | **blocked** |
| `voice-first` | "Their little voice.\nYours to hear again." | Same sound-player screen as frame 04, plus a supporting collection view | Same gap as frame 04 for the player; a supporting collection view could reuse `IMG_0908.PNG`/`IMG_0910.PNG`, but the required player evidence is still missing. | **blocked** on the player; the supporting-collection half only is `partial`. |

## Optional slot-7 ownership test

| Test | Headline | Route / state needed | Candidate genuine source asset | Status |
|---|---|---|---|---|
| `07-ownership-alternative` | "Your memories\nstay yours." | Owner export action (`app/(app)/(tabs)/settings.tsx`, owner-only) + post-lapse readable archive | **NO GENUINE ASSET — BLOCKED.** No screenshot of the export action or a post-lapse read-only state exists on disk. The feature itself is real (`docs/features/data-export.md`), but no capture proves it visually. | **blocked** |

## Three provenance paths and shared source events

The brief requires three separate provenance paths — photo, story, sound — rather than one
combined "memory" concept. Mapped against what is actually on disk:

- **Photo path:** `store-assets/source/IMG_0908.PNG` (blanket-fort photo card, timeline) and
  `store-assets/source/IMG_0910.PNG` (day-list view referencing the same or adjacent dated
  entries). Both are the iPhone captures; iPad equivalents are `ipad/s3-timeline.png` and
  `ipad/s5-calendar.png`.
- **Story path:** `store-assets/source/IMG_0908.PNG`'s text-only "crackers" story card
  (`funny` emotion) is the only genuine story-text capture on disk. It is a **different
  memory** from the illustrated ladybug story in `IMG_0912.PNG` — the two should not be
  conflated as "the same story, illustrated," since they are visibly distinct entries.
- **Sound path:** **no genuine capture exists anywhere in this inventory.** Frames 01
  (inset), 04 (primary), and the `voice-first` opener all depend on this path and are all
  `partial`/`blocked` specifically because of this one missing capture category.

**Shared source events across frames:**

- Frame 01 (photo+story half) and frame 03 (illustration output) both draw from the same
  demo household (`supabase/scripts/demo-family-spec.ts`) but from **different, specific
  memories** (`IMG_0908.PNG`'s crackers/blanket-fort entries vs. `IMG_0912.PNG`'s ladybug
  entry) — they are not the same event shown twice.
- Frame 07's iPhone half (`IMG_0910.PNG`, Calendar/day-list) and frame 01's photo half
  (`IMG_0908.PNG`, Timeline) plausibly show overlapping dated entries from the same
  household's history, but this was not confirmed date-by-date in this pass; treat them as
  "same household, not confirmed same specific memory" rather than asserting continuity.
- Frame 06 (family roster, `IMG_0909.PNG`) and frame 03/01 (memories tagging those same
  family members) share the same household's people but again were not cross-checked for
  identical specific memories.
