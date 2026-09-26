# Momora App Store listing revamp — v2 memory-first execution plan

**Authority:** `momora-listing-handoff-v2/MASTER-BRIEF.md` (v2, memory-first). This plan
does not restate strategy; it records the decisions, ground truth and file layout that
implementers need. Where this plan and the master brief disagree, the brief wins, except
for the factual corrections in §2, which were verified against this checkout and Apple's
live documentation.

**Branch:** `listing/v2-memory-first`. Nothing is committed, published, uploaded, ordered
or priced by this work.

---

## 1. Verified ground truth (do not re-derive)

Established by inspection of this checkout on 2026-09-20. Cite these paths in evidence files.

### 1.1 Feature claims

| Claim | Verdict | Evidence |
|---|---|---|
| Camera-roll scan with permission, 3-hour-gap clustering into suggested memories | TRUE (code) | `docs/features/gallery-import.md:16-24,50`, `src/utils/gallery-import-scanner.ts` |
| AI drafts captions per cluster (`gpt-4o-mini`, Cloudflare `GalleryImportWorkflow`) | TRUE (code) | `docs/features/gallery-import.md:61,77,138` |
| Approval control is literally **Keep** / **Set aside**; nothing auto-approves | TRUE (code) | `docs/features/gallery-import.md:31` |
| 512px previews upload to private R2 for AI **before** review; full originals only after approval | TRUE (code) | `docs/features/gallery-import.md:10,22-23,71-72,81` |
| Camera roll never modified | TRUE (code) | `docs/features/gallery-import.md:10` |
| Gallery import enabled in the **production** build profile | TRUE (config) | `eas.json:49`; flag read at `src/utils/gallery-import-flags.ts:7` |
| Gallery import also has a **server-side admission gate** | TRUE (code) | `docs/features/gallery-import.md:151` — OWNER GATE, see §4 |
| Typed short note; dictation transcribes then **discards** audio | TRUE (code) | `docs/features/memories.md:344`, `docs/features/voice-journaling.md:13,83` |
| "Keep the sound" persists the actual clip as the memory artifact | TRUE (code) | `docs/features/audio-memories.md` overview, `:68-89` |
| Saved sound plays back with visible elapsed/total duration and an editable caption | TRUE (code) | `docs/features/audio-memories.md:18,29,38` |
| Text memory → optional AI illustration using date-resolved family portraits | TRUE (code) | `docs/features/memories.md:20-28,307-336` |
| Gallery import **never** produces an illustration; photo and illustration pipelines are mutually exclusive | TRUE (code) | `docs/features/memories.md:9`, `docs/features/gallery-import.md:34` |
| Illustration caps at 6 tagged members and needs a ready portrait | TRUE (code) | `docs/features/memories.md:20,325,327-330` |
| Roles are exactly **owner / manager / viewer** | TRUE (code) | `docs/features/family-sharing.md:11,74-90` |
| Viewers cannot write memories, invite, export, or order a book | TRUE (code) | `docs/features/family-sharing.md:74-90`, `docs/features/memory-book-generation.md:50` |
| Invite = 3-word dash-separated code, shared out-of-band, then owner/manager approval | TRUE (code) | `docs/features/family-sharing.md:15-18,30-39,257-286` |
| Timeline, calendar, per-child profile collection, memory detail all exist | TRUE (code) | routes in §1.2 |
| **Global search is NOT reachable from any UI** | FALSE as a claim | `docs/features/memories.md:42-61` — hook exists, no UI setter. Never claim search. |
| **Looking Back** recap rail | NOT RELEASED | `docs/features/looking-back.md` status in-progress. Never claim. |
| **Home-screen widget** | NOT STORE-RELEASED | `docs/features/home-screen-widget.md:3-17` — dev builds only. Never claim. |
| Book: choose child + scope (age-year / calendar-year / everything), AI curates outline, lays out pages | TRUE (code) | `docs/features/memory-book-generation.md:24-46,53-58,191-208` |
| Book review/edit/order happens in an **external system browser** at `shop.usemomora.com`, separate login — no in-app WebView, no native editor | TRUE (code) | `docs/features/memory-book-generation.md:60-63,601-611`, `:407-591`; `docs/features/memory-book-orders.md` |
| Print is a separate Stripe purchase, not part of the subscription | TRUE (code) | `docs/features/memory-book-orders.md:237` |
| Whether **book generation/online review** is subscription-included | UNVERIFIED | not stated in either doc — OWNER GATE, see §4 |
| Subscription gates new memory writes, engagement writes, media changes and AI generation — **not** reading | TRUE (code) | `docs/features/subscriptions.md:40-43,164` |
| Lapsed owner keeps browse + export | TRUE (code) | `docs/features/subscriptions.md:39`, `docs/features/data-export.md:110` |
| Export is **owner-only**, ZIP with `manifest.json` + numbered assets, owner-owned families only | TRUE (code) | `docs/features/data-export.md:9-11,17,20-21,60-61` |

