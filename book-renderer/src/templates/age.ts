import type { Language } from './furniture';

/**
 * Age labels ("2 years and 9 months old" / "2 años y 9 meses") are
 * furniture-adjacent text the renderer computes and localizes itself
 * (owner decision, visual-review round 2) — never trusted verbatim from
 * the manifest's own `ageLabel` field, which is always written in English.
 */

export interface AgeMonths {
  years: number;
  months: number;
}

/** Exact age-at-date from a child's date of birth, using UTC calendar math (no timezone drift). */
export function ageAtDate(dob: string, at: string): AgeMonths | null {
  const d0 = new Date(dob);
  const d1 = new Date(at);
  if (Number.isNaN(d0.getTime()) || Number.isNaN(d1.getTime())) return null;
  let years = d1.getUTCFullYear() - d0.getUTCFullYear();
  let months = d1.getUTCMonth() - d0.getUTCMonth();
  if (d1.getUTCDate() < d0.getUTCDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) return null;
  return { years, months };
}

/**
 * Defensive fallback when no date of birth is available: parses the
 * manifest's own English `ageLabel` ("2 years and 9 months old", "5 months
 * old", "1 year old") back into {years, months} so it can be re-rendered
 * in the target language. Returns null when neither unit is found.
 */
export function parseAgeLabel(label: string): AgeMonths | null {
  const yearsMatch = /(\d+)\s*years?/i.exec(label);
  const monthsMatch = /(\d+)\s*months?/i.exec(label);
  if (!yearsMatch && !monthsMatch) return null;
  return {
    years: yearsMatch ? Number(yearsMatch[1]) : 0,
    months: monthsMatch ? Number(monthsMatch[1]) : 0,
  };
}

/** "2 años y 9 meses" (es, matches the design canvas's through-the-years captions) / "2 years and 9 months old" (en). */
export function formatAge({ years, months }: AgeMonths, lang: Language): string {
  if (lang === 'es') {
    const yearsPart = years > 0 ? `${years} ${years === 1 ? 'año' : 'años'}` : '';
    const monthsPart = months > 0 ? `${months} ${months === 1 ? 'mes' : 'meses'}` : '';
    if (yearsPart && monthsPart) return `${yearsPart} y ${monthsPart}`;
    return yearsPart || monthsPart || '0 meses';
  }
  const yearsPart = years > 0 ? `${years} ${years === 1 ? 'year' : 'years'}` : '';
  const monthsPart = months > 0 ? `${months} ${months === 1 ? 'month' : 'months'}` : '';
  const core = yearsPart && monthsPart ? `${yearsPart} and ${monthsPart}` : yearsPart || monthsPart || '0 months';
  return `${core} old`;
}

/**
 * The portrait strip's age label: prefers exact DOB-based math when the
 * manifest has it, otherwise parses+relocalizes the manifest's own English
 * label, otherwise (unparseable) falls back to the raw label untouched —
 * better a stray English label on a malformed input than a blank caption.
 */
export function localizedAgeLabel(
  params: { ageLabel: string; date: string; dateOfBirth?: string | null },
  lang: Language,
): string {
  if (params.dateOfBirth) {
    const age = ageAtDate(params.dateOfBirth, params.date);
    if (age) return formatAge(age, lang);
  }
  const parsed = parseAgeLabel(params.ageLabel);
  if (parsed) return formatAge(parsed, lang);
  return params.ageLabel;
}
