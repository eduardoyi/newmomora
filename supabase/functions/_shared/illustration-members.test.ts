import { assertEquals } from 'jsr:@std/assert@1';
import { resolveMemberIdsForIllustration } from './illustration-members.ts';

Deno.test('resolveMemberIdsForIllustration keeps explicit tags', () => {
  const ids = resolveMemberIdsForIllustration(
    ['11111111-1111-4111-8111-111111111111'],
    'Enzo ate oatmeal',
    [{ id: '22222222-2222-4222-8222-222222222222', name: 'Mara' }],
  );

  assertEquals(ids, ['11111111-1111-4111-8111-111111111111']);
});

Deno.test('resolveMemberIdsForIllustration infers members mentioned in content', () => {
  const ids = resolveMemberIdsForIllustration(
    [],
    'Enzo and Mara did not want oatmeal',
    [
      { id: 'enzo-id', name: 'Enzo' },
      { id: 'mara-id', name: 'Mara', nicknames: ['Marita'] },
      { id: 'timmy-id', name: 'Timmy' },
    ],
  );

  assertEquals(ids, ['enzo-id', 'mara-id']);
});

Deno.test('resolveMemberIdsForIllustration ignores substring false positives', () => {
  const ids = resolveMemberIdsForIllustration(
    [],
    'We were planning breakfast',
    [{ id: 'ann-id', name: 'Ann' }],
  );

  assertEquals(ids, []);
});
