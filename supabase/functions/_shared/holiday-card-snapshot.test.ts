import { assert, assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  buildCardSnapshot,
  canonicalJson,
  CARD_QR_BASE_URL,
  CardSnapshotError,
  normalizeCardEdits,
  snapshotHash,
  type BuildCardSnapshotInput,
} from './holiday-card-snapshot.ts';

// Fictional fixture (the repo is public): the Rivera Soto family.
const TOKEN = 'Ab3dEf6hIj9lMn2pQr5tUv';
const MEDIA_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const MEDIA_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const MEDIA_NODIMS = 'cccccccc-3333-4333-8333-333333333333';
const MARTA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DIEGO = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOMAS = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const LUCIA = '44444444-dddd-4ddd-8ddd-dddddddddddd';
const ABUELA = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';

function fixture(over: Partial<BuildCardSnapshotInput> = {}): BuildCardSnapshotInput {
  return {
    cardId: '99999999-0000-4000-8000-000000000001',
    year: 2026,
    language: 'es',
    locale: 'es-CO',
    greeting: 'christmas',
    familyName: 'Rivera Soto',
    signature: 'Marta, Diego, Tomás y Lucía',
    qrCaption: 'Mira nuestro año',
    shareToken: TOKEN,
    format: '5R',
    letters: [
      { tone: 'classic', text: 'Querida familia,\n\nEste año Lucía aprendió a montar en bici.' },
      { tone: 'playful', text: 'Hola, hola.\n\nTomás ya lee solo.' },
    ],
    edits: {},
    frontCandidateIds: [MEDIA_NODIMS, MEDIA_A, MEDIA_B],
    media: [
      { id: MEDIA_NODIMS, originalKey: 'fam/orig/c.jpg', previewKey: 'fam/prev/c.jpg', width: null, height: null },
      { id: MEDIA_A, originalKey: 'fam/orig/a.JPG', previewKey: 'fam/prev/a.jpg', width: 4032, height: 3024, memoryId: 'mem-a', date: '2026-07-04' },
      { id: MEDIA_B, originalKey: 'fam/orig/b.png', previewKey: null, width: 3000, height: 4000, date: '2026-08-15' },
    ],
    people: [
      { id: LUCIA, name: 'Lucía Rivera Soto', dateOfBirth: '2022-03-02', relationship: 'child', illustratedProfileKey: 'fam/portrait/lucia-own.png', illustratedProfileStatus: 'ready' },
      { id: TOMAS, name: 'Tomás Rivera Soto', dateOfBirth: '2019-06-10', relationship: 'child' },
      { id: DIEGO, name: 'Diego', dateOfBirth: '1988-01-20', relationship: 'parent' },
      { id: MARTA, name: 'Marta', dateOfBirth: '1989-05-05', relationship: 'parent' },
      { id: ABUELA, name: 'Abuela Inés', dateOfBirth: '1955-02-02', relationship: 'grandparent', illustratedProfileKey: 'fam/portrait/abuela.png', illustratedProfileStatus: 'ready' },
    ],
    portraitVersions: [
      { id: 'v1', family_member_id: MARTA, reference_date: null, profile_picture_key: 'fam/in/marta.jpg', illustrated_profile_key: 'fam/portrait/marta.png', illustrated_profile_status: 'ready', created_at: '2026-01-01T00:00:00Z' },
      { id: 'v2', family_member_id: DIEGO, reference_date: '2026-01-01', profile_picture_key: 'fam/in/diego.jpg', illustrated_profile_key: 'fam/portrait/diego.webp', illustrated_profile_status: 'ready', created_at: '2026-01-02T00:00:00Z' },
      { id: 'v3', family_member_id: TOMAS, reference_date: '2026-01-01', profile_picture_key: 'fam/in/tomas.jpg', illustrated_profile_key: 'fam/portrait/tomas.png', illustrated_profile_status: 'ready', created_at: '2026-01-03T00:00:00Z' },
    ],
    portraitDimensions: {
      'fam/portrait/marta.png': { width: 1024, height: 1024 },
      'fam/portrait/diego.webp': { width: 1024, height: 1024 },
      'fam/portrait/tomas.png': { width: 1024, height: 1536 },
      'fam/portrait/lucia-own.png': { width: 1024, height: 1024 },
    },
    asOfDate: '2026-10-06',
    ...over,
  };
}

