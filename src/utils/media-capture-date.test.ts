import { deriveSuggestedMemoryDate, extractCaptureDateIso } from './media-capture-date';

describe('extractCaptureDateIso', () => {
  const TODAY = '2024-06-15';

  describe('input shape', () => {
    it('returns null for null', () => {
      expect(extractCaptureDateIso(null, TODAY)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(extractCaptureDateIso(undefined, TODAY)).toBeNull();
    });

    it('returns null for an array (even one containing exif-like objects)', () => {
      expect(extractCaptureDateIso([{ DateTimeOriginal: '2024:06:01 10:00:00' }], TODAY)).toBeNull();
    });

    it('returns null for primitive types', () => {
      expect(extractCaptureDateIso('2024:06:01 10:00:00', TODAY)).toBeNull();
      expect(extractCaptureDateIso(42, TODAY)).toBeNull();
      expect(extractCaptureDateIso(true, TODAY)).toBeNull();
    });

    it('ignores a nested { Exif: {...} } shape (contract drift guard) -- flat keys only', () => {
      expect(
        extractCaptureDateIso({ Exif: { DateTimeOriginal: '2024:06:01 10:00:00' } }, TODAY),
      ).toBeNull();
    });

    it('reads a flat top-level object as the confirmed platform shape', () => {
      expect(
        extractCaptureDateIso({ DateTimeOriginal: '2024:06:01 10:00:00' }, TODAY),
      ).toBe('2024-06-01');
    });
  });

  describe('key priority and fallback', () => {
    it('prefers DateTimeOriginal over DateTimeDigitized and DateTime', () => {
      expect(
        extractCaptureDateIso(
          {
            DateTimeOriginal: '2024:06:01 10:00:00',
            DateTimeDigitized: '2024:06:02 10:00:00',
            DateTime: '2024:06:03 10:00:00',
          },
          TODAY,
        ),
      ).toBe('2024-06-01');
    });

    it('falls back to DateTimeDigitized when DateTimeOriginal is absent', () => {
      expect(
        extractCaptureDateIso(
          { DateTimeDigitized: '2024:06:02 10:00:00', DateTime: '2024:06:03 10:00:00' },
          TODAY,
        ),
      ).toBe('2024-06-02');
    });

    it('falls back to DateTime when only DateTime is present', () => {
      expect(extractCaptureDateIso({ DateTime: '2024:06:03 10:00:00' }, TODAY)).toBe('2024-06-03');
    });

    it('falls through to DateTimeDigitized when DateTimeOriginal is present but invalid', () => {
      expect(
        extractCaptureDateIso(
          { DateTimeOriginal: '2024:02:31 10:00:00', DateTimeDigitized: '2024:06:02 10:00:00' },
          TODAY,
        ),
      ).toBe('2024-06-02');
    });

    it('falls through past an invalid DateTimeOriginal and invalid DateTimeDigitized to a valid DateTime', () => {
      expect(
        extractCaptureDateIso(
          {
            DateTimeOriginal: 'garbage',
            DateTimeDigitized: '0000:00:00 00:00:00',
            DateTime: '2024:06:03 10:00:00',
          },
          TODAY,
        ),
      ).toBe('2024-06-03');
    });

    it('returns null when no key is present', () => {
      expect(extractCaptureDateIso({ Make: 'Apple' }, TODAY)).toBeNull();
    });

    it('returns null when every candidate is invalid', () => {
      expect(
        extractCaptureDateIso(
          {
            DateTimeOriginal: 'garbage',
            DateTimeDigitized: '2024:02:31 10:00:00',
            DateTime: '0000:00:00 00:00:00',
          },
          TODAY,
        ),
      ).toBeNull();
    });
  });

  describe('colon-format parsing without Date-string coercion', () => {
    it('does not accept ISO/slash forms that Date() would parse but EXIF never emits', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024-06-01T10:00:00' }, TODAY)).toBeNull();
      expect(extractCaptureDateIso({ DateTimeOriginal: '06/01/2024 10:00:00' }, TODAY)).toBeNull();
    });

    it('rejects a value missing the time-of-day portion', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:06:01' }, TODAY)).toBeNull();
    });
  });

  describe('whitespace / NUL padding', () => {
    it('trims trailing NUL padding from a fixed-length EXIF ASCII field', () => {
      expect(
        extractCaptureDateIso(
          { DateTimeOriginal: '2024:06:01 10:00:00\u0000\u0000\u0000' },
          TODAY,
        ),
      ).toBe('2024-06-01');
    });

    it('trims surrounding whitespace', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '  2024:06:01 10:00:00  ' }, TODAY)).toBe(
        '2024-06-01',
      );
    });
  });

  describe('invalid types and malformed strings', () => {
    it('rejects null and undefined values for a key', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: null }, TODAY)).toBeNull();
      expect(extractCaptureDateIso({ DateTimeOriginal: undefined }, TODAY)).toBeNull();
    });

    it('rejects a non-string value for a key (number, array)', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: 20240601 }, TODAY)).toBeNull();
      expect(extractCaptureDateIso({ DateTimeOriginal: ['2024:06:01 10:00:00'] }, TODAY)).toBeNull();
    });

    it('rejects a malformed string', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: 'not-a-date' }, TODAY)).toBeNull();
    });

    it('rejects zero fields', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '0000:00:00 00:00:00' }, TODAY)).toBeNull();
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:00:01 10:00:00' }, TODAY)).toBeNull();
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:06:00 10:00:00' }, TODAY)).toBeNull();
    });

    it('rejects an invalid month', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:13:01 10:00:00' }, TODAY)).toBeNull();
    });

    it('rejects an invalid day for the given month', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:04:31 10:00:00' }, TODAY)).toBeNull();
    });

    it('rejects Feb 29 on a non-leap year', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2023:02:29 10:00:00' }, TODAY)).toBeNull();
    });

    it('accepts Feb 29 on a leap year', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:02:29 10:00:00' }, TODAY)).toBe(
        '2024-02-29',
      );
    });

    it('rejects a year before 1900', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '1899:12:31 10:00:00' }, TODAY)).toBeNull();
    });

    it('accepts a year exactly at the 1900 floor', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '1900:01:01 10:00:00' }, '1900-01-01')).toBe(
        '1900-01-01',
      );
    });
  });

  describe('deterministic today / today+1 tolerance', () => {
    it('accepts a capture date equal to today', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:06:15 10:00:00' }, TODAY)).toBe(
        '2024-06-15',
      );
    });

    it('accepts a capture date at today + 1 day', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:06:16 10:00:00' }, TODAY)).toBe(
        '2024-06-16',
      );
    });

    it('rejects a capture date at today + 2 days', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:06:17 10:00:00' }, TODAY)).toBeNull();
    });

    it('does not clamp an accepted future date to today', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:06:16 23:59:59' }, TODAY)).toBe(
        '2024-06-16',
      );
    });

    it('rolls the +1 tolerance across a month boundary', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:07:01 10:00:00' }, '2024-06-30')).toBe(
        '2024-07-01',
      );
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:07:02 10:00:00' }, '2024-06-30')).toBeNull();
    });

    it('rolls the +1 tolerance across a year boundary', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2025:01:01 10:00:00' }, '2024-12-31')).toBe(
        '2025-01-01',
      );
      expect(extractCaptureDateIso({ DateTimeOriginal: '2025:01:02 10:00:00' }, '2024-12-31')).toBeNull();
    });

    it('rolls the +1 tolerance across a leap-day boundary', () => {
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:02:29 10:00:00' }, '2024-02-28')).toBe(
        '2024-02-29',
      );
      expect(extractCaptureDateIso({ DateTimeOriginal: '2024:03:01 10:00:00' }, '2024-02-28')).toBeNull();
    });

    it('falls closed (rejects every candidate) when the injected todayIso is itself invalid', () => {
      expect(
        extractCaptureDateIso({ DateTimeOriginal: '2024:06:15 10:00:00' }, 'not-a-date'),
      ).toBeNull();
      expect(
        extractCaptureDateIso({ DateTimeOriginal: '2024:06:15 10:00:00' }, '2024-02-30'),
      ).toBeNull();
    });

    it('defaults todayIso to the current local date when omitted', () => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      expect(extractCaptureDateIso({ DateTimeOriginal: `${year}:${month}:${day} 09:00:00` })).toBe(
        `${year}-${month}-${day}`,
      );
    });
  });
});

