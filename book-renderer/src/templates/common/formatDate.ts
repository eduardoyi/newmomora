import type { Language } from '../furniture';

/**
 * Language-aware date formatting. Deliberately NOT using
 * `Date.prototype.toLocaleDateString` — its output (abbreviation style,
 * punctuation, ICU data) varies by runtime/locale-data version, which would
 * make the printed book non-deterministic across environments (dev preview
 * vs. a future print pipeline). Fixed month-name tables keep it exact and
 * testable. Dates are read via UTC getters so a date-only ISO string
 * ("2024-12-12") never shifts by a day under a non-UTC local timezone.
 */

const MONTHS_FULL: Record<Language, string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
};

const MONTHS_ABBR: Record<Language, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
};

function dateParts(iso: string): { day: number; month: number; year: number; valid: boolean } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: 0, month: 0, year: 0, valid: false };
  return { day: d.getUTCDate(), month: d.getUTCMonth(), year: d.getUTCFullYear(), valid: true };
}

/**
 * Footer-index / firsts-list date: "23 oct" (es) / "Oct 23" (en) — day +
 * abbreviated month, no year (the year already lives in the spread's own
 * context; see the Momora Book Layout System's numbered footer index).
 */
export function formatIndexDate(iso: string, lang: Language): string {
  const { day, month, valid } = dateParts(iso);
  if (!valid) return iso;
  return lang === 'es' ? `${day} ${MONTHS_ABBR.es[month]}` : `${MONTHS_ABBR.en[month]} ${day}`;
}

/**
 * Long-form date used in attributions, illustrated-story/audio-note
 * headers, and long-entry pages: "10 de agosto de 2025" (es) / "August 10,
 * 2025" (en).
 */
export function formatLongDate(iso: string, lang: Language): string {
  const { day, month, year, valid } = dateParts(iso);
  if (!valid) return iso;
  return lang === 'es' ? `${day} de ${MONTHS_FULL.es[month]} de ${year}` : `${MONTHS_FULL.en[month]} ${day}, ${year}`;
}

/**
 * Through-the-years portrait caption date: "12 diciembre 2024" (es, no
 * "de" — matches the design canvas's portrait-strip caption exactly) /
 * "December 12, 2024" (en, same shape as the long date).
 */
export function formatPortraitDate(iso: string, lang: Language): string {
  const { day, month, year, valid } = dateParts(iso);
  if (!valid) return iso;
  return lang === 'es' ? `${day} ${MONTHS_FULL.es[month]} ${year}` : `${MONTHS_FULL.en[month]} ${day}, ${year}`;
}

const MONTH_NAME_TO_INDEX: Record<string, number> = MONTHS_FULL.en.reduce<Record<string, number>>((acc, name, i) => {
  acc[name.toLowerCase()] = i;
  return acc;
}, {});

/**
 * Localizes a backbone (month) section's auto-generated "Month YYYY" /
 * "Month–Month YYYY" label — the outline's own date-range formatter always
 * emits these in English regardless of `manifest.language` (a known
 * upstream-pipeline gap, same shape as `ordinals.ts`'s `extractYearOrdinal`:
 * parse the English label back into structure, then re-render it in the
 * book's own language). Used for BOTH the month segment's kicker/eyebrow
 * (`element.subtitle`, e.g. "October–November 2024") and, when a segment
 * has no special editorial title of its own, its plain month-name title
 * (`element.title`, e.g. "December 2024") — both come from the same
 * upstream formatter and share the same bug.
 *
 * Anything that doesn't match this exact "Month[–Month] YYYY" shape (a real
 * editorial title/kicker, e.g. "El mes en que cumpliste dos") is returned
 * completely untouched — this never risks garbling free-form text.
 */
export function localizeMonthLabel(label: string, lang: Language): string {
  const match = label.match(/^([A-Za-z]+)(?:[–-]([A-Za-z]+))?\s+(\d{4})$/);
  if (!match) return label;
  const [, startName, endName, year] = match;
  const startIdx = MONTH_NAME_TO_INDEX[startName.toLowerCase()];
  const endIdx = endName ? MONTH_NAME_TO_INDEX[endName.toLowerCase()] : undefined;
  if (startIdx == null || (endName && endIdx == null)) return label; // not actually a recognized month name — leave it alone
  if (lang === 'en') return label; // already the right language
  const months = MONTHS_FULL[lang];
  return endIdx != null ? `${months[startIdx]}–${months[endIdx]} ${year}` : `${months[startIdx]} ${year}`;
}
