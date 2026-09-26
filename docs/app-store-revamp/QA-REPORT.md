# QA report — phase 5, independent review

**Reviewer:** fresh phase-5 session (Claude Sonnet 5), no memory of phases 0–4, no
authorship of any prior file in this handoff. Read files and opened images directly rather
than trusting `state.json` or prior prose. Date: 2026-09-20. Branch: `listing/v2-memory-first`.
Nothing was published, uploaded, submitted, priced, ordered, or committed by this pass.

Scope note: this report separates **VERIFIED** (I ran the check myself, in this session)
from **TAKEN ON TRUST WITH SPOT-CHECK** (I read the prior evidence file and independently
re-derived a sample of its claims) from **UNVERIFIED** (no live/production check was
possible from this checkout, logged as unverified, never as passed).

---

## 1. Copy validation — VERIFIED (re-run + independently re-implemented)

Commands actually run in this session (Node 20 via `nvm use 20`):

```
node store-assets/listing/build-copy.mjs      # exit 0
node store-assets/listing/validate-copy.mjs   # exit 0, status: "pass"
```

I did not stop at the validator's own report. I independently re-counted every exported
file with a standalone Python one-liner reading raw bytes and UTF-8-decoded characters:

| Field | Limit | My count | Validator's count | Result |
|---|---|---|---|---|
| name | ≤30 chars | 23 | 23 | PASS |
| subtitle | ≤30 chars | 30 | 30 | PASS (at limit, not over) |
| promotional_text | ≤170 chars | 132 | 132 | PASS |
| description | ≤4000 chars | 2067 chars / 2087 UTF-8 bytes | 2067 | PASS |
| keywords | ≤100 UTF-8 bytes | 66 bytes | 66 | PASS |
| whats_new | ≤4000 chars | 377 | 377 | PASS |

I independently diffed each `out/en-US/*.txt` file against `registry.v2.json`'s
`public_fields` — all six fields (`name`, `subtitle`, `promotional_text`, `description`,
`keywords`, `whats_new`) match byte-for-byte (MATCH on every field, my own script, not the
validator's).

I independently grepped the registry and every exported `.txt` file for `\$[0-9]` (dollar
amounts) and for the four forbidden terms (`search`, `recap`, `looking back`, `widget`,
case-insensitive). Both scans came back clean in the public fields: the only two hits are
inside `registry.v2.json`'s own internal guard-config keys (`public_exact_prices_guard`,
`forbidden_public_vocabulary`), which describe the rule, not violate it. **No `$` amount
and no banned feature word appears in any generated public field.**

`screenshot-copy.txt` is explicitly labeled "internal — not an App Store Connect field. Do
not upload this file." — correctly excluded from the public-field set.

## 2. Every rendered image — VERIFIED, opened with Read (visual tool)

I generated 500px-wide thumbnails (`sips -Z 500`) for all 28 `out/v2/<bucket>/*.png`
frames, plus the two opener-challenger frame-1s, and opened every one with the image
viewer. I additionally opened four frames at ~1000px to check disclosure legibility and
text-clipping at higher fidelity: `ipad/05-optional-book.png`, `ipad/07-look-back.png`,
`appstore/01-more-than-photos.png`, `appstore/03-unphotographed-stories.png`.

**Frames actually opened this session (with what I saw):**

- `appstore/01-more-than-photos.png` (thumb + full) — DRAFT banner clearly legible even
  at 500px. Real text-story card ("Maya packed three crackers…") and real photo card
  (blanket fort) render cleanly, no clipping, no overlap. A dashed "Saved sound — not yet
  captured" placeholder is honestly labeled, not styled as real UI. No search bar, no
  recap rail, no widget, no fabricated all-in-one card. Matches the frame's job.
- `appstore/02-existing-photos.png` — DRAFT banner legible. Body is a dashed grey
  placeholder captioned "Capture not yet available / app/(app)/gallery-import/review.tsx".
  No fake gallery-import deck was drawn — correctly honest.
- `appstore/03-unphotographed-stories.png` (thumb + full) — DRAFT banner legible. Real
  ladybug watercolor illustration + full caption text, no clipping, tags/date readable.
  Composer input area is a labeled placeholder, not invented.
