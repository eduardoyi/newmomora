import {
  keepsakeProductRoute,
  keepsakeRecapsRoute,
  keepsakesTabRoute,
  newMemoryRoute,
  parseNewMemoryAction,
  yearFilmRoute,
} from '@/lib/routes';

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

describe('newMemoryRoute with a shortcut action', () => {
  it('carries action and actionId alongside the source', () => {
    expect(newMemoryRoute('shortcut_voice', { action: 'voice', actionId: 'a1' })).toEqual({
      pathname: '/(app)/new-memory',
      params: { source: 'shortcut_voice', action: 'voice', actionId: 'a1' },
    });
  });

  it('carries an action without a source', () => {
    expect(newMemoryRoute(undefined, { action: 'scan', actionId: 'a2' })).toEqual({
      pathname: '/(app)/new-memory',
      params: { action: 'scan', actionId: 'a2' },
    });
  });
});

describe('parseNewMemoryAction', () => {
  it('accepts the four known actions', () => {
    expect(parseNewMemoryAction('text')).toBe('text');
    expect(parseNewMemoryAction('photo')).toBe('photo');
    expect(parseNewMemoryAction('voice')).toBe('voice');
    expect(parseNewMemoryAction('scan')).toBe('scan');
  });

  it('rejects unknown, empty and non-string values', () => {
    expect(parseNewMemoryAction('video')).toBeUndefined();
    expect(parseNewMemoryAction('')).toBeUndefined();
    expect(parseNewMemoryAction(undefined)).toBeUndefined();
    expect(parseNewMemoryAction(['voice'])).toBeUndefined();
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
