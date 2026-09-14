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
  dedication: {
    greeting: (childName: string) => string;
    signature: string;
    /**
     * Print-polish round (owner decision 2026-09-14, item D1): the
     * dedication page's small bottom-right footnote explaining the book's
     * scan marks — covers BOTH video and audio memories (never "watch"
     * alone). Only rendered when the fitted document actually contains at
     * least one scan mark (`BookPage.params.hasScanMarks`, computed in
     * `fitter.ts`'s `documentHasScanMarks`) — a book with no media codes
     * keeps a pristine dedication page. Editable per book via the
     * `furniture:scanInstruction` edit target, same fallback-to-default
     * shape as every other furniture field (see `edits.ts`).
     */
    scanInstruction: string;
  };
  /** "Enzo, 10 de agosto de 2025 — seis momentos" — canvas's spread-title attribution pattern. */
  spreadTitleAttribution: (childName: string, dateStr: string, momentCount: number) => string;
  /**
   * Video credit-line microcopy ("escanea para verlo") that used to render
   * next to EVERY inline scan mark (PhotoTile, and the full-bleed/panorama
   * video credit in FooterIndex). Print-polish round (owner decision
   * 2026-09-14, item D3) removed both render sites — the new play/audio
   * badge drawn INSIDE the mark itself (see `QrCode.tsx`'s `badge` prop)
   * plus the dedication page's one-time `scanInstruction` footnote make a
   * per-mark text label redundant, and it was cluttering photo pages with
   * video. This field is intentionally kept (not deleted) even though
   * nothing renders it any more: `scanToWatch` was never part of the
   * editable `FURNITURE_KEYS` allowlist (`model/edits.ts`) so no saved
   * per-book edit can be orphaned by its removal from render — this is
   * purely "stop reading a value that used to have a UI", not a data-
   * migration concern. Left in place rather than deleted so a future
   * revert doesn't have to reconstruct the Spanish/English copy from
   * scratch.
   */
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
      // Owner-approved copy (print-polish round, 2026-09-14) — covers both
      // video ("ver") and audio ("escuchar") memories, never just "watch".
      scanInstruction:
        'Cuando veas un código como este, escanéalo con la cámara de tu teléfono para ver o escuchar ese recuerdo.',
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
      scanInstruction:
        "When you see a code like this, scan it with your phone's camera to watch or listen to that memory.",
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