- `appstore/04-little-voice.png` — DRAFT banner legible. Placeholder body correctly named
  ("SoundStage, visible duration" route). No fake waveform/player was invented.
- `appstore/05-optional-book.png` (+ ipad full-res) — DRAFT banner legible. Real rendered
  book-interior page (readable full short story, "the colander as a hat") is the visible
  content; disclosure line "Printed books sold separately. Shipping extra." is fully
  legible above the banner in every bucket I checked (appstore, appstore-alt, appstore-65,
  ipad). **Confirmed pre-flagged cosmetic defect:** the draft banner's reason text
  ("...pending owner approval") visibly runs to and is clipped at the right edge of the
  canvas on every bucket (appstore, appstore-alt, appstore-65, ipad) — reproduced
  independently in this session, not newly discovered. It is on a draft-only frame that is
  excluded from the upload manifest, so it has no release consequence, but it is a real
  rendering defect that should be fixed before this frame is ever promoted out of draft.
- `appstore/06-private-family.png` — DRAFT banner legible. Real family-roster crop (Maya/
  Theo/Ari/Nora with portraits) renders cleanly; a small "In the app" inset (phone-in-hand)
  is honestly labeled. Correctly draft: this is the character-portrait roster, not the
  actual invite/role-management screen the frame's job requires, and the manifest does not
  claim otherwise.
- `appstore/07-look-back.png` — DRAFT banner legible, correctly present (day-list rows are
  genuinely truncated and end mid-week with an empty day, which the brief itself says does
  not establish the value on its own).
- `ipad/01-more-than-photos.png` through `ipad/06-private-family.png` — same six frames,
  same content classes, all correctly carry the DRAFT banner on iPad too (this content is
  bucket-independent; only 07 differs by bucket).
- `ipad/07-look-back.png` (full-res) — **Confirmed genuinely clean: no draft banner.**
  Real "Memories with Nora" per-child collection: profile header + ten complete,
  non-truncated dated rows (Jul 14 → Apr 22, 2026) each with a full one/two-sentence story
  and an emotion tag. No search box, no recap rail, no widget, no habit/streak indicator.
  Text is fully legible at both full and reduced size, no clipping, no overlapping
  elements. This is a strong, honest frame and the only genuinely upload-ready default
  asset in the entire set.
- `appstore-alt/05-optional-book.png`, `appstore-alt/07-look-back.png`,
  `appstore-65/05-optional-book.png`, `appstore-65/07-look-back.png` — spot-checked at
  thumbnail size to confirm the same draft/clean pattern holds across all four buckets, not
  just `appstore`/`ipad`. Confirmed: same draft banner on 05 (with the same right-edge
  overflow) and on 07 for these two iPhone buckets; content is pixel-identical to
  `appstore` per the independently-recomputed hashes in §4 below.
- Opener challengers: `v2-challenger-photo/{appstore,ipad}/existing-photo-first.png` and
  `v2-challenger-voice/{appstore,ipad}/voice-first.png` — all four opened. All four
  correctly carry a DRAFT banner (no genuine capture exists for either challenger's frame-1
  concept). `voice-first` reuses the real photo/story card content underneath its own
  headline, correctly labeled "genuine collection shown in context" in the draft reason,
  not implying it is a saved-sound capture.

**Not individually opened this session (scope limitation, disclosed):** the remaining
`appstore-alt` and `appstore-65` frames 01–04 and 06 were not opened pixel-by-pixel in this
pass; they were relied on via the independently-recomputed cross-bucket sha256 hashes
(§4) for frames 02–07, and via direct dimension/alpha inspection (§3, covers all 76 files).
Frame 01 differs per bucket (never hashed across buckets, since it is the resized render of
the same source at a different canvas), but I did open frame 01 in both `appstore` and
`ipad` and the content class (draft banner + real photo/story cards) is structurally
identical between them; I did not additionally open `appstore-alt`/`appstore-65` copies of
frame 01. This is a reasonable-confidence extrapolation, not a claim of having visually
opened all 28 files individually — logged honestly rather than rounded up.

