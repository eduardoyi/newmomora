# Momora — Cost Optimization

How we keep infrastructure costs predictable as image volume grows. Complements [TECH_SPEC.md](./TECH_SPEC.md).

---

## Cost drivers (ranked)

| Rank | Service | Why it matters for Momora |
|------|---------|---------------------------|
| 1 | **OpenAI image generation** | Every portrait + memory illustration = API call; dominant variable cost |
| 2 | **Image bandwidth** | Timeline/calendar re-load illustrations; was expensive on Supabase Storage |
| 3 | **OpenAI text/audio** | Emotion, voice cleanup, transcription — cheap per call vs images |
| 4 | **Supabase** | Postgres + Auth + Edge Functions — modest at MVP scale |
| 5 | **Cloudflare R2** | Storage + ops; **$0 egress** makes bandwidth a non-issue |
| 6 | **Expo Push** | Negligible at MVP scale |

---

## Measured unit economics (eval, 2026-07-23)

Measured with `npm run eval:image-cost` (see [Re-measuring](#re-measuring-costs) below) against real
account data, capturing the Images API `usage` token object per call. Token counts were identical
across repeats, so per-generation cost is **deterministic**, not an estimate.

### Pricing inputs (per 1M tokens, OpenAI pricing page 2026-07-23)

| Model | Text in | Image in | Output |
|-------|---------|----------|--------|
| `gpt-image-2` (primary) | $5.00 | $8.00 | $30.00 |
| `gpt-image-1.5` (fallback) | $5.00 | $8.00 | $32.00 image / $10.00 text |

gpt-image-1.5 responses include ~420–490 **text output tokens** billed at the cheaper $10/1M rate
(gpt-image-2 emits none) — cost math must split `output_tokens_details`, not price all output
tokens at the image rate. Reference-image input tokens follow OpenAI's documented tile formula
(image scaled to 512px shortest side): gpt-image-1.5 bills 65 base + 129/tile = **194
tokens/square ref** at default fidelity, **+4,160/ref** (square; +6,240 non-square) at
`input_fidelity: high` = 4,354; gpt-image-2 bills a flat **1,024 tokens/square ref**. All three
match our measurements exactly.
| `gpt-4o-mini` | $0.15 | — | $0.60 |
| `gpt-4o-mini-transcribe` | $1.25 (+ ~$0.003/min audio) | — | $5.00 |

### Cost formula (gpt-image-2, `quality: medium`, 1024×1024, webp)

- Output: flat **1,756 tokens = $0.0527** per image.
- Input: flat **1,024 tokens = $0.0082 per square reference image** (independent of pixel size —
  see "levers that don't work"). Non-square references can bill slightly less.
- Prompt text: ~550–620 tokens ≈ $0.003.

> **Memory illustration ≈ $0.055 + $0.0082 × references** &nbsp;·&nbsp; **Portrait = $0.069**

| References | Cost/generation | |
|-----------|-----------------|--|
| 1 | $0.064 | measured |
| 2 | $0.072 | measured |
| 3 | $0.080 | measured |
| 4 | $0.089 | measured |
| 5 | $0.097 | extrapolated (exact linearity) |
| 6 (`MAX_ILLUSTRATION_MEMBERS`) | $0.105 | extrapolated (exact linearity) |

Text/audio calls are confirmed noise: safety-rewrite + emotion chats ≈ $0.001/memory; a full
2-minute voice memory ≈ $0.007.

### Quality policy: explicit `medium` everywhere (fixed 2026-07-23)

Omitting `quality` (provider default `auto`) resolved to **high** for a 3-reference memory scene:
7,024 output tokens = **$0.238 and ~155s** — 3× the cost and latency of medium, with no
product-quality justification (medium validated in prior evals). All four call sites (worker
`workflow.ts` + `openai.ts:editPortraitImage`, both legacy Edge Function paths) now send
`quality: 'medium'` explicitly. Never reintroduce an unqualified image call.

### Levers that do NOT work

- **Downscaling reference images** (1024 → 512px): billed exactly the same 1,024 input tokens per
  reference. Image input tokens are flat per image, not per pixel. The existing 1024px server-side
  cap is for upload size/latency only, not OpenAI cost.
- The only real input-side levers are **fewer references** (product decision) and possibly
  **cached image-input pricing** ($2/1M vs $8/1M) — but back-to-back identical `/v1/images/edits`
  calls showed no cached tokens, so caching does not apply to this endpoint as we use it. At most
  it would save ~$0.006/ref via a different API surface; not worth pursuing at current scale.

### Accepted: fallback bills ~1.8× (decision 2026-07-24)

`gpt-image-1.5` with `input_fidelity: 'high'` (auto-set for multi-reference edits) bills 4,354
input image tokens per square reference (vs 1,024 on gpt-image-2) → **$0.146/call** at 3 refs vs
$0.080 primary. Worst-case single memory (2 primary attempts + 1 fallback) ≈ **$0.31**.

We tested dropping `input_fidelity` (2026-07-24 eval, `fallback-no-fidelity` cell): it would make
the fallback the *cheapest* path (~$0.046 at 3 refs, references billed at just 194 tokens each),
but the output style/likeness was visibly worse — **rejected**. High fidelity stays; the ~1.8×
cost is accepted as the price of character likeness on a rarely-hit path. Do not remove
`input_fidelity: 'high'` from the fallback without re-running the style comparison.

### Scenario model (per active family/month)

Assumes avg 2–3 refs/memory, +15% buffer for regenerates/fallbacks, chat+voice included.
One-time onboarding for a 5-member family ≈ $0.35 in portraits; portrait timeline updates
≈ $0.07 each (~$0.70/member/year).

| Profile | Illustrated memories/mo | AI cost/mo |
|---------|------------------------|------------|
| Light | 4 | ~$0.45 |
| Moderate | 12 | ~$1.15 |
| Heavy | 30 | ~$2.75 |
| Worst-case heavy (all 6 refs) | 30 | ~$3.60 |

Even the worst-case heavy family stays under $4/mo — comfortably inside a typical subscription
price after the 15–30% store cut. The real cost risk is not per-generation price but **runaway
regeneration** (recovery/retrigger cascades) — watch attempt counts in
`memory_illustration_jobs` / `portrait_generation_jobs`.

### Re-measuring costs

```
npm run eval:image-cost -- --list-members            # member UUIDs
npm run eval:image-cost -- --search " " --limit 30 --dry-run   # memory UUIDs + ref counts, no spend
npm run eval:image-cost -- --memory-id <uuid> --member-id <uuid> \
  --cells baseline,quality-sweep,fallback-model --repeats 2
```

Re-run after any model/quality/size change or OpenAI price change, and update the dated pricing
constant in `supabase/scripts/eval-image-cost.ts` + the tables above.

---

## Storage: Cloudflare R2 (not Supabase Storage)

### The problem with Supabase Storage for Momora

Memora v1 stored all images in Supabase Storage. Costs hurt because:

- **Egress** is billed beyond plan quotas (unified egress ~$0.09/GB uncached on Pro)
- Every timeline scroll, calendar view, and detail open re-downloads images
- A parent revisiting memories multiplies bandwidth with no revenue offset in MVP

### Why R2 fits

| | Supabase Storage (typical) | Cloudflare R2 |
|--|---------------------------|---------------|
| Storage | ~$0.021/GB-month (Pro) | ~$0.015/GB-month |
| **Egress to internet** | **Billed after quota** | **$0** |
| S3 API | No | Yes |
| Auth integration | Built-in RLS | Via Edge Functions (presigned URLs) |

For an image-heavy journal app, **zero egress** is the decisive win.

### Architecture split

| Keep on Supabase | Move to R2 |
|------------------|------------|
| Auth | Profile photos |
| PostgreSQL + RLS | Character portraits |
| Edge Functions (orchestration) | Memory illustrations |
| | Public style reference assets |

Postgres stores **R2 object keys**, not public URLs. Edge Functions issue **presigned URLs** (short TTL) for the app.

### R2 cost tips

- Use **WebP** for photos and AI output (smaller files vs PNG/JPEG)
- **Delete superseded objects** on illustration regeneration (already spec'd)
- **Prefix delete** `{userId}/` on account hard-delete
- Style assets in a **small public bucket** — fixed cost, CDN-friendly
- R2 free tier: 10 GB-month storage + generous ops — enough for early beta

---

## OpenAI cost optimization

Image generation will likely be your **largest bill**.

### Reduce unnecessary generations

- Don't regenerate portrait unless profile photo changes
- Don't regenerate illustration unless memory text/tags change (or user taps retry)
- Save memory **text first**; failed illustration = retry, not duplicate memory rows

### Model & quality

- Use `gpt-image-2` with fallback to `gpt-image-1.5` — always pass `quality: 'medium'` explicitly (see [Measured unit economics](#measured-unit-economics-eval-2026-07-23); `auto` can silently bill 3×)
- Emotion/voice: `gpt-4o-mini` + `gpt-4o-mini-transcribe` — keep on mini, not full models
- Photo media emotion uses `gpt-4o-mini` vision on server-downscaled images (768px max edge) — cheap vs image generation

### Image size

- Profile photos are resized client-side to a **2048px max edge** and recompressed to JPEG before R2 upload
- Illustration/portrait OpenAI references are capped server-side to a **1024px max edge** before the image edit API call (upload size/latency only — reference input tokens are flat per image regardless of pixel size, so further downscaling saves nothing)
- Generate illustrations at display resolution, not print resolution
- Consider timeline **thumbnails** post-MVP if full illustrations are large (store `illustration.webp` + `thumb.webp`)

### Future (post-MVP)

- Monetization/credits to align usage with revenue
- Batch or queue illustration jobs to smooth spikes

---

## Supabase cost optimization

### What to use Supabase for

- Auth, Postgres, RLS — core value, hard to replace cheaply
- Edge Functions — already paid for in plan; co-locate AI orchestration here

### What to avoid on Supabase

- **Storage for user images** — use R2
- Service role in client — never (security + no benefit)
- Over-fetching in Realtime — poll illustration status or subscribe to one column only

### Database

- Journal text is tiny; storage cost is negligible
- Index only what you query (`user_id`, `memory_date`)
- Full-text search via GIN — fine at MVP scale

---

## Client-side optimizations (free)

- **`expo-image`** disk cache — repeat views don't re-hit network
- TanStack Query cache for presigned URLs (~50 min, refresh before expiry)
- Virtualize timeline (`FlashList`) — don't mount 100 images at once
- Lazy-load illustrations off-screen

These improve UX and reduce R2 Class B (read) operations slightly.

---

## What we are NOT optimizing early

- Multi-region replication
- Separate thumbnail CDN unless metrics justify it
- Self-hosting AI models
- Moving Postgres off Supabase

Revisit when you have usage metrics.

---

## Monitoring (when live)

Track monthly:

- OpenAI dashboard: image vs chat vs audio spend
- Cloudflare R2: storage GB, Class A/B ops
- Supabase: egress (should be low without Storage), Edge Function invocations, DB size

Set billing alerts on OpenAI and Cloudflare.

---

## Summary recommendation

| Area | Decision |
|------|----------|
| User images | **Cloudflare R2** + presigned URLs via Edge Functions |
| Metadata & auth | **Supabase** |
| AI | **OpenAI** — optimize by avoiding redundant image gens + WebP |
| Biggest future lever | Credits/monetization tied to illustration count |
