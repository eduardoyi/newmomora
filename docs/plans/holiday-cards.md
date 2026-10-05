# Holiday Cards — printed family card + QR holiday film (Plan)

**Status:** plan, 2026-10-04 (owner discussion; not hardened yet)
**Siblings:** [memory-book.md](memory-book.md) (printing, shop, orders) ·
[year-film.md](year-film.md) (films) · feature docs to come:
`docs/features/holiday-cards.md`

## 1. Outcome

A new Keepsakes type: the family's **holiday card**. A flat two-sided 5×7 card
mailed in envelopes, the kind US families send relatives and friends in
December:

- **Front:** a real family photo, chosen from "top picks" from the year or any
  photo in the journal (like the book's photo picker). An **AI-illustrated
  holiday scene** of the family, built from their portraits, is offered as an
  alternative.
- **Back:** a short letter about the family's year. Momora writes 3–4 versions
  in different tones from the year's memories, and the parent picks one and
  edits it. Then a signature ("Love, the Yi family"), and a **QR code that
  opens a holiday film**.
- **Holiday film:** a ~30–45 s version of the family year film with a holiday
  theme (holiday end card, holiday music). It is made for this card, covers
  Jan 1 → the day the card is made, and is watched **publicly** (no login) by
  whoever scans the card.
- The card is also offered **without a film or QR**, e.g. for families whose
  year is too thin.

It ships to the family in one box (packs of 10, with envelopes). The family
addresses and mails them.

**Launch target: ~Nov 10, 2026.** That catches the November card-buying
wave. US orders can arrive in time until about **Dec 12** (Gelato US is made
in the US, USPS 4–5 days; USPS Priority Express 3–4 days as a late option).

## 2. Locked decisions (owner, 2026-10-04)

| Area | Decision |
|---|---|
| Front | **Photo is the hero.** Top picks + "any photo" picker. Illustrated holiday scene offered as an option. |
| Back | Letter variations (3–4 tones), editable; signature; QR to the film. Everything on the front (one-sided card) was **rejected**. |
| Film | Made for the card at creation (scope Jan 1 → creation day), **not** the year-end film (that one is made Dec 28 and arrives too late). **Kept** once ordered: never swapped for the full-year cut. |
| Thin years | **Lower film floor** for cards. Card also offered **without film/QR**. |
| Greeting | User picks: Merry Christmas / Happy Holidays / Felices Fiestas / Happy New Year (es + en sets). |
| Provider | **Gelato** (not Prodigi). Live quotes below. **No Mexico** in v1. |
| Sample | **The sample is the real Momora-made card** for Eduardo's family (like the book's V4 physical proof), not a generic sample. |
| Process | Same as the book and the films: **dogfood stages on the laptop first** (§6, C0–C5), iterate locally, order the sample from here; **then** the product (app, shop, Fly, Workflow). |
| Who | Owners/managers, subscribers. Card editor + checkout live on the web shop like books (`shop.usemomora.com`); the app's Keepsakes tab links in. |
| Reorders | "Order more of this card" without redesigning. |
| Price | **$2.49/card, shipping included**, quantities 20 / 30 / 50 / 100 (owner, 2026-10-04). |
| Signature | Defaults from the family name in the app ("Love, the {name} family"), **editable** like the letter. |
| Sample QR | Build the public `/f/:token` film page **early** (before C4) so the sample's QR works when the cards arrive. |

## 3. Provider: Gelato

Product (all regions, same UID; Gelato routes it to the nearest plant):
`pack_of_cards_qt_10_pcs_pf_5r_upt_350-gsm-130lb-coated-silk_cl_4-4_ct_none_prt_none_sft_none_set_none_hor_ept_standard`.
That is a flat 5×7 (`5R`), printed both sides (`4-4`), 350 gsm coated silk,
standard envelopes, **pack of 10**. Product dimensions: 182.4 × 133.4 mm
(the exact print-file spec, bleed and page order, is checked in C2).

Live quotes, 2026-10-04 (orders:quote + prices API; prices exclude sales tax):

| To | Made in | 20 cards | 50 cards | 100 cards | Shipping (cheapest) |
|---|---|---|---|---|---|
| US | US | $11.68 + $7.03 | $32.44 + $8.56 | $59.90 + $11.11 | USPS Ground Advantage, 4–5 days |
| CA | CA | $12.91 + $8.35 | $32.29 + $9.85 | $59.62 + $12.35 | 3–9 days |
| ES | ES | $18.57 | $46.42 | $85.72 | "Standard delivery", shipping $0.00 (verify) |
| PT | PT | $11.41 (10) | $57.04 | — | "Standard delivery", shipping $0.00 (verify) |
| MX | US | $22.81 + $26.08 | | | UPS DDU, 9–18 days → **excluded** |

US express (USPS Priority Mail Express) is $23.62–31.93. Uncoated matte paper
costs ~25% more (option if the silk sample disappoints). For comparison,
Prodigi (UK-made, DHL $31.37 flat to the US) cost $97 for 50 US cards
against Gelato's $41.

**Pricing (owner-approved 2026-10-04):** **$2.49/card, shipping included**,
quantities 20 / 30 / 50 / 100. US 50 cards: $124.50 revenue vs $41.00 cost,
about 67% gross before Stripe. The market (live, 2026-10-04): Minted list
$2.26/card at 50, Shutterfly $3.33 list (about $1.80 on its usual promos), budget brands
$0.70–0.80. Free shipping over ~$100 is the norm, so we never show a big
shipping line.

