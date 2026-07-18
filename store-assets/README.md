# Momora Store Assets

A repeatable pipeline for rendering pixel-exact app store listing assets
(screenshots + Play feature graphic) from HTML/CSS templates via headless
Chromium, plus a helper script for generating watercolor spot art with
OpenAI's image API (`gpt-image-2`).

This folder is self-contained: its own `package.json`, its own
`node_modules`, nothing here is wired into the main Expo app.

The slide set implements the round-1 storyboard/copy spec (6 slides ×
6 sizes + feature graphic = 37 PNGs).

## Layout

```
store-assets/
  source/           4 raw iPhone screenshots (1170x2532) used as device-frame fills
    ipad/             5 raw iPad Pro 13" (M5) screenshots (2064x2752); 4 wired
                       into slides s2-s5, 1 spare (person-detail) unused
  fonts/            Local TTFs copied from node_modules/@expo-google-fonts/*
    Newsreader/      400 Regular, 500 Medium, 400 Regular Italic
    PlusJakartaSans/ 400 Regular, 500 Medium, 700 Bold
    Caveat/          400 Regular, 700 Bold
  templates/
    screenshot.html      One template, all screenshot sizes via ?size=; two layouts (device / hero);
                          two device-frame skins (iPhone / iPad) picked automatically per size bucket
    feature-graphic.html 1024x500 Play feature graphic
  manifest.json      Drives rendering: array of slides {id, template, sizes, params}
  render.mjs         Playwright renderer -> out/<bucket>/<id>.png
  generate-art.mjs   OpenAI gpt-image-2 helper (watercolor art)
  prompts/           Prompt .txt files (shared house-style block + per-image scene)
  art/               Generated art (hero-family, evening-moment, feature-hero; gitignored)
  out/               Rendered PNGs (gitignored)
    appstore/          1260x2736 (primary, App Store Connect, iPhone frame)
    appstore-alt/      1320x2868 (insurance size, iPhone frame)
    play/              1080x1920 (Play phone, 9:16, iPhone frame)
    ipad/              2064x2752 (App Store iPad 13" portrait, 3:4, iPad frame)
    play-tablet7/      1080x1920 (Play 7" tablet, 9:16, iPad frame)
    play-tablet10/     1620x2880 (Play 10" tablet, 9:16, iPad frame)
    feature/           1024x500
```

## Setup (one time)

```bash
source ~/.nvm/nvm.sh && nvm use 20
cd store-assets
npm install
npx playwright install chromium
```

## Rendering

```bash
source ~/.nvm/nvm.sh && nvm use 20
cd store-assets
node render.mjs                  # render every slide in manifest.json (37 PNGs)
node render.mjs --id s2-transformation   # one slide (all of its sizes)
node render.mjs --manifest other.json    # different manifest file
```

After each screenshot, `render.mjs` reads the PNG's own IHDR header and
asserts its pixel dimensions match the expected size for that slide's size
bucket. Any mismatch fails loudly (non-zero exit + diagnostic).

Manual check at any time:

```bash
sips -g pixelWidth -g pixelHeight out/*/*.png
```

## Manifest schema

Each slide:

```json
{
  "id": "s2-transformation",
  "template": "screenshot.html",
  "sizes": ["appstore", "appstore-alt", "play"],
  "params": { ... }
}
```

- `sizes` (array) renders one PNG per size into `out/<size>/<id>.png`;
  the feature graphic uses `size: "feature"` (single).
- Asset paths inside `params` (`screenshot`, `art.src`) are resolved
  relative to `templates/`, hence `../source/...` and `../art/...`.
- Sizes `ipad`, `play-tablet7`, `play-tablet10` are "tablet buckets" — the
  template automatically swaps to the iPad capture set + iPad device frame
  for these, no separate slide/manifest entry needed. See "iPad device
  frame" below.

### `screenshot.html` params

