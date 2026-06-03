import { assertEquals } from 'jsr:@std/assert@1';
import {
  isNameMentionedInText,
  matchMemberIdsMentionedInText,
} from './member-mentions.ts';

Deno.test('isNameMentionedInText matches whole names only', () => {
  assertEquals(isNameMentionedInText('Ann had oatmeal', 'Ann'), true);
  assertEquals(isNameMentionedInText('We were planning breakfast', 'Ann'), false);
  assertEquals(isNameMentionedInText('Enzo and Mara did not want oatmeal', 'Enzo'), true);
  assertEquals(isNameMentionedInText('Enzo and Mara did not want oatmeal', 'Mara'), true);
});

Deno.test('isNameMentionedInText is case-insensitive', () => {
  assertEquals(isNameMentionedInText('emma laughed today', 'Emma'), true);
});

Deno.test('matchMemberIdsMentionedInText returns mentioned member ids', () => {
  const ids = matchMemberIdsMentionedInText('Enzo and Mara played', [
    { id: 'enzo-id', name: 'Enzo' },
    { id: 'mara-id', name: 'Mara', nicknames: ['Marita'] },
    { id: 'timmy-id', name: 'Timmy' },
  ]);

  assertEquals(ids, ['enzo-id', 'mara-id']);
});

Deno.test('matchMemberIdsMentionedInText matches nicknames with word boundaries', () => {
  const ids = matchMemberIdsMentionedInText('Marita was sleepy', [
    { id: 'mara-id', name: 'Mara', nicknames: ['Marita'] },
  ]);

  assertEquals(ids, ['mara-id']);
});
