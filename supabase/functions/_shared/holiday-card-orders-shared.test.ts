import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  deletePrintFiles,
  isFreshClaim,
  parsePrintFiles,
  printFilesPrefix,
  printOrderPrefix,
  releasePrintFiles,
  releaseUnpaidArtifacts,
} from './holiday-card-fulfillment.ts';
import {
  candidateIdsFrom,
  checkFilmGate,
  type HolidayCardRow,
  editsForRenderer,
  lettersFrom,
  loadCardSnapshot,
  CardLoadError,
  cardUnchangedForPrint,
} from './holiday-card-snapshot-loader.ts';
import { renderCard, RenderCardContentError, RenderCardUnavailableError } from './render-card-client.ts';
import {
  cardWorldSeed,
  FakeDb,
  fakeImageSize,
  fakePresign,
  IDS,
  makeGelatoFake,
  makeR2Fake,
  makeWorldFetch,
  SHARE_TOKEN,
} from './holiday-card-orders.test-support.ts';

// ── render-card-client ───────────────────────────────────────────────────

const REQUEST = {
  orderId: IDS.order,
  mode: 'render' as const,
  format: '5R' as const,
  fileLayout: 'two_files' as const,
  card: { version: 1 },
  edits: {},
  assets: { 'assets/photo.jpg': 'https://r2.test/x' },
  outputPrefix: `print-orders/${IDS.order}/`,
};

const okBody = (prefix: string) => ({
  ok: true,
  mode: 'render',
  files: [
    { side: 'front', key: `${prefix}front.pdf`, sha256: 'a'.repeat(64), bytes: 10 },
    { side: 'back', key: `${prefix}back.pdf`, sha256: 'b'.repeat(64), bytes: 10 },
  ],
  checks: { pages: 2 },
});