| param | meaning |
|---|---|
| `layout` | `"device"` (default) or `"hero"` (no frame, full-bleed art lower ~2/3, soft top fade via CSS mask) |
| `headline` | Newsreader serif headline (sentence case per copy spec — never ALL CAPS) |
| `subline` | Plus Jakarta Sans subline (optional) |
| `script_accent` | Caveat pink script line rendered under the headline (optional) |
| `caption_top` | caption block top as % of canvas height (optional override) |
| `screenshot` | device-layout source screenshot path (iPhone frame; used for appstore/appstore-alt/play) |
| `screenshot_tablet` | device-layout source screenshot path for the iPad frame (used for ipad/play-tablet7/play-tablet10); falls back to `screenshot` if omitted |
| `statusbar_bg` | CSS background for the iPhone replacement status bar (default paper `#FAFAFD`; S2 uses a light-blue gradient matching IMG_0912's header) |
| `statusbar_bg_tablet` | CSS background for the iPad replacement status bar; falls back to `statusbar_bg` if omitted |
| `statusbar` | `false` disables the replacement status bar (iPhone frame only) |
| `bleed` | iPhone device frame bleeds off the bottom edge (tablet buckets have their own bleed rules — see below) |
| `chips` | floating pastel emotion chips: `{emotion, top_pct, left, size, rotate}` — `top_pct` is % of canvas height, `left` in 1260-space px. Rendered above the device so they always read as intentional floating elements. Optional per-chip `top_pct_tablet` / `left_tablet` override the position on the three tablet buckets only — used to keep chips off TEXT inside the capture where the tablet device geometry differs (the 9:16 tablet frame is full-bleed, so phone-authored positions can land on headings); nudge onto imagery, card edges, or the bezel instead |
| `art` | hero layout: `{src}` full-bleed art; device layout: absolute spot-art slot `{src, top, left, width, height, z}` |
| `wordmark` | `{position: "top"}` small top-center lockup (default) or `{position: "bottom"}` large bottom lockup with a soft paper glow for legibility over art |

Emotion pastels: joy `#FFE7B0`, wonder `#CFE1F4`, calm `#D6EDDE`, tender
`#FBD6E1`, mischief `#E5D2F1`. The app's "funny" tag is aliased to the
tender pink pastel (there is no dedicated "funny" pastel in the palette).

### Status bar replacement

The raw captures carry a real status bar ("22:47"/"11:19 PM", charging
battery). In the device frame the screenshot is anchored
`object-position: top` and a clean opaque HTML status bar strip covers the
raw one.

- **iPhone frame** (appstore/appstore-alt/play): 106px in 996px-screen
  space ≈ 124px at 1170-source scale, "9:41" left, wifi + full battery
  right, background matched to each screenshot's top-of-screen tone
  (sampled from the source pixels). The dynamic island pill stays.
- **iPad frame** (ipad/play-tablet7/play-tablet10): 40px fixed (covers the
  raw capture's own status bar, measured at y=19-45 for the "11:19 PM Sat
  Jul 18" text in the 2064x2752 source, with margin before the app's own
  header content, which never starts earlier than y=84). No dynamic
  island, so "9:41  Sat Jul 18" sits flush left and wifi + full battery
  flush right, matching real iPadOS layout. Background matched per capture
  (`statusbar_bg_tablet`, sampled from source pixels the same way).

### iPad device frame

Tablet buckets (`ipad`, `play-tablet7`, `play-tablet10`) render the iPad
Pro 13" (M5) captures in `source/ipad/` inside a separate frame skin
(`.device-ipad` class, toggled automatically by size bucket): a slimmer
uniform bezel than the iPhone frame (1.6% padding vs. iPhone's ~2.1%),
squarer corners (56px device / 40px screen radius vs. iPhone's 96px/74px),
and no dynamic island. Frame height is derived from width via
`aspect-ratio: 2064/2752` (the source captures' own aspect) rather than a
fixed percent of stage height, so the screenshot is never crop-distorted.

All tablet buckets position the frame dynamically: device top sits a small
intentional gap (2.5% of canvas height) below the caption's actual
rendered bottom (same technique as the hero-layout art positioning,
recomputed once web fonts load), then the frame bleeds off the bottom
edge. A fixed bottom-anchored offset (the iPhone `.bleed` approach) is
wrong in both directions for this frame: on the squarer 3:4 `ipad` canvas
it pushes the device up into the caption, and on the tall 9:16 tablet
canvases it strands a large dead paper band (with the chips floating in
it) between the subline and the frame.

Width differs by canvas shape:

- `ipad` (3:4): fixed 81% of the 1260-unit stage; the aspect-kept frame is
  tall enough to bleed off the bottom on its own.
- `play-tablet7` / `play-tablet10` (9:16): the 2240-unit-tall stage means
  no on-canvas 3:4 frame can span from below the caption to the bottom
  edge, so the width is computed per slide as
  `(stageH - deviceTop + 16) * 2064/2752` — the aspect-kept frame exactly
  reaches just past the bottom. This comes out slightly wider than the
  canvas (~105-112% depending on caption height), so the sides bleed
  off-canvas; the clipped side strips are bezel plus the capture's own
  blank margin (no UI text is lost), and the chips overlap the on-canvas
  device instead of floating in empty paper.

### Scaling model

The template is authored in a fixed 1260-unit-wide coordinate space; a
single `--scale` var maps it to the requested canvas width. Because the
screenshot canvases have different aspect ratios (appstore ~0.460,
appstore-alt ~0.460, play/play-tablet7 0.5625, play-tablet10 0.5625, ipad
0.75), the stage height (in 1260-space units) is recomputed per size so
`stage-height * scale` exactly equals the target height, and top-level
vertical placement (wordmark, caption, device wrap, hero art) uses
percentages of stage height so blocks reflow proportionally instead of
being cropped. Horizontal layout and most local chrome (bezel radius,
dynamic island, iPad statusbar height) stay fixed-px; the iPad device
frame's width is either a fixed percentage of the constant-width stage
(`ipad`) or computed per slide so the aspect-kept frame spans caption to
bottom edge (`play-tablet7`/`play-tablet10` — see "iPad device frame"
above), with height always following from `aspect-ratio`.

## Feature graphic

`feature-graphic.html`: blush gradient (`#FDEAF1` → `#FBD3E2`) with a
saturated pink radial accent; left — wordmark lockup + "Keep the little
things." + pink brush-stroke SVG accent; right — `art/feature-hero.png` in
a soft-rounded organic mask. All critical content inside the centered
860×480 safe zone. No badges, CTA, pricing, or device imagery.

## Generating watercolor art

**Costs money.** Always dry-run first.

```bash
node generate-art.mjs --prompt-file prompts/hero-family.txt --size 1024x1536 --out art/hero-family.png --dry-run
node generate-art.mjs --prompt-file prompts/hero-family.txt --size 1024x1536 --out art/hero-family.png
```

Supported sizes (the only ones the API accepts): `1024x1024`, `1536x1024`,
`1024x1536`.

Current prompts (each = shared house-style block + scene description):

| prompt file | output | size |
|---|---|---|
| `prompts/hero-family.txt` | `art/hero-family.png` (S1 hook) | 1024x1536 |
| `prompts/evening-moment.txt` | `art/evening-moment.png` (S6 closing) | 1024x1536 |
| `prompts/feature-hero.txt` | `art/feature-hero.png` (feature graphic) | 1536x1024 |

The API key is read at runtime from `../supabase/.env.local`
(`OPENAI_API_KEY=...`, dotenv-style). The script never prints, logs, or
copies the key anywhere — `--dry-run` only confirms the key was *found*.
House style guardrails live in the shared block of every prompt (watercolor
children's-book, not photoreal/3D/CGI, no text/letters/numbers). If a
generation comes back with baked-in text or looks photoreal, regenerate
once with a strengthened negative instruction; if still bad, keep both
files and flag it for human review.

## Fonts

Copied from `node_modules/@expo-google-fonts/*` into `fonts/` so templates
can `@font-face` them locally without a network fetch:

| Family | Weights copied | Source package |
|---|---|---|
| Newsreader | 400 Regular, 500 Medium, 400 Regular Italic | `@expo-google-fonts/newsreader` |
| Plus Jakarta Sans | 400 Regular, 500 Medium, 700 Bold | `@expo-google-fonts/plus-jakarta-sans` |
| Caveat | 400 Regular, 700 Bold | `@expo-google-fonts/caveat` |

All requested weights were available — nothing missing or substituted.

## Notes / known deviations

- The "funny" chip color is an alias of the tender pink pastel — the
  palette has no dedicated funny color.
- `render.mjs` parses PNG dimensions itself from the IHDR chunk rather
  than adding an image-size dependency (only dependency is `playwright`).
- The status-bar clock reads "9:41" (Apple's marketing-standard time) with
  wifi + full battery, replacing the raw captures' "22:47"/"11:19 PM" +
  charging battery. The iPad statusbar additionally shows the weekday/date
  ("9:41  Sat Jul 18"), matching the iPadOS status bar's own layout.
- `source/ipad/spare-person-detail.png` (person-detail capture) is not
  wired into any slide — kept as a spare in case a future slide needs it.
- Nothing outside `store-assets/` is modified by any script here.
