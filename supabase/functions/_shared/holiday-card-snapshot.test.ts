import { assert, assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  buildCardSnapshot,
  buildEditorView,
  buildFrozenEditorView,
  canonicalJson,
  CARD_QR_BASE_URL,
  CardSnapshotError,
  computeQrState,
  normalizeCardEdits,
  parseFrozenSnapshot,
  resolveFrontId,
  snapshotHash,
  type BuildCardSnapshotInput,
  type BuildEditorViewInput,
  type QrFilmFacts,
  type QrState,
  type QrTokenFacts,
} from './holiday-card-snapshot.ts';
import { checkFilmGate, type HolidayCardRow } from './holiday-card-snapshot-loader.ts';

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

// ── Shared default-front rule ────────────────────────────────────────────

Deno.test('resolveFrontId: no pick -> candidate #1, a pick -> the pick, nothing -> null', () => {
  assertEquals(resolveFrontId(null, [MEDIA_A, MEDIA_B]), MEDIA_A);
  assertEquals(resolveFrontId(undefined, [MEDIA_B]), MEDIA_B);
  assertEquals(resolveFrontId(MEDIA_B, [MEDIA_A]), MEDIA_B);
  assertEquals(resolveFrontId(MEDIA_B, []), MEDIA_B);
  assertEquals(resolveFrontId(null, []), null);
  assertEquals(resolveFrontId('', [MEDIA_A]), MEDIA_A);
  // With a usability test, no pick falls back to the first USABLE candidate; a pick is never replaced; nothing usable -> null.
  assertEquals(resolveFrontId(null, [MEDIA_A, MEDIA_B], (id) => id === MEDIA_B), MEDIA_B);
  assertEquals(resolveFrontId(MEDIA_A, [MEDIA_A, MEDIA_B], (id) => id === MEDIA_B), MEDIA_A);
  assertEquals(resolveFrontId(null, [MEDIA_A, MEDIA_B], () => false), null);
});

Deno.test('buildEditorView: no pick with candidate #1 unusable uses the first usable one (not frontMissing)', () => {
  const view = buildEditorView(editorFixture({ media: [{ id: MEDIA_B, originalKey: 'fam/orig/b.png', previewKey: null }] }));
  assertEquals([view.frontMissing, view.cardData.photo.mediaId], [false, MEDIA_B]);
  assertEquals(view.assets['assets/photo-bbbbbbbb.png'], 'fam/orig/b.png'); // the chosen front: original
  // An unusable explicit pick is still missing.
  assertEquals(buildEditorView(editorFixture({ edits: { frontImage: MEDIA_A }, media: [{ id: MEDIA_B, originalKey: 'fam/orig/b.png', previewKey: null }] })).frontMissing, true);
});

// ── qrState: one table over every combination ────────────────────────────

const published: QrFilmFacts = { status: 'ready', blocked: false, videoKey: 'films/x.mp4', readyAt: '2026-10-06T00:00:00Z' };
const FILMS = {
  none: null,
  blocked: { ...published, blocked: true },
  published,
  publishedRerendering: { ...published, status: 'rendering' },
  rendering: { status: 'rendering', blocked: false, videoKey: null, readyAt: null },
  queued: { status: 'queued', blocked: false, videoKey: null, readyAt: null },
  failedUnpublished: { status: 'failed', blocked: false, videoKey: null, readyAt: null },
  failedPublished: { ...published, status: 'failed' },
  endedPublished: { ...published, status: 'ended' },
  endedUnpublished: { status: 'ended', blocked: false, videoKey: null, readyAt: null },
  skipped: { status: 'skipped', blocked: false, videoKey: null, readyAt: null },
  // a video that never became ready is not published
  videoWithoutReadyAt: { status: 'rendering', blocked: false, videoKey: 'films/x.mp4', readyAt: null },
} satisfies Record<string, QrFilmFacts | null>;
type FilmKind = keyof typeof FILMS;
type TokenKind = 'noToken' | QrTokenFacts;

// Expected state when the parent has NOT switched the QR off (qr choice undefined or true).
const EXPECTED: Record<TokenKind, Record<FilmKind, QrState>> = {
  noToken: Object.fromEntries(Object.keys(FILMS).map((k) => [k, 'unavailable'])) as Record<FilmKind, QrState>,
  revoked: Object.fromEntries(Object.keys(FILMS).map((k) => [k, 'off'])) as Record<FilmKind, QrState>,
  missing: Object.fromEntries(Object.keys(FILMS).map((k) => [k, 'unavailable'])) as Record<FilmKind, QrState>,
  live: {
    none: 'unavailable',
    blocked: 'unavailable',
    published: 'on',
    publishedRerendering: 'on',
    rendering: 'waiting_film',
    queued: 'waiting_film',
    failedUnpublished: 'unavailable',
    failedPublished: 'on',
    endedPublished: 'unavailable',
    endedUnpublished: 'unavailable',
    skipped: 'unavailable',
    videoWithoutReadyAt: 'waiting_film',
  },
};

