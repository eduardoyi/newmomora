# Prodigi order spec — layflat photo book (210×210mm)

Research artifact for V3 Phase 2 (fulfillment side) of the memory book
(`docs/plans/memory-book.md`). No code here — this documents the current
Prodigi facts needed to build the wraparound-cover PDF pipeline (a parallel
task parameterized its cover generator with `--spine-mm`) and to place the
first physical sample orders (memory-book.md's V4 milestone).

**Cross-checked against**: the official Prodigi file-setup PDF, the
product page, the API reference docs, and the FAQ (all fetched 2026-08-29;
URLs in each section). Two ambiguities need a direct support question
before committing code to numbers — see "Open questions for support"
at the end.

## 1. Product / SKU options

Prodigi's **layflat photo book** product family covers our target size.

| Size | Orientation | Dimensions |
|---|---|---|
| A4 | Landscape | 297 × 210mm / 11.7 × 8.3" |
| A4 | Portrait | 210 × 297mm / 8.3 × 11.7" |
| **8.3 × 8.3"** | **Square** | **210 × 210mm** ← our target |
| 11.7 × 11.7" | Square | 297 × 297mm |

Source: [Layflat Photo book set up guide V2 (PDF)](https://www.prodigi.com/download/print-guides/layflat-photo-book-print-guide.pdf), p.3.

**SKU:** prefix `BOOK-FE`. The only confirmed full SKU string from public
docs is the A4-landscape example: `BOOK-FE-A4-L-LF-G`. Reading that
pattern (`BOOK-FE-{size}-{orientation}-LF-G`, where `LF` = layflat and `G`
is presumably the paper/gloss variant), the 210×210mm square SKU is very
likely `BOOK-FE-SQ8-LF-G` or `BOOK-FE-SQ-LF-G` — **but this is inference,
not a confirmed value**, since square sizes have no orientation letter to
pattern-match against. Confirm it before writing it into a config file, via
either:

```bash
curl -s https://api.sandbox.prodigi.com/v4.0/products \
  -H "X-API-Key: $PRODIGI_SANDBOX_KEY" | grep -i "layflat\|BOOK-FE"
```

or the Prodigi dashboard's product picker (search "layflat" → 8.3×8.3" →
the SKU is shown in the product detail panel).

Source: [Layflat photo book product page](https://www.prodigi.com/products/books-and-magazines/layflat-photo-book/).

## 2. Interior page-count limits

**18–122 pages, even number required.** Odd submissions get a blank final
page appended automatically (not rejected). This is the hard ceiling that
bounds a Momora book's outline — 122 pages, not "as many as the curation
wants."

Source: layflat PDF guide, p.4 ("Our layflat books range from 18-122
pages. Your book **must** have an even number of pages... If you submit an
odd number, the final page will be left white.")

For comparison, Prodigi's other book families (useful if a future book
size/binding pivot happens):

| Product | Page range |
|---|---|
| Layflat | 18–122 |
| Softcover | 20–300 |
| Hardcover | 24–300 (or 24–500, 150gsm gloss paper only) |

Source: [Photo books technical guide](https://www.prodigi.com/blog/photo-books-technical-guide/).

## 3. Spine width — no public formula; must query the API

This is the most important finding for the parallel agent's `--spine-mm`
cover generator: **Prodigi does not publish a spine-width formula or table
for layflat books.** The official guide is explicit about this:

> "Spine dimensions are calculated based on the total number of pages and
> the specific production lab that will print and bind your photo book...
> To ensure your spine artwork fits correctly, please **query the API** to
> receive the exact dimensions required for your project."

Source: layflat PDF guide, p.7 ("Spine calculation for API users").

### The spine endpoint

```
POST https://api.sandbox.prodigi.com/v4.0/products/spine   (sandbox — free, no fulfillment)
POST https://api.prodigi.com/v4.0/products/spine            (production)
```

Headers: `X-API-Key: <your key>`, `Content-Type: application/json`.

Request body (fields per the API reference):

```json
{
  "sku": "BOOK-FE-SQ8-LF-G",
  "destinationCountryCode": "ES",
  "numberOfPages": 120
}
```

Response shape (this endpoint is a documented special case — it returns
`{ success, message, spineInfo }`, **not** the standard outcome envelope
every other Prodigi endpoint uses):

```json
{
  "success": true,
  "message": "...",
  "spineInfo": {
    "widthMm": 25.4
  }
}
```

(`25.4` above is Prodigi's own illustrative example value from their docs
— **not a real measurement for our book**. See "What I could not obtain"
below.)

Source: [Prodigi API reference](https://www.prodigi.com/print-api/docs/reference/), spine endpoint section.

### What I could not obtain

I have no Prodigi API key (sandbox or production) and this task is
research-only (no owner credentials were provided, and none should be
pasted into this doc). **The exact `widthMm` for a 120-page and a
122-page 210×210mm layflat book has not been obtained** — it requires one
authenticated POST per page count. This is straightforward for the owner
to get once a sandbox key exists (free signup, no card required per the
FAQ): see the "Order the first two samples" checklist below, step 2, for
the exact commands to run.

**Do not hardcode a guessed spine width.** Since the pipeline already
parameterizes `--spine-mm`, the right integration is to call this endpoint
at cover-generation time (or cache the result per page-count, since spine
width is a pure function of `sku` + `numberOfPages` + destination) rather
than freezing a number from a one-time lookup — Prodigi's own docs warn the
value depends on "the specific production lab," which could differ by
fulfillment region.

## 4. File specs

Source: layflat PDF guide, pp.3, 4, 8 (all bullets below are direct from
that document unless noted).

| Spec | Value |
|---|---|
| Resolution | 300dpi |
| Colour profile (content authoring) | **RGB** |
| Recommended PDF export setting | **PDF/X-4 (coated FOGRA 39)** |
| Bleed / crop marks | **Do not add.** "Our system will automatically generate these." |
| Safety margin | 10mm from every trimmed edge (top/bottom/outer edge on content pages; all four edges on the cover) |
| Content page size | Same as book trim size — 210×210mm per page, not a spread size |
| Fonts | Must be embedded |
| Transparency | Must be flattened |

**⚠️ Ambiguity #1 (flag for support):** the guide states content should be
authored in **RGB**, but recommends exporting as **PDF/X-4 (coated FOGRA
39)** — FOGRA 39 is a *coated CMYK* ICC profile. It's unclear whether
Prodigi wants: (a) an RGB-authored PDF that merely carries the X-4
compliance flag (fonts embedded, transparency flattened, no actual color
conversion), or (b) an actual RGB→CMYK conversion against FOGRA 39 before
export. Given illustrations are watercolor-style AI output and skin-tone
accuracy matters, this is worth a direct support question before the
render pipeline locks in a color-management step — see "Open questions."

### Submission format: spreads vs. individual pages

**Always submit individual single pages, never merged two-page spread
images** — even though the book is *designed* as spreads:

> "You can design double-page spreads starting from pages 3 & 4... All
> spreads must be saved as individual single pages (e.g. page 3 and page 4
> should be saved as separate pages in the PDF)."

Page-to-book mapping (from the guide's "Layout" diagram, p.6):

| PDF page | Printed position |
|---|---|
| 1 | Front cover |
| — | Inside front cover: blank, added by Prodigi, cannot be printed on |
| 2 | First content page (right-hand side) |
| 3, 4, ... | Content pages, left/right alternating |
| second-to-last | Last content page |
| — | Inside back cover: blank, added by Prodigi |
| last | Back cover |

One PDF file containing cover + all content pages, in that order, for
**manual/dashboard orders**. For **API orders**, two submission modes are
supported:

1. A single cover file (front + back + spine combined) + a separate inner-pages file, **or**
2. Spine artwork provided as its own separate asset from the cover.

Source: layflat PDF guide, p.7 ("Spine calculation for API users").

### Cover spec dimensions

There is no static cover template dimension published for layflat books —
by construction, cover width = `2 × 210mm + spineWidthMm` (plus whatever
wrap/bleed margin Prodigi auto-generates), and `spineWidthMm` is the
page-count-dependent value from §3. The exact pixel dimensions per print
area (`printAreaSizes`, keyed by print area name, in `horizontalResolution`
/ `verticalResolution` pixels) are returned by:

```
GET https://api.sandbox.prodigi.com/v4.0/products/{sku}
```

Source: [Prodigi API reference](https://www.prodigi.com/print-api/docs/reference/), Product Details endpoint. Not called in this task (no API key) — see the ordering checklist below for the exact command.

## 5. How ordering works

- **Dashboard (manual order form):** upload a single PDF (cover + content
  as described above); the order form UI itself prompts for spine text,
  text color, and background color — **Prodigi renders the spine text for
  you** in this path.
- **Print API:** `POST /v4.0/Orders` (or `/Quotes` for a price-only dry
  run) with an `items` array; each item has `sku`, `copies`, `attributes`,
  and an `assets` array where each asset specifies a `printArea` (e.g.
  `"default"`, `"spine"`) and a source image/PDF URL. **API orders must
  bake the spine artwork into the submitted file themselves** — there is
  no server-side spine-text renderer on this path. This directly confirms
  the parallel agent's `--spine-mm` parameterization is the correct
  approach: our renderer must draw the spine (title, background) as part
  of the generated cover PDF, using the width from §3.
- **Storefront integrations** also exist (Shopify, Etsy, Squarespace,
  WooCommerce, BigCommerce, Wix, Adobe Commerce, TikTok) — not relevant to
  our custom pipeline.
- **Sandbox:** `api.sandbox.prodigi.com` is free, requires no card, and
  never charges or fulfills real orders — the correct environment for
  every V4 dry run before a real paid sample. Get a sandbox key by
  signing up at the Prodigi dashboard and clicking the gear icon → "Show
  API key." Auth header: `X-API-Key: <key>`.
- **Note on data parity:** Prodigi's own FAQ warns sandbox and production
  aren't always in exact data parity (SKU availability, pricing) — "the
  Live environment always has the most up-to-date and accurate
  information." Confirm final SKU/spine numbers against production once
  the sandbox pipeline works, before the real sample order.

Sources: [Print API FAQ](https://www.prodigi.com/faq/print-api/), [API reference](https://www.prodigi.com/print-api/docs/reference/).

## 6. Indicative unit cost + shipping to Spain

**Floor price:** the layflat product page advertises "Starting from
£18.01" (GBP, excluding tax/shipping) — but that's the cheapest
configuration (18 pages, base paper). Our target book is 120–122 pages,
which will cost meaningfully more; **no public per-page or per-100-pages
price list exists**.

**Exact cost + Spain shipping requires an authenticated call.** Two ways
to get it, both gated on having an account:

1. **Quote endpoint** (works in sandbox, no charge):
   ```
   POST https://api.sandbox.prodigi.com/v4.0/quotes
   ```
   with the real SKU, `copies: 1`, `destinationCountryCode: "ES"`, and
   `numberOfPages` in the item's attributes. Returns `costSummary` with
   separate `items` and `shipping` costs, and a `shipments` array with
   carrier + `fulfillmentLocation`.
2. **Dashboard pricing & shipping tool** — downloads a price sheet per
   product/destination; no API integration needed, fastest path if the
   owner just wants a number before writing any order code.

**Shipping mechanics (from the general shipping FAQ, not book-specific):**
three tiers — Budget (slowest, often untracked outside the US), Standard,
Express (tracked, FedEx/UPS/DPD) — with production time (96–144 hours /
4–6 days for layflat specifically, per the product page) additional to
shipping transit time. No Spain-specific transit-time number is published;
get it from the same Quote call (destination-specific `shipments` data) or
the dashboard tool.

Sources: [Layflat product page](https://www.prodigi.com/products/books-and-magazines/layflat-photo-book/), [Shipping FAQ](https://www.prodigi.com/faq/shipping/), [Print API FAQ](https://www.prodigi.com/faq/print-api/).

## 7. Turnaround

- **Production:** 96–144 hours (4–6 days) for layflat books specifically
  (per the product page). For comparison, softcover is faster (96h) than
  hardcover (120h) per the technical guide — layflat's binding (PUR
  adhesive, described as needing to "cure through a chemical reaction with
  moisture in the air") plausibly explains it sitting at the slower end.
- **Shipping:** additional to the above, tier-dependent (see §6). Get an
  ES-specific number from the Quote endpoint or dashboard tool before
  promising the owner (or eventually a customer) a delivery date.

## Order the first two samples — step-by-step checklist

Scoped to memory-book.md's **V4 — Physical proof** milestone: one real
Prodigi order of Eduardo's actual book, including a QR test page. This
checklist gets the two numbers ("what's the exact SKU" and "what's the
exact spine width") that block writing the cover-generation code against
real values, then walks through a sandbox dry run before the paid sample.

1. **Create a Prodigi account and get a sandbox API key.**
   Sign up at the Prodigi dashboard → gear icon → "Show API key" → copy
   the **sandbox** key (starts fresh, no card needed). Store it as a local
   env var, never in a committed file:
   ```bash
   export PRODIGI_SANDBOX_KEY="..."
   ```

2. **Confirm the exact SKU for 210×210mm (8.3×8.3") layflat:**
   ```bash
   curl -s https://api.sandbox.prodigi.com/v4.0/products \
     -H "X-API-Key: $PRODIGI_SANDBOX_KEY" \
     | python3 -m json.tool | grep -B2 -A10 -i "layflat"
   ```
   (If the products endpoint requires a different query shape than a bare
   list — the public docs weren't fully explicit — the dashboard's product
   picker gives the same SKU string with zero API calls: Create Order →
   search "layflat" → 8.3×8.3" → SKU shown in the panel.)

3. **Get the real spine width for a 120-page book and a 122-page book**
   (our two candidate page counts — 120 as a round target, 122 as the
   hard ceiling from §2), using the confirmed SKU from step 2:
   ```bash
   curl -s -X POST https://api.sandbox.prodigi.com/v4.0/products/spine \
     -H "X-API-Key: $PRODIGI_SANDBOX_KEY" \
     -H "Content-Type: application/json" \
     -d '{"sku":"<CONFIRMED_SKU>","destinationCountryCode":"ES","numberOfPages":120}'

   curl -s -X POST https://api.sandbox.prodigi.com/v4.0/products/spine \
     -H "X-API-Key: $PRODIGI_SANDBOX_KEY" \
     -H "Content-Type: application/json" \
     -d '{"sku":"<CONFIRMED_SKU>","destinationCountryCode":"ES","numberOfPages":122}'
   ```
   Record both `spineInfo.widthMm` values here (or in whatever config the
   cover generator reads) once obtained — **do not proceed to wire
   `--spine-mm` defaults into committed code from anything other than this
   live response.**

4. **Get exact print-area pixel dimensions for the cover template:**
   ```bash
   curl -s https://api.sandbox.prodigi.com/v4.0/products/<CONFIRMED_SKU> \
     -H "X-API-Key: $PRODIGI_SANDBOX_KEY" | python3 -m json.tool
   ```
   Read `variants[].printAreaSizes` for the `default` (cover) and any
   `spine`-named print area.

5. **Sandbox dry-run order** using the real book PDF once the renderer
   (parallel task) produces one at the confirmed spine width — sandbox
   never charges or fulfills, so this is free and repeatable:
   ```bash
   curl -s -X POST https://api.sandbox.prodigi.com/v4.0/Orders \
     -H "X-API-Key: $PRODIGI_SANDBOX_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "shippingMethod": "Standard",
       "recipient": { "name": "...", "address": { "line1": "...", "postalOrZipCode": "...", "countryCode": "ES" } },
       "items": [{
         "sku": "<CONFIRMED_SKU>",
         "copies": 1,
         "assets": [
           { "printArea": "default", "url": "<hosted cover+content PDF URL>" }
         ]
       }]
     }'
   ```
   Confirm the response reports no preflight errors (the brief's "Prodigi
   rejection must alert us and never silently strand a paid order" concern
   from memory-book.md §5 — validate this in sandbox before ever hitting
   production).

6. **Get a real cost + Spain shipping quote** before ordering for real:
   ```bash
   curl -s -X POST https://api.sandbox.prodigi.com/v4.0/quotes \
     -H "X-API-Key: $PRODIGI_SANDBOX_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "shippingMethod": "Standard",
       "destinationCountryCode": "ES",
       "items": [{ "sku": "<CONFIRMED_SKU>", "copies": 1 }]
     }'
   ```

7. **Switch to a production API key, submit the real order** for Eduardo's
   actual 120-or-122-page book (V4). Optionally repeat with the Peecho
   twin per memory-book.md's V4 note, for a paper/binding comparison.

8. **On arrival:** verify per memory-book.md §7 — paper/binding/color
   verdict, and QR scannability on the actual gloss-coated stock under
   real lighting (glare risk called out explicitly in that doc).

## Open questions for support (ask before locking pipeline defaults)

1. **RGB vs. PDF/X-4 FOGRA 39 (§4, Ambiguity #1).** Does Prodigi want a
   straight RGB-authored PDF with the X-4 compliance flag only (fonts
   embedded, transparency flattened), or an actual RGB→CMYK conversion
   against FOGRA 39 before export? This changes whether our render
   pipeline needs a color-management/ICC conversion step.
2. **Exact SKU for the 210×210mm square layflat variant** — confirm via
   step 2 of the checklist above rather than trusting the inferred
   `BOOK-FE-SQ8-LF-G` guess in §1.
3. **Does the 10mm safety-margin / no-bleed rule apply identically on the
   API cover-file-with-spine path**, or does combining front+back+spine
   into one file change the margin math at the spine edges specifically?
   The published guide's diagrams only show single-page and simple
   spread layouts, not a combined cover+spine file.
4. **Spine-width stability**: does `POST /products/spine`'s `widthMm`
   response ever change for the same `(sku, numberOfPages,
   destinationCountryCode)` tuple over time (e.g. if Prodigi re-routes
   production to a different lab)? If yes, the cover generator should call
   this endpoint at generation time rather than caching a value
   indefinitely — worth confirming the intended caching lifetime, if any.

---

## Appendix: illustration upscale comparison (V3 Phase 2, Task 3)

Separate research task, appended here rather than filed as its own doc
since it directly informs whether the print pipeline needs an upscale step
before submitting the PDF above.

### The question

Momora illustrations generate at a fixed **1024×1024px**. The book layout
prints a single illustration up to **160mm**, which works out to:

```
1024px / (160mm / 25.4mm-per-inch) = 162.6 dpi
```

...below the commonly-cited **~212dpi** "safe" threshold for coated
photo-book stock (the rule of thumb behind most print guides' 300dpi
*recommendation*, scaled down for how close a book is actually held/viewed
vs. a poster). The question this comparison answers: does that actually
look soft/pixelated once printed, or does Momora's painterly
watercolor-style illustration forgive it?

### Method

Script: `scripts/upscale-test/generate.mjs` (standalone dir, own
`package.json`, `sharp` as its only dependency — never touches the app or
`book-renderer`'s dependency tree). Not production code; a one-off decision
artifact per the task brief.

For 3 real illustrations from `book-renderer/book-data/enzo-year-three/assets`
(deterministically spread across the 71 available files, not hand-picked
for being flattering — samples 1, 24, and 47 of the alphabetically sorted
list), it renders side by side:

- **(a) Native 1024px source**, a centered 60×60mm patch (384×384px at
  source resolution) resized up to a simulated-300dpi display canvas
  (709×709px) — this is "what actually prints today."
- **(b) Classical lanczos3 upscale to 2560px** (`sharp`'s
  `kernel: lanczos3`, no learned/generative model), the **same** 60×60mm
  patch, at the same simulated-300dpi display size.

Both patches are marked on a full-illustration thumbnail (dashed outline)
so the crop location is verifiable, not cherry-picked.

**Method honesty note:** lanczos3 is a *classical* (interpolation-only)
resampler — it can only resample smoothly, it cannot invent detail absent
from the 1024px source. Any visible improvement from (a) to (b) can only
come from smoother interpolation at the print RIP stage, never from
recovered/added detail. That's the whole point of testing it before
reaching for anything heavier.

Output: `book-renderer/book-data/upscale-test/` (gitignored — per-sample
PNGs `1-*-comparison.png` … `3-*-comparison.png`, plus a combined
`0-all-samples-comparison.png`). Run it yourself:

```bash
cd scripts/upscale-test
npm install
npm run generate
```

### What the comparison shows (reviewed against all 3 samples)

**The two patches are close to indistinguishable at simulated 300dpi, on
all 3 samples.** The native 163dpi crop shows visible watercolor
brush/paper texture but no hard pixelation, blocking, or stair-stepping —
the illustration style's soft edges and painterly texture read as
*intentional texture*, not as a resolution artifact, even magnified to a
60mm patch. The lanczos3 upscale looks marginally smoother in a couple of
high-contrast edges (hairline/eyebrow strokes) but does not reveal any
additional detail — exactly what the method predicts, since it can't.

**Honest conclusion: this soft/painterly illustration style does not
obviously need upscaling at 160mm print size.** The commonly-cited 212dpi
threshold is a general-purpose rule of thumb (aimed at photographic detail
and sharp typography); it doesn't automatically transfer to watercolor
illustration, where the medium's own softness already sits below what that
threshold is protecting against. This is a visual read from 3 samples on a
retina display, not a substitute for the physical proof — **V4's printed
sample (memory-book.md) is still the real test**, since screen rendering
and glare/gloss-coated paper behavior at close reading distance can surface
things a display comparison can't. If V4 comes back looking soft, revisit
with the options below; if it looks fine, this rules out a whole
implementation task and its ongoing per-illustration cost.

### AI-upscale options (if V4 says otherwise)

For scale: **~80 illustrations** is roughly Eduardo's own book's likely
illustration count per the V0 audit (memory-book.md cites hundreds of
memories across children/years; a single book scopes to one child's
age-year or similar, in the tens). Costs below are per-run figures found
during this research (2026-08-29), not fetched via each vendor's live
API/dashboard — confirm before committing to one.

| Option | What it is | Setup cost | Per-image cost (~80 images) | Notes |
|---|---|---|---|---|
| **Do nothing** (this comparison's finding) | — | none | $0 | Ships fastest; validate against V4 physical proof first |
| **Real-ESRGAN, local** | Open-weight classical+learned super-resolution model, runs on-device | Free; `ncnn-vulkan` portable binary needs no Python/CUDA (~2–4GB VRAM, works on modest/integrated GPUs); full Python setup is more control but more setup | $0 (compute only, a few minutes on a laptop GPU) | Excluded from this task's script per the brief ("no model downloads") — noted, not installed. Best cost/effort ratio if a generative bump ever IS needed. |
| **Replicate-hosted Real-ESRGAN API** | Same family of model, hosted, pay-per-call | None (API key only) | **~$0.20–$3.36** total (two model variants found: `nightmareai/real-esrgan` ≈$0.0025/run, `xinntao/esrgan` ≈$0.042/run) | Cheapest hosted option found; no local GPU needed; good fit for a one-off batch job |
| **Topaz Gigapixel** | Desktop app (also has a Pro/API tier), learned upscaler with a strong reputation for photo restoration | $29/mo or $149/yr (Personal), $499/yr (Pro/API tier) | Effectively the subscription price for an 80-image one-off — expensive relative to Replicate unless already a Topaz subscriber for other reasons | Best *quality* reputation of the options surveyed, but priced for ongoing/professional use, not a single batch |
| **Clipdrop (Stability AI / now Jasper) upscale API** | Hosted upscale API, credit-based | 100 free credits on signup | Unclear — could not confirm current $/credit from the public pricing page (JS-rendered, not scraped by this research); publicly reported credit cost rose ~30–40× after the 2024 Jasper acquisition (0.2 → 1 credit/megapixel) | Free tier alone might cover an 80-image test batch depending on current credit-to-image ratio; verify in-dashboard before relying on it — flagged as the least-confirmed number in this table |

**Recommendation given the comparison's finding:** don't build an upscale
step yet. If V4's physical proof says otherwise, Replicate-hosted
Real-ESRGAN is the cheapest way to test whether a learned upscaler helps
before spending any engineering time on a local Real-ESRGAN integration.

## CONFIRMED LIVE (2026-08-29, owner's production API key)

- **SKU (owner-confirmed from dashboard, validated via GET /v4.0/products):**
  `BOOK-FE-8_3-SQ-LF-G` — "Square Layflat Book, Gloss, 190gsm, Matte
  Cover, 8.3x8.3" / 21x21cm". Note the `8_3` underscore token — this is
  why pattern-guessing from the A4 example failed; always copy SKUs from
  the dashboard verbatim.
- **Spine widths (POST /v4.0/products/spine, destination ES):**
  | pages | spine |
  |---|---|
  | 108 | 26.0mm |
  | 110 | 26.0mm |
  | 120 | 28.0mm |
  | 122 | **28.0mm** |
  Both current order candidates (enzo-year-three, mara-year-one) are 122
  pages -> render covers with `--spine-mm 28`.
- **Quote (POST /v4.0/quotes, 2 copies, Standard to ES):** items $48.66 +
  shipping $16.22 = **~$64.88 total (~$32.44/book landed)**.

Remaining before upload: tokens migration + print-resolution re-export +
final `book:pdf --spine-mm 28` render (in flight). Color: OWNER DECIDED
(2026-08-29) — first samples ship in RGB as the pipeline produces them
(their guide's own "300dpi RGB content" instruction); the physical sample
is the color-fidelity test. Revisit FOGRA39 conversion only if the
samples come back visibly off.
