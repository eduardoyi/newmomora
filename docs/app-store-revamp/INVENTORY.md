# Implementation inventory

Scope: WP-A, Phase 1. Every path below was checked with `ls`/`sed -n`/`git log` on this
checkout (branch `listing/v2-memory-first`, HEAD `93620da9b6...cb9af3`) on 2026-09-20, not
assumed from PLAN.md §1.3 — PLAN.md's list was the starting point and every entry resolved.

## 1. Reusable renderer and tooling

| File | Verified | Role |
|---|---|---|
| `store-assets/render.mjs` | exists; `SIZES` map at line 32; per-slide × per-size render loop at line 93 | Playwright renderer. Reads `manifest.json` (or `--manifest <file>`), renders each slide × size, then re-opens each output PNG and asserts its pixel dimensions from the PNG's own IHDR chunk before accepting it (`store-assets/README.md` "Rendering" section). |
| `store-assets/templates/screenshot.html` | exists; inline `<script>` `SIZES` map at line 531, `TABLET_SIZES` set at line 542 | Single template, all sizes via a `?size=` query param; `device`/`hero` layouts; iPhone/iPad frame skins auto-picked by size bucket; a replacement 9:41 status bar (not a real screenshot's status bar). Authored in a fixed 1260-unit-wide space; `--scale` maps it to any canvas. |
| `store-assets/manifest.json` | exists; one commit in history (`git log --oneline -- store-assets/manifest.json` → `4381f0e` only) | v1 render manifest: 6 slides (`s1-hook` … `s6-closing`) + `feature-graphic`. Superseded copy — see MIGRATION-REPORT.md. Stays in place as the v1 artifact; v2 must render from a new `store-assets/manifest.v2.json` (not yet created). |
| `store-assets/package.json` scripts | exists | `npm run render` → `node render.mjs`; `npm run generate-art` → `node generate-art.mjs` (paid OpenAI `gpt-image-2` call — see "Do not run" below). |
| `store-assets/fonts/{Newsreader,PlusJakartaSans,Caveat}/*.ttf` | exists (Caveat 400/700, Newsreader 400/400-italic/500, PlusJakartaSans 400/500/700) | Repo-licensed, local TTFs copied from `node_modules/@expo-google-fonts/*` — no network fetch at render time. |
| `store-assets/README.md` | exists | Documents setup (`nvm use 20`, `npm install`, `npx playwright install chromium`), the output bucket→pixel-size table, and the IHDR-assertion behavior. States the v1 slide set is "37 PNGs" (6 slides × 6 sizes + feature graphic) — note this includes two Play/Android buckets (`play`, `play-tablet7`, `play-tablet10`) that are **out of scope** for this App-Store-only WP-A/pass; do not assume all six v1 buckets carry forward. |

**Working command (safe, offline, free):**

```bash
source ~/.nvm/nvm.sh && nvm use 20
cd store-assets && npm install && npx playwright install chromium
node render.mjs                      # renders the existing v1 manifest — useful only for archive/QA comparison, not for producing v2 output
node render.mjs --manifest manifest.v2.json   # will be the v2 entry point once that file exists (phase 4)
```

Not run in this pass (no builds were executed per PLAN.md §6 standing rules — this command
is documented from README.md's own instructions, not executed here).

### The `SIZES` duplication trap

`store-assets/render.mjs:32` and `store-assets/templates/screenshot.html:531` each define
their own `SIZES` map independently (one in Node, one inline in the browser-rendered HTML).
Adding the new `appstore-65` (1284×2778) bucket in phase 4 means editing **both** files —
missing one produces either a render-time `SIZES[size]` lookup failure in `render.mjs` or a
silently-wrong on-page layout size in the template (the IHDR dimension assertion in
`render.mjs` would still fail at the very end, but only after a full render pass, and would
not explain which of the two maps was out of sync).

## 2. Genuine capture inventory (all from the fictional demo household)

`supabase/scripts/demo-family-spec.ts:4` — "Every person and every visual in this file is
fictional and must be [presented as such]." This is the Kim-Ortiz/Nora-Gabe-Maya household
referenced throughout `store-assets/source/`. All approved for reuse under that fictional
framing.

| File | Size | Verified shows | v2 candidate use |
|---|---|---|---|
| `store-assets/source/IMG_0908.PNG` | 1170×2532 | Timeline: text-only story card (crackers, `funny` emotion) + photo card (blanket fort) | Frame 01 photo/story half |
| `store-assets/source/IMG_0909.PNG` | 1170×2532 | Family roster — character portraits | Frame 06 secondary context only (see ASSET-CHECKLIST.md — it is the character cast, not roles/invites) |
| `store-assets/source/IMG_0910.PNG` | 1170×2532 | Calendar tab, reverse-chronological day list | Frame 07 |
| `store-assets/source/IMG_0912.PNG` | 1170×2532 | Memory detail — ladybug watercolor illustration, caption, tags, `wonder` emotion | Frame 03 illustration-output half |
| `store-assets/source/ipad/s2-memory-detail.png` | 2064×2752 | iPad memory detail — bath-scene illustration | iPad variant of frame 03 |
| `store-assets/source/ipad/s3-timeline.png` | 2064×2752 | iPad timeline | iPad variant of frame 01 |
| `store-assets/source/ipad/s4-family.png` | 2064×2752 | iPad family roster | iPad variant of frame 06 (same caveat as `IMG_0909.PNG`) |
| `store-assets/source/ipad/s5-calendar.png` | 2064×2752 | iPad day list | iPad variant of frame 07 |
| `store-assets/source/ipad/spare-person-detail.png` | 2064×2752 | **Per-child collection** — "Memories with Nora" | Frame 07 (per-child collection framing); listed `ready` in ASSET-CHECKLIST.md |
| `back-on-timeline.png` (repo root) | 1080×2424 | Android timeline **with Looking Back carousel** | **Excluded.** Shows the unreleased Looking Back rail (`docs/features/looking-back.md:3`, status `in-progress`). Never use. |
| `bell-sheet.png` (repo root) | 1080×2424 | Android family-activity sheet | Not mapped to any of the 7 default frames or 2 openers; not needed this pass |
| `composer2.png` (repo root) | 1080×2424 | Composer in an **error state** | **Excluded — unusable** (shows an error, not a working flow) |
| `settings-expiring.png` (repo root) | 1080×2424 | Android settings, Family section | Not mapped to any of the 7 default frames or 2 openers; not needed this pass |

### Demo video inventory (new finding beyond PLAN.md §1.3's explicit list)

`marketing/assets/ugc/demo-cuts/` contains six MP4s, documented in its own
`marketing/assets/ugc/demo-cuts/README.md`. PLAN.md §1.3 names two
(`demo-voice-capture.mp4`, `demo-family-feed.mp4`) as candidates; the directory in fact
holds four more:

| File | Duration | Contents (per its own README) |
|---|---:|---|
| `demo-timeline-stories.mp4` | 11.6s | Baby book / camera-roll / private-family-feed context |
| `demo-illustrations-portraits.mp4` | 10.3s | AI illustration reveal, family characters |
| `demo-family-feed.mp4` | 12.4s | Private family feed, shared reactions |
| `demo-voice-capture.mp4` | 11.9s | Hands-full capture, "say it before I forget" |
| `demo-looking-back.mp4` | 10.3s | **"Rediscovering forgotten moments... memories resurfaced"** — explicitly the Looking Back sequence per its own README ("The Looking Back sequence appears around 00:07–00:10 in the source demo") |
| `demo-overview.mp4` | 15.0s | Broad product overview |

**`demo-looking-back.mp4` must never be used** — it is a video demonstration of the same
unreleased Looking Back feature that `back-on-timeline.png` shows, called out by name in its
own README. All six are 720×1280, below master screenshot resolution, and per PLAN.md §1.3
must never be used as a full-bleed device fill — cropped insets only, if used at all.

## 3. Book material

| Item | Verified | Note |
|---|---|---|
| `book-renderer/` | exists, has its own `package.json`, Vite + Vitest project | Self-contained, not wired into the Expo app |
| `book-renderer/package.json` script `book:pdf` | `"book:pdf": "vite-node scripts/render-pdf.mts"` (line 13) | Confirmed command form: `cd book-renderer && npm run book:pdf -- --slug sample --spine-mm <n>` |
| `book-renderer/book-data/index.json` | exists; lists slugs `enzo-year-one`, `enzo-year-three`, `enzo-year-two`, `mara-year-one`, `mara-year-two`, `sample`, and more (truncated in this check — see file for the full list) | `sample` is fully fictional (SVG placeholder art). `enzo-*`/`mara-*` use the owner's own family photos — real-person rights gate, PLAN.md §4 gate 4. |
| `book-renderer/book-data/enzo-year-three/print/cover.pdf` | exists, 1.9 MB | Committed real cover PDF — owner-photo rights gate applies before any marketing use |
| `book-renderer/book-data/mara-year-one/print/cover.pdf` | exists, 616 KB | Same gate |

`sample` is the only slug safe to render and use in this pass without an additional owner
rights conversation; it has not been rendered in this WP-A pass (rendering is phase 3 scope,
and PLAN.md §6 permits it as the one safe/free book render — it was not executed here since
WP-A's scope is evidence documents, not asset production).

## 4. Design tokens

`src/constants/theme.ts` is the source of truth (per PLAN.md §1.3, confirmed present).
`store-assets/templates/screenshot.html` holds a **hand-mirrored copy** of the palette —
not a shared import — so token drift between the app and the template is possible and was
not diffed line-by-line in this pass (recorded as a `needs_revalidation` item in
`momora-listing-handoff-v2/state.json`, owned by phase 4).

## 5. Missing tools / capability gaps

- **No runtime demo/fixture mode.** `__mocks__/` (`expo-media-library.ts`,
  `posthog-react-native.ts`, `react-native-purchases.ts`) is Jest-only; it cannot produce a
  populated screen for a native screenshot capture.
- **No `ios/` directory** — confirmed with `ls ios` → "No such file or directory". No
  cached native build exists to launch and screenshot directly.
- **No demo/fixture environment** — the populated demo content lives in a
  production-pointed Supabase project behind OTP email to the seeded demo account
  (`docs/features/gallery-import.md` and related feature docs describe this account by
  email; this document deliberately does not repeat that address — see PLAN.md constraints
  on not propagating it).
- **Seed scripts are dry-run by default and cost money/mutate production with `--apply`.**
  Confirmed in `supabase/scripts/seed-demo-top-up.ts`: "Dry-run is the default. `--apply` is
  required before any OpenAI, R2, or [production] [call]" (comment block, line 4;
  `options.apply` default `false` at line 122; `if (arg === '--apply')` at line 129). Not
  run in this pass.

## Do not run (PLAN.md §6 do-not-run list, confirmed present in `package.json`)

| Script | Why not to run |
|---|---|
| `npm run seed:demo-top-up`, `npm run seed:demo-engagement` (and any other `seed:demo-*`) | `--apply` performs real production writes and paid OpenAI/fal.ai calls against a production-pointed Supabase project; dry-run without `--apply` is technically safe but still out of this pass's scope and not needed for evidence documents. |
| `npm run backfill:previews`, `backfill:video-posters`, `backfill:share-cards`, `backfill:portrait-reencode`, `backfill:memory-analysis` (any `backfill:*`) | Confirmed present in `package.json` (lines 31–35). Production data-mutation scripts, not listing tooling. |
| `npm run regenerate:illustrations` | Confirmed present (`package.json:30`). Triggers paid AI image generation against production data. |
| `npm run import:printed-memory-book` | Confirmed present (`package.json:48`). Imports/writes against production order records. |
| `npm run eval:*` (`eval:portrait`, `eval:illustration`, `eval:image-cost`, `eval:memory-book-*`) | Confirmed present (`package.json:18-24,47`). Prompt-iteration harnesses that call paid providers against the real database. |
| `store-assets/generate-art.mjs` (`npm run generate-art` inside `store-assets/`) | Calls OpenAI `gpt-image-2` to generate new decorative watercolor art — billable. Existing `store-assets/art/*.png` outputs may be reused (per PLAN.md §6, generated art is allowed only as labelled decorative brand texture, never as product evidence); regenerating them is unnecessary for this pass. |
| Any `build`/EAS build command | PLAN.md §6: do not run builds. |
| `book-renderer`'s slugs other than `sample` (`enzo-*`, `mara-*`) | Use the owner's real family photographs; rendering itself is technically free/offline, but using the *output* for marketing needs the owner-approval gate in PLAN.md §4 gate 4 — not run in this pass. |