**No frame in any bucket shows:** a search bar, a "Looking Back"/recap carousel, a widget,
a fake audio player, a fabricated gallery-import deck, a fake in-app book editor, a QR/
"listen to it" scan mark, or an unsupported all-in-one photo+audio+illustration card. This
was checked deliberately on every frame opened above.

## 3. Technical claims — VERIFIED with an independent script

I wrote and ran my own Python PNG-IHDR parser (not `sips`, not the renderer's own checker)
over all 76 PNGs in `store-assets/out/v2/`, `out/v2-challenger-photo/`, and
`out/v2-challenger-voice/`:

- **Dimensions:** all 76 files match their bucket's required size exactly —
  `appstore` 1260×2736, `appstore-alt` 1320×2868, `appstore-65` 1284×2778, `ipad`
  2064×2752. Zero mismatches.
- **Alpha:** all 76 files report PNG color type 2 (RGB, no alpha channel) directly from the
  IHDR colour-type byte, not inferred from a tool that could itself be fooled by a
  post-processed file. Zero files use color type 4 or 6 (grey/RGBA with alpha).
- **HASHES.txt byte-identity claim:** I recomputed sha256 for all 24 frame×bucket
  combinations (6 frames × 4 buckets) independently across `out/v2/`,
  `out/v2-challenger-photo/`, and `out/v2-challenger-voice/`. All 24 are byte-identical
  across all three trees, confirming `HASHES.txt`'s own claim rather than just reading it.
  I also independently recomputed the sha256 quoted in `UPLOAD-CANDIDATES.json` for
  `out/v2/ipad/07-look-back.png` (`458730c1…`) — matches exactly.
- **`UPLOAD-CANDIDATES.json` is an explicit allowlist, not a wildcard:** confirmed by
  reading the file directly — it is a hand-built JSON object with one `uploadable` entry
  (`07-look-back` → `ipad` only) and an explicit `excluded` map naming all other
  frame×bucket combinations, with `uploadable_slot_count: 1` and `total_slot_count: 28`
  stated in its own summary. No glob, no wildcard pattern found in this file or in
  `manifest.v2.json`'s draft logic.

## 4. Master brief's 10 final-acceptance tests — my verdicts

| # | Test | Verdict | Evidence |
|---|---|---|---|
| 1 | Frames 1–3 explain digital value without depending on printing | **PASS (copy); PARTIAL (imagery)** | Description sections "START WITH THE PHOTOS YOU HAVE," "FOR THE THINGS A PHOTO MISSED," "KEEP THEIR LITTLE VOICE" all precede and do not reference the book paragraph. Frames 01 and 03 show real, non-print-dependent content (photo/story cards; illustration). Frame 02's image is currently a labeled placeholder (no genuine gallery-import-deck capture exists) — the *copy* claim is sound, the *frame-02 image* is not yet real evidence of it. |
| 2 | Remove frame 5 + print paragraph → still a coherent reason to subscribe/return | **PASS** | Reading the description with the "AND A BOOK TO HOLD, TOO" paragraph and the closing print/subscription sentence removed still leaves: photo import, unphotographed-story capture + optional illustration, saved-voice replay, per-child revisiting, and family sharing — five independent non-print reasons, matching `COMMERCIAL-CLARITY.md`'s own decision test. |
| 3 | Frame 5 demonstrates automatic book creation and separates print/shipping charges | **PARTIAL / BLOCKED for a shippable asset** | The disclosure text itself ("Printed books sold separately. Shipping extra.") is present, legible, and correctly worded on every bucket. But the frame's dominant content is only a real interior book *page* (offline-rendered from the fictional `sample` slug) — there is no genuine in-app book-shelf or browser-review capture, so the frame does not yet visually demonstrate the "Momora selects the memories and lays out the pages" workflow end-to-end. It is correctly excluded from the upload manifest as draft, so this is an honest **blocked**, not a false pass. |
| 4 | All 7 defaults + 2 openers exist per device family, or have precise blockers; only verified-complete assets reach an RC | **FAIL (release completeness) / PASS (blocker-honesty process)** | Plainly: **1 of 28** default frame×bucket slots is genuinely upload-ready (`07-look-back` on `ipad`). 0 of the two opener-challenger sets have any upload-ready frame at all (both openers replace frame 1, and frame 1 has no genuine capture in either concept). As a completeness milestone this is a clear **FAIL** — most of the storyboard is still placeholder. As a process-integrity check (did the team fabricate completeness, or honestly gate it) this is a clear **PASS** — every blocker is precisely named in `BLOCKERS.md`/`CAPTURE-REQUESTS.md` with route, missing input, and resolution owner, and the allowlist in `UPLOAD-CANDIDATES.json` reflects exactly the 1 genuinely-complete asset, not a rounded-up or aspirational count. |
| 5 | Copy matches current behavior, fits real field limits, price/entitlement/legal checks are honest | **PASS** | Field limits independently re-verified (§1). `CLAIM-MATRIX.md`'s claims are all doc/code-evidence, cross-checked against the actual description text; I found no contradiction. Unresolved commercial facts (book-review entitlement, exact SKU/currency/trial, gallery-import server admission) are explicitly logged as open in `BLOCKERS.md` and `COMMERCIAL-EXPECTATION-MAP.md`, not silently assumed. |
| 6 | Source media paths don't imply unsupported combinations, AI facts, or a fake native book editor | **PASS** | `ASSET-MANIFEST.json` shows the team itself caught and rejected three risky assets after visual review: `book-cover-sample.png` and `book-spread-sample.png`/`book-spread-text-sample.png` (placeholder-dimension text baked into the sample book's own SVG art, and a QR "listen to it" mark whose short code is documented in `book-renderer/src/model/fitter.ts:1180` as fabricated) were moved to `raw/rejected/` and excluded from `store-assets/v2/assets/`. I independently confirmed none of the shipped `store-assets/v2/assets/*.png` files or the rendered frames contain that QR mark or placeholder-dimension text. No frame implies gallery import produces an illustration or that a dictation note retains audio. |
| 7 | UI genuine, demo data cleared, fonts/images load, native tablet layouts respected, every frame inspected at usable sizes | **PASS**, with one disclosed gap | Fonts render correctly (Newsreader serif headlines, Plus Jakarta Sans body, visible in every opened frame). Demo data is the documented fictional Kim-Ortiz household (`supabase/scripts/demo-family-spec.ts`). The `ipad` bucket uses a genuine, distinct iPad capture (`spare-person-detail.png`), not a stretched phone layout. I opened all 7 default frames on 2 of 4 buckets in full plus spot-checks on the other 2 (§2); I did not open every one of the 76 files individually — disclosed as a scope limitation, not rounded up to "all." |
| 8 | v1 headline/order/variant/acceptance logic absent from active default registries/tests/manifests | **PASS** | Grepped for the two most identifying v1 strings ("Say it. Watch it become art.", "Everyone becomes a character."): both appear only in `store-assets/manifest.json` (explicitly exempted as the preserved v1 artifact) and inside `registry.v2.json`'s own `superseded_active_strings`/history documentation (explicitly exempt as labeled history, per `validate-copy.mjs`'s own exemption logic, which I read directly). Zero hits in `manifest.v2.json`, `manifest.v2-challenger-*.json`, or any `out/en-US/*.txt` export. |
| 9 | Editable sources re-render using commands actually run; no made-up performance/runtime/approval claims | **PARTIAL — copy re-render VERIFIED; image re-render NOT independently re-executed** | `build-copy.mjs`/`validate-copy.mjs` were re-run by me in this session with the results shown in §1. The Playwright-based `render.mjs` pipeline was **not** re-executed by me: `store-assets/` has no installed `node_modules` in this checkout (`playwright` is a listed devDependency but not installed, and no browser binaries are present), and installing them was outside this pass's authorized scope (network fetch, not a listing-content change). I instead independently re-verified the *already-rendered* output artifacts at the byte level (dimensions, alpha, cross-tree hashes, §3) and visually (§2), which is strong evidence the renderer ran correctly once, but is not the same as re-running it myself. **Logging this as unverified-by-re-execution, not as passed.** |
| 10 | Nothing published, ordered, charged, deployed, or changed in pricing/identity | **PASS** | `git status` shows only the three expected modified tracked files (`store-assets/.gitignore`, `render.mjs`, `templates/screenshot.html`) plus untracked new listing directories; nothing staged or committed. `git diff` on the three modified tracked files shows only screenshot-compositor changes (new `appstore-65` bucket, alpha/dimension assertions, card/inset/draft-banner layout, copy-registry loader) — no touches to `app.json`, `eas.json`, onboarding, paywall, pricing, or any runtime path. The one new untracked non-listing artifact, `book-renderer/book-data/sample/print/{cover,interior}.pdf`, is the expected, explicitly-authorized, offline, free output of `book:pdf --slug sample` (PLAN.md §6) — not a runtime or pricing change. |

