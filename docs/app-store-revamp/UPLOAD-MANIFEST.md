# Upload manifest — explicit allowlist (locale en-US)

**Uploadable count: 1 image, out of 28 required default frame×bucket slots (7 frames × 4
device buckets), plus 0 of the opener-challenger and optional-slot-7 experiments.**

This is not a rounded-up number. It is the literal count of assets that (a) have a genuine
product-evidence source per `store-assets/v2/ASSET-MANIFEST.json`, (b) carry no DRAFT
banner, and (c) are named explicitly in `store-assets/out/v2/UPLOAD-CANDIDATES.json`'s
`uploadable` object — independently re-verified in `QA-REPORT.md` §3–4. Nothing else in
this repository should be uploaded to App Store Connect at this time.

Excluded from this manifest, deliberately: all draft-marked frames, `store-assets/source/`
raw captures, `store-assets/v2/raw/` (including `raw/rejected/`), contact sheets and
preview galleries under `store-assets/preview/`, repo-licensed fonts, the preserved v1
artifact tree (`store-assets/manifest.json`, `store-assets/out/appstore*`, `out/ipad`,
`out/play*`, `out/feature`), and both opener-challenger sets in full (0 uploadable frames
in either).

---

## Images — App Store Connect screenshot upload

| Locale | Device family (ASC bucket) | Slot order | Filename | SHA-256 | Variant |
|---|---|---|---|---|---|
| en-US | iPad 13" (2064×2752) | 1 of 1 usable slot (frame 7 of the intended 7) | `07-look-back.png` | `458730c1fc48c390f389e89ddff665b6f54ecd1d2b2e544a0ccb4aecba520b5d` | default (not an opener challenger) |

Source path: `store-assets/out/v2/ipad/07-look-back.png`.

**Do not upload this single image as if it were a complete 7-image set.** App Store
Connect screenshot slots are ordered; uploading only slot 7 without slots 1–6 would show an
incomplete, out-of-context listing. This manifest exists to prevent exactly that mistake —
it documents what is *technically* ready, not what is ready to *publish*. Publishing
requires the other 6 default frames (all four buckets) and, separately, an owner decision
on which opener (default frame 1, `existing-photo-first`, or `voice-first`) to ship, none of
which currently have a genuine capture.

**Every other frame×bucket combination is excluded**, per the explicit `excluded` map in
`store-assets/out/v2/UPLOAD-CANDIDATES.json`:

- `01-more-than-photos` — excluded on all 4 buckets (no saved-sound capture exists).
- `02-existing-photos` — excluded on all 4 buckets (no gallery-import-deck capture exists).
- `03-unphotographed-stories` — excluded on all 4 buckets (no composer-input capture exists).
- `04-little-voice` — excluded on all 4 buckets (no saved-sound-player capture exists).
- `05-optional-book` — excluded on all 4 buckets (no in-app book-shelf/browser-review
  capture exists; only an offline-rendered sample interior page is real).
- `06-private-family` — excluded on all 4 buckets (existing capture shows the character
  roster, not the actual invite/role-management screen the frame requires).
- `07-look-back` — excluded on `appstore`, `appstore-alt`, `appstore-65` (the iPhone
  day-list capture is genuinely truncated); **not excluded on `ipad`** (see table above).

## Opener challengers — separate, optional, not part of the default set

`store-assets/out/v2-challenger-photo/` (`existing-photo-first`) and
`store-assets/out/v2-challenger-voice/` (`voice-first`) each have **0 uploadable frames**.
Frames 02–07 inside each set are pixel-identical to the default set (independently
reproven by recomputed sha256 in `QA-REPORT.md` §3) but are draft for the same reasons as
the default set; frame 1 of each challenger has no genuine capture at all. These are
release candidates for a future opener A/B test only if and when an owner decision is made
to run that test (per `MASTER-BRIEF.md` — "opener tests, not complete business-model
comparisons") and the missing frame-1 capture is produced. **None are included in this
upload manifest.**

## App Store Connect field mapping (text)

| ASC field | Source file | Notes |
|---|---|---|
| App Name | `store-assets/listing/out/en-US/name.txt` | 23 characters, verified ≤30. |
| Subtitle | `store-assets/listing/out/en-US/subtitle.txt` | 30 characters, at the limit. |
| Promotional Text | `store-assets/listing/out/en-US/promotional-text.txt` | 132 characters, verified ≤170. This field can be changed without a new build/review — safe to update independently once genuinely approved. |
| Description | `store-assets/listing/out/en-US/description.txt` | 2067 characters (2087 UTF-8 bytes), verified ≤4000. |
| Keywords | `store-assets/listing/out/en-US/keywords.txt` | 66 UTF-8 bytes, verified ≤100. Comma-separated, no spaces, per Apple's field convention — confirm this exact format is what the ASC keyword field expects at submission time. |
| What's New in This Version | `store-assets/listing/out/en-US/whats-new.txt` | 377 characters, verified ≤4000. **Only use this text in the specific release where gallery-import + book-generation are actually new to the shipped build** — do not paste it into an unrelated release. |
| Screenshots (iPad 13") | `store-assets/out/v2/ipad/07-look-back.png` | Only genuinely uploadable image; see table above. Screenshot captions/headlines burned into the image are sourced from `store-assets/listing/registry.v2.json`'s `screenshots[6]` entry, not a separate ASC field — App Store screenshots do not have a separate per-image text field beyond the image itself. |
| Screenshots (all other slots/buckets) | — | **Not ready.** Do not upload placeholders, drafts, or raw captures to any other slot. |

## Not included in this manifest (explicitly, per task constraints)

- Raw captures (`store-assets/source/`, `store-assets/v2/raw/`).
- Contact sheets / preview galleries (`store-assets/preview/`).
- Fonts (`store-assets/fonts/`).
- The preserved v1 artifact set (`store-assets/manifest.json` and its `out/appstore*`,
  `out/ipad`, `out/play*`, `out/feature` outputs) — historical, not a v2 release candidate.
- Rejected sources (`store-assets/v2/raw/rejected/book-cover-sample.png`,
  `book-spread-sample.png`, `book-spread-text-sample.png`) — explicitly rejected after
  visual review, never a candidate.
- Any file under `momora-listing-handoff-v2/` or `docs/app-store-revamp/` — these are
  process/evidence documents, not upload assets.
