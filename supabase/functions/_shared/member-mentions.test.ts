import { assertEquals } from 'jsr:@std/assert@1';
import {
  isNameMentionedInText,
  matchMemberIdsMentionedInText,
} from './member-mentions.ts';

Deno.test('isNameMentionedInText matches whole names only', () => {
  assertEquals(isNameMentionedInText('Ann had oatmeal', 'Ann'), true);
  assertEquals(isNameMentionedInText('We were planning breakfast', 'Ann'), false);
  assertEquals(isNameMentionedInText('Tomás and Lucía did not want oatmeal', 'Tomás'), true);
  assertEquals(isNameMentionedInText('Tomás and Lucía did not want oatmeal', 'Lucía'), true);
});

Deno.test('isNameMentionedInText is case-insensitive', () => {
  assertEquals(isNameMentionedInText('emma laughed today', 'Emma'), true);
});

Deno.test('matchMemberIdsMentionedInText returns mentioned member ids', () => {
  const ids = matchMemberIdsMentionedInText('Tomás and Lucía played', [
    { id: 'tomas-id', name: 'Tomás' },
    { id: 'lucia-id', name: 'Lucía', nicknames: ['Lucita'] },
    { id: 'timmy-id', name: 'Timmy' },
  ]);

  assertEquals(ids, ['tomas-id', 'lucia-id']);
});

Deno.test('matchMemberIdsMentionedInText matches nicknames with word boundaries', () => {
  const ids = matchMemberIdsMentionedInText('Lucita was sleepy', [
    { id: 'lucia-id', name: 'Lucía', nicknames: ['Lucita'] },
  ]);

  assertEquals(ids, ['lucia-id']);
});
