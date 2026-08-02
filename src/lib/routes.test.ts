import { newMemoryRoute } from '@/lib/routes';

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