Deno.test('computeQrState: every (qr choice x token x film) combination', () => {
  let combos = 0;
  for (const qrChoice of [undefined, true, false] as const) {
    for (const tokenKind of ['noToken', 'live', 'revoked', 'missing'] as TokenKind[]) {
      for (const filmKind of Object.keys(FILMS) as FilmKind[]) {
        const state = computeQrState({
          qrChoice,
          hasToken: tokenKind !== 'noToken',
          token: tokenKind === 'noToken' ? null : tokenKind,
          film: FILMS[filmKind],
        });
        // The parent's explicit "off" beats everything else, like the checkout gate.
        const expected = qrChoice === false ? 'off' : EXPECTED[tokenKind][filmKind];
        assertEquals(state, expected, `${String(qrChoice)} / ${tokenKind} / ${filmKind}`);
        combos++;
      }
    }
  }
  assertEquals(combos, 3 * 4 * Object.keys(FILMS).length);
});

/** A minimal supabase stand-in for checkFilmGate: three tables, `.select().eq().maybeSingle()`. */
function gateClient(rows: { token: { token: string; revoked_at: string | null } | null; film: Record<string, unknown> | null }) {
  const answer = (table: string) => (table === 'film_share_tokens' ? rows.token : table === 'year_films' ? rows.film : null);
  return {
    from: (table: string) => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve({ data: answer(table), error: null }) };
      return chain;
    },
  } as never;
}

Deno.test('computeQrState agrees with checkFilmGate (the checkout gate) on every combination', async () => {
  for (const qrChoice of [undefined, true, false] as const) {
    for (const tokenKind of ['noToken', 'live', 'revoked', 'missing'] as TokenKind[]) {
      for (const filmKind of Object.keys(FILMS) as FilmKind[]) {
        const film = FILMS[filmKind];
        const label = `${String(qrChoice)} / ${tokenKind} / ${filmKind}`;
        const card = {
          id: 'c', film_id: film ? 'film-1' : null, share_token: tokenKind === 'noToken' ? null : TOKEN,
          edits: qrChoice === undefined ? {} : { choices: { qr: qrChoice } },
        } as unknown as HolidayCardRow;
        const rows = {
          token: tokenKind === 'live' ? { token: TOKEN, revoked_at: null } : tokenKind === 'revoked' ? { token: TOKEN, revoked_at: '2026-10-06T00:00:00Z' } : null,
          film: film ? { id: 'film-1', status: film.status, blocked: film.blocked, video_key: film.videoKey, ready_at: film.readyAt } : null,
        };
        const gate = await checkFilmGate(gateClient(rows), card);
        const state = computeQrState({
          qrChoice,
          hasToken: tokenKind !== 'noToken',
          token: tokenKind === 'noToken' ? null : tokenKind,
          film,
        });
        const prints = gate.ok && gate.shareTokenActive;
        assertEquals(state === 'on', prints, label);
        // Orderable states print: only `waiting_film` is a refusal (wait, or switch the QR off).
        if (state === 'waiting_film') assert(!gate.ok && gate.code === 'FILM_NOT_READY', label);
        else assert(gate.ok, label);
        // `unavailable` / `off` print WITHOUT a QR.
        if (state === 'unavailable' || state === 'off') assertEquals(gate, { ok: true, shareTokenActive: false }, label);
        // Strict (reorders of a card that printed a QR) still refuses a blocked / given-up film.
        const strict = await checkFilmGate(gateClient(rows), card, { strict: true });
        if (state === 'unavailable' && film && tokenKind === 'live') assert(!strict.ok, label);
        else assertEquals(strict, gate, label);
      }
    }
  }
});

// ── buildEditorView ──────────────────────────────────────────────────────

const MEDIA_PICK = 'dddddddd-4444-4444-8444-444444444444';

function editorFixture(over: Partial<BuildEditorViewInput> = {}): BuildEditorViewInput {
  const base = fixture();
  return {
    cardId: base.cardId,
    year: 2026,
    language: 'es',
    locale: 'es-CO',
    greeting: 'christmas',
    familyName: 'Rivera Soto',
    signature: 'Marta, Diego, Tomás y Lucía',
    qrCaption: 'Mira nuestro año',
    shareToken: TOKEN,
    qrFacts: { token: 'live', film: published },
    letters: base.letters,
    edits: {},
    candidates: [
      { mediaId: MEDIA_A, width: 4032, height: 3024, rank: 1 },
      { mediaId: MEDIA_B, width: 3000, height: 4000, rank: 2 },
    ],
    media: [
      { id: MEDIA_A, originalKey: 'fam/orig/a.JPG', previewKey: 'fam/prev/a.jpg', memoryId: 'mem-a', date: '2026-07-04' },
      { id: MEDIA_B, originalKey: 'fam/orig/b.png', previewKey: null, date: '2026-08-15' },
      { id: MEDIA_PICK, originalKey: 'fam/orig/p.webp', previewKey: 'fam/prev/p.jpg', aspectRatio: 2 },
    ],
    people: base.people,
    portraitVersions: base.portraitVersions,
    asOfDate: '2026-10-06',
    ...over,
  };
}

