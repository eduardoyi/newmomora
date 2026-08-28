import { describe, expect, it } from 'vitest';
import { ALL_FURNITURE, FURNITURE_LANGUAGES, getFurniture, getLanguage, numberWord } from '../furniture';
import { formatIndexDate, formatLongDate, formatPortraitDate, localizeMonthLabel } from '../common/formatDate';

/** Replaces every function value with a stable marker so two objects can be
 * compared structurally (key paths + leaf *shape*, not function identity). */
function shapeOf(value: unknown): unknown {
  if (typeof value === 'function') return '<fn>';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = shapeOf((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return typeof value;
}

describe('furniture — table completeness', () => {
  it('has exactly the same key shape in every language', () => {
    const [first, ...rest] = FURNITURE_LANGUAGES;
    const reference = shapeOf(ALL_FURNITURE[first]);
    for (const lang of rest) {
      expect(shapeOf(ALL_FURNITURE[lang])).toEqual(reference);
    }
  });

  it('every furniture string is non-empty for every language', () => {
    for (const lang of FURNITURE_LANGUAGES) {
      const f = getFurniture(lang);
      expect(f.throughTheYears.kicker.length).toBeGreaterThan(0);
      expect(f.throughTheYears.titleLines[0].length).toBeGreaterThan(0);
      expect(f.throughTheYears.titleLines[1].length).toBeGreaterThan(0);
      expect(f.dedication.greeting('Enzo').length).toBeGreaterThan(0);
      expect(f.dedication.signature.length).toBeGreaterThan(0);
      expect(f.scanToWatch.length).toBeGreaterThan(0);
      expect(f.listenToIt.length).toBeGreaterThan(0);
      expect(f.firsts.kicker.length).toBeGreaterThan(0);
      expect(f.closing.headline.length).toBeGreaterThan(0);
      expect(f.closing.memoryCountLine(10, 'Year One', null).length).toBeGreaterThan(0);
    }
  });

  it('getLanguage defaults to "en" when manifest.language is absent, and follows "es" when set', () => {
    expect(getLanguage({})).toBe('en');
    expect(getLanguage({ language: undefined })).toBe('en');
    expect(getLanguage({ language: 'es' })).toBe('es');
    expect(getLanguage({ language: 'en' })).toBe('en');
  });
});

describe('furniture — Spanish strings match the design canvas verbatim', () => {
  it('through-the-years', () => {
    const es = getFurniture('es');
    expect(es.throughTheYears.kicker).toBe('un año en retratos');
    expect(es.throughTheYears.titleLines).toEqual(['Cómo cambiaste', 'en doce meses']);
  });

  it('dedication', () => {
    const es = getFurniture('es');
    expect(es.dedication.greeting('Enzo')).toBe('Para Enzo,');
    // Generic, not "mami y papi" (owner review round 3 — the household
    // writing it isn't always that shape).
    expect(es.dedication.signature).toBe('Escrito con amor, día a día');
  });

  it('scan-mark microcopy', () => {
    const es = getFurniture('es');
    expect(es.scanToWatch).toBe('escanea para verlo');
    expect(es.listenToIt).toBe('escúchalo');
  });

  it('firsts kicker', () => {
    expect(getFurniture('es').firsts.kicker).toBe('primeras veces');
  });

  it('closing headline', () => {
    expect(getFurniture('es').closing.headline).toBe('Hasta el año que viene.');
  });

  it('closing memory-count line matches the owner review round 3 template exactly: "Este libro recoge [X] recuerdos de tu tercer año."', () => {
    expect(getFurniture('es').closing.memoryCountLine(42, 'Year Three', 3)).toBe(
      'Este libro recoge 42 recuerdos de tu tercer año.',
    );
  });

  it('closing memory-count line falls back to the neutral scope label when no year ordinal is extractable', () => {
    expect(getFurniture('es').closing.memoryCountLine(42, 'un año especial', null)).toBe(
      'Este libro recoge 42 recuerdos de un año especial.',
    );
  });
});

describe('furniture — spread-title attribution pattern', () => {
  it('spells the moment count in words (es): "Enzo, 10 de agosto de 2025 — seis momentos"', () => {
    const es = getFurniture('es');
    const dateStr = formatLongDate('2025-08-10', 'es');
    expect(dateStr).toBe('10 de agosto de 2025');
    expect(es.spreadTitleAttribution('Enzo', dateStr, 6)).toBe('Enzo, 10 de agosto de 2025 — seis momentos');
  });

  it('spells the moment count in words (en)', () => {
    const en = getFurniture('en');
    const dateStr = formatLongDate('2025-08-10', 'en');
    expect(dateStr).toBe('August 10, 2025');
    expect(en.spreadTitleAttribution('Enzo', dateStr, 6)).toBe('Enzo, August 10, 2025 — six moments');
  });

  it('omits the moment count entirely at 1 (no "un momento" invented)', () => {
    expect(getFurniture('es').spreadTitleAttribution('Enzo', '10 de agosto de 2025', 1)).toBe('Enzo, 10 de agosto de 2025');
    expect(getFurniture('en').spreadTitleAttribution('Enzo', 'August 10, 2025', 1)).toBe('Enzo, August 10, 2025');
  });

  it('falls back to digits past the spelled-out range (0-10)', () => {
    expect(numberWord(11, 'es')).toBe('11');
    expect(numberWord(11, 'en')).toBe('11');
    expect(numberWord(0, 'es')).toBe('cero');
    expect(numberWord(10, 'en')).toBe('ten');
  });
});

describe('date formatting per role and language', () => {
  const ISO = '2024-12-12';

  it('formatIndexDate: "23 oct" (es, no year) / "Oct 23" (en, no year)', () => {
    expect(formatIndexDate('2024-10-23', 'es')).toBe('23 oct');
    expect(formatIndexDate('2024-10-23', 'en')).toBe('Oct 23');
  });

  it('formatLongDate: "10 de agosto de 2025" (es) / "August 10, 2025" (en)', () => {
    expect(formatLongDate('2025-08-10', 'es')).toBe('10 de agosto de 2025');
    expect(formatLongDate('2025-08-10', 'en')).toBe('August 10, 2025');
  });

  it('formatPortraitDate: "12 diciembre 2024" (es, no "de") / "December 12, 2024" (en)', () => {
    expect(formatPortraitDate(ISO, 'es')).toBe('12 diciembre 2024');
    expect(formatPortraitDate(ISO, 'en')).toBe('December 12, 2024');
  });

  it('is stable across a full 12-month cycle (no off-by-one month index bugs)', () => {
    const esMonths = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
    ];
    for (let m = 0; m < 12; m++) {
      const iso = `2024-${String(m + 1).padStart(2, '0')}-05`;
      expect(formatLongDate(iso, 'es')).toBe(`5 de ${esMonths[m]} de 2024`);
    }
  });

  it('returns the raw string for an invalid date rather than throwing', () => {
    expect(formatLongDate('not-a-date', 'es')).toBe('not-a-date');
    expect(formatIndexDate('not-a-date', 'en')).toBe('not-a-date');
    expect(formatPortraitDate('not-a-date', 'en')).toBe('not-a-date');
  });
});

describe('localizeMonthLabel — backbone month-section eyebrow/title (English-only upstream formatter)', () => {
  it('localizes a two-month range for es', () => {
    expect(localizeMonthLabel('October–November 2024', 'es')).toBe('octubre–noviembre 2024');
  });

  it('localizes a single month for es', () => {
    expect(localizeMonthLabel('December 2024', 'es')).toBe('diciembre 2024');
  });

  it('leaves an en label unchanged (already the right language)', () => {
    expect(localizeMonthLabel('October–November 2024', 'en')).toBe('October–November 2024');
    expect(localizeMonthLabel('December 2024', 'en')).toBe('December 2024');
  });

  it('is stable across a full 12-month cycle for both single months and ranges', () => {
    const enMonths = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const esMonths = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
    ];
    for (let m = 0; m < 12; m++) {
      expect(localizeMonthLabel(`${enMonths[m]} 2025`, 'es')).toBe(`${esMonths[m]} 2025`);
      const next = (m + 1) % 12;
      expect(localizeMonthLabel(`${enMonths[m]}–${enMonths[next]} 2025`, 'es')).toBe(`${esMonths[m]}–${esMonths[next]} 2025`);
    }
  });

  it('never touches genuine editorial text that only happens to contain a real word', () => {
    // Real backbone/themed titles and kickers from the outline generator —
    // none of these match the exact "Month[–Month] YYYY" shape, so the
    // localizer must return them byte-for-byte untouched.
    expect(localizeMonthLabel('El mes en que cumpliste dos', 'es')).toBe('El mes en que cumpliste dos');
    expect(localizeMonthLabel('lo que nos hiciste reír', 'es')).toBe('lo que nos hiciste reír');
    expect(localizeMonthLabel('Ay Dios mío', 'es')).toBe('Ay Dios mío');
  });

  it('never garbles a string that merely looks close to the pattern but is not a real month name', () => {
    expect(localizeMonthLabel('Whenever 2024', 'es')).toBe('Whenever 2024');
  });
});
