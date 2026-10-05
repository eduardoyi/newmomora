// Year Film verdict cache (docs/plans/year-film-p1.md Decision 5). Every
// model verdict is stored in year_films.ai_checks under a per-item key that
// changes whenever anything that could change the answer changes (model,
// prompt version, the asset and window, the reference portraits), so a
// Workflow retry or an edit re-render never pays for a verdict it has.
// Batches are split into per-item entries before saving.
import type { VerifiedQuote } from './year-film-script.ts';
import type { FrameCheck } from './year-film-vision.ts';
import type { VoiceCheck } from './year-film-voice.ts';

/** Bump when a check prompt changes in a way that should re-check. */
export const CHECK_PROMPT_VERSION = 1;

/** Bump (v3…) whenever the public-audience prompt changes in a way that should re-check. */
export const PUBLIC_CHECK_VARIANT = 'public-v2';
export type PublicCheckVariant = typeof PUBLIC_CHECK_VARIANT;

export type CheckKind = 'claim' | 'frame' | 'voice';

export interface QuotePick {
  accepted: VerifiedQuote[];
  language: string | null;
}

export type CachedCheck =
  | { kind: 'claim' | 'frame'; value: FrameCheck | null }
  | { kind: 'voice'; value: VoiceCheck | null }
  | { kind: 'quote'; value: QuotePick };

export type CheckCache = Record<string, CachedCheck>;

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CheckKeyInput {
  kind: CheckKind;
  model: string;
  /** The R2 key the verdict is about (asset or prepared artifact source). */
  assetKey: string;
  /** Clip/voice window, if any. */
  window?: { start: number; end: number } | null;
  /** Reference portrait keys the model compared against (frame/claim). */
  referenceKeys?: readonly string[];
  /** 'public-v2': the public-audience prompt (holiday card film; v2 = bare torsos
   * are fine in a beach/pool/swim context, owner 2026-10-05 round 3). Part of
   * the key, so a normal verdict — or one from the retired 'public' (v1, no beach
   * exception) prompt — is never reused. Absent for every other film, which keeps
   * its keys (and cached verdicts) as they were. */
  variant?: PublicCheckVariant;
}

export async function checkCacheKey(input: CheckKeyInput): Promise<string> {
  const window = input.window ? `${input.window.start.toFixed(3)}-${input.window.end.toFixed(3)}` : '';
  const refs = [...(input.referenceKeys ?? [])].sort().join(',');
  return `${input.kind}:${await sha(
    [CHECK_PROMPT_VERSION, input.model, input.assetKey, window, refs, ...(input.variant ? [input.variant] : [])].join('\u001f'),
  )}`;
}

/** Positional batch results (parseFrameCheckResponse) → per-item entries. */
export function splitBatch<T extends FrameCheck | VoiceCheck>(
  kind: CheckKind,
  keys: readonly string[],
  results: ReadonlyMap<number, T>,
): CheckCache {
  const out: CheckCache = {};
  keys.forEach((key, index) => {
    out[key] = { kind, value: results.get(index) ?? null } as CachedCheck;
  });
  return out;
}

export function cachedFrame(cache: CheckCache, key: string): FrameCheck | null | undefined {
  const entry = cache[key];
  if (!entry || (entry.kind !== 'claim' && entry.kind !== 'frame')) return undefined;
  return entry.value;
}

export function cachedVoice(cache: CheckCache, key: string): VoiceCheck | null | undefined {
  const entry = cache[key];
  if (!entry || entry.kind !== 'voice') return undefined;
  return entry.value;
}

export function cachedQuote(cache: CheckCache, key: string): QuotePick | undefined {
  const entry = cache[key];
  return entry?.kind === 'quote' ? entry.value : undefined;
}