Deno.test('renderCard signs the raw body like /fit and parses the files', async () => {
  let seen: { url: string; headers: Headers; body: string } | null = null;
  const result = await renderCard(async (url, init) => {
    seen = { url: String(url), headers: new Headers(init?.headers), body: String(init?.body) };
    return new Response(JSON.stringify(okBody(REQUEST.outputPrefix)), { status: 200 });
  }, 'https://render.test/', 'secret', REQUEST);
  assertEquals(seen!.url, 'https://render.test/render-card');
  assertEquals(seen!.body, JSON.stringify(REQUEST));
  const timestamp = seen!.headers.get('x-render-timestamp')!;
  const nonce = seen!.headers.get('x-render-nonce')!;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${seen!.body}`)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  assertEquals(seen!.headers.get('x-render-signature'), expected);
  assertEquals(result.files.map((f) => f.side), ['front', 'back']);
});

Deno.test('renderCard: a 422 with a known code is a content error, anything else is "unavailable"', async () => {
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const content = await assertRejects(
    () => renderCard(respond(422, { ok: false, code: 'IMAGE_LOW_RES', message: 'the photo is too small' }), 'https://render.test', 's', REQUEST),
    RenderCardContentError,
  );
  assertEquals(content.code, 'IMAGE_LOW_RES');
  for (const [status, body] of [[422, { ok: false, code: 'SOMETHING_NEW', message: 'x' }], [401, { ok: false }], [503, 'nope'], [200, { ok: false }]] as const) {
    await assertRejects(() => renderCard(respond(status, body), 'https://render.test', 's', REQUEST), RenderCardUnavailableError);
  }
  await assertRejects(() => renderCard(async () => { throw new Error('boom https://secret-url'); }, 'https://render.test', 's', REQUEST), RenderCardUnavailableError, 'unreachable');
});

Deno.test('renderCard rejects a file entry outside the output prefix or with a bad hash', async () => {
  const bad = okBody('print-orders/other/');
  await assertRejects(
    () => renderCard(async () => new Response(JSON.stringify(bad), { status: 200 }), 'https://render.test', 's', REQUEST),
    RenderCardUnavailableError,
  );
  const badHash = okBody(REQUEST.outputPrefix);
  badHash.files[0].sha256 = 'zz';
  await assertRejects(
    () => renderCard(async () => new Response(JSON.stringify(badHash), { status: 200 }), 'https://render.test', 's', REQUEST),
    RenderCardUnavailableError,
  );
});

// ── fulfillment helpers ──────────────────────────────────────────────────

Deno.test('parsePrintFiles tolerates junk and isFreshClaim honours the TTL', () => {
  assertEquals(parsePrintFiles(null), {});
  assertEquals(parsePrintFiles([1, 2]), {});
  assertEquals(parsePrintFiles({ files: [{ nope: 1 }, { side: 'front', key: 'k', sha256: 's', bytes: 1 }] }).files?.length, 1);
  const now = Date.parse('2026-10-06T12:00:00Z');
  assertEquals(isFreshClaim({ claim: { id: 'c', at: '2026-10-06T11:58:00Z' } }, now), true);
  assertEquals(isFreshClaim({ claim: { id: 'c', at: '2026-10-06T11:50:00Z' } }, now), false);
  assertEquals(isFreshClaim({}, now), false);
  assertEquals(isFreshClaim({ claim: { id: 'c', at: 'not a date' } }, now), false);
});

Deno.test('printOrderPrefix only accepts a uuid and deletePrintFiles never leaves the order prefix', async () => {
  assertEquals(printOrderPrefix(IDS.order), `print-orders/${IDS.order}/`);
  for (const bad of ['../x', 'abc', `${IDS.order}/../other`]) {
    let threw = false;
    try { printOrderPrefix(bad); } catch { threw = true; }
    assertEquals(threw, true);
  }
  const r2 = makeR2Fake([`print-orders/${IDS.order}/front.pdf`, 'print-orders/someone-else/front.pdf']);
  const sloppyList = (_prefix: string) => Promise.resolve([...r2.keys]); // a listing that over-returns
  assertEquals(await deletePrintFiles({ listKeys: sloppyList, deleteKey: r2.deleteKey }, IDS.order), 1);
  assertEquals(r2.keys.has('print-orders/someone-else/front.pdf'), true);
});

function fulfillmentDeps(gelato: ReturnType<typeof makeGelatoFake>, r2: ReturnType<typeof makeR2Fake>) {
  return { fetch: gelato.fetch, sendEmail: async () => 'sent' as const, listKeys: r2.listKeys, deleteKey: r2.deleteKey, gelatoApiKey: 'k', stripeSecretKey: 'sk_test_x' };
}

Deno.test('releaseUnpaidArtifacts refuses an order somebody paid for (never deletes its draft)', async () => {
  const gelato = makeGelatoFake();
  gelato.state.orders.set('gel-paid0001', { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] });
  const r2 = makeR2Fake([`print-orders/${IDS.order}/front.pdf`]);
  const db = new FakeDb({
    holiday_card_orders: [{ id: IDS.order, status: 'cancelled', gelato_order_id: 'gel-paid0001', stripe_payment_intent_id: 'pi_1', print_files: { files: [] } }],
  });
  assertEquals(await releaseUnpaidArtifacts(fulfillmentDeps(gelato, r2), db.client()(), IDS.order), false);
  assertEquals(gelato.state.orders.size, 1);
  assertEquals(r2.keys.size, 1);

  const live = new FakeDb({ holiday_card_orders: [{ id: IDS.order, status: 'checkout', gelato_order_id: 'gel-paid0001', stripe_payment_intent_id: null, print_files: {} }] });
  assertEquals(await releaseUnpaidArtifacts(fulfillmentDeps(gelato, r2), live.client()(), IDS.order), false);
  assertEquals(gelato.state.orders.size, 1);
});

Deno.test('releasePrintFiles only acts on shipped / failed / cancelled orders', async () => {
  const r2 = makeR2Fake([`print-orders/${IDS.order}/front.pdf`]);
  const live = new FakeDb({ holiday_card_orders: [{ id: IDS.order, status: 'submitted', print_files: { files: [] } }] });
  assertEquals(await releasePrintFiles(r2, live.client()(), IDS.order), false);
  assertEquals(r2.keys.size, 1);
  const done = new FakeDb({ holiday_card_orders: [{ id: IDS.order, status: 'shipped', print_files: { files: [] } }] });
  assertEquals(await releasePrintFiles(r2, done.client()(), IDS.order), true);
  assertEquals(r2.keys.size, 0);
  // A purge marker, not null: the prefix is purged once more >= 1 h later.
  assertEquals(typeof (done.row('holiday_card_orders', IDS.order).print_files as { purgedAt?: string }).purgedAt, 'string');
  assertEquals(await releasePrintFiles(r2, done.client()(), IDS.order), true); // idempotent: the marker is kept as is
});

// ── snapshot loader ──────────────────────────────────────────────────────

Deno.test('tone mapping: the writer angle warm is the renderer tone reflective (letters, edits.letters, choices.tone)', () => {
  assertEquals(lettersFrom([{ tone: 'warm', text: 'hi' }, { tone: 'classic', text: 'yo' }, { tone: 'playful', text: ' ' }]), [
    { tone: 'reflective', text: 'hi' },
    { tone: 'classic', text: 'yo' },
  ]);
  assertEquals(lettersFrom({ variants: [{ tone: 'warm', text: 'hi' }] }), [{ tone: 'reflective', text: 'hi' }]);
  const edits = editsForRenderer({ letters: { warm: 'edited', classic: 'x' }, choices: { layout: 'bordered', tone: 'warm' } }) as { letters: Record<string, string>; choices: { tone: string } };
  assertEquals(edits.letters, { reflective: 'edited', classic: 'x' });
  assertEquals(edits.choices.tone, 'reflective');
  assertEquals(editsForRenderer(null), null);
});

Deno.test('candidateIdsFrom accepts both stored shapes and drops legacy ids', () => {
  assertEquals(candidateIdsFrom([{ mediaId: IDS.mediaFront }, { mediaId: 'legacy:abc' }, IDS.mediaOther, { mediaId: IDS.mediaFront }]), [IDS.mediaFront, IDS.mediaOther]);
  assertEquals(candidateIdsFrom({ candidates: [{ mediaId: IDS.mediaFront }] }), [IDS.mediaFront]);
  assertEquals(candidateIdsFrom(null), []);
});

function loaderDeps() {
  const world = makeWorldFetch();
  return { createPresignedGetUrls: fakePresign(), fetch: world.fetch, imageSize: fakeImageSize };
}

const cardOf = (db: FakeDb) => db.row('holiday_cards', IDS.card) as unknown as HolidayCardRow;

Deno.test('loadCardSnapshot builds a deterministic snapshot from rows: original key, portraits, mapped tones, stable hash', async () => {
  const db = new FakeDb(cardWorldSeed());
  const options = { format: '5R' as const, shareTokenActive: true };
  const a = await loadCardSnapshot(loaderDeps(), db.client()(), cardOf(db), options);
  const b = await loadCardSnapshot(loaderDeps(), db.client()(), cardOf(db), options);
  assertEquals(a.hash, b.hash);
  assertEquals(a.hash.length, 64);
  assertEquals(a.snapshot.front.originalKey, 'u1/photos/front-original.jpg');
  assertEquals(a.snapshot.card.photo.width, 4000);
  assertEquals(a.snapshot.card.letters.map((l) => l.tone), ['classic', 'reflective']);
  assertEquals(a.snapshot.card.portraits?.length, 2);
  assertEquals(a.snapshot.card.familyName, 'The Example Family');
  assertEquals(a.snapshot.qrUrl?.endsWith('/AbCdEfGhIjKlMnOpQrStUv'), true);
  // Editing the letter changes the hash (the webhook compares it).
  db.row('holiday_cards', IDS.card).edits = { letters: { classic: 'A different letter' }, choices: { layout: 'bordered', tone: 'classic' } };
  const c = await loadCardSnapshot(loaderDeps(), db.client()(), cardOf(db), options);
  assertEquals(c.hash === a.hash, false);
});

Deno.test('loadCardSnapshot refuses unprintable cards with codes', async () => {
  const code = async (seed: ReturnType<typeof cardWorldSeed>) => {
    const db = new FakeDb(seed);
    try {
      await loadCardSnapshot(loaderDeps(), db.client()(), cardOf(db), { format: '5R', shareTokenActive: false });
      return 'ok';
    } catch (error) {
      return error instanceof CardLoadError ? error.code : 'other';
    }
  };
  assertEquals(await code(cardWorldSeed({ card: { status: 'generating' } })), 'CARD_NOT_READY');
  assertEquals(await code(cardWorldSeed({ card: { deleted_at: '2026-10-01T00:00:00Z' } })), 'CARD_DELETED');
  assertEquals(await code(cardWorldSeed({ card: { letters: [] } })), 'NO_LETTERS');
  assertEquals(await code(cardWorldSeed({ card: { front_candidates: [] } })), 'NO_FRONT_PHOTO');
  assertEquals(await code(cardWorldSeed({ card: { edits: { frontImage: 'legacy:abc' } } })), 'FRONT_PHOTO_UNREADABLE');
  // The other family's photo: media exists but its memory belongs to a different family.
  assertEquals(await code(cardWorldSeed({ card: { edits: { frontImage: IDS.mediaOther } } })), 'FRONT_PHOTO_UNREADABLE');
});

Deno.test('loadCardSnapshot with no pick uses the first USABLE candidate (the editor\'s rule); nothing usable is refused', async () => {
  const code = async (candidates: unknown[]) => {
    const db = new FakeDb(cardWorldSeed({ card: { front_candidates: candidates } }));
    try {
      const loaded = await loadCardSnapshot(loaderDeps(), db.client()(), cardOf(db), { format: '5R', shareTokenActive: false });
      return loaded.snapshot.front.mediaId;
    } catch (error) {
      return error instanceof CardLoadError ? error.code : 'other';
    }
  };
  // #1 belongs to another family (not printable for this card): the first usable candidate is the front, as in the editor.
  assertEquals(await code([{ mediaId: IDS.mediaOther }, { mediaId: IDS.mediaFront }]), IDS.mediaFront);
  assertEquals(await code([{ mediaId: IDS.mediaOther }]), 'FRONT_PHOTO_UNREADABLE');
  assertEquals(await code([{ mediaId: IDS.mediaFront }, { mediaId: IDS.mediaOther }]), IDS.mediaFront);
  assertEquals(await code([]), 'NO_FRONT_PHOTO');
});

Deno.test('checkFilmGate: QR off wins, a revoked/missing token is QR off, a live QR needs a PUBLISHED film', async () => {
  const gate = async (seed: ReturnType<typeof cardWorldSeed>) => {
    const db = new FakeDb(seed);
    return await checkFilmGate(db.client()(), cardOf(db));
  };
  assertEquals(await gate(cardWorldSeed()), { ok: true, shareTokenActive: true });
  // Published (video + ready_at), whatever the current status: re-rendering and a failed re-render keep the old video.
  for (const status of ['rendering', 'queued', 'curating', 'failed', 'skipped']) {
    assertEquals(await gate(cardWorldSeed({ film: { status } })), { ok: true, shareTokenActive: true });
  }
  // Still being made (never published, not given up): not ready -- wait, or switch the QR off.
  assertEquals(await gate(cardWorldSeed({ film: { video_key: null } })), { ok: false, code: 'FILM_NOT_READY' });
  assertEquals(await gate(cardWorldSeed({ film: { ready_at: null } })), { ok: false, code: 'FILM_NOT_READY' });
  // Blocked, or the render gave up (failed / skipped / ended without a published video): prints WITHOUT a QR (editor "unavailable").
  const noQr = { ok: true as const, shareTokenActive: false };
  assertEquals(await gate(cardWorldSeed({ film: { status: 'ended', video_key: null } })), noQr);
  assertEquals(await gate(cardWorldSeed({ film: { status: 'ended' } })), noQr);
  assertEquals(await gate(cardWorldSeed({ film: { blocked: true } })), noQr);
  assertEquals(await gate(cardWorldSeed({ film: { status: 'failed', video_key: null, ready_at: null } })), noQr);
  assertEquals(await gate(cardWorldSeed({ film: { status: 'skipped', video_key: null, ready_at: null } })), noQr);
  // strict (a reorder of a card whose first print HAD a QR) keeps refusing.
  const strict = async (seed: ReturnType<typeof cardWorldSeed>) => {
    const db = new FakeDb(seed);
    return await checkFilmGate(db.client()(), cardOf(db), { strict: true });
  };
  assertEquals(await strict(cardWorldSeed({ film: { blocked: true } })), { ok: false, code: 'FILM_BLOCKED' });
  assertEquals(await strict(cardWorldSeed({ film: { status: 'failed', video_key: null, ready_at: null } })), { ok: false, code: 'FILM_NOT_READY' });
  assertEquals(await strict(cardWorldSeed({ film: { status: 'ended' } })), { ok: false, code: 'FILM_NOT_READY' });
  assertEquals(await strict(cardWorldSeed()), { ok: true, shareTokenActive: true });
  assertEquals(await gate(cardWorldSeed({ film: { status: 'failed' }, card: { edits: { choices: { layout: 'bordered', tone: 'classic', qr: false } } } })), { ok: true, shareTokenActive: false });
  assertEquals(await gate(cardWorldSeed({ film: { blocked: true }, token: { revoked_at: '2026-10-05T00:00:00Z' } })), { ok: true, shareTokenActive: false });
  assertEquals(await gate(cardWorldSeed({ film: { blocked: true }, token: null })), { ok: true, shareTokenActive: false });
  assertEquals(await gate(cardWorldSeed({ film: null })), { ok: true, shareTokenActive: false });
});

Deno.test('cardUnchangedForPrint: deleted card, changed or revoked token', async () => {
  const check = async (seed: ReturnType<typeof cardWorldSeed>, printed: string | null) => {
    const db = new FakeDb(seed);
    return await cardUnchangedForPrint(db.client()(), IDS.card, printed);
  };
  assertEquals(await check(cardWorldSeed(), SHARE_TOKEN), true);
  assertEquals(await check(cardWorldSeed(), null), true);
  assertEquals(await check(cardWorldSeed({ card: { deleted_at: '2026-10-06T00:00:00Z' } }), null), false);
  assertEquals(await check(cardWorldSeed({ token: { revoked_at: '2026-10-06T00:00:00Z' } }), SHARE_TOKEN), false);
  assertEquals(await check(cardWorldSeed({ token: { revoked_at: '2026-10-06T00:00:00Z' } }), null), true); // QR was off: irrelevant
});

Deno.test('printFilesPrefix is content-addressed under the order prefix', () => {
  const hash = 'abcdef0123456789'.repeat(4);
  assertEquals(printFilesPrefix(IDS.order, hash), `print-orders/${IDS.order}/abcdef0123456789/`);
  let threw = false;
  try { printFilesPrefix(IDS.order, '../x'); } catch { threw = true; }
  assertEquals(threw, true);
});
