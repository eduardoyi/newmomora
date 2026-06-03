import {
  isNameMentionedInText,
  matchMemberIdsMentionedInText,
} from '@/utils/member-mentions';

describe('member-mentions', () => {
  it('matches whole names only', () => {
    expect(isNameMentionedInText('Ann had oatmeal', 'Ann')).toBe(true);
    expect(isNameMentionedInText('We were planning breakfast', 'Ann')).toBe(false);
    expect(isNameMentionedInText('Enzo and Mara did not want oatmeal', 'Enzo')).toBe(true);
    expect(isNameMentionedInText('Enzo and Mara did not want oatmeal', 'Mara')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isNameMentionedInText('emma laughed today', 'Emma')).toBe(true);
  });

  it('returns mentioned member ids', () => {
    const ids = matchMemberIdsMentionedInText('Enzo and Mara played', [
      { id: 'enzo-id', name: 'Enzo' },
      { id: 'mara-id', name: 'Mara', nicknames: ['Marita'] },
      { id: 'timmy-id', name: 'Timmy' },
    ]);

    expect(ids).toEqual(['enzo-id', 'mara-id']);
  });

  it('matches nicknames with word boundaries', () => {
    const ids = matchMemberIdsMentionedInText('Marita was sleepy', [
      { id: 'mara-id', name: 'Mara', nicknames: ['Marita'] },
    ]);

    expect(ids).toEqual(['mara-id']);
  });
});