### 1.2 Routes

| Surface | Route |
|---|---|
| Timeline / home | `app/(app)/(tabs)/timeline.tsx` |
| Calendar | `app/(app)/(tabs)/calendar.tsx` |
| Memory detail (incl. `SoundStage` playback) | `app/(app)/memory/[id]/index.tsx` |
| Timeline sound card (`SoundCard`) | `src/components/memory-card.tsx` |
| Gallery import consent / deck / progress / composer | `app/(app)/gallery-import/{index,review,progress,approve}.tsx` |
| Composer | `app/(app)/new-memory.tsx` |
| Family roster / invite / approvals | `app/(app)/sharing/{members,invite,pending-invites,approvals,redeem}.tsx` |
| Per-child collection | `app/(app)/family/[id]/index.tsx` |
| Memory book shelf / scope picker | `app/(app)/family/[id]/memory-books.tsx` |
| Export trigger | `app/(app)/(tabs)/settings.tsx` (owner-only action) |

### 1.3 Existing assets and tooling

**Compositor — reuse, do not rebuild.** `store-assets/` is a self-contained Playwright
pipeline: `render.mjs` (per-slide × per-size render, asserts output PNG dimensions by
parsing the IHDR chunk), `templates/screenshot.html` (authored in a fixed 1260-unit-wide
space, `--scale` maps to any canvas; `device` and `hero` layouts; iPhone and iPad frame
skins auto-picked by size bucket; replacement 9:41 status bar), `manifest.json`,
`fonts/` (repo-licensed Newsreader / Plus Jakarta Sans / Caveat TTFs, local, no network).

> **Trap:** the `SIZES` map is duplicated in `render.mjs` **and** inside
> `templates/screenshot.html`'s inline `<script>`. Both must be updated together.

**Genuine captures on disk** — all from the fictional seeded demo household
(Kim-Ortiz family; people defined in `supabase/scripts/demo-family-spec.ts`, which states
every person and visual is fictional). This is the approved demo family; reuse it.

| File | Size | Shows |
|---|---|---|
| `store-assets/source/IMG_0908.PNG` | 1170×2532 | Timeline "Your moments." — text-only story card (crackers, `funny`) + photo card (blanket fort) |
| `store-assets/source/IMG_0909.PNG` | 1170×2532 | Family "Your people." — character portrait roster |
| `store-assets/source/IMG_0910.PNG` | 1170×2532 | "Backwards." reverse-chronological day list, Calendar tab |
| `store-assets/source/IMG_0912.PNG` | 1170×2532 | Memory detail — ladybug watercolor illustration, caption, tags, `wonder` |
| `store-assets/source/ipad/s2-memory-detail.png` | 2064×2752 | iPad memory detail — bath scene illustration |
| `store-assets/source/ipad/s3-timeline.png` | 2064×2752 | iPad timeline |
| `store-assets/source/ipad/s4-family.png` | 2064×2752 | iPad family roster |
| `store-assets/source/ipad/s5-calendar.png` | 2064×2752 | iPad day list |
| `store-assets/source/ipad/spare-person-detail.png` | 2064×2752 | **Per-child collection** — "Memories with Nora" |
| `back-on-timeline.png` (repo root) | 1080×2424 | Android timeline **with Looking Back carousel** — unreleased feature, do not use |
| `bell-sheet.png` | 1080×2424 | Android family-activity sheet |
| `composer2.png` | 1080×2424 | Composer in an **error state** — unusable |
| `settings-expiring.png` | 1080×2424 | Android settings, Family section |

**Book material.** `book-renderer/` renders book PDFs offline with no network or paid
calls: `cd book-renderer && npm run book:pdf -- --slug sample --spine-mm <n>`. Slugs in
`book-renderer/book-data/index.json`. `sample` is fully fictional but uses SVG placeholder
art; `enzo-*` / `mara-*` use the **owner's own family photos** (owner-approval gate).
Committed real cover PDFs exist at `book-renderer/book-data/{enzo-year-three,mara-year-one}/print/cover.pdf`.

**Demo videos.** `marketing/assets/ugc/demo-cuts/*.mp4`, 720×1280 — genuine UI in motion,
including `demo-voice-capture.mp4` and `demo-family-feed.mp4`. Candidate source for honest
cropped insets only; **never** as a full-bleed device fill (resolution is far below master
scale and upscaling flattened UI is forbidden).

