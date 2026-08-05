import { buildShareCardTempFilename } from './share-card-filename';

describe('buildShareCardTempFilename', () => {
  it('formats the date and a 6-char id fragment with dashes stripped', () => {
    expect(buildShareCardTempFilename('2026-06-08', '11111111-2222-3333-4444-555555555555'))
      .toBe('momora-jun-8-2026-111111.png');
  });

  it('does not zero-pad single-digit days/months (matches the server filename)', () => {
    expect(buildShareCardTempFilename('2026-01-01', 'abcdef12-0000-0000-0000-000000000000'))
      .toBe('momora-jan-1-2026-abcdef.png');
  });

  it('uses the last month of the year correctly', () => {
    expect(buildShareCardTempFilename('2026-12-25', 'ffffffff-0000-0000-0000-000000000000'))
      .toBe('momora-dec-25-2026-ffffff.png');
  });

  it('falls back to a generic date segment for an unparseable date', () => {
    expect(buildShareCardTempFilename('not-a-date', '11111111-0000-0000-0000-000000000000'))
      .toBe('momora-memory-111111.png');
  });

  it('falls back to a placeholder id fragment when the id has no non-dash characters', () => {
    expect(buildShareCardTempFilename('2026-06-08', '------')).toBe('momora-jun-8-2026-share.png');
  });

  it('uses the whole id when it is shorter than the fragment length', () => {
    expect(buildShareCardTempFilename('2026-06-08', 'ab')).toBe('momora-jun-8-2026-ab.png');
  });
});
