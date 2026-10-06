import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  buildMemberIllustrationDescription,
  prepareIllustrationReferences,
  sortMembersByTagOrder,
} from './illustration-references.ts';

Deno.test('sortMembersByTagOrder preserves tag order', () => {
  const sorted = sortMembersByTagOrder(
    [
      { id: 'lucia-id', name: 'Lucia' },
      { id: 'tomas-id', name: 'Tomas' },
    ],
    ['tomas-id', 'lucia-id'],
  );

  assertEquals(sorted.map((member) => member.id), ['tomas-id', 'lucia-id']);
});

Deno.test('buildMemberIllustrationDescription includes age, gender, and additional guidance', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'tomas-id',
      name: 'Tomas',
      date_of_birth: '2022-10-01',
      gender: 'Male',
      additional_info: 'He has curly brown hair',
      illustrated_profile_key: 'user/family/tomas/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(
    description,
    'Tomas (3 years and 7 months old, Male). Additional guidance: He has curly brown hair.',
  );
});

Deno.test('buildMemberIllustrationDescription omits additional guidance when absent', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'tomas-id',
      name: 'Tomas',
      date_of_birth: '2022-10-01',
      gender: 'Male',
      additional_info: null,
      illustrated_profile_key: 'user/family/tomas/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description, 'Tomas (3 years and 7 months old, Male)');
});

Deno.test('buildMemberIllustrationDescription never leaks a nickname alias into the description', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'lucia-id',
      name: 'Lucia',
      nicknames: ['Lucita'],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/lucia/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description, 'Lucia (1 year and 6 months old, Female)');
  assertEquals(description.includes('May appear in the memory as:'), false);
  assertEquals(description.includes('Lucita'), false);
});

Deno.test('buildMemberIllustrationDescription never leaks multiple nickname aliases into the description', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'lucia-id',
      name: 'Lucia',
      nicknames: ['Lucita', 'Mimi'],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/lucia/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description.includes('May appear in the memory as:'), false);
  assertEquals(description.includes('Lucita'), false);
  assertEquals(description.includes('Mimi'), false);
});

Deno.test('buildMemberIllustrationDescription omits nickname aliases when absent', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'lucia-id',
      name: 'Lucia',
      nicknames: null,
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/lucia/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description.includes('May appear in the memory as:'), false);
});

Deno.test('buildMemberIllustrationDescription filters empty nickname strings', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'lucia-id',
      name: 'Lucia',
      nicknames: ['', ' '],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: null,
      illustrated_profile_key: 'user/family/lucia/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(description.includes('May appear in the memory as:'), false);
});

Deno.test('buildMemberIllustrationDescription includes additional guidance without leaking nickname aliases', () => {
  const description = buildMemberIllustrationDescription(
    {
      id: 'lucia-id',
      name: 'Lucia',
      nicknames: ['Lucita'],
      date_of_birth: '2024-11-01',
      gender: 'Female',
      additional_info: 'She has curly hair',
      illustrated_profile_key: 'user/family/lucia/portrait.webp',
      profile_picture_key: null,
    },
    '2026-05-26',
  );

  assertEquals(
    description,
    'Lucia (1 year and 6 months old, Female). Additional guidance: She has curly hair.',
  );
  assertEquals(description.includes('May appear in the memory as:'), false);
  assertEquals(description.includes('Lucita'), false);
});

Deno.test('prepareIllustrationReferences loads one image per member in tag order', async () => {
  const requestedKeys: string[] = [];

  const bundle = await prepareIllustrationReferences(
    [
      {
        id: 'tomas-id',
        name: 'Tomas',
        date_of_birth: '2022-10-01',
        gender: 'Male',
        additional_info: null,
        illustrated_profile_key: 'user/family/tomas/portrait.webp',
        profile_picture_key: 'user/family/tomas/photo.jpg',
      },
      {
        id: 'lucia-id',
        name: 'Lucia',
        date_of_birth: '2024-11-01',
        gender: 'Female',
        additional_info: null,
        illustrated_profile_key: 'user/family/lucia/portrait.webp',
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
    'user/family/tomas/portrait.webp',
    'user/family/lucia/portrait.webp',
  ]);
  assertEquals(bundle.characterReferences, [
    { referenceIndex: 1, description: 'Tomas (3 years and 7 months old, Male)' },
    { referenceIndex: 2, description: 'Lucia (1 year and 6 months old, Female)' },
  ]);
  assertEquals(bundle.referenceImages.length, 2);
  assertEquals(bundle.referenceImages[0]?.filename, 'reference-1-tomas.webp');
  assertEquals(bundle.referenceImages[1]?.filename, 'reference-2-lucia.webp');
});

Deno.test('prepareIllustrationReferences reindexes when an earlier portrait fails to load', async () => {
  const bundle = await prepareIllustrationReferences(
    [
      {
        id: 'tomas-id',
        name: 'Tomas',
        date_of_birth: '2022-10-01',
        gender: 'Male',
        additional_info: null,
        illustrated_profile_key: 'missing-portrait.webp',
        profile_picture_key: 'missing-photo.jpg',
      },
      {
        id: 'lucia-id',
        name: 'Lucia',
        date_of_birth: '2024-11-01',
        gender: 'Female',
        additional_info: null,
        illustrated_profile_key: 'user/family/lucia/portrait.webp',
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
    { referenceIndex: 1, description: 'Lucia (1 year and 6 months old, Female)' },
  ]);
  assertEquals(bundle.referenceImages[0]?.filename, 'reference-1-lucia.webp');
});

Deno.test('prepareIllustrationReferences propagates an abort without trying the next source', async () => {
  const controller = new AbortController();
  const requestedKeys: string[] = [];

  await assertRejects(() =>
    prepareIllustrationReferences(
      [
        {
          id: 'lucia-id',
          name: 'Lucia',
          date_of_birth: '2024-11-01',
          gender: 'Female',
          additional_info: null,
          illustrated_profile_key: 'user/family/lucia/portrait.webp',
          profile_picture_key: 'user/family/lucia/photo.jpg',
        },
      ],
      '2026-05-26',
      async (key) => {
        requestedKeys.push(key);
        controller.abort('deadline reached');
        throw new DOMException('Aborted', 'AbortError');
      },
      { signal: controller.signal },
    ),
  );

  assertEquals(requestedKeys, ['user/family/lucia/portrait.webp']);
});
