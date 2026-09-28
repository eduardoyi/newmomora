/**
 * Token usage + cost for the Year Film eval scripts (docs/plans/year-film.md
 * §11): every OpenAI response's `usage` is recorded per model, and a run ends
 * with a per-model summary. Prices are USD per 1M tokens, standard tier, short
 * context (OpenAI pricing page, 2026-09-28). Counts only — no content.
 */

const PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-6-sol': { input: 2.0, cachedInput: 0.2, output: 10.0 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-6-astra': { input: 10.0, cachedInput: 1.0, output: 50.0 },
};

interface Tally {
  calls: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

const tallies = new Map<string, Tally>();

/** Records one response's usage (Chat Completions shape). */
export function recordUsage(model: string, usage: Record<string, unknown> | undefined): void {
  const t = tallies.get(model) ?? { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
  const details = (usage?.prompt_tokens_details ?? {}) as Record<string, number>;
  const out = (usage?.completion_tokens_details ?? {}) as Record<string, number>;
  t.calls += 1;
  t.input += Number(usage?.prompt_tokens ?? 0);
  t.cached += Number(details.cached_tokens ?? 0);
  t.output += Number(usage?.completion_tokens ?? 0);
  t.reasoning += Number(out.reasoning_tokens ?? 0);
  tallies.set(model, t);
}

function costOf(model: string, t: Tally): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return ((t.input - t.cached) * price.input + t.cached * price.cachedInput + t.output * price.output) / 1e6;
}

/** Usage since the last reset, per model, with cost where the price is known. */
export function usageSummary(): { model: string; calls: number; input: number; cached: number; output: number; reasoning: number; usd: number | null }[] {
  return [...tallies.entries()].map(([model, t]) => ({ model, ...t, usd: costOf(model, t) }));
}

export function resetUsage(): void {
  tallies.clear();
}

export function formatUsage(label: string): string {
  const rows = usageSummary();
  if (rows.length === 0) return `${label}: no model calls`;
  const known = rows.filter((r) => r.usd !== null).reduce((sum, r) => sum + r.usd!, 0);
  return [
    `${label}: ≈ $${known.toFixed(4)}${rows.some((r) => r.usd === null) ? ' (+ unpriced models)' : ''}`,
    ...rows.map((r) =>
      `  ${r.model}: ${r.calls} call(s) · ${r.input} in (${r.cached} cached) · ${r.output} out (${r.reasoning} reasoning)${
        r.usd === null ? ' · price unknown' : ` · $${r.usd.toFixed(4)}`
      }`
    ),
  ].join('\n');
}
