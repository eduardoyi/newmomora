import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildMemberIllustrationDescription,
  prepareIllustrationReferences,
  sortMembersByTagOrder,
} from './illustration-references.ts';

Deno.test('sortMembersByTagOrder preserves tag order', () => {
  const sorted = sortMembersByTagOrder(
    [
      { id: 'mara-id', name: 'Mara' },
      { id: 'enzo-id', name: 'Enzo' },
    ],
    ['enzo-id', 'mara-id'],
  );

  assertEquals(sorted.map((member) => member.id), ['enzo-id', 'mara-id']);
});

Deno.test('buildMemberIllustrationDescription includes age, gender, and additional guidance', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'enzo-id',
      name: 'Enzo',
      date_of_birth: '2022-10-01',
      gender: 'Male',
      additional_info: 'He has curly brown hair',
      illustrated_profile_key: 'user/family/enzo/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(
    description,
    'Enzo (3 years and 7 months old, Male). Additional guidance: He has curly brown hair.',
  );
});

Deno.test('buildMemberIllustrationDescription omits additional guidance when absent', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'enzo-id',
      name: 'Enzo',
      date_of_birth: '2022-10-01',
      gender: 'Male',
      additional_info: null,
      illustrated_profile_key: 'user/family/enzo/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description, 'Enzo (3 years and 7 months old, Male)');
});

Deno.test('buildMemberIllustrationDescription never leaks a nickname alias into the description', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'mara-id',
      name: 'Mara',
      nicknames: ['Marita'],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/mara/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description, 'Mara (1 year and 6 months old, Female)');
  assertEquals(description.includes('May appear in the memory as:'), false);
  assertEquals(description.includes('Marita'), false);
});

Deno.test('buildMemberIllustrationDescription never leaks multiple nickname aliases into the description', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'mara-id',
      name: 'Mara',
      nicknames: ['Marita', 'Mimi'],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/mara/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description.includes('May appear in the memory as:'), false);
  assertEquals(description.includes('Marita'), false);
  assertEquals(description.includes('Mimi'), false);
});

Deno.test('buildMemberIllustrationDescription omits nickname aliases when absent', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'mara-id',
      name: 'Mara',
      nicknames: null,
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/mara/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description.includes('May appear in the memory as:'), false);
});

Deno.test('buildMemberIllustrationDescription filters empty nickname strings', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'mara-id',
      name: 'Mara',
      nicknames: ['', ' '],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/mara/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description.includes('May appear in the memory as:'), false);
});

Deno.test('buildMemberIllustrationDescription includes additional guidance without leaking nickname aliases', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'mara-id',
      name: 'Mara',
      nicknames: ['Marita'],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: 'She has curly hair',
      illustrated_profile_key: 'user/family/mara/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(
    description,
    'Mara (1 year and 6 months old, Female). Additional guidance: She has curly hair.',
  );
  assertEquals(description.includes('May appear in the memory as:'), false);
  assertEquals(description.includes('Marita'), false);
});

Deno.test('prepareIllustrationReferences loads one image per member in tag order', async () => {
  const requestedKeys: string[] = [];

  const bundle = await prepareIllustrationReferences(
    [
      {
        id: 'enzo-id',
        name: 'Enzo',
        date_of_birth: '2022-10-01',
        gender: 'Male',
        additional_info: null,
        illustrated_profile_key: 'user/family/enzo/portrait.webp',
        profile_picture_key: 'user/family/enzo/photo.jpg',
      },
      {
        id: 'mara-id',
        name: 'Mara',
        date_of_birth: '2024-11-01',
        gender: 'Female',
        additional_info: null,
        illustrated_profile_key: 'user/family/mara/portrait.webp',
        profile_picture_key: null,
      },
    ],
    '2026-05-26',
    async (key) => {
      requestedKeys.push(key);
      return new Uint8Array([1, 2, 3]);
    },
  );

  assertEquals(requestedKeys, [
    'user/family/enzo/portrait.webp',
    'user/family/mara/portrait.webp',
  ]);
  assertEquals(bundle.characterReferences, [
    { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    { referenceIndex: 2, description: 'Mara (1 year and 6 months old, Female)' },
  ]);
  assertEquals(bundle.referenceImages.length, 2);
  assertEquals(bundle.referenceImages[0]?.filename, 'reference-1-enzo.webp');
  assertEquals(bundle.referenceImages[1]?.filename, 'reference-2-mara.webp');
});

Deno.test('prepareIllustrationReferences reindexes when an earlier portrait fails to load', async () => {
  const bundle = await prepareIllustrationReferences(
    [
      {
        id: 'enzo-id',
        name: 'Enzo',
        date_of_birth: '2022-10-01',
        gender: 'Male',
        additional_info: null,
        illustrated_profile_key: 'missing-portrait.webp',
        profile_picture_key: 'missing-photo.jpg',
      },
      {
        id: 'mara-id',
        name: 'Mara',
        date_of_birth: '2024-11-01',
        gender: 'Female',
        additional_info: null,
        illustrated_profile_key: 'user/family/mara/portrait.webp',
        profile_picture_key: null,
      },
    ],
    '2026-05-26',
    async (key) => {
      if (key.startsWith('missing-')) {
        throw new Error('not found');
      }

      return new Uint8Array([9]);
    },
  );

  assertEquals(bundle.characterReferences, [
    { referenceIndex: 1, description: 'Mara (1 year and 6 months old, Female)' },
  ]);
  assertEquals(bundle.referenceImages[0]?.filename, 'reference-1-mara.webp');
});