**Design tokens.** `src/constants/theme.ts` is the source of truth; the store-assets
template holds a hand-mirrored copy. Palette: `bg #FAFAFD`, `surface #F4F3F8`,
`surface2 #F2EFF8`, `border #EBE7F2`, `ink #2C2418`, `ink2 #6B5E4F`, `ink3 #9A8B79`,
`primary #D63E78`, `primarySoft #FBD3E2`, `primaryTint #FDEAF1`. Emotion softs: joy
`#FFE7B0`, funny `#FCDCC0`, calm `#D6EDDE`, wonder `#CFE1F4`, tender `#FBD6E1`, mischief
`#E5D2F1`. Fonts: Newsreader display, Plus Jakarta Sans body, Caveat script accent.

### 1.4 Capture feasibility — why some frames are blocked

No runtime demo/fixture mode exists (`__mocks__/` is Jest-only). The populated demo content
lives in a **production-pointed** Supabase project behind OTP email to
`the seeded demo account address (in supabase/scripts/, not repeated here)`. There is no `ios/` directory and no cached build. The demo
seeders (`supabase/scripts/seed-demo-*.ts`) are dry-run by default and `--apply` performs
real production writes and paid OpenAI / fal.ai calls — **do not run them.**

Therefore new native captures of populated screens require owner action and are recorded as
blockers, not invented. See §4.

---

## 2. Corrections to the handoff, with evidence

1. **Screenshot sizes.** The brief suggests 1320×2868 as "an accepted 6.9-inch set" and
   told us to recheck. Apple's live specification lists 6.9" portrait as **1260×2736**;
   the *required* iPhone size is **6.5" 1284×2778**, and the *required* iPad size is
   **13" 2064×2752**. 1–10 screenshots per localization, no alpha channel.
   → We render four buckets: `appstore` 1260×2736, `appstore-alt` 1320×2868 (both already
   exist), **new** `appstore-65` 1284×2778, and `ipad` 2064×2752.
2. **Field limits.** Promotional text 170, description 4000, What's New 4000, keywords 100
   **bytes**, confirmed on Apple's platform-version-information reference. Name and subtitle
   30 characters is applied per the brief; the implementer records the source it verifies it against.
3. **Book review wording.** "Review the book online" in the v2 description is accurate and
   must stay — review is an external browser handoff with its own login. Nothing may imply
   an in-app editor or WebView.
4. **Never claim** search, recaps / Looking Back, or widgets. These appear in reference
   captures (`back-on-timeline.png`) and must be kept out of every frame.

---

## 3. Deliverable layout

```
momora-listing-handoff-v2/
  state.json                    v2 state, merged; phases only marked by executed evidence
  MIGRATION-REPORT.md           v1 → v2 mapping, what was archived, reopened gates

docs/app-store-revamp/
  PLAN.md                       this file
  INVENTORY.md                  reusable files, commands, permissions, missing tools
  CLAIM-MATRIX.md               claim → verdict → path:lines → evidence class
  COMMERCIAL-EXPECTATION-MAP.md membership vs print vs unresolved entitlements
  ASSET-CHECKLIST.md            7 frames + 2 openers → route/state/source/status
  DEVICE-LOCALE-PLAN.md         buckets, dimensions, iPad stance, locale scope
  BLOCKERS.md                   only what cannot be resolved from the checkout
  CAPTURE-REQUESTS.md           one exact request per gap
  COPY-CHANGELOG.md             substantive copy changes and their evidence
  QA-REPORT.md                  phase 5: checks actually run, images actually opened
  OWNER-SIGNOFF.md              owner gates
  EXPERIMENT-PLAN.md            metrics centred on understood paid membership
  REVIEW-NOTES.md               App Review guidance (no credentials in tracked files)
  UPLOAD-MANIFEST.md            explicit allowlist, hashes, ASC field mapping

store-assets/
  listing/
    registry.v2.json            canonical copy registry — single source of truth
    build-copy.mjs              registry → plain-UTF-8 field files
    validate-copy.mjs           literal counts, registry/export equality, stale-v1 scan
    out/en-US/*.txt             generated public fields
  v2/
    assets/                     prepared capture crops, book page PNGs, insets
    ASSET-MANIFEST.json         provenance per asset
    raw/                        untouched extracted frames, kept separate from finals
  manifest.v2.json              seven defaults + two openers + optional slot-7 test
  templates/screenshot.html     extended (new bucket, crop/inset layout, draft banner)
  render.mjs                    extended SIZES map
  out/v2/<bucket>/              default renders
  out/v2-challenger-*/          opener challengers
  preview/                      gallery, contact sheets, 390px cards, 120-140px diagnostics
  archive/v1-2026-08/           superseded v1 outputs, kept for rollback
```

