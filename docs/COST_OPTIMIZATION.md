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

- Use `gpt-image-2` with fallback to `gpt-image-1.5` — pick quality tier deliberately in prompts
- Emotion/voice: `gpt-4o-mini` + `gpt-4o-mini-transcribe` — keep on mini, not full models
- Photo media emotion uses `gpt-4o-mini` vision on server-downscaled images (768px max edge) — cheap vs image generation

### Image size

- Profile photos are resized client-side to a **2048px max edge** and recompressed to JPEG before R2 upload
- Illustration/portrait OpenAI references are capped server-side to a **1024px max edge** before the image edit API call
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
