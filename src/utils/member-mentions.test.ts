import {
  isNameMentionedInText,
  matchMemberIdsMentionedInText,
} from '@/utils/member-mentions';

describe('member-mentions', () => {
  it('matches whole names only', () => {
    expect(isNameMentionedInText('Ann had oatmeal', 'Ann')).toBe(true);
    expect(isNameMentionedInText('We were planning breakfast', 'Ann')).toBe(false);
    expect(isNameMentionedInText('Tomás and Lucía did not want oatmeal', 'Tomás')).toBe(true);
    expect(isNameMentionedInText('Tomás and Lucía did not want oatmeal', 'Lucía')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isNameMentionedInText('emma laughed today', 'Emma')).toBe(true);
  });

  it('returns mentioned member ids', () => {
    const ids = matchMemberIdsMentionedInText('Tomás and Lucía played', [
      { id: 'tomas-id', name: 'Tomás' },
      { id: 'lucia-id', name: 'Lucía', nicknames: ['Lucita'] },
      { id: 'timmy-id', name: 'Timmy' },
    ]);

    expect(ids).toEqual(['tomas-id', 'lucia-id']);
  });

  it('matches nicknames with word boundaries', () => {
    const ids = matchMemberIdsMentionedInText('Lucita was sleepy', [
      { id: 'lucia-id', name: 'Lucía', nicknames: ['Lucita'] },
    ]);

    expect(ids).toEqual(['lucia-id']);
  });
});