Deno.test('buildEditorView: all candidates, the saved non-candidate front, original for the chosen one, previews for the rest', () => {
  const view = buildEditorView(editorFixture({ edits: { frontImage: MEDIA_PICK } }));
  assertEquals(view.cardData.frontOptions?.map((o) => o.id), [MEDIA_A, MEDIA_B, MEDIA_PICK]);
  // Size of a non-candidate comes from its aspect ratio (2:1 -> 3000 x 1500).
  assertEquals(view.cardData.frontOptions?.[2], { id: MEDIA_PICK, kind: 'photo', file: 'assets/photo-dddddddd.webp', thumb: 'assets/thumb-dddddddd.jpg', width: 3000, height: 1500 });
  assertEquals(view.cardData.photo.mediaId, MEDIA_A); // the generated default
  assertEquals(view.cardData.photo.memoryId, 'mem-a');
  assertEquals(view.assets['assets/photo-dddddddd.webp'], 'fam/orig/p.webp');
  assertEquals(view.assets['assets/photo-aaaaaaaa.jpg'], 'fam/prev/a.jpg');
  assertEquals(view.assets['assets/photo-bbbbbbbb.png'], 'fam/orig/b.png'); // no preview stored
  assertEquals(view.assets['assets/thumb-aaaaaaaa.jpg'], 'fam/prev/a.jpg');
  assertEquals(view.frontMissing, false);
  // Edits are raw (nothing frozen, greeting choice kept for the editor to see).
  assertEquals(view.edits.frontImage, MEDIA_PICK);
  assertEquals(view.edits.choices.qr, undefined);

  // No pick: the default front (candidate #1) is the one served from its original.
  const noPick = buildEditorView(editorFixture());
  assertEquals(noPick.assets['assets/photo-aaaaaaaa.jpg'], 'fam/orig/a.JPG');
  assertEquals(noPick.assets['assets/photo-bbbbbbbb.png'], 'fam/orig/b.png');
  assertEquals(noPick.cardData.frontOptions?.length, 2);
  // A pick that is also a candidate is not duplicated.
  assertEquals(buildEditorView(editorFixture({ edits: { frontImage: MEDIA_B } })).cardData.frontOptions?.map((o) => o.id), [MEDIA_A, MEDIA_B]);
});

Deno.test('buildEditorView: unknown sizes are placeholders with the right proportions (square when even the ratio is unknown)', () => {
  const view = buildEditorView(editorFixture({
    candidates: [{ mediaId: MEDIA_A, width: null, height: null, rank: 1 }, { mediaId: MEDIA_B, width: null, height: null, rank: 2 }],
    media: [
      { id: MEDIA_A, originalKey: 'fam/orig/a.jpg', previewKey: null, aspectRatio: 0.75 },
      { id: MEDIA_B, originalKey: 'fam/orig/b.jpg', previewKey: null },
    ],
  }));
  assertEquals(view.cardData.frontOptions?.map((o) => [o.width, o.height]), [[2250, 3000], [3000, 3000]]);
});

Deno.test('buildEditorView: frontMissing for an unusable pick or default; never throws for a missing photo', () => {
  assertEquals(buildEditorView(editorFixture({ edits: { frontImage: 'eeeeeeee-5555-4555-8555-555555555555' } })).frontMissing, true);
  assertEquals(buildEditorView(editorFixture({ media: [] })).frontMissing, true);
  const noFront = buildEditorView(editorFixture({ candidates: [], media: [] }));
  assertEquals([noFront.frontMissing, noFront.cardData.frontOptions, noFront.cardData.photo], [true, [], { file: '', width: 0, height: 0 }]);
  assertEquals(buildEditorView(editorFixture({ edits: { frontImage: MEDIA_B } })).frontMissing, false);
});