## 5. Repairs made in this pass

None. I did not find a repairable listing-scope failure that was within this pass's
authority to fix without re-rendering or redesigning compositions (both out of scope per
the task's constraints). The one defect found (frame 05's draft-banner text overflow) is
cosmetic, confirmed pre-existing/pre-flagged, occurs only on a draft-excluded frame, and
fixing it would require editing `screenshot.html`'s stamp-width/reason-text logic and
re-rendering — a compositor change beyond "genuinely repair locally," so it is reported,
not silently patched.

## 6. Safety scan

Grepped all new files under `docs/app-store-revamp/`, `momora-listing-handoff-v2/`,
`store-assets/listing/`, `store-assets/v2/`, and the new `store-assets/manifest.v2*.json`
for `sk-`, `eyJ`, `service_role`, and email-address patterns.

- **No API keys, JWTs, or `service_role` strings found anywhere in the new files.**
- `the seeded demo account address (in supabase/scripts/, not repeated here)` (the pre-existing repo's own seeded demo-account address)
  appears in two **new** files: `docs/app-store-revamp/PLAN.md` and
  `docs/app-store-revamp/CAPTURE-REQUESTS.md`. Both usages are internal documentation
  explaining *why* certain screens could not be captured (the demo content sits behind OTP
  auth to that address) — neither file is a public-facing asset, and no password/OTP/token
  is present alongside it. Per the task's explicit instruction to flag this if it leaked
  into any new listing file, **flagging it here**: it is low-risk (a documented internal
  demo mailbox, not a customer's), but it is technically a real email address in a new
  file, and I have not deleted it (deleting evidence was out of scope and the instruction
  was to report, not silently remove).
- `hello@usemomora.com` also appears in `COPY-CHANGELOG.md`, cited from
  `docs/store-submission-answers.md` as the app's own public support contact address. This
  is the intended, already-public support address (an App Store Connect requirement), not a
  leak.
- No invite codes, no 3-word-dash tokens, no other private customer data found in any new
  file.

## 7. Items logged as unverified (not passed)

- Gallery-import server-side production admission gate — cannot be checked from this
  checkout (no production DB access in this pass).
- Book generation/online-review subscription entitlement — undocumented in code/docs,
  owner-only fact.
- Exact SKU, currency, trial eligibility, print price variance, tax, and shipping
  territories — owner-only facts.
- `momora.co/e/<token>` redirect liveness and whether real books carry minted tokens —
  owner/production-only fact (see `audioQrFinding` in `ASSET-MANIFEST.json`).
- Playwright render pipeline re-execution (see test 9 above) — not re-run in this pass due
  to missing installed dependencies; existing output artifacts were verified instead.
- Whether the `What's New` text belongs to the specific release it will ship in — a
  release-scheduling fact, not something this checkout can answer.

## Release status determination

**Blocked.**

Justification: the copy layer (name/subtitle/promo/description/keywords/what's-new) is
locally validated and independently re-verified as accurate to the shipped codebase. But
the visual asset layer has only 1 of 28 required default frame×bucket slots genuinely
upload-ready, and 0 of the opener-challenger slots. A release cannot proceed to App Store
Connect on 1 image. This is not "awaiting owner and live checks" (that status would apply
if the copy/commercial facts were the only open items) — it is blocked on missing native
device captures that require someone with the seeded demo account and a real device/
simulator, which this checkout-only pass cannot produce, per `BLOCKERS.md` and
`CAPTURE-REQUESTS.md`.
