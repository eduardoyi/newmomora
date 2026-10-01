import { describe, expect, it } from 'vitest';
import { ALL_FURNITURE, FURNITURE_LANGUAGES, getFurniture, getLanguage, numberWord } from '../furniture';
import { formatIndexDate, formatLongDate, formatPortraitDate, localizeMonthLabel, parseSingleMonthLabel } from '../common/formatDate';

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
      expect(f.dedication.scanInstruction.length).toBeGreaterThan(0);
      expect(f.scanToWatch.length).toBeGreaterThan(0);
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
    // Audio marks are badge-only now (no "escúchalo" script word) — see AudioNote.
    expect('listenToIt' in es).toBe(false);
  });

  it('dedication scan-instruction covers both video and audio (print-polish round, owner-approved copy)', () => {
    const es = getFurniture('es');
    expect(es.dedication.scanInstruction).toBe(
      'Cuando veas un código como este, escanéalo con la cámara de tu teléfono para ver o escuchar ese recuerdo.',
    );
    const en = getFurniture('en');
    expect(en.dedication.scanInstruction).toBe(
      "When you see a code like this, scan it with your phone's camera to watch or listen to that memory.",
    );
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

  it('localizes the cross-year range "Month YYYY – Month YYYY" (worker formatMonthRangeLabel shape) for es', () => {
    expect(localizeMonthLabel('December 2025 – January 2026', 'es')).toBe('diciembre 2025 – enero 2026');
    expect(localizeMonthLabel('September 2024 – March 2025', 'es')).toBe('septiembre 2024 – marzo 2025');
  });

  it('leaves the cross-year range unchanged for en', () => {
    expect(localizeMonthLabel('December 2025 – January 2026', 'en')).toBe('December 2025 – January 2026');
  });

  it('localizes every shape x language (single / same-year / cross-year)', () => {
    const cases: Array<[string, { en: string; es: string }]> = [
      ['March 2025', { en: 'March 2025', es: 'marzo 2025' }],
      ['March–May 2025', { en: 'March–May 2025', es: 'marzo–mayo 2025' }],
      ['November 2025 – February 2026', { en: 'November 2025 – February 2026', es: 'noviembre 2025 – febrero 2026' }],
    ];
    for (const [input, expected] of cases) {
      expect(localizeMonthLabel(input, 'en')).toBe(expected.en);
      expect(localizeMonthLabel(input, 'es')).toBe(expected.es);
    }
  });

  it('never garbles a cross-year lookalike whose words are not month names', () => {
    expect(localizeMonthLabel('Whenever 2025 – January 2026', 'es')).toBe('Whenever 2025 – January 2026');
    expect(localizeMonthLabel('December 2025 – Whenever 2026', 'es')).toBe('December 2025 – Whenever 2026');
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

describe('parseSingleMonthLabel — lone "Month YYYY" only', () => {
  it('parses a single English month label', () => {
    expect(parseSingleMonthLabel('December 2025')).toEqual({ monthIndex: 11, year: 2025 });
    expect(parseSingleMonthLabel('January 2026')).toEqual({ monthIndex: 0, year: 2026 });
  });

  it('returns null for same-year and cross-year ranges (no single month-end to age against)', () => {
    expect(parseSingleMonthLabel('October–November 2024')).toBeNull();
    expect(parseSingleMonthLabel('December 2025 – January 2026')).toBeNull();
  });

  it('returns null for editorial text and already-localized labels', () => {
    expect(parseSingleMonthLabel('El mes en que cumpliste dos')).toBeNull();
    expect(parseSingleMonthLabel('diciembre 2025')).toBeNull();
  });
});

describe('furniture — multi-year (everything scope) strings', () => {
  it('chapter titles and kickers, es', () => {
    const es = getFurniture('es').chapter;
    const titles = ['primer', 'segundo', 'tercer', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'];
    titles.forEach((w, i) => expect(es.title(i + 1)).toBe(`Tu ${w} año`));
    expect(es.title(11)).toBe('Tu 11.º año');
    expect(es.title(14)).toBe('Tu 14.º año');
    const kickers = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'];
    kickers.forEach((w, i) => expect(es.kicker(i + 1)).toBe(`capítulo ${w}`));
    expect(es.kicker(11)).toBe('capítulo 11');
  });

  it('chapter titles and kickers, en', () => {
    const en = getFurniture('en').chapter;
    const words = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
    words.forEach((w, i) => expect(en.title(i + 1)).toBe(`Year ${w}`));
    expect(en.title(11)).toBe('Year 11');
    words.forEach((w, i) => expect(en.kicker(i + 1)).toBe(`chapter ${w.toLowerCase()}`));
    expect(en.kicker(11)).toBe('chapter 11');
  });

  it('through-the-years multi-year variant', () => {
    expect(getFurniture('es').throughTheYearsMultiYear).toEqual({
      kicker: 'los años en retratos',
      titleLines: ['Cómo cambiaste', 'con los años'],
    });
    expect(getFurniture('en').throughTheYearsMultiYear).toEqual({
      kicker: 'the years in portraits',
      titleLines: ['How you changed', 'over the years'],
    });
  });

  it('closing multi-year headline and count line (range and single-year)', () => {
    const es = getFurniture('es').closing.multiYear;
    expect(es.headline).toBe('Y la historia continúa.');
    expect(es.memoryCountLine(487, '2022', '2026')).toBe('Este libro recoge 487 recuerdos, de 2022 a 2026.');
    expect(es.memoryCountLine(12, '2025', '2025')).toBe('Este libro recoge 12 recuerdos, de 2025.');
    const en = getFurniture('en').closing.multiYear;
    expect(en.headline).toBe('And the story continues.');
    expect(en.memoryCountLine(487, '2022', '2026')).toBe('This book holds 487 memories, from 2022 to 2026.');
    expect(en.memoryCountLine(12, '2025', '2025')).toBe('This book holds 12 memories, in 2025.');
  });

  it('single-year closing / through-the-years strings are unchanged', () => {
    expect(getFurniture('en').closing.headline).toBe('See you next year.');
    expect(getFurniture('en').throughTheYears.titleLines).toEqual(['How you changed', 'in twelve months']);
    expect(getFurniture('es').closing.memoryCountLine(3, 'Everything', null)).toBe('Este libro recoge 3 recuerdos de Everything.');
  });
});
