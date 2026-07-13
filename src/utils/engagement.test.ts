import { formatEngagementTimestamp } from './engagement';

describe('formatEngagementTimestamp', () => {
  const now = new Date('2026-07-13T12:00:00Z');

  it.each([
    ['2026-07-13T11:59:30Z', 'now'],
    ['2026-07-13T11:42:00Z', '18m'],
    ['2026-07-13T08:00:00Z', '4h'],
    ['2026-07-10T12:00:00Z', '3d'],
  ])('formats recent timestamp %s as %s', (timestamp, expected) => {
    expect(formatEngagementTimestamp(timestamp, now)).toBe(expected);
  });

  it('switches to a calendar date after one week', () => {
    expect(formatEngagementTimestamp('2026-07-01T12:00:00Z', now)).toContain('Jul');
  });

  it('includes the year for older calendar years', () => {
    expect(formatEngagementTimestamp('2025-12-01T12:00:00Z', now)).toContain('2025');
  });
});