describe('deriveSuggestedMemoryDate', () => {
  it('returns null for an empty list', () => {
    expect(deriveSuggestedMemoryDate([])).toBeNull();
  });

  it('returns null when no attachment has a capturedAtIso', () => {
    expect(deriveSuggestedMemoryDate([{}, {}])).toBeNull();
  });

  it('returns the single valid date', () => {
    expect(deriveSuggestedMemoryDate([{ capturedAtIso: '2024-06-01' }])).toBe('2024-06-01');
  });

  it('returns the earliest valid date across multiple attachments', () => {
    expect(
      deriveSuggestedMemoryDate([
        { capturedAtIso: '2024-06-05' },
        { capturedAtIso: '2024-06-01' },
        { capturedAtIso: '2024-06-10' },
      ]),
    ).toBe('2024-06-01');
  });

  it('finds the earliest date when a non-dated attachment comes first', () => {
    expect(
      deriveSuggestedMemoryDate([{}, { capturedAtIso: '2024-06-01' }]),
    ).toBe('2024-06-01');
  });

  it('finds the earliest date when a non-dated attachment comes second', () => {
    expect(
      deriveSuggestedMemoryDate([{ capturedAtIso: '2024-06-01' }, {}]),
    ).toBe('2024-06-01');
  });

  it('ignores an invalid capturedAtIso and still returns the earliest valid one', () => {
    expect(
      deriveSuggestedMemoryDate([
        { capturedAtIso: '2024-02-30' },
        { capturedAtIso: '2024-06-01' },
        { capturedAtIso: 'not-a-date' },
      ]),
    ).toBe('2024-06-01');
  });

  it('ignores video/mixed attachments without a capturedAtIso', () => {
    expect(
      deriveSuggestedMemoryDate([
        { capturedAtIso: undefined },
        { capturedAtIso: '2024-06-03' },
        { capturedAtIso: undefined },
      ]),
    ).toBe('2024-06-03');
  });

  it('returns null when every capturedAtIso is invalid', () => {
    expect(
      deriveSuggestedMemoryDate([{ capturedAtIso: 'garbage' }, { capturedAtIso: '2024-13-01' }]),
    ).toBeNull();
  });
});
