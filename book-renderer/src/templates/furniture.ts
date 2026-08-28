import type { BookManifest } from '../model/types';
import { ordinalWord } from './ordinals';

/**
 * Fixed book "furniture" — chrome copy the templates own (section labels,
 * signatures, scan-mark microcopy, the closing headline) as distinct from
 * memory content and outline-authored editorial copy, which are never
 * translated or altered here.
 *
 * Product decision: furniture follows the family's journal language
 * (`manifest.language`), not the app UI language. Spanish strings are
 * taken VERBATIM from the Momora Book Layout System design canvas
 * (book-data/design-handoff/Momora Book Layout System.dc.html) — do not
 * reword them. English strings are this module's own mirror translation;
 * the canvas has no English furniture to copy from.
 */

export type Language = 'es' | 'en';

/** `manifest.language` is `"es" | "en"`, defaulting to `"en"` when absent. */
export function getLanguage(manifest: Pick<BookManifest, 'language'>): Language {
  return manifest.language === 'es' ? 'es' : 'en';
}

const NUMBER_WORDS: Record<Language, string[]> = {
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'],
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
};

/** Spells 0-10 in the given language; falls back to digits outside that range. */
export function numberWord(n: number, lang: Language): string {
  if (Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS[lang].length) return NUMBER_WORDS[lang][n];
  return String(n);
}

export interface Furniture {
  throughTheYears: { kicker: string; titleLines: [string, string] };
  dedication: { greeting: (childName: string) => string; signature: string };
  /** "Enzo, 10 de agosto de 2025 — seis momentos" — canvas's spread-title attribution pattern. */
  spreadTitleAttribution: (childName: string, dateStr: string, momentCount: number) => string;
  /** Video credit-line microcopy under the inline scan mark ("escanea para verlo"). */
  scanToWatch: string;
  /** The single Caveat word on an audio-note page. */
  listenToIt: string;
  firsts: { kicker: string };
  closing: {
    headline: string;
    /**
     * `count` is the MEMORY count (owner review round 3: "closing line =
     * 'Este libro recoge [X] recuerdos...' (memory count)" — deliberately
     * not the page count, which is an implementation detail readers don't
     * care about). `yearOrdinal`, when extractable from an age-year scope
     * (see templates/ordinals.ts), gives the canvas's exact phrasing ("de tu
     * tercer año"); otherwise falls back to the neutral scope-label form.
     */
    memoryCountLine: (count: number, scopeLabel: string, yearOrdinal: number | null) => string;
  };
}

const FURNITURE: Record<Language, Furniture> = {
  es: {
    throughTheYears: {
      kicker: 'un año en retratos',
      titleLines: ['Cómo cambiaste', 'en doce meses'],
    },
    dedication: {
      greeting: (childName) => `Para ${childName},`,
      // Generic, not "mami y papi" — the household writing it isn't always
      // that shape (owner review round 3).
      signature: 'Escrito con amor, día a día',
    },
    spreadTitleAttribution: (childName, dateStr, momentCount) =>
      momentCount > 1 ? `${childName}, ${dateStr} — ${numberWord(momentCount, 'es')} momentos` : `${childName}, ${dateStr}`,
    scanToWatch: 'escanea para verlo',
    listenToIt: 'escúchalo',
    firsts: { kicker: 'primeras veces' },
    closing: {
      headline: 'Hasta el año que viene.',
      memoryCountLine: (count, scopeLabel, yearOrdinal) =>
        `Este libro recoge ${count} recuerdos de ${yearOrdinal ? `tu ${ordinalWord(yearOrdinal, 'es')} año` : scopeLabel}.`,
    },
  },
  en: {
    throughTheYears: {
      kicker: 'through the years',
      titleLines: ['How you changed', 'in twelve months'],
    },
    dedication: {
      greeting: (childName) => `For ${childName},`,
      signature: 'Written with love, day by day',
    },
    spreadTitleAttribution: (childName, dateStr, momentCount) =>
      momentCount > 1 ? `${childName}, ${dateStr} — ${numberWord(momentCount, 'en')} moments` : `${childName}, ${dateStr}`,
    scanToWatch: 'scan to watch it',
    listenToIt: 'listen to it',
    firsts: { kicker: 'firsts' },
    closing: {
      headline: 'See you next year.',
      memoryCountLine: (count, scopeLabel, yearOrdinal) =>
        `This book holds ${count} memories from ${yearOrdinal ? `your ${ordinalWord(yearOrdinal, 'en')} year` : scopeLabel}.`,
    },
  },
};

export function getFurniture(lang: Language): Furniture {
  return FURNITURE[lang];
}

/** Every furniture language table, for completeness testing. */
export const FURNITURE_LANGUAGES: Language[] = ['es', 'en'];
export { FURNITURE as ALL_FURNITURE };
