import {
  artifactMemories,
  formatMemoryDayLabel,
  paywallBackdropMemories,
  yearMemories,
} from '@/constants/onboarding-memories';

describe('formatMemoryDayLabel', () => {
  it('formats a date as "weekday, short month day"', () => {
    expect(formatMemoryDayLabel('2025-08-14')).toBe('Thu, Aug 14');
  });

  it('formats artifactMemories dates correctly', () => {
    expect(formatMemoryDayLabel('2025-07-22')).toBe('Tue, Jul 22');
    expect(formatMemoryDayLabel('2025-08-16')).toBe('Sat, Aug 16');
  });

  // 2026-07-01 is the case called out by the brief: naively parsing an
  // ISO date-only string with `new Date(isoDate)` treats it as UTC
  // midnight, which any timezone behind UTC (the Americas, for instance)
  // renders as the PREVIOUS calendar day (here, Jun 30 instead of Jul 1).
  // formatMemoryDayLabel must resolve to Jul 1 regardless of the host
  // machine's local timezone.
  it('does not shift the day for a date whose UTC/local difference could change the weekday', () => {
    expect(formatMemoryDayLabel('2026-07-01')).toBe('Wed, Jul 1');
  });

  it('is stable regardless of the runtime timezone', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14, the furthest-ahead real timezone
      expect(formatMemoryDayLabel('2026-07-01')).toBe('Wed, Jul 1');

      process.env.TZ = 'Etc/GMT+12'; // UTC-12, the furthest-behind real timezone
      expect(formatMemoryDayLabel('2026-07-01')).toBe('Wed, Jul 1');
    } finally {
      process.env.TZ = originalTz;
    }
  });
});

describe('artifactMemories', () => {
  it('has exactly 3 entries', () => {
    expect(artifactMemories).toHaveLength(3);
  });

  it('gives every entry an illustrated asset and a joy/tender/weary emotion', () => {
    for (const memory of artifactMemories) {
      expect(memory.type).toBe('illustrated');
      expect(memory.asset).toBeTruthy();
      expect(memory.emotion).toBeTruthy();
    }
  });

  it('has unique keys', () => {
    const keys = artifactMemories.map((memory) => memory.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('yearMemories', () => {
  it('has exactly 20 entries', () => {
    expect(yearMemories).toHaveLength(20);
  });

  it('has unique keys', () => {
    const keys = yearMemories.map((memory) => memory.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every non-text memory an asset', () => {
    for (const memory of yearMemories) {
      if (memory.type !== 'text') {
        expect(memory.asset).toBeTruthy();
      }
    }
  });

  it('gives every text memory no asset', () => {
    for (const memory of yearMemories) {
      if (memory.type === 'text') {
        expect(memory.asset).toBeUndefined();
      }
    }
  });

  it('gives every video memory a durationLabel', () => {
    for (const memory of yearMemories) {
      if (memory.type === 'video') {
        expect(memory.durationLabel).toBeTruthy();
      }
    }
  });

  it('gives no non-video memory a durationLabel', () => {
    for (const memory of yearMemories) {
      if (memory.type !== 'video') {
        expect(memory.durationLabel).toBeUndefined();
      }
    }
  });

  it('gives every entry non-empty text and a valid ISO date', () => {
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    for (const memory of yearMemories) {
      expect(memory.text.length).toBeGreaterThan(0);
      expect(memory.isoDate).toMatch(isoDatePattern);
    }
  });

  it('is ordered newest first', () => {
    const isoDates = yearMemories.map((memory) => memory.isoDate);
    const sortedDescending = [...isoDates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(isoDates).toEqual(sortedDescending);
  });
});

describe('paywallBackdropMemories', () => {
  it('has exactly 3 entries, all sourced from yearMemories', () => {
    expect(paywallBackdropMemories).toHaveLength(3);
    for (const memory of paywallBackdropMemories) {
      expect(yearMemories).toContain(memory);
    }
  });

  it('references the bath-mustache, goodnight-moon, and ladybug entries', () => {
    expect(paywallBackdropMemories.map((memory) => memory.key)).toEqual([
      'bath-mustache',
      'goodnight-moon',
      'ladybug',
    ]);
  });
});
