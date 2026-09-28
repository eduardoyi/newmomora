import { EMPTY_WHOS_WHO_DISMISSAL, newestSuggestionAt, whosWhoCardKind } from './whos-who-card';

const base = {
  canEdit: true,
  suggestions: [] as { created_at: string }[],
  isLinked: true,
  notInList: false,
  hasLinkableMember: true,
  dismissal: EMPTY_WHOS_WHO_DISMISSAL,
};

describe('whosWhoCardKind', () => {
  it('shows suggestions to owners/managers until dismissed, and returns on newer ones', () => {
    const suggestions = [{ created_at: '2026-09-28T10:00:00Z' }, { created_at: '2026-09-28T11:00:00Z' }];
    expect(whosWhoCardKind({ ...base, suggestions })).toBe('suggestions');
    expect(whosWhoCardKind({ ...base, suggestions, canEdit: false })).toBeNull();
    const dismissed = { suggestionsSeenAt: '2026-09-28T11:00:00Z', selfPromptDismissed: false };
    expect(whosWhoCardKind({ ...base, suggestions, dismissal: dismissed })).toBeNull();
    const newer = [...suggestions, { created_at: '2026-09-29T09:00:00Z' }];
    expect(whosWhoCardKind({ ...base, suggestions: newer, dismissal: dismissed })).toBe('suggestions');
  });

  it('asks unlinked accounts (any role) which one they are', () => {
    expect(whosWhoCardKind({ ...base, isLinked: false, canEdit: false })).toBe('self');
    expect(whosWhoCardKind({ ...base, isLinked: false, notInList: true })).toBeNull();
    expect(whosWhoCardKind({ ...base, isLinked: false, hasLinkableMember: false })).toBeNull();
    expect(
      whosWhoCardKind({ ...base, isLinked: false, dismissal: { suggestionsSeenAt: null, selfPromptDismissed: true } }),
    ).toBeNull();
  });

  it('is quiet when everything is sorted', () => {
    expect(whosWhoCardKind(base)).toBeNull();
  });
});

describe('newestSuggestionAt', () => {
  it('returns the max created_at or null', () => {
    expect(newestSuggestionAt([])).toBeNull();
    expect(newestSuggestionAt([{ created_at: 'b' }, { created_at: 'c' }, { created_at: 'a' }])).toBe('c');
  });
});
