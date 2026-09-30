import { upcomingRecapLabel } from '@/components/keepsakes/upcoming-recap-card';

describe('upcomingRecapLabel', () => {
  it('names the month in progress and the next 1st', () => {
    expect(upcomingRecapLabel('2026-10-15')).toBe('October recap · Nov 1');
    expect(upcomingRecapLabel('2026-01-01')).toBe('January recap · Feb 1');
    expect(upcomingRecapLabel('2026-02-28')).toBe('February recap · Mar 1');
  });

  it('rolls December over to Jan 1', () => {
    expect(upcomingRecapLabel('2026-12-31')).toBe('December recap · Jan 1');
  });
});
