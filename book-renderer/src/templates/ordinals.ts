import type { Language } from './furniture';
import type { ManifestScope } from '../model/types';

/**
 * Best-effort extraction of "which numbered year" from the manifest's own
 * scope, for the closing line's "tu tercer año" / "your third year" phrasing
 * (owner decision: "parametrize the year ordinal from scope where possible,
 * else a neutral variant"). Only applies to an age-year scope; everything
 * else (calendar-year, custom range, "everything") has no single "year N"
 * to name, so callers fall back to the neutral scope-label phrasing.
 */

const EN_NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const ES_NUMBER_WORDS = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'];
const ES_ORDINAL_WORDS_IN_LABEL = [
  'primer',
  'segundo',
  'tercer',
  'cuarto',
  'quinto',
  'sexto',
  'séptimo',
  'octavo',
  'noveno',
  'décimo',
];

const EN_ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ES_ORDINALS = ES_ORDINAL_WORDS_IN_LABEL;

export function extractYearOrdinal(scope: Pick<ManifestScope, 'kind' | 'label'>): number | null {
  if (scope.kind !== 'age-year') return null;
  const label = scope.label.toLowerCase();

  const digitMatch = /(\d+)/.exec(label);
  if (digitMatch) return Number(digitMatch[1]);

  for (let i = 0; i < EN_NUMBER_WORDS.length; i++) {
    if (label.includes(EN_NUMBER_WORDS[i])) return i + 1;
  }
  for (let i = 0; i < ES_NUMBER_WORDS.length; i++) {
    if (label.includes(ES_NUMBER_WORDS[i])) return i + 1;
  }
  for (let i = 0; i < ES_ORDINAL_WORDS_IN_LABEL.length; i++) {
    if (label.includes(ES_ORDINAL_WORDS_IN_LABEL[i])) return i + 1;
  }
  for (let i = 0; i < EN_ORDINALS.length; i++) {
    if (label.includes(EN_ORDINALS[i])) return i + 1;
  }
  return null;
}

/** 1 -> "first"/"primer", falls back to "Nth"/"N.º" past the spelled-out range. */
export function ordinalWord(n: number, lang: Language): string {
  const table = lang === 'es' ? ES_ORDINALS : EN_ORDINALS;
  if (Number.isInteger(n) && n >= 1 && n <= table.length) return table[n - 1];
  return lang === 'es' ? `${n}.º` : `${n}th`;
}
