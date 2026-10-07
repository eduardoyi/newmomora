import { keepsakeProductRoute, keepsakeRecapsRoute, keepsakesTabRoute, newMemoryRoute, yearFilmRoute } from '@/lib/routes';

// `newMemoryRoute` gained an optional `source` param
// (docs/plans/analytics-implementation.md WP3 item 1) so `memory_saved`
// (new-memory.tsx) can tell which entry point opened the composer.
describe('newMemoryRoute', () => {
  it('returns the plain string route when no source is given', () => {
    expect(newMemoryRoute()).toBe('/(app)/new-memory');
  });

  it('carries the source as a route param when given', () => {
    expect(newMemoryRoute('fab_timeline')).toEqual({
      pathname: '/(app)/new-memory',
      params: { source: 'fab_timeline' },
    });
    expect(newMemoryRoute('fab_calendar')).toEqual({
      pathname: '/(app)/new-memory',
      params: { source: 'fab_calendar' },
    });
    expect(newMemoryRoute('share_sheet')).toEqual({
      pathname: '/(app)/new-memory',
      params: { source: 'share_sheet' },
    });
    expect(newMemoryRoute('notification')).toEqual({
      pathname: '/(app)/new-memory',
      params: { source: 'notification' },
    });
  });
});

describe('year film routes', () => {
  it('builds the player route from a film id', () => {
    expect(yearFilmRoute('film-1')).toBe('/(app)/year-film/film-1');
  });

  it('builds the recaps grid route from a year', () => {
    expect(keepsakeRecapsRoute(2026)).toBe('/(app)/keepsakes/recaps/2026');
  });
});

describe('keepsake product routes', () => {
  it('builds the holiday card page route', () => {
    expect(keepsakeProductRoute('holiday-card')).toBe('/(app)/keepsakes/holiday-card');
  });

  it('builds the memory book page route, with an optional child', () => {
    expect(keepsakeProductRoute('memory-book')).toBe('/(app)/keepsakes/memory-book');
    expect(keepsakeProductRoute('memory-book', 'child 1')).toBe('/(app)/keepsakes/memory-book?memberId=child%201');
  });

  it('ignores a member id on the holiday card page', () => {
    expect(keepsakeProductRoute('holiday-card', 'child-1')).toBe('/(app)/keepsakes/holiday-card');
  });

  it('exposes the tab route used as the cold-start fallback', () => {
    expect(keepsakesTabRoute).toBe('/(app)/(tabs)/keepsakes');
  });
});
