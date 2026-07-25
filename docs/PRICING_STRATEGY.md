# Momora — Pricing Strategy

**Last updated:** 2026-07-24 · Owner decision: **$12.99/month or $99.99/year** ($8.33/mo
equivalent, a 36% discount), paid-only (no free tier). Monthly is deliberately priced as the
anchor; annual is the intended mainstream choice. This doc records the unit economics behind that
price, the benchmark evidence, and the guardrails from customer research. Companions:
[COST_OPTIMIZATION.md](./COST_OPTIMIZATION.md) (measured costs),
[features/usage-limits.md](./features/usage-limits.md) (margin protection),
[voice-of-customer.md](./voice-of-customer.md) (what parents punish and reward).

---

## Unit economics at $12.99 / $99.99

Store fee scenarios: 30% standard; 15% under the App Store Small Business Program / Play
equivalent (likely applies at our scale, and to year-2+ subscribers regardless).

| Plan | Gross/mo | Net/mo @30% | Net/mo @15% |
|------|----------|-------------|-------------|
| Monthly $12.99 | $12.99 | $9.09 | $11.04 |
| Annual $99.99 | $8.33 | $5.83 | $7.08 |

Measured AI cost per family/month (COST_OPTIMIZATION.md, 2026-07 eval):

| Profile | AI cost/mo | Margin vs worst net ($5.83) |
|---------|-----------|------------------------------|
| Light (4 memories/mo) | ~$0.45 | 92% |
| Moderate (12/mo) | ~$1.15 | 80% |
| Heavy (30/mo) | ~$2.75 | 53% |
| At monthly usage cap (100 gens) | ~$8–9 | ≈ break-even |

**Verdict: the price is margin-safe.** Break-even is ~76 generations/month on the worst
plan/fee combination (annual @30%) and ~118–143 on monthly; the fair-use cap (100/mo) sits at or
above that line for every combination except annual@30%, where a cap-hitting family is a small,
bounded loss (~$2–3/mo) — acceptable as the extreme tail. Unbounded loss is impossible. Infrastructure (R2, Supabase, Workers) is
noise at this scale.

---

## Benchmark context (tasu conversion brain, retrieved 2026-07-24)

- **Price level:** ChatGPT normalized $20/mo for consumer AI; AI apps monetize at ~2× pre-AI
  ARPU (Olivia Moore, a16z / RevenueCat SOSA 2026). $12.99 is comfortably under the normalized
  ceiling while our AI serving cost is real — consistent with Phil Carter's observation that
  AI-era apps rationally gate more and push annual.
- **Plan mix is category-specific** (RevenueCat SOSA 2026, 115k apps): Health & Fitness is 68%
  annual (59% of revenue from annual); Gaming is 82% weekly. Adapty 2026 (20k apps) finds weekly
  converts 2–7× better than annual and monthly is "a graveyard" (install-to-trial 0.3–0.6%) —
  but that benchmark is dominated by utility/impulse categories. A family memory archive is a
  sustained-journey product (the YarnPal counter-case: chose annual over the weekly benchmark for
  exactly this reason). **A weekly plan would be wrong for Momora** — it reads transactional and
  triggers the archive-anxiety our VoC flags. Lead annual; keep monthly as the anchor/on-ramp.
- **Anchoring tactics** (Mobbin, 2,995 paywalls): quote the per-month equivalent for annual
  ($99.99 → "$8.33/mo") and optionally the per-week figure ($1.92/week); compare to a spend
  parents already accept (one printed photo book, a coffee). Bend ($1.1M/mo) shows the pattern:
  high monthly ($13.99) as anchor, cheap annual ($39.99 = $3.33/mo) as the real product.
- **Trial:** if we run one, gate the free trial to the annual plan (Wrestle AI, Moonly; Headspace's
  winning variant was 14-day on annual) — it filters intent and collects the high-LTV term.
  Requiring commitment up front cut sign-ups >50% but 5×'d conversion in the Outsider case.
- **Do not use** spin-wheel/fake-urgency paywalls: short-term weekly-revenue tactics with decaying
  edge and LTV damage (Mobbin) — and brand-toxic for a keepsake product.

## Plan structure: monthly as anchor (decided 2026-07-24)

Originally considered $9.99/mo, which made the annual discount a thin 17% — benchmarks show
annual-led apps using much deeper gaps (Bend: 76%). Decision: **raise monthly to $12.99** so
$99.99/yr is a genuine 36% discount ($8.33/mo), following the anchor pattern (higher monthly
frames annual as the obvious choice; both per-month prices shown side by side, annual marked as
the default). Annual prepay = lower churn surface + cash up front; RevenueCat SOSA 2026 shows
annual share falling market-wide (41.4%→33.6%), so the discount has to do real work — 36% does.

Instrument plan mix from launch; if monthly share stays unexpectedly high, that's margin-positive
(monthly nets most) but churn-risky — revisit with cohort data.

---

## VoC guardrails (violating these costs more than any pricing win)

1. **Publish data ownership/export prominently near the price.** The Tinybeans $179/yr AUD shock
   review is really about lock-in ("every photo I've ever taken… felt like too much to walk
   away from"). Momora's price must never feel like ransom on memories: export exists, say so.
2. **No visible credits/metering** — see [features/usage-limits.md](./features/usage-limits.md).
   Chatbooks' credit resentment is the cautionary quote.
3. **No guilt mechanics** (streaks-shaming, expiring offers): top VoC anti-requirement is "another
   app that becomes a chore or source of guilt."

## Revisit triggers

- OpenAI reprices or models change → re-run `npm run eval:image-cost`, update COST_OPTIMIZATION.md
  and the break-even/cap linkage here and in usage-limits.md.
- Free tier ever considered → whole limit + pricing structure needs rework (visible limits).
- Plan-mix data after launch → resolve the annual-discount question above.