Deno.test('buildEditorView: portraits resolved as of the card date without probes (1024 square unless a size is passed)', () => {
  const view = buildEditorView(editorFixture());
  assertEquals(view.cardData.portraits?.map((p) => [p.name, p.role, p.width, p.height]), [
    ['Diego', 'parent', 1024, 1024],
    ['Marta', 'parent', 1024, 1024],
    ['Tomás', 'child', 1024, 1024],
    ['Lucía', 'child', 1024, 1024],
  ]);
  assertEquals(view.assets['assets/portrait-22222222.webp'], 'fam/portrait/diego.webp');
  // Same members and order the print snapshot uses.
  assertEquals(view.cardData.portraits?.map((p) => p.file), buildCardSnapshot(fixture()).card.portraits?.map((p) => p.file));
  const sized = buildEditorView(editorFixture({ portraitDimensions: { 'fam/portrait/tomas.png': { width: 800, height: 1200 } } }));
  assertEquals(sized.cardData.portraits?.find((p) => p.name === 'Tomás')?.height, 1200);
  // Nobody has a portrait: none, no throw.
  assertEquals(buildEditorView(editorFixture({ people: [], portraitVersions: [] })).cardData.portraits, []);
});

Deno.test('buildEditorView: the QR url is carried whenever the card has a token; `enabled` only when the link can work', () => {
  const on = buildEditorView(editorFixture());
  assertEquals([on.qrState, on.cardData.qr], ['on', { enabled: true, token: TOKEN, url: `${CARD_QR_BASE_URL}/${TOKEN}` }]);
  const off = buildEditorView(editorFixture({ edits: { choices: { qr: false } } }));
  assertEquals([off.qrState, off.cardData.qr.url, off.cardData.qr.enabled], ['off', `${CARD_QR_BASE_URL}/${TOKEN}`, true]);
  const none = buildEditorView(editorFixture({ shareToken: null, qrFacts: { token: null, film: null } }));
  assertEquals([none.qrState, none.cardData.qr], ['unavailable', { enabled: false, token: '', url: '' }]);
  const blocked = buildEditorView(editorFixture({ qrFacts: { token: 'live', film: FILMS.blocked } }));
  assertEquals([blocked.qrState, blocked.cardData.qr.enabled], ['unavailable', false]);
});

Deno.test('buildEditorView: carries the card text; errors are codes only', () => {
  const view = buildEditorView(editorFixture({ format: 'A5' }));
  assertEquals(
    [view.cardData.format, view.cardData.language, view.cardData.locale, view.cardData.familyName, view.cardData.signature, view.cardData.qrCaption, view.cardData.slug],
    ['A5', 'es', 'es-CO', 'Rivera Soto', 'Marta, Diego, Tomás y Lucía', 'Mira nuestro año', fixture().cardId],
  );
  assertEquals(view.cardData.letters.map((l) => l.tone), ['classic', 'playful']);
  let code: string | null = null;
  try {
    buildEditorView(editorFixture({ letters: [] }));
  } catch (e) {
    assert(e instanceof CardSnapshotError);
    assert(!e.message.includes('Rivera'));
    code = e.code;
  }
  assertEquals(code, 'NO_LETTERS');
  assertThrows(() => buildEditorView(editorFixture({ greeting: 'easter' as never })), CardSnapshotError);
});

// ── Frozen (ordered) snapshots ───────────────────────────────────────────

Deno.test('parseFrozenSnapshot / buildFrozenEditorView: what was printed comes back, keys by file, QR checked live', () => {
  const snap = buildCardSnapshot(fixture());
  const stored = JSON.parse(JSON.stringify({ card: snap.card, edits: snap.edits, assets: snap.assets, qrUrl: snap.qrUrl, front: snap.front }));
  const frozen = parseFrozenSnapshot(stored)!;
  assertEquals(frozen.card, snap.card);
  assertEquals(frozen.assets, snap.assets);
  const view = buildFrozenEditorView(frozen, { token: 'live', film: published });
  assertEquals(view.cardData, snap.card);
  assertEquals(view.assets['assets/photo-aaaaaaaa.jpg'], 'fam/orig/a.JPG');
  assertEquals(Object.keys(view.assets).length, snap.assets.length);
  assertEquals([view.qrState, view.frontMissing], ['on', false]);
  assertEquals(buildFrozenEditorView(frozen, { token: 'revoked', film: published }).qrState, 'off');
  assertEquals(buildFrozenEditorView(frozen, { token: 'live', film: FILMS.blocked }).qrState, 'unavailable');
  // A snapshot that printed no QR stays off whatever the film does.
  const noQr = buildCardSnapshot(fixture({ shareToken: null }));
  assertEquals(buildFrozenEditorView(parseFrozenSnapshot(JSON.parse(JSON.stringify(noQr)))!, { token: 'live', film: published }).qrState, 'off');

  for (const bad of [null, 'x', {}, { card: {}, edits: {}, assets: [] }, { ...stored, assets: [{ file: 1 }] }, { ...stored, card: { ...stored.card, letters: [] } }]) {
    assertEquals(parseFrozenSnapshot(bad), null);
  }
});