**API notes:** order API v4 (`order.gelatoapis.com/v4/orders`, `quantity` =
packs, files by URL, PDF accepted), `orders:quote`, prices API, webhooks for
status/tracking, draft orders. **Requests need a browser-like `User-Agent`**
(Cloudflare returns `1010` for Python's default). Key: `GELATO_API_KEY`
(local `.env.local`; later a Supabase/Worker secret).

## 4. Reuse map (from the 2026-10-04 code survey)

| Need | Reuse | New |
|---|---|---|
| Letter writer | Book outline prompt style + language resolution (`_shared/memory-book-outline.ts`, `resolveOutlineLanguage`), film i18n (`year-film-i18n.ts`: `topicActivity`, `milestoneLabel`), `distinctiveThemes()`, `isCertainFirst()` | `_shared/holiday-card-letter.ts`: prompt, parse, privacy post-check |
| Privacy | `shareSensitiveIds()` + `SHARE_SENSITIVE_TEXT` (year-film-script), `mapFamilyRows()` exclusions (reports, blocked authors, removals) | Card audience is acquaintances: stricter (no health, no `tough-days`, no names beyond the family's own) |
| Top picks | Book cover verify (`buildCoverVerifySystemPrompt`, vision `detail: high`), `measureOriginalDimensions` (ranged R2 read), year-film vision verdicts | `_shared/holiday-card-photos.ts`: candidates (≥2 family members tagged, landscape-friendly, original ≥ ~2000 px) → vision "card-worthy" judge |
| Illustrated scene | Memory-illustration prompt + up to 6 portrait refs (`buildIllustrationPrompt`, `prepareIllustrationReferences`) | Holiday scene prompt; output is 1024² today, so test 1536×1024 and/or upscale (see `prodigi-order-spec.md` appendix) |
| Card layout + print | `book-renderer` (React templates, mm geometry, vendored print fonts, Puppeteer `page.pdf`, `assertPrintFontsLoaded`, QR rendering via `qrcode`) | Card templates (2–3 fronts, 1 back), `card.html` print entry, `card:pdf` script |
| Film | Whole Year Film pipeline: script builder, assets bridge, assembler, render job | Kind `family_holiday` + `buildHolidayScript()` (≤45 s), card floors, holiday theme in `assemble.mjs`, holiday music bed(s), fail-closed burst frames (public audience) |
| Public film page | `workers/memory-viewer` (m.usemomora.com): Range streaming, OG poster, 404/410 pages | `film_share_tokens` table + `/f/:token` routes (P1) |
| Orders | Book order shape: Stripe Checkout, webhook, Workflow, sweep, address forms, order status UI | `holiday_card_orders` (separate table, so the live book flow isn't touched), Gelato client, webhook routing by `metadata.productType` |

## 5. Guardrails

- **Public audience.** The film and letter go to people outside the family.
  Same share-safety filter as films, stricter: burst frames **fail closed**
  (no vision verdict → drop), no health/medical/bath/potty, no sad/worried
  moments, no quoted speech from anyone outside the family, no surnames other
  than the signature the parent writes.
- **Letter = facts from the journal only.** Never invent events; never
  developmental-comparison language (VoC anti-requirement, same as the book).
  Parent voice, warm, specific.
- **PII.** Same as the book/films: eval outputs go to gitignored dirs only,
  stdout counts-only, logs ids and codes only.
- **Revocable QR.** Every printed QR resolves through a revocable token; a
  deletion or report still takes the moment out of the film (the film is
  re-made without it, like any year film). "Kept" means no new moments and no
  swap, not "immune to deletion".
- **Print verification.** Only rasterized PDF output proves print correctness
  (book lesson, learned twice). Every card render is checked as a raster.

## 6. Validation plan — dogfood-first, gated (C0–C5), then product (P1–P3)

Like the book (§9 there) and the films (§10 there): built and judged against
**Eduardo's real journal** before any product surface exists. C-stages are
eval scripts, local previews and local renders only: **no migrations, no app
code, no deploys.** Results are recorded below as `### C<n> results` and
`### C<n> owner review round N`.

Conventions (same as `eval:memory-book-*` / `eval:year-film-*`):
- Deno scripts `supabase/scripts/eval-holiday-card-*.ts`, run via
  `npm run eval:holiday-card-*` with `--env-file=supabase/.env.local
  --env-file=.env.local`. Read-only through the RLS-scoped client.
- Real-data outputs only in gitignored places:
  `supabase/scripts/eval-output/holiday-card/`, `book-renderer/card-data/`,
  `film-renderer/film-data/`.
- **Production logic is written as pure `_shared/holiday-card-*.ts` modules
  from the start** (book lesson), so passing a stage means the production
  logic passed.

| Stage | Build | Review artifact | Pass question |
|---|---|---|---|
| **C0 — Audit + print spec** | `eval:holiday-card-audit`: the family's 2026 pool as a card would see it (Jan 1 → today): memories / photos / videos, card-film floor check (and what the floor should be), photo candidates with ≥2 family members tagged + original pixel sizes, letter material (distinctive themes, certain firsts, quotable lines, holiday-topic memories). Plus the Gelato print-file spec (template, bleed, page order) for the 5R card. | Markdown report in `eval-output/holiday-card/`. | Is there enough for a great card **today**? How many photos qualify for print? What's the right film floor for thin years? |
| **C1 — Front** | `_shared/holiday-card-photos.ts`: candidates (photo pool = **last Dec 1 → today**, ≥2 family members tagged, full-bleed or bordered print class, portrait **and** landscape) → vision "card-worthy" judge (everyone visible, faces, light, sharp, not a screenshot, crop survives). Plus 2–3 illustrated holiday scenes of the core family from their portraits. `eval:holiday-card-front`. | HTML review page: top ~10 photo picks with why, near-misses with why, the illustrated scenes. | Is the top pick the photo you'd choose? Is the illustrated scene card-worthy? |
| **C2 — Holiday script + letters** | Kind `family_holiday` in the shared film code: `buildHolidayScript()` (≤45 s, holiday topics boosted, floor **20 moments / 12 visuals**, no quarter rule, fail-closed bursts). `_shared/holiday-card-digest.ts`: the **year digest** the letter is written from (themes, highlights with excerpt + tagged people + emotion + date, per-child notes, the line of the year), built **from the holiday FilmScript** when there is a film, else from the pool with the same scoring/themes. `_shared/holiday-card-letter.ts`: 3–4 variants (warm / playful / short / reflective), es + en, length cap, privacy post-check, plus the QR caption ("Scan to see our year: …"). `eval:year-film-script --film holiday:2026` (storyboard) + `eval:holiday-card-letters`. Thin-year runs (subsampled) for both paths. | Holiday film storyboard (HTML, like F1) + the letters next to the moments they mention; the no-film letters for a thin subsample. | Are these the right moments for relatives to see? Would you keep a letter with light edits? Does the letter match the film? |
| **C3 — Card design + print PDF** | Card templates in `book-renderer` (portrait + landscape; fronts: full-bleed photo, bordered photo + greeting band, illustrated; back: greeting, letter, signature, QR + caption, small Momora mark; no-QR back), text auto-fit, `card:preview` (switch photo / letter / greeting / layout: the seed of the web editor), `card:pdf` → Gelato-spec PDF (2 pages, 4 mm bleed), raster check. `eval:holiday-card-assets` downloads originals into `book-renderer/card-data/<slug>/`. | On-screen preview + rasterized print pages at 300 dpi. | Premium, as good as Minted? Letter readable? Photo holds up at 5×7? |
| **C4 — Holiday film (motion + local render)** | Holiday theme in `film-renderer/assemble.mjs` (palette, snow, greeting end card with the family signature), 1–2 holiday music beds, `eval:year-film-assets` → local render. | Local MP4s on the phone (sound on and muted): Eduardo's 2026 holiday film + a thin-year one. | Would you send this to your aunt? Holiday without cheesy? Thin year still intentional? |
| **C5 — Public film page + physical sample** | `film_share_tokens` + `/f/:token` routes in `workers/memory-viewer` (built early, owner 2026-10-04) serving the C4 film from R2. The real card (C3) with the real QR → Gelato order (one pack of 10 to Lisbon, made in PT). | 10 printed cards + envelopes; QR scanned from paper plays the film. | Paper, color, photo quality? Letter readable? QR scans? Envelope fit? |
| **C6 — Render infra** | Card PDF on the book renderer service (`/render-card`, Fly) from a sample fixture; holiday film on the year-film image. | Render time/cost per card PDF; one holiday film on Fly. | Fast and cheap enough for "make my card now"? |

**Gate:** do not start C(n+1) before C(n) passes, except: C1 (front) and
C2 (script + letters) are independent and can overlap; C4 (film motion) can
run in parallel with C3 (card design). C5 needs C3 + C4. C6 can run in
parallel with late C3/C4 rounds.

**Why letters come from the film (owner, 2026-10-04):** the film's curation
already does the expensive judgment (share-safety, vision-verified
subjects, distinctive themes, per-child chapters, the line of the year), and
a letter that mentions what the film shows makes the card one piece. The
letter is written from the film's *script* (ready minutes after start, before
the render), so it never waits for the MP4. Cards without a film get a digest
built from the pool with the same scoring, so one letter writer serves both.
The letter reads excerpts **plus tagged people and emotions**.

### C0 results (run 2026-10-04, `npm run eval:holiday-card-audit -- --all-families`)

Script: `supabase/scripts/eval-holiday-card-audit.ts`. Report (gitignored):
`supabase/scripts/eval-output/holiday-card/2026-10-04T16-21-44-149Z-audit.md`.
Scope Jan 1 → Oct 4, share-safe pool (film filter + worried/sad/weary removed).

**Eduardo's family: plenty for a great card today.**
- Pool: 163 moments, 134 visuals (114 photo memories, 28 video), 4/4
  quarters; share-safety removed 15. Already passes the year-end floors.
- Front photos (≥2 people tagged): 129 photos in 66 memories, 31 tag the whole
  core family (Eduardo, Adriana, Enzo, Mara), **21 whole-family photos are
  full-bleed print quality** (≥2194×1594 px after a 7:5 crop). 109/129 are
  full-bleed, 16 bordered-only, 4 too small. Pixel sizes come from ranged R2
  reads of the originals (no full downloads).
- **Orientation: 79 portrait vs 49 landscape.** Most family photos are
  portrait, so a landscape-only card would crop most of them badly.
- Holiday photos: none in scope (Jan–Oct, of course), but last December has 9
  usable two-person photos (8 full-bleed), including Christmas Day.
- Letter material: 8 distinctive themes (costumes, eating out, big outings,
  park days, story time, music, art…), 100 quotable memories, beach/travel.
  **Certain firsts: 0.** Milestones are almost all `candidate`, so the
  letter can't rely on the milestone catalog and must read memory excerpts
  directly (like the book outline does).
- Illustrated portraits ready for all 4 core members → the illustrated scene
  is possible.
- Journal language detected: es.

**All families (counts only, 18 with ≥1 memory in 2026):** 15 have fewer than
10 moments this year; only 3 pass a 10/6 floor, 2 pass 20/12, 1 passes the
year-end 60/40. **For today's user base, the no-QR card is the common case.**
Re-run this before launch (gallery import and November journaling change it).

**Gelato print spec** (support.gelato.com): one PDF, page 1 = front, page 2 =
back, 4 mm bleed on every side (page 185.8 × 135.0 mm for 5R landscape), text
≥4 mm inside the trim, PDF/X-4 recommended.

**C0 verdict (proposed): PASS**, with these consequences for C1/C2:
1. **Support portrait and landscape cards**: the card's orientation follows the
   chosen front photo (Gelato has both `_hor` and `_ver` UIDs of the same
   product; one design per pack).
2. **Card-film floor: 20 moments / 12 visuals, no quarter rule.** A family
   that started journaling Sep 1 (32/23) still gets a film; below it, no QR.
3. **Photo pool for the front = last Dec 1 → today**, so last holidays' best
   photo can be the front.
4. **Letter writer reads memory excerpts + tagged people + emotions + themes**,
   not milestones, and is built from the holiday film's script (owner,
   2026-10-04; see the stage table).

**C0 owner review (2026-10-04): PASSED**, all four consequences agreed.

### C1 results (2026-10-04, `npm run eval:holiday-card-front`)

Module `_shared/holiday-card-photos.ts` (pool Dec 1 → today, print class per
the photo's own orientation, vision judge on `CLAIM_CHECK_MODEL`, ranking) +
`_shared/holiday-card-illustration.ts` (holiday scene prompt on top of
`buildIllustrationPrompt`, variants tree / snow / table). 24 Deno tests.
Review page: `eval-output/holiday-card/2026-10-04T16-43-28-743Z-front.html`.

- 138 photos in the pool, 30 judged, 27 ranked. #1 Jun 4 and #2 May 18 are
  whole-family photos (judge 9 and 8/10); Christmas Day 2025 is #8.
- Review fix: the memory's tags describe the memory, not the photo, so a
  one-child photo from a whole-family memory got the family bonus (#5, #8 in
  the first run). The family bonus now needs the judge to see that many people,
  one-person photos cost 3 points, crowds (> family + 3) cost 2
  (`expectedPeople`). `--scenes-from <runId>` re-ranks without new images.
- Illustrations: `gpt-image-2.5-flare`, quality medium, 4 portrait refs,
  1536×1024 / 1024×1536 accepted. All four faces read clearly in house style;
  framing is tight (greeting goes in a band, not over the art); tree and
  table are Christmas-specific, snow is the neutral one.
- Spend ≈ $0.60 (vision twice ≈ $0.31, three images ≈ $0.30, image cost not
  priced by the shared pricer for flare yet).
- Eval-only gap for production: 3 originals without a stored preview were
  downscaled with local ffmpeg.

### C2 results (2026-10-04, holiday script + `npm run eval:holiday-card-letters`)

Kind `family_holiday` in the shared film code (`holidayFilmScope`,
`holidayPool`, `evaluateHolidayFilm` 20/12 no quarter rule, `buildHolidayScript`,
`holidayVisionCandidates`, `planFilm` branch, holiday end-card strings,
`theme: 'holiday'`, `burstFrameVerdict({failClosed})`, `defaultBed` borrows the
year-end bed; worker `stages.ts` got the two new cases only). The year film's
chapter code moved into a shared `buildChapters` (pure move, same logic).
`_shared/holiday-card-digest.ts` + `_shared/holiday-card-letter.ts`
(4 tones + QR caption + signature, length caps, sensitive-text and
foreign-name checks). Verified: `npm run test:edge` 1923 passed; worker
`tsc` clean + vitest 17/17; app `tsc` clean.

- Holiday film for 2026: ~44 s, 9 scenes (title, burst, chapter ×2, themed
  burst, sound, finale burst, family close, holiday end card), 30 burst frames
  (15 photos, 9 clips, 6 drawings), every frame vision-checked.
  Storyboard: `eval-output/year-film-script/2026-10-04T16-41-25-399Z/holiday-2026/storyboard.html`.
- Thin years: a 30-memory subsample still passes 20/12 (~38 s film); 15
  memories → no film, letters from the pool.
- Letters (es + en, all runs): 0 rejected variants; 450–530 chars for the
  long tones, 200–230 for short (caps 650 / 280). Only soft flag: unknown
  capitalized words (costume characters).
- Reviewer notes (Claude): facts are right and specific, but the playful
  tone is stiff and picks trivia; variants reuse the same 3–4 moments; one
  English run read a costume-party name as a place. Owner to judge.
- Spend ≈ $0.78 (storyboards ≈ $0.19, letters ≈ $0.60, ~1 min per letter call).
- Open for C4/P1: fail-closed bursts aren't wired into asset resolution yet;
  the renderer must show the end card's greeting + signature; greeting choice
  not wired.

### C1/C2 owner review round 1 (2026-10-04) → round 2

- **Photos:** #1 and the top picks are good, except #8 (the kids + their
  uncle). → Photos tagged with anyone outside the core family cost 4 points
  (`rankFrontPicks`, test added).
- **Illustrations:** "kinda cheesy": tree is OK, snow and table are too
  over-the-top holiday. → Keep tree; replace the other two with quieter
  variants (family as subject, one or two subtle seasonal touches at most).
- **Letters:** none liked: "FORCED mentions of events, oddly specific… the
  letter should stand on its own without people needing to watch the video."
  → Letters v2: the digest becomes **per-person profiles** (age, recurring
  themes and emotions, a few grounding excerpts), not an event list; the
  classic holiday-letter shape (how the year felt → a line or two per child →
  parents if evidenced → wish); at most one detail per child, only if it shows
  personality; **no mention of the film** (the QR caption does that); variants
  differ in shape (classic / short / playful / reflective).
- **Film:** "can be a bit longer; bursts a bit slower." → budget ~60 s and a
  relaxed pacing field for bursts (C4 renderer honours it). "The together
  section doesn't include me." → the close uses only photos tagged with the
  whole core family (both parents + own children) and nobody else, preferring
  the card's top picks. "Include milestones." → firsts scene when certain
  firsts exist; the family has 0 certain firsts today (all `candidate`), so
  the storyboard lists the unconfirmed ones for the owner to confirm, and an
  eval flag previews them. **Product idea:** a "Did these happen this year?"
  confirm step in the card flow feeds both the film and the letter (and gives
  milestones the confirm UI they don't have yet).

### C1/C2 round 2 results (2026-10-04)

- **Front:** kids + uncle fell from #8 to #24; the top 4 are whole-family
  photos plus the Oct 1 portrait of both kids. New quiet scenes
  `winter-walk` (portrait) and `window-light` (landscape) replace snow/table;
  tree kept. Both quiet ones read as a family card, not a Christmas scene;
  the family still fills most of the frame, so the greeting goes in a band.
  ≈ $0.05 per image (estimator now records flare usage).
  Page: `eval-output/holiday-card/2026-10-04T19-42-58-383Z-front.html`.
- **Film:** 60 s budget, bursts carry `holdFactor: 1.5` (renderer contract
  documented on the type; C4 implements it in `assemble.mjs`); ~54 s, 9
  scenes, 36 burst frames. The close is two photos tagged with exactly the
  four of them (Aug 1, Jul 18), with fallbacks recorded and portraits as the
  last resort so a parent is never missing; `preferredCloseMedia` takes the
  card's top picks. Firsts scene included when certain firsts exist; the family
  has 1 unconfirmed candidate in the share-safe pool (Mara walking, Jan 17,
  text gate fails), listed in the storyboard; `--confirm-milestones` previews it
  (~56 s). `--preferred-close` flag. Storyboard:
  `eval-output/year-film-script/2026-10-04T19-52-00-574Z/holiday-2026/storyboard.html`.
- **Letters v2:** per-person profiles (age by Dec 31, recurring themes with
  lift, moods, tone-only excerpts; parents only with real evidence), the
  classic letter shape, shapes classic / short / playful / reflective; hard
  check: no film/video/QR/scan words. No forced events and no film mentions in
  any run; 0 rejected; one `cliche` flag ("mágico", from Enzo's own quote).
  Reviewer note (Claude): the voice is natural now but has swung a little
  abstract in places ("amplio y cercano", "texture of our days", "días que se
  sientan verdaderamente suyos"); a middle ground would allow one concrete,
  recurring detail per child and ban abstract filler.
- Verified: test:edge 1933 passed; worker tsc + vitest 17/17; app tsc clean.
  The only non-holiday production change is an optional `id` on
  `FilmAssetRef` (vision cache key is unchanged: `checkKey` uses the preview
  or object key). Spend this round ≈ $0.67; total ≈ $2.10.

### C2 round 3 results (2026-10-04, letters v3 + family voice)

- **Voice:** `_shared/holiday-card-voice.ts` builds a style card from ~40
  share-safe captions the two parent accounts wrote (`family_members.user_id`
  → `memories.user_id`), on `gpt-6-luna` (~$0.001): casual Latin-American
  Spanish, tuteo, "papi/mami", mixed sentence length ending on a remark or
  punchline, no emojis, characteristic words (abracito, fiestica, Dios mío,
  listo…). The letter gets the card + 5 short caption snippets (voice only).
- **Concreteness:** per-child recurring details from `memories.labels`
  (`topic_details` is too sparse), per-theme details, certain/confirmed firsts;
  abstract-filler ban + soft `abstract` / `copied_voice_example` flags.
- **Film:** 10 scenes, ~56 s, firsts scene with Mara walking (owner-confirmed);
  the close opens with the owner's chosen front photo (Jun 4).
- Two identical runs: consistent quality, 0 flags, 0 rejects.
- Reviewer notes (Claude): clearly better: plain, concrete, sounds like
  parents (Mara's first steps, story time on the sofa, park, dress-up), and
  the Spanish carries the family's register. Remaining issues: (1) the
  family's catchphrases get **sprinkled in** ("Dios mío, qué entrenamiento",
  "fine dining, naturally", "abracito" and "Dios mío" inside English
  letters): a new kind of forced; (2) still a bit list-like and repetitive
  ("una y otra vez", "volvimos", park/excursions/meals out); (3) English
  copied the Spanish opener literally ("Today, looking back"); (4) the kids'
  details are thin because labels are generic ("cuentos", "parque"); the
  line of the year ("el mundo es un lugar mágico") dropped out.
- Verified: test:edge 1943 passed; worker tsc + vitest 17/17; app tsc clean.
  Spend this round ≈ $0.90; total ≈ $3.00.

### C2 round 4 results (2026-10-04, letters v4)

- Voice now shapes rhythm/register only (≤1 family expression, none in
  English, no in-jokes, caption openers not copied); specific details per child
  extracted from memory TEXT (`_shared/holiday-card-details.ts`, luna, every
  detail verified literally against cited excerpts: 5/5 and 4–5/4–5 verified,
  0 dropped); the line of the year is back as an optional verbatim quote;
  repetition / enumeration / foreign-word / catchphrase flags.
- Result: catchphrases and Spanish-in-English are gone; English reads native;
  a real specific surfaced (Enzo riding a bike without training wheels); Enzo's
  "papi, el mundo es un lugar mágico!" quoted in 3 of 4 Spanish
  classic/playful letters across the two runs (not guaranteed: `line_unused`
  flag added).
- Reviewer notes (Claude): plainer and truer, but now a bit flat and
  formulaic: every variant uses "X tiene N años y …"; label calques leak
  into Spanish ("jugar a imaginar", "caminar con confianza" instead of "sus
  primeros pasos"); closing wishes are long and generic. Diminishing returns
  on prompt rounds; options: one polish round (idiomatic Spanish, varied
  per-child structure, short closers, the line guaranteed in code) and/or an
  A/B of the writer model on the identical digest.
- Verified: test:edge 1951 passed; worker tsc + vitest 17/17; app tsc clean.
  Spend this round ≈ $1.70; total ≈ $4.70.

### C2 round 5 results (2026-10-04, letters v5, FINAL candidate)

- Writer `gpt-6-sol` (owner decision); language and regional register from
  `families.gallery_caption_language` (owner: `es-CO` → Colombian Spanish),
  detection only as fallback; `gallery_caption_instructions` passed as quoted
  data; voice card no longer infers region; letters only in the family's
  language (`--also-lang` opt-in). Polish: firsts as plain facts ("dio sus
  primeros pasos"), label-calque / formulaic-age / long-closer flags, one-line
  wish, the line of the year required in classic + playful (code-checked,
  one retry).
- Result: natural Colombian Spanish ("tiquetes", "por acá", "verse las
  caras"), real specifics (Spider-Man, the swings, the bike without training
  wheels, an imaginary plane; thin year: stracciatela ice cream, nose kisses),
  humor that lands, Enzo's line used well. Letters are shorter (≈280–390
  chars), which suits a 5×7 back with a QR. 0 rejects; one calque flag on a
  natural phrase (now allowlisted). ≈ $0.03–0.04 per letter set.
- Open for C3: the wish says "Navidad" on its own; it must follow the card's
  chosen greeting (Christmas / holidays / New Year).
- Verified: test:edge 1957 passed; worker tsc + vitest 17/17; app tsc clean.
  Total C1+C2 spend ≈ $4.80.

### C3 results (2026-10-05, card design + print PDF)

`book-renderer/src/card/` (types, geometry, text fit, fitted document,
CardFront / CardBack / CardQr, preview app, print app), `card.html` +
`card-print.html` + `vite.card.config.ts`, `card:preview` / `card:pdf`
scripts (`scripts/lib/renderCardPdf.ts`), data via
`npm run eval:holiday-card-assets` → `book-renderer/card-data/<slug>/`
(gitignored). The letter's closing wish now takes the card's `greeting`
(`holiday-card-letter.ts`, `occasion_mismatch` flag). Verified:
book-renderer 794 tests (22 new), build clean.

- Fronts: full-bleed photo (greeting position per card; top-center on the
  owner's sky), bordered (photo + greeting band), illustrated (band, never over
  faces); both orientations. Back: greeting, letter (Newsreader, auto-fit
  9–12 pt; every v5 variant fits at 12 pt), Caveat signature, 26 mm QR (ECC H,
  play badge, decodes from the 300-dpi raster), caption, "hecho con Momora";
  no-QR back.
- PDF: 2 pages, 185.8 × 135 mm with 4 mm bleed (TrimBox/BleedBox set), fonts
  embedded, no Type 3, originals passed through (photo #1 at 551 dpi full-bleed,
  768 dpi bordered; illustrations ~280–289 dpi). Not PDF/X-4 (check Gelato's
  preflight at C5).
- The owner's card QR is reserved: `m.usemomora.com/f/<token>` in
  `card.json` (C5 registers it).
- Reviewer notes (Claude): clean, legible, premium-quiet. To improve: the
  bordered landscape photo is only ~49% of the card (band too tall); the back
  is all type (could use one signature element); a letter variant prints
  `mágico!”.` (drop the period after a closing `!”`); the signature is large
  next to the body.

### C3 owner review round 1 (2026-10-05) → round 2

- Editing should feel like the book: **click directly on any text to edit**;
  every text is editable (front greeting, back heading, letter, sign-off, QR
  caption).
- Remove "hecho con Momora": just the **Momora wordmark**, small and subtle,
  bottom-right of the back.
- **Replace and reposition the image** like the book editor (picker + focal
  point).
- The left controls are too much for users: a clean user mode (layout,
  letter version, greeting, QR on/off, change photo) and a `?dev=1` mode for
  guides/zoom/readouts.
- Keep the **bordered vs full-bleed** choice.
- Signature element: the family's **illustrated portraits** near the
  sign-off.

### C4 results (2026-10-05, holiday film motion + local render)

- `film-renderer/assemble.mjs` holiday theme (only when `theme === 'holiday'`;
  `family-2026`, `month-2026-09`, `birthday-enzo-y4` assemble byte-identical):
  warm winter palette, a 34-flake seeded GSAP snowfall on light scenes, faint
  warm light over bursts, gentler close glints, a 2×2 portrait close fallback
  when no whole-family photo exists, a greeting end card (wall of stills →
  mark → greeting in Newsreader, gold rule, "de parte de la familia …" in
  Caveat). `holdFactor` implemented in `burst()` (first-half burst 0.52 →
  0.79 s per frame; finale 0.33 → 0.45 s).
- Greeting input on `buildHolidayScript` (christmas / holidays / new-year,
  default holidays; `--greeting`); holiday title subtitle.
- Fail-closed in production `resolveFrames` for `family_holiday` (no verdict
  or no check image → drop; upset faces dropped); `burstFrameVerdict`
  fail-closed also drops faceless blurry frames and photos of screens
  (caught a blurry diaper clip in the first render).
- Music: `winter-bells` (104 BPM, full energy 6.5 s) and `fireside-piano`
  (92 BPM, measures 15.5 s to full energy, so it's the weaker one) via
  ElevenLabs; `PENDING_P1_BEDS` keeps the SQL/app parity tests green until
  P1 adds the allow-list migration + app manifest + previews (P1 must do this
  before any holiday film is queued).
- Renders: `holiday-2026.mp4` (57.1 s, 10 scenes, firsts = Mara walking) and
  `holiday-2026-sub30-seed1.mp4` (44.3 s). Loudness −14.6 LUFS.
- Verified: test:edge 1962 passed; worker tsc + vitest 17/17;
  render/year-film-renderer 10/10; app tsc clean + year-film-beds jest 6/6;
  `hyperframes check` clean.
- Reviewer notes (Claude): reads as a quiet family winter film, not
  Christmas kitsch. Issues: the firsts card shows the catalog label
  ("Camina con confianza") instead of plain words ("Dio sus primeros
  pasos"), which the letter already does; the end card still says "hecho
  con Momora." (owner removed that wording from the card); the public-audience
  photo rule still allows shirtless/diaper/bath shots (the thin-year end-card
  mosaic shows a bath photo); chapter and close layouts leave empty space;
  snow barely visible.

### C3 round 2 results (2026-10-05, editor + design)

- Click-to-edit for every text (front greeting + year, back heading, letter,
  sign-off, QR caption) reusing the book's popover (`TextPopoverView`
  extracted; the book's `TextEditPopover` is a thin wrapper, no behaviour
  change); per-field reset; the letter never shrinks below 9 pt (Save blocked
  with a warning instead). Replace (`CardPhotoPicker` against a
  `FrontPhotoProvider` interface, so P2 plugs in the family pool) and
  reposition (book's focal-point modal, `FocalPointModalView` extracted, the
  book's 3% gate). Edits model `CardEdits {text, letters, focalPoints,
  frontImage, choices}` saved to `card-data/<slug>/edits.json` by the dev
  server (P1 persists the same shape).
- User mode (layout bordered/full-bleed, letter chips, greeting, film QR,
  change photo; one sheet + front/back toggle at phone width) vs `?dev=1`
  (guides, zoom, readouts, orientation/greeting-position overrides, portraits
  toggle).
- "Momora." wordmark (Newsreader Medium 8 pt, pink dot) bottom-right; "hecho
  con" removed. The core family's illustrated portraits (12–13 mm circles)
  beside the sign-off. Bordered photo 49% → 67% of the card (greeting + year on
  one line), smaller sign-off, balanced portrait back, no period after `!”`.
- Verified: book-renderer 806 tests, `build` + `build:web` (bundle check)
  clean; letter deno test 23.
- Open: PDF/X-4 still not produced; greeting position is per card (no face
  detection); portraits embedded at 1024 px (could downscale); the control strip
  is functional, not designed.

### Letters v6 (2026-10-05, owner reopened the classic letter)

Owner: the classic letter "drops random and too-specific facts here and
there" (it closed on "También salimos a comer en familia más de una vez."
right before "Feliz Navidad") and "the opening is too abrupt — it jumps from
hi straight into facts; it could say why we send this, that you're important
to us, that we share a bit of our year."

Fix (`holiday-card-letter.ts`, by Claude directly): the genre is now a real
letter frame: greeting → a FRAMING sentence (why we're writing to them) → the
kids (one concrete thing each) → the family only if it matters (never an
add-on "also we…" fact) → a LANDING sentence turned toward the reader →
the wish (following the card's greeting). New soft flag `trailing_filler`
(a "También/Además/Also…" sentence right before the wish); `--greeting` on
`eval:holiday-card-letters`. Two runs: the frame holds in every variant; 0
`trailing_filler`. Letter tests 24 pass.

### C4 round 2 results (2026-10-05)

- **Strict public rule (owner: yes):** `publicAudience` frame-check variant
  (`underdressed`: bare torso at any age, diaper/underwear only,
  bath/shower, nudity, toilet, medical, crying; swimsuits only if they cover
  the torso; unsure → excluded), required by the strict parser; separate
  cache key (`variant: 'public'`; normal keys unchanged, pinned by a test);
  every frame a holiday film shows is now checked (chapters, firsts, close,
  pair photos behind portraits, video sound windows), fail closed, removals
  pruned by `pruneUnpreparedScenes`; the holiday close is always a still; the
  end-card mosaic uses only checked stills; stricter text screen for holiday.
  Full film: 42 frames checked, 3 removed; thin: 28 checked, 3 removed; the
  bath / shirtless / bathroom-mirror / crying frames are gone. Worker
  `stages.ts` and Fly `job.mjs` carry the same rule (not deployed).
- **End card (holiday only):** the mark fades in place, greeting + "de
  parte de la familia …" centred, small "Momora." wordmark bottom-right, no
  "hecho con". Birthday/month/year films assemble byte-identical.
- **Sound bug:** root cause = a 0.75 s voiced excerpt accepted (no minimum)
  inside an 8-beat (~4.6 s) scene. Fix: `MIN_VOICED_SECONDS = 2` in the
  shared `rankVoiceWindows` (**affects live films once the worker/Fly image is
  next deployed**: very short voice clips are no longer chosen); holiday
  scenes are sized to the excerpt (0.4 s lead + excerpt + 0.9 s tail, 5-beat
  floor). Live films keep the 8-beat floor (dead tail ≤ ~1.5 s); owner to
  decide whether to apply the holiday sizing to all films.
- **Firsts:** plain phrasing `HOLIDAY_FIRST_PHRASES` / `holidayFirstLabel`
  in `year-film-i18n.ts` ("Dio sus primeros pasos"), holiday only.
- Renders: `holiday-2026.mp4` 59.4 s (winter-bells), thin 45.0 s
  (fireside-piano). Verified: test:edge 1980; worker tsc + vitest 19/19;
  render tests 10/10; app tsc clean; `hyperframes check` clean (one
  transient contrast warning on the fading mark).

### Letters v7–v8 (2026-10-05)

Owner + Adriana on v6: mixed casual and Spain-style Spanish ("hemos
pasado"); the close invited them to catch up (should be "we're sharing,
we love you, merry Christmas"); facts felt bolted on ("sharing about our
year" then two specifics and "the park"). Claude hand-wrote three letters
from the family's data (owner: "awesome, I love that style and structure"),
then reverse-engineered them into the prompt:

- **Shape (v7):** greeting → "les queremos contar un poquito de cómo nos fue"
  → the year in broad strokes (the one sentence where a 2–4 item list is
  right) → a warm bridge to the kids → the kids, one or two concrete things each,
  told in context (the line of the year set in its MOMENT, i.e. the parents'
  words just before the quote, `withQuoteContext`) → "Los queremos mucho y
  les deseamos una feliz Navidad." No invitation. A fictional family's
  example letter in the prompt (repo is public).
- **Register:** es-CO = simple past ("fuimos", "cumplió"), never the
  Spain-style perfect (`spain_perfect` flag); `invitation` flag; a second
  list flags `enumeration`; the greeting on its own line.
- **Data (v8):** named trips from place labels on consecutive days or
  travel memories (`namedTrips`: the family's two 3-day trips were found; the
  place labels were being dropped as if they were names); birthdays inside
  the year told as done when before ~Dec 20 (`turningNote`: "Enzo cumplió
  cuatro", even with no birthday memories yet, since cards are made before
  Enzo's Oct 23 and Mara's Nov 8); distinctive recurring photo labels
  (glasses) promoted from "fallback". Owner: content not in the memories stays
  out; drafts aim at 80–90% and parents edit.
- **Model:** the letter writer and front judge use `gpt-6.1-sol`
  (`HOLIDAY_SOL_MODEL`); the holiday film's claim checks and quote pick too
  (`HOLIDAY_CLAIM_CHECK_MODEL`, `HOLIDAY_QUOTE_MODEL`); live films keep
  `gpt-6-sol`. Pricing $2 / $0.10 cached / $10 per M.
- Result: the best classic is close to the hand-written draft (trips by name,
  "cumplió cuatro / dos", the quote in its moment, love + wish). Still weak:
  Mara's glasses not used yet; short/playful variants weaker; one reflective
  run attributed an imaginary plane to the wrong child (check the details
  extraction's child attribution). Holiday-card tests 75 pass.

### C4 round 3 (2026-10-05)

Beach/pool shirtless allowed in the public rule (`public-v2` cache variant;
nudity, bath, diaper/underwear outside water play, crying still out); the sound
scene's caption now always comes from the memory whose audio plays
(`alternateCaptions`; shared bug, live films too); the end-card wordmark in
the bottom-right corner; holiday sound scenes end with the voice (≤ ~0.3 s
tail). test:edge 1988; worker 20/20; render 10/10; app tsc clean;
non-holiday assembly byte-identical.

### C5 build: public film page + dogfood publish (2026-10-05)

Built and tested locally, **not deployed** (the orchestrator reviews and runs
the deploy steps):

- Migration `20261005120000_family_holiday_film_share.sql`: `year_films.kind`
  accepts `family_holiday`; `year_film_bed_ids()` adds `winter-bells` and
  `fireside-piano` (the `PENDING_P1_BEDS` parity exceptions are gone: the SQL
  list now equals the Deno manifest, and the app manifest deliberately omits the
  holiday beds, see `src/utils/year-film-beds.test.ts`); new table
  `film_share_tokens` (select-only RLS through `year_films`, no client writes).
  No other SQL enumerates kinds: `year_film_due` / `year_film_candidate_rows`
  hard-code the three scheduled kinds, `placement_date` already falls through to
  Dec 31, and the member policy already hides `forced` rows. pgTAP:
  `supabase/tests/film_share_tokens.sql`.
- `workers/memory-viewer`: `GET /f/:token` (9:16 player, tap-to-play with
  sound), `/f/:token/video` (Range), `/f/:token/poster`; see its README "Public
  film page". `/m` behaviour unchanged (the Range streaming moved into a shared
  `src/stream.ts`).
- `npm run holiday:publish-sample` (`supabase/scripts/publish-holiday-film-sample.ts`):
  dry run by default; creates/reuses the forced `family_holiday` row, uploads
  `film.mp4` + `poster.jpg` + `poster_thumb.jpg` to
  `{ownerId}/year-films/{filmId}/{attemptId}/`, registers the token.
- **Known gap (dogfood row):** it sits outside the render pipeline with empty
  `referenced_*` arrays, so deleting/editing/reporting a memory does not
  invalidate it until P1 re-renders the card film under the same film id. Until
  then block it by hand (`year_films.blocked = true` shows the "being updated"
  page) or revoke the token.
- P1 follow-ups: a small column or `film_script->'endCard'` for the greeting
  (the Worker currently fetches the whole `film_script` to read two strings);
  members/owners reading the token of a forced film (service role only today);
  `save_year_film_edits` does not refuse `family_holiday` rows (they are
  invisible to clients, so their ids are not discoverable).

### C5 deploy (2026-10-05, owner-approved)

- Migration `20261005120000_family_holiday_film_share.sql` applied by the
  owner (`supabase db push`; only pending migration): `family_holiday` kind,
  holiday beds in `year_film_bed_ids()`, `film_share_tokens`.
- Sample film published with `npm run holiday:publish-sample --apply`: forced
  `family_holiday` row for the owner's family (ready, outside the render
  pipeline until P1; empty references, so it is blocked by hand if needed),
  film + poster + thumb in R2, the card's reserved token linked.
- `workers/memory-viewer` deployed with `/f/:token`, `/video`, `/poster`
  (version d901bee6). Smoke test: page 200 + `no-store` + `noindex`, video
  206 Range, poster 200, unknown token 404, `/m` unchanged; mobile render
  checked (cover, "Toca para ver con sonido", wordmark).
- Letters: a sentence naming both children no longer gives a detail to
  either (owner: vague → skip; the "avión imaginario" memory). Final set
  loaded into the owner's card (`card-data/yi-2026`, token reused).

### C5 sample order (2026-10-05)

- Owner's own letter (edited from Claude's hand-written draft B) on the
  full-bleed card; final PDF via `card:pdf --saved` (letter 10.75 pt, photo
  551 dpi, QR decodes to the live `/f/` link; the owner scanned it on his phone
  and the film played).
- **Gelato file lessons:** (1) the API takes the back as a SEPARATE file
  (`files: [{type: 'default'}, {type: 'back'}]`), not page 2 of one PDF;
  `splitCardPdf` writes `-front.pdf` / `-back.pdf`; (2) no TrimBox/BleedBox:
  with a TrimBox 4 mm inside the page, Gelato's preview shifted the art and
  left 4 mm white strips on the right and bottom; the page is the bleed
  (185.8 × 135 mm). (3) Orders need the company info filled in the Gelato
  portal once. (4) Requests need a browser-like User-Agent.
- Draft → owner checked previews in the dashboard, set quantity 3 (first-order
  30% off) → confirmed via `PATCH /v4/orders/{id} {orderType: 'order'}`:
  order `e4e54644-560e-4b2f-8c74-24608d48cbee`, 3 packs (30 cards + envelopes),
  **€19.80, shipping €0** (EU/PT), made in PT, to Lisbon.
- Open: the generated letters are still blander than the owner's edit (his
  benchmark: "un pedacito de nuestra vida", "no se pierde nada de lo que hace
  su hermano"); pgTAP for the migration not run yet (local Docker hangs).

- **Refused 2026-10-05:** "Delivery for submitted combination of products
  isn't possible to chosen destination" (not charged). The chosen variant
  (5R, 350 gsm silk, no coating) lists PT in `notSupportedCountries`; other
  5R variants deliver to PT/ES/US. Lessons: check each product's
  `supportedCountries` / `notSupportedCountries` per destination before
  ordering (EU quotes return `price: null` shipping even for deliverable
  products, so the quote is not a deliverability signal); production needs a
  per-region product map. New draft `d906d4ed…` with
  `…coated-silk_cl_4-4_ct_glossy-protection_prt_1-0…` (gloss protection on the
  front only, back writable), 3 packs, €28.29 before the first-order discount,
  same files.

- **Refused again** on the 5R gloss-front variant (`refusalReasonCode:
  capability`, routed to a placeholder facility), although its product record
  doesn't exclude PT. Conclusion: Gelato's 5R "Greeting Cards Legacy" packs
  are only really produced in the US/CA network; EU quotes for them come back
  with `null` shipping prices. **The EU catalog (`cards-eu`) has only A-sizes**;
  its A5 card quotes with real shipping (PT: made in ES, €28.29 / 3 packs before
  discount, DHL from €8.64, 7–10 days).
- **Decision (needs the product map in P1): US/CA → 5R (5×7); Europe → A5
  (148 × 210 mm).** The card renderer now takes `format: '5R' | 'A5'`
  (`CARD_FORMATS`, `cardGeometry(orientation, format)`, `card.json.format`,
  `eval:holiday-card-assets --format A5`); layouts adapt (owner's card at A5:
  photo 470 dpi, letter 12 pt, QR decodes). A quote is only a deliverability
  signal when it returns real shipping prices.
- New A5 draft `9703d949…` (`…pf_a5_upt_350-gsm-130lb-coated-silk…glossy-protection_prt_1-0…`),
  3 packs, same QR token.

- **Held** (A5 order `9703d949…`): "Can't combine multiple files into
  production one". **The EU line wants ONE 2-page PDF** (page 1 front, page 2
  back) as `type: 'default'`; the US 5R product wanted separate
  `default` + `back` files. P1's product map must carry the file layout per
  product/region (the renderer writes both: `saved.pdf` 2-page and
  `-front/-back` singles). New draft `6234f0a9…` with the single A5 2-page PDF
  (no TrimBox); the held order cancelled (not charged).

- Gelato support (a human, after their AI agent; 2026-10-05) confirmed for the
  EU A5 pack: **one 2-page PDF as `type: 'default'`, page 1 front, page 2
  back; the preview shows only the front for this product, which is
  expected.** Our editor's own back preview is the one parents should rely on.
  Order `6234f0a9…` placed (€34.98: €19.80 cards after first-order discount +
  €8.64 shipping, VAT incl.), routed to ES.

### Letters v10–v11 (2026-10-05): editor + writer

- **v10** taught the single-call writer the owner's printed letter (framing
  with meaning, the year ending on the kids growing, a quote trimmed to its
  core, `sharedSpecifics` → a sibling line, a `together` count). Better, still
  "not natural enough" (owner).
- **Why the hand-written drafts were better** (Claude's analysis, agreed): they
  were built on what CHANGED this year (the digest ranks by recurrence =
  routines); they allowed warm framing of real facts (the prompt forbade
  "embellishing"); one letter from ~5 facts vs four letters under ~30 rules;
  fuller memory text vs fragments and tags; examples beat rules; choosing came
  before writing.
- **v11 = `_shared/holiday-card-letter-v2.ts`:** (1) `selectEditorCandidates`
  reads every written share-safe entry (≤120, ≤360 chars, ★ on news words);
  (2) the EDITOR call picks 5–7 facts by newsworthiness (skill > first > age >
  new thing > line > trip > siblings; one-off events last), each with evidence
  ids that `parseEditorFacts` verifies (or GIVEN: birthdays, firsts, trips, the
  line), plus a ≤3-item broad-strokes sentence and the QR caption; (3) the
  WRITER is called once per angle (classic, warm, playful) with only those
  facts, the parents' voice examples, three example letters for a FICTIONAL
  family and ~8 principles: leave facts out, one warm turn per child, never a
  new fact; (4) `checkV2Letter` keeps the v1 hard checks (sensitive,
  developmental, names, film mention, length) and shows a few soft ones.
- **Owner choice (c):** classic and warm stay plain ("say it plainly when a
  turn feels strained"); playful gets the charm. `eval:holiday-card-letters`
  defaults to `--pipeline v2` and shows the editor's facts + evidence on the
  review page, so a weak letter is traceable to picking or writing.
- Known variance: the editor doesn't always pick a multi-entry skill (the
  bike) even with the priority; parents finish in the editor (target 80–90%).
  ≈ $0.04–0.05 per card (1 editor + 3 writer calls, gpt-6.1-sol). 84 tests.

### Product build (after C4 passes)

| Phase | Build | Gate |
|---|---|---|
| **P1 — Backend** | Migration: `holiday_cards` (family, year, language, front choice, picks, letter variants + chosen text, greeting, signature, film id, status), `film_share_tokens`, `holiday_card_orders` (copies, Gelato ids, status machine like books). RLS + types + TECH_SPEC. Edge Function `holiday-cards` (create, generate content, picker pool scoped to family + year, save, mint token). Film: kind `family_holiday` in SQL (CHECK, `placement_date`, RLS/visibility for card films to owner/manager), **on-demand dispatch** (single-film claim RPC + signed dispatch, no hourly cron wait), card floors in `planFilm`. `workers/memory-viewer` `/f/:token`, `/f/:token/video` (Range), `/f/:token/poster`. Gelato client (quote, order with copies, status) + checkout + `stripe-webhook` routing by `productType` + order Workflow (render card PDF → presign → Gelato order) + Gelato webhook or sweep. Feature doc `docs/features/holiday-cards.md`. | Canary on production for Eduardo's family: create a card end-to-end, the film renders on demand, the QR page plays, a real paid order arrives (2nd physical proof, through the product). |
| **P2 — Shop + app** | Web shop: `/c/<id>` card editor (layouts, photo top picks + full picker, illustrated option, greeting, letter variants + editing with live fit, signature, film preview + film on/off), checkout with quantity, order status, reorders. App: Keepsakes "Holiday card" entry (seasonal: Nov 1 → Dec 31), opens the shop. EAS Update (JS only). Unit + integration + Maestro. | Device pass iOS + Android (owner). |
| **P3 — Launch** | Announce to subscribers (~Nov 10); watch orders, render queue, Gelato production times. December capacity: card films share render slots with the Dec 1 monthly rush and Dec 28 year-end films (`max_concurrent_renders`). | First real customer cards delivered before Dec 15. |

### Timeline (target)

| Week of | Work |
|---|---|
| Oct 5 | C0 ✓, C1 (front), C2 (script + letters) |
| Oct 12 | C3 (card design) + C4 (film motion) in parallel; owner review rounds |
| Oct 19 | C5: `/f/` page + sample ordered (arrives ~1 week); C6; P1 starts |
| Oct 26 | P1; sample review |
| Nov 2 | P2; canary order |
| **Nov 10** | **Launch** (P3) |

## 7. Open questions

1. ~~Price~~ decided: $2.49/card, shipping included (§2).
2. **Gelato print spec:** bleed, page order (front = page 1?), safe area,
   envelope size. Settled in C0/C2 from Gelato's template + a draft-order
   file check.
3. **EU shipping:** quotes show $0.00 shipping for ES/PT. Real, or missing
   from the quote? The C4 sample order's charge answers it.
4. **Illustration resolution:** 1024² today = ~146–205 dpi at 5×7. Try
   1536×1024 output and/or an upscale in C1/C2.
5. **Card-film floor** (C0/C3): proposal ≥20 memories / ≥12 photos+videos, no
   quarter rule.
6. ~~Sample QR~~ decided: build `/f/:token` early (before C4).
7. ~~Signature~~ decided: from the app's family name, editable.

## 8. Notes for future agents

- This plan follows the book's V-stages and the film's F-stages: read
  `memory-book.md` §9 and `year-film.md` §10 for how review rounds were run
  and recorded.
- The Prodigi research (2026-10-04) is kept for reference: UK/EU only for
  cards, $31 DHL to the US, classic greeting cards don't ship to the US. Don't
  reopen it unless Gelato fails.