Deno.test('card.json has every field the print app reads (CardData subset) and a clean shape', () => {
  const { card, edits, assets, qrUrl, front } = buildCardSnapshot(fixture());
  // parseCardData requirements (book-renderer/src/card/types.ts)
  assertEquals(card.version, 1);
  assertEquals(typeof card.slug, 'string');
  assertEquals(card.language, 'es');
  assertEquals(card.greeting, 'christmas');
  assertEquals(typeof card.signature, 'string');
  assert(card.letters.length > 0);
  assert(card.photo.file.length > 0 && card.photo.width > 0 && card.photo.height > 0);
  assertEquals(typeof card.qr.url, 'string');
  // fields cardInputFromData reads
  assertEquals(card.year, 2026);
  assertEquals(card.format, '5R');
  assertEquals(card.qrCaption, 'Mira nuestro año');
  assertEquals(card.qr, { enabled: true, token: TOKEN, url: `${CARD_QR_BASE_URL}/${TOKEN}` });
  assertEquals(card.illustrations, []);
  assertEquals(card.familyName, 'Rivera Soto');
  assertEquals(card.locale, 'es-CO');

  // the chosen front: the first candidate WITH a known size (the unknown-size one is skipped), the ORIGINAL key prints
  assertEquals(card.photo.mediaId, MEDIA_A);
  assertEquals(card.photo.memoryId, 'mem-a');
  assertEquals(card.photo.file, `assets/photo-aaaaaaaa.jpg`);
  assertEquals(card.photo.width, 4032);
  assertEquals(card.frontOptions?.map((o) => o.id), [MEDIA_A]);
  assertEquals(card.frontOptions?.[0].kind, 'photo');
  assertEquals(front, { mediaId: MEDIA_A, originalKey: 'fam/orig/a.JPG', previewKey: 'fam/prev/a.jpg', width: 4032, height: 3024 });
  assertEquals(assets[0], { file: 'assets/photo-aaaaaaaa.jpg', key: 'fam/orig/a.JPG' });
  assertEquals(qrUrl, `${CARD_QR_BASE_URL}/${TOKEN}`);

  // edits: the chosen front is explicit, greeting is not carried, QR is explicit
  assertEquals(edits.version, 1);
  assertEquals(edits.frontImage, MEDIA_A);
  assertEquals(edits.choices.greeting, undefined);
  assertEquals(edits.choices.qr, true);
});

Deno.test('portraits: parents first, then children by birth date; non-core people left out; asset list matches', () => {
  const { card, assets, warnings } = buildCardSnapshot(fixture());
  assertEquals(card.portraits?.map((p) => [p.name, p.role, p.file]), [
    ['Diego', 'parent', 'assets/portrait-22222222.webp'],
    ['Marta', 'parent', 'assets/portrait-11111111.png'],
    ['Tomás', 'child', 'assets/portrait-33333333.png'],
    ['Lucía', 'child', 'assets/portrait-44444444.png'],
  ]);
  // dated version wins; an undated legacy version resolves too; the child with no version uses its own ready portrait
  assertEquals(assets.map((a) => a.key), [
    'fam/orig/a.JPG',
    'fam/portrait/diego.webp',
    'fam/portrait/marta.png',
    'fam/portrait/tomas.png',
    'fam/portrait/lucia-own.png',
  ]);
  assertEquals(warnings, []);
  assertEquals(card.portraits?.[2].height, 1536);
});

Deno.test('portraits: a member without a ready portrait or without dimensions is left out with a warning', () => {
  const dims = { 'fam/portrait/marta.png': { width: 1024, height: 1024 }, 'fam/portrait/diego.webp': { width: 1024, height: 1024 } };
  const { card, warnings } = buildCardSnapshot(fixture({ portraitDimensions: dims }));
  assertEquals(card.portraits?.map((p) => p.name), ['Diego', 'Marta']);
  assertEquals(warnings.map((w) => [w.code, w.memberId]).sort(), [['portrait_no_dimensions', LUCIA], ['portrait_no_dimensions', TOMAS]].sort());
  const noPortrait = buildCardSnapshot(fixture({ portraitVersions: [], people: fixture().people.filter((p) => p.id !== ABUELA) }));
  assert(noPortrait.warnings.some((w) => w.code === 'portrait_missing' && w.memberId === MARTA));
});

Deno.test('front choice: the editor pick wins (with its focal point); an unusable pick falls back to the top candidate', () => {
  const picked = buildCardSnapshot(fixture({
    edits: { frontImage: MEDIA_B, focalPoints: { [MEDIA_B]: { x: 0.25, y: 1.4 }, [MEDIA_A]: { x: 0.5, y: 0.5 } } },
  }));
  assertEquals(picked.card.photo.mediaId, MEDIA_B);
  assertEquals(picked.card.photo.file, 'assets/photo-bbbbbbbb.png');
  assertEquals(picked.edits.frontImage, MEDIA_B);
  assertEquals(picked.edits.focalPoints, { [MEDIA_B]: { x: 0.25, y: 1 } }); // clamped, other picture's focal dropped
  assertEquals(picked.front.previewKey, null);

  for (const frontImage of ['illustration-tree', MEDIA_NODIMS, 'not-a-media-id']) {
    const fallback = buildCardSnapshot(fixture({ edits: { frontImage } }));
    assertEquals(fallback.card.photo.mediaId, MEDIA_A, frontImage);
    assertEquals(fallback.edits.frontImage, MEDIA_A);
  }
});