---

## 3a. Owner decisions — 2026-09-20 (supersede earlier blockers)

1. **Gallery import is LIVE in production and available to all users.** Owner-confirmed.
   §4 gate 1 is RESOLVED. The listing may lead with import. Record as
   `production-confirmation (owner statement)` — still not a runtime observation by us.
2. **Faithful UI reconstructions are approved for store frames.** The owner's existing
   listing already uses composed mockups built from the app's design system, which is
   standard App Store practice (device frame, real UI, enlarged callouts). This SUPERSEDES
   this plan's earlier stance that only native captures could back a frame.
   The rule that survives: a reconstruction must faithfully depict a screen that genuinely
   ships, built from the real component source and design tokens — never invented
   functionality, never a screen that does not exist, never an image generator.
   Every reconstruction is provenance-classed `ui-reconstruction` and requires owner
   fidelity sign-off before upload.
3. **`enzo-year-three` is approved** for marketing use (that book only). §4 gate 4 is
   RESOLVED for year three; the other enzo/mara books remain unapproved.

## 4. Owner gates (cannot be resolved from the checkout)

1. **Gallery import server-side admission** — is it enabled for production? The client flag
   is on (`eas.json:49`) but `docs/features/gallery-import.md:151` documents a separate
   server admission gate. Frames 01/02, the subtitle, promo text and description all lead
   with import; if admission is off in production this is a review-guideline risk.
2. **Book generation / online review entitlement** — included in membership or not.
   Unstated in the docs. Until answered, no copy may call it included or free.
3. **Localized offer** — exact annual SKU, currency code, trial eligibility; whether the
   $99 print reference is fixed or varies by page count; taxes; shipping territories.
4. **Demo-content rights** — the `enzo-*` / `mara-*` books use the owner's own family
   photographs. Marketing use needs explicit owner approval; `sample` does not.
5. **Native captures for blocked frames** — see `CAPTURE-REQUESTS.md`.

---

## 5. Work packages

**WP-A — Phase 0 + 1: migration and evidence.** `state.json`, `MIGRATION-REPORT.md`,
`INVENTORY.md`, `CLAIM-MATRIX.md`, `COMMERCIAL-EXPECTATION-MAP.md`, `ASSET-CHECKLIST.md`,
`DEVICE-LOCALE-PLAN.md`, `BLOCKERS.md`.

**WP-B — Phase 2: copy.** Registry, generator, validator, generated field files,
`COPY-CHANGELOG.md`, stale-v1 scan.

**WP-C — Phase 3: asset pack.** Archive v1 outputs; crop genuine captures; render the
sample book offline and convert pages to PNG; extract and evaluate demo-video frames;
`ASSET-MANIFEST.json`; `CAPTURE-REQUESTS.md`.

**WP-D — Phase 4: compositor and renders.** Extend template and `SIZES`; author
`manifest.v2.json`; render seven defaults across four buckets plus two openers; prove
frames 02–07 byte-identical across opener sets by hash; build previews and diagnostics.

**WP-E — Phase 5: independent QA and release pack.** Fresh reviewer against the brief's
seven acceptance tests; then the release pack files.

A, B and C are file-disjoint and run in parallel. D depends on C. E depends on all.

---

## 6. Standing rules for every implementer

- **Never use an image generator for UI, book pages, text, or any product evidence.**
  Generated watercolor spot art is permitted only as decorative brand texture, in the same
  role as the existing `store-assets/art/` pieces, and must be labelled in the manifest.
- **Do not run** `seed-demo-*.ts`, any `backfill:*`, `regenerate:illustrations`,
  `import:printed-memory-book`, or any `eval:*` script. They touch production and/or cost
  money. `book-renderer`'s `book:pdf --slug sample` is the only render that is safe and free.
- **Do not modify** app runtime code, onboarding, paywall, pricing, `app.json` identity,
  icons, bundle IDs, subscriptions, or `eas.json`. Listing artefacts only.
- **No secrets** in any written file: no invite codes, no real email addresses, no keys.
  Read `.env*` only if strictly necessary and never echo values.
- A frame that cannot be backed by a genuine asset is rendered with a **visible draft
  banner**, recorded as draft in state, and **excluded from the upload manifest**. It is
  never described as complete.
- Public copy outputs are plain UTF-8 — no Markdown, no JSON, no comments, no placeholders.
- Report deviations and plan defects explicitly rather than improvising around them.
