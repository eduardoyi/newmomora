import { assertEquals } from 'jsr:@std/assert@1';
import { getAgeInYearsAtDate, isAdultAtDate } from './age.ts';

Deno.test('isAdultAtDate treats 18+ as adult', () => {
  assertEquals(isAdultAtDate('1989-06-24', '2026-05-27'), true);
  assertEquals(isAdultAtDate('2022-10-23', '2026-05-27'), false);
});

Deno.test('getAgeInYearsAtDate returns whole years', () => {
  assertEquals(getAgeInYearsAtDate('1989-06-24', '2026-05-27'), 36);
  assertEquals(getAgeInYearsAtDate('2022-10-23', '2026-05-27'), 3);
});