Deno.test('QR: no share token (no film) prints without a QR; an edit can turn it off, never on without a token', () => {
  const noFilm = buildCardSnapshot(fixture({ shareToken: null, edits: { choices: { qr: true } } }));
  assertEquals(noFilm.card.qr, { enabled: false, token: '', url: '' });
  assertEquals(noFilm.card.qrCaption, null);
  assertEquals(noFilm.qrUrl, null);
  assertEquals(noFilm.edits.choices.qr, false);

  const off = buildCardSnapshot(fixture({ edits: { choices: { qr: false } } }));
  assertEquals(off.card.qr.enabled, false);
  assertEquals(off.qrUrl, null);
  assertEquals(off.card.qrCaption, null);

  const badToken = buildCardSnapshot(fixture({ shareToken: 'short' }));
  assertEquals(badToken.card.qr.enabled, false);
});

Deno.test('edits: letter/text/choices pass through normalized; the greeting choice is dropped (row is the single source)', () => {
  const { edits, card } = buildCardSnapshot(fixture({
    greeting: 'new-year',
    edits: {
      text: { 'back.signature': 'Los Rivera Soto', 'front.greeting': 7, bogus: 'x' },
      letters: { classic: 'Texto editado por los papás', playful: '   ' },
      choices: { layout: 'full-bleed', tone: 'playful', greeting: 'christmas', portraits: false, greetingPosition: 'top-center' },
    },
  }));
  assertEquals(card.greeting, 'new-year');
  assertEquals(edits.text, { 'back.signature': 'Los Rivera Soto' });
  assertEquals(edits.letters, { classic: 'Texto editado por los papás' });
  assertEquals(edits.choices, { layout: 'full-bleed', tone: 'playful', portraits: false, greetingPosition: 'top-center', qr: true });
  assertEquals(normalizeCardEdits(null).choices, { layout: 'bordered', tone: 'classic' });
  assertEquals(normalizeCardEdits('junk').frontImage, null);
});

Deno.test('errors carry codes only: no letters, no usable front photo, bad slug', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      assert(e instanceof CardSnapshotError);
      assert(!e.message.includes('Rivera'));
      return e.code;
    }
    return null;
  };
  assertEquals(code(() => buildCardSnapshot(fixture({ letters: [] }))), 'NO_LETTERS');
  assertEquals(code(() => buildCardSnapshot(fixture({ letters: [{ tone: 'classic', text: '  ' }] }))), 'NO_LETTERS');
  assertEquals(code(() => buildCardSnapshot(fixture({ frontCandidateIds: [MEDIA_NODIMS] }))), 'NO_FRONT_PHOTO');
  assertEquals(code(() => buildCardSnapshot(fixture({ frontCandidateIds: [], media: [] }))), 'NO_FRONT_PHOTO');
  assertEquals(code(() => buildCardSnapshot(fixture({ slug: '../x' }))), 'INVALID_INPUT');
  assertThrows(() => buildCardSnapshot(fixture({ greeting: 'easter' as never })), CardSnapshotError);
});

Deno.test('A5 format flows through to card.json', () => {
  assertEquals(buildCardSnapshot(fixture({ format: 'A5' })).card.format, 'A5');
});

Deno.test('canonicalJson sorts keys recursively and drops undefined', () => {
  assertEquals(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null } }), '{"a":{"c":null,"d":[3,{"z":1}]},"b":1}');
  assertEquals(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

Deno.test('snapshotHash: stable hex sha256, key-order independent, sensitive to every printed field', async () => {
  const a = buildCardSnapshot(fixture());
  const h = await snapshotHash(a);
  assert(/^[0-9a-f]{64}$/.test(h));
  assertEquals(h, await snapshotHash(buildCardSnapshot(fixture())));

  // reordering object keys does not change the hash
  const reordered = { qrUrl: a.qrUrl, assets: a.assets, edits: JSON.parse(JSON.stringify(a.edits)), card: Object.fromEntries(Object.entries(a.card).reverse()) } as typeof a;
  assertEquals(await snapshotHash(reordered), h);
  // warnings / front metadata are not part of the hash
  assertEquals(await snapshotHash({ ...a, warnings: [{ code: 'portrait_missing', memberId: 'x' }] } as typeof a), h);

  const changes: Partial<BuildCardSnapshotInput>[] = [
    { letters: [{ tone: 'classic', text: 'Otro texto' }] },
    { signature: 'Los Rivera' },
    { edits: { text: { 'back.signature': 'x' } } },
    { shareToken: 'Zz3dEf6hIj9lMn2pQr5tUv' },
    { greeting: 'holidays' },
    { format: 'A5' },
    { edits: { frontImage: MEDIA_B } },
  ];
  const seen = new Set([h]);
  for (const change of changes) {
    const next = await snapshotHash(buildCardSnapshot(fixture(change)));
    assertNotEquals(next, h, JSON.stringify(Object.keys(change)));
    seen.add(next);
  }
  assertEquals(seen.size, changes.length + 1);
});
