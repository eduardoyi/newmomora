import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { CHECKOUT_CLAIM_TTL_MS } from '../_shared/holiday-card-fulfillment.ts';
import {
  cardLanguageFor,
  civilDate,
  classifyTimezone,
  deriveFilmState,
  GENERATION_ATTEMPT_CAP,
  handleHolidayCards,
  type HolidayCardsDependencies,
  readFrontCandidates,
} from './index.ts';

// Fictional ids only (the repo is public).
const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_FAMILY_ID = '23232323-2323-4232-8232-232323232323';
const CARD_ID = '33333333-3333-4333-8333-333333333333';
const FILM_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_FILM_ID = '601f9af7-0000-4000-8000-000000000000';
const MEDIA_A = '55555555-5555-4555-8555-555555555555';
const MEDIA_B = '66666666-6666-4666-8666-666666666666';
const MEDIA_HEIC = '78787878-7878-4787-8787-787878787878';
const MEDIA_FOREIGN = '77777777-7777-4777-8777-777777777777';
const MEMORY_A = '88888888-8888-4888-8888-888888888888';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW = new Date('2026-10-06T15:00:00Z');

// ── Fake service client ──────────────────────────────────────────────────

interface Query {
  table: string;
  action: 'select' | 'update';
  columns: string;
  filters: Array<[string, string, unknown]>;
  patch?: Record<string, unknown>;
}

type Result = { data: unknown; error?: unknown };
type TableHandler = (query: Query) => Result;

interface Fake {
  client: () => never;
  queries: Query[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function filterValue(query: Query, column: string): unknown {
  return query.filters.find(([, c]) => c === column)?.[2];
}

function createFake(
  tables: Record<string, TableHandler>,
  rpcs: Record<string, (args: Record<string, unknown>) => Result> = {},
): Fake {
  const queries: Query[] = [];
  const rpcCalls: Fake['rpcCalls'] = [];
  const client = () => ({
    from(table: string) {
      const query: Query = { table, action: 'select', columns: '', filters: [] };
      const run = (): Promise<Result> => {
        queries.push(query);
        const handler = tables[table];
        if (!handler) throw new Error(`Unexpected table ${table}`);
        const result = handler(query);
        return Promise.resolve({ data: result.data, error: result.error ?? null });
      };
      const chain: Record<string, unknown> = {
        select: (columns = '') => {
          if (query.action === 'select') query.columns = columns;
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          query.action = 'update';
          query.patch = patch;
          return chain;
        },
        eq: (c: string, v: unknown) => (query.filters.push(['eq', c, v]), chain),
        in: (c: string, v: unknown) => (query.filters.push(['in', c, v]), chain),
        is: (c: string, v: unknown) => (query.filters.push(['is', c, v]), chain),
        gte: (c: string, v: unknown) => (query.filters.push(['gte', c, v]), chain),
        lt: (c: string, v: unknown) => (query.filters.push(['lt', c, v]), chain),
        like: (c: string, v: unknown) => (query.filters.push(['like', c, v]), chain),
        order: () => chain,
        range: (from: number, to: number) => (query.filters.push(['range', 'range', [from, to]]), chain),
        maybeSingle: async () => {
          const result = await run();
          const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
          return { data, error: result.error };
        },
        then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => run().then(resolve, reject),
      };
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const handler = rpcs[name];
      if (!handler) throw new Error(`Unexpected rpc ${name}`);
      const result = handler(args);
      return Promise.resolve({ data: result.data, error: result.error ?? null });
    },
  });
  return { client: client as never, queries, rpcCalls };
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CARD_ID,
    family_id: FAMILY_ID,
    year: 2026,
    status: 'generating',
    language: 'en',
    locale: 'en-US',
    film_id: null,
    share_token: null,
    greeting: 'christmas',
    front_candidates: null,
    letters: null,
    qr_caption: null,
    signature: null,
    edits: {},
    edits_version: 0,
    generation_attempts: 0,
    last_failure_code: null,
    created_at: '2026-10-06T14:00:00Z',
    updated_at: '2026-10-06T14:00:00Z',
    deleted_at: null,
    heartbeat_at: null,
    ...overrides,
  };
}

interface Harness {
  deps: Partial<HolidayCardsDependencies>;
  fake: Fake;
  dispatched: Array<{ cardId: string; attemptId: string }>;
  deletedKeys: string[];
  probed: string[];
  billingCalls: string[];
}

function harness(options: {
  role?: 'owner' | 'manager' | 'viewer' | null;
  tables?: Record<string, TableHandler>;
  rpcs?: Record<string, (args: Record<string, unknown>) => Result>;
  billing?: Response | null;
  dispatchResult?: boolean | 'throw';
  probeResult?: { width: number; height: number } | null;
} = {}): Harness {
  const fake = createFake(options.tables ?? {}, options.rpcs ?? {});
  const dispatched: Harness['dispatched'] = [];
  const deletedKeys: string[] = [];
  const probed: string[] = [];
  const billingCalls: string[] = [];
  const deps: Partial<HolidayCardsDependencies> = {
    getAuthenticatedUser: async () => ({ id: USER_ID, is_anonymous: false } as never),
    createServiceClient: fake.client,
    getCallerFamilyRole: async () => (options.role === undefined ? 'owner' : options.role),
    checkBillingFamilyWrite: async (_client, _family, _user, operation) => {
      billingCalls.push(operation);
      return options.billing ?? null;
    },
    createPresignedGetUrls: async (keys) => Object.fromEntries(keys.map((k) => [k, `https://signed.test/${k}`])),
    deleteObject: async (key) => {
      deletedKeys.push(key);
    },
    dispatchGeneration: async (cardId, attemptId) => {
      dispatched.push({ cardId, attemptId });
      if (options.dispatchResult === 'throw') throw new Error('network');
      return options.dispatchResult ?? true;
    },
    probeDimensions: async (key) => {
      probed.push(key);
      return options.probeResult === undefined ? { width: 2400, height: 1800 } : options.probeResult;
    },
    now: () => NOW,
  };
  return { deps, fake, dispatched, deletedKeys, probed, billingCalls };
}

const call = (body: unknown, deps: Partial<HolidayCardsDependencies>) =>
  handleHolidayCards(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }), deps);

/** Standard create fixtures: no existing card, a US-style family, create RPC returns the row. */
function createTables(card: Record<string, unknown>, extra: { existing?: unknown; captionLanguage?: string; profileTimezone?: string } = {}) {
  return {
    holiday_cards: (q: Query): Result =>
      q.columns.startsWith('id, deleted_at') ? { data: extra.existing ?? null } : { data: card },
    families: () => ({ data: { gallery_caption_language: extra.captionLanguage ?? 'en-US' } }),
    user_profiles: () => ({ data: { timezone: extra.profileTimezone ?? 'UTC' } }),
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

Deno.test('classifyTimezone: US/CA known, real non-US/CA zones outside, everything else unknown', () => {
  assertEquals(classifyTimezone('America/Chicago'), 'us_ca');
  assertEquals(classifyTimezone('Canada/Pacific'), 'us_ca');
  assertEquals(classifyTimezone('Europe/Madrid'), 'outside');
  assertEquals(classifyTimezone('Asia/Tokyo'), 'outside');
  assertEquals(classifyTimezone('America/Bogota'), 'outside');
  for (const unknown of ['UTC', 'Etc/GMT+5', '', '   ', 'Not/AZone', null, undefined, 42, 'x'.repeat(80)]) {
    assertEquals(classifyTimezone(unknown), 'unknown', String(unknown));
  }
});

Deno.test('civilDate follows the timezone, falling back to UTC', () => {
  const late = new Date('2026-12-31T23:30:00Z');
  assertEquals(civilDate(late, 'Asia/Tokyo'), '2027-01-01');
  assertEquals(civilDate(late, 'America/Los_Angeles'), '2026-12-31');
  assertEquals(civilDate(late, null), '2026-12-31');
  assertEquals(civilDate(late, 'Not/AZone'), '2026-12-31');
});

Deno.test('cardLanguageFor maps the family caption language', () => {
  assertEquals(cardLanguageFor('es-CO'), { language: 'es', locale: 'es-CO' });
  assertEquals(cardLanguageFor('en-US'), { language: 'en', locale: 'en-US' });
  assertEquals(cardLanguageFor('es'), { language: 'es', locale: 'es' });
  assertEquals(cardLanguageFor(null), { language: 'en', locale: 'en-US' });
  assertEquals(cardLanguageFor('klingon!!'), { language: 'en', locale: 'en-US' });
});

Deno.test('deriveFilmState covers every film status', () => {
  const film = (status: string, extra: Record<string, unknown> = {}) => ({ status, blocked: false, ready_at: null, ...extra });
  assertEquals(deriveFilmState(null), 'none');
  assertEquals(deriveFilmState(film('queued')), 'rendering');
  assertEquals(deriveFilmState(film('curating')), 'rendering');
  assertEquals(deriveFilmState(film('preparing')), 'rendering');
  assertEquals(deriveFilmState(film('rendering')), 'rendering');
  assertEquals(deriveFilmState(film('ready', { ready_at: '2026-10-06T00:00:00Z' })), 'ready');
  assertEquals(deriveFilmState(film('failed')), 'failed');
  assertEquals(deriveFilmState(film('skipped')), 'none');
  assertEquals(deriveFilmState(film('ended', { ready_at: '2026-10-06T00:00:00Z' })), 'none');
  // Blocked wins over ready; a published film that re-renders or fails a re-render stays ready.
  assertEquals(deriveFilmState(film('ready', { blocked: true, ready_at: 'x' })), 'blocked');
  assertEquals(deriveFilmState(film('rendering', { ready_at: 'x' })), 'ready');
  assertEquals(deriveFilmState(film('failed', { ready_at: 'x' })), 'ready');
});

Deno.test('readFrontCandidates accepts an array or { candidates } and drops malformed entries', () => {
  const entry = { mediaId: MEDIA_A, memoryId: MEMORY_A, rank: 1, cardOrientation: 'landscape', printClass: 'full-bleed', width: 4000, height: 3000, verdict: { why: 'ignored' } };
  assertEquals(readFrontCandidates([entry, { nope: true }, 'x'])[0], {
    mediaId: MEDIA_A, memoryId: MEMORY_A, rank: 1, cardOrientation: 'landscape', printClass: 'full-bleed', width: 4000, height: 3000,
  });
  assertEquals(readFrontCandidates({ candidates: [entry] }).length, 1);
  assertEquals(readFrontCandidates(null), []);
  assertEquals(readFrontCandidates({ candidates: 'x' }), []);
});

// ── Entry point ──────────────────────────────────────────────────────────

Deno.test('rejects an unauthenticated caller, a non-POST, bad JSON and an unknown op', async () => {
  const h = harness();
  assertEquals((await call({ op: 'get', cardId: CARD_ID }, { ...h.deps, getAuthenticatedUser: async () => null })).status, 401);
  assertEquals((await handleHolidayCards(new Request('http://localhost', { method: 'GET' }), h.deps)).status, 405);
  assertEquals((await handleHolidayCards(new Request('http://localhost', { method: 'POST', body: '{' }), h.deps)).status, 400);
  const unknown = await call({ op: 'regenerate_letters', cardId: CARD_ID }, h.deps);
  assertEquals(unknown.status, 400);
  assertEquals((await unknown.json()).code, 'validation_error');
  for (const op of ['refresh_film', 'set_greeting']) assertEquals((await call({ op, cardId: CARD_ID }, h.deps)).status, 400);
});

// ── create ───────────────────────────────────────────────────────────────

const rpcsForCreate = (card: Record<string, unknown>, attempt: number | null = 1) => ({
  create_holiday_card: () => ({ data: card }),
  increment_holiday_card_generation_attempt: () => ({ data: attempt }),
});

Deno.test('create: a US family gets a card, one dispatch, language from the family, no region warning', async () => {
  const card = cardRow();
  const h = harness({ tables: createTables(card, { captionLanguage: 'es-CO' }), rpcs: rpcsForCreate(card) });
  const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Chicago' }, h.deps);
  const json = await res.json();
  assertEquals(res.status, 201);
  assertEquals(json.created, true);
  assertEquals(json.regionWarning, false);
  assertEquals(json.card.id, CARD_ID);
  assertEquals(json.card.generationAttempts, 1);
  assertEquals(json.generation, { state: 'generating', failureCode: null, attempts: 1, dispatched: true });
  assertEquals(Object.keys(json.card).includes('editor_facts'), false);

  const create = h.fake.rpcCalls.find((c) => c.name === 'create_holiday_card')!;
  assertEquals(create.args, {
    p_family_id: FAMILY_ID, p_user_id: USER_ID, p_year: 2026, p_greeting: 'christmas', p_language: 'es', p_locale: 'es-CO',
  });
  const attempt = h.fake.rpcCalls.find((c) => c.name === 'increment_holiday_card_generation_attempt')!;
  assertEquals(attempt.args, { p_card_id: CARD_ID, p_cap: GENERATION_ATTEMPT_CAP });
  assertEquals(GENERATION_ATTEMPT_CAP, 3);
  assertEquals(h.dispatched.length, 1);
  assertEquals(h.dispatched[0].cardId, CARD_ID);
  assertEquals(h.billingCalls, ['holiday_card_create']);
});

Deno.test('create: warn-only region check, a Europe/Lisbon caller still gets a card, a dispatch and regionWarning', async () => {
  const card = cardRow();
  const h = harness({ tables: createTables(card), rpcs: rpcsForCreate(card) });
  const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'holidays', timezone: 'Europe/Lisbon' }, h.deps);
  const json = await res.json();
  assertEquals(res.status, 201);
  assertEquals(json.regionWarning, true);
  assertEquals(h.dispatched.length, 1);

  // The stored account timezone is used when the body has none; unknown zones warn too.
  const stored = harness({ tables: createTables(card, { profileTimezone: 'Europe/Berlin' }), rpcs: rpcsForCreate(card) });
  const storedRes = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas' }, stored.deps);
  assertEquals(storedRes.status, 201);
  assertEquals((await storedRes.json()).regionWarning, true);
  assertEquals(stored.dispatched.length, 1);

  const unknown = harness({ tables: createTables(card, { profileTimezone: 'UTC' }), rpcs: rpcsForCreate(card) });
  assertEquals((await (await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas' }, unknown.deps)).json()).regionWarning, true);
});

Deno.test('create: a double tap returns the same card without a second dispatch', async () => {
  // The first tap already moved the counter and the worker has not reported yet.
  const existing = cardRow({ generation_attempts: 1 });
  const h = harness({
    tables: createTables(existing, { existing: { id: CARD_ID, deleted_at: null } }),
    rpcs: rpcsForCreate(existing, 2),
  });
  const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.created, false);
  assertEquals(json.card.id, CARD_ID);
  assertEquals(h.dispatched, []);
  assertEquals(h.fake.rpcCalls.some((c) => c.name === 'increment_holiday_card_generation_attempt'), false);
});

Deno.test('create: concurrent taps race on the atomic counter, only the caller that moved it 0 -> 1 dispatches', async () => {
  // Both callers read generation_attempts = 0; the loser's increment returns 2.
  const card = cardRow();
  const h = harness({ tables: createTables(card), rpcs: rpcsForCreate(card, 2) });
  const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
  assertEquals(res.status, 201);
  assertEquals(h.dispatched, []);
  // A card whose attempts are exhausted (NULL) never dispatches either.
  const capped = harness({ tables: createTables(card), rpcs: rpcsForCreate(card, null) });
  await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, capped.deps);
  assertEquals(capped.dispatched, []);
});

Deno.test('create: a live lease, or a card that is already ready or failed, is never dispatched', async () => {
  const live = cardRow({ heartbeat_at: '2026-10-06T14:55:00Z' });
  const leased = harness({ tables: createTables(live, { existing: { id: CARD_ID, deleted_at: null } }), rpcs: rpcsForCreate(live) });
  await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, leased.deps);
  assertEquals(leased.dispatched, []);
  for (const status of ['ready', 'failed']) {
    const done = cardRow({ status });
    const h = harness({ tables: createTables(done, { existing: { id: CARD_ID, deleted_at: null } }), rpcs: rpcsForCreate(done) });
    const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
    assertEquals(res.status, 200);
    assertEquals(h.dispatched, [], status);
  }
});

Deno.test('create: a failed or throwing dispatch still returns the card (the sweep recovers it)', async () => {
  for (const dispatchResult of [false, 'throw'] as const) {
    const card = cardRow();
    const h = harness({ tables: createTables(card), rpcs: rpcsForCreate(card), dispatchResult });
    const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
    const json = await res.json();
    assertEquals(res.status, 201);
    assertEquals(json.generation.dispatched, false);
    assertEquals(json.card.status, 'generating');
  }
});

Deno.test('create: slot used by a deleted card is 409, a non-manager is 403, billing and validation short-circuit', async () => {
  const slot = harness({
    tables: createTables(cardRow()),
    rpcs: {
      create_holiday_card: () => ({ data: null, error: { code: '23505', message: 'holiday_card_slot_used', hint: 'holiday_card_slot_used' } }),
    },
  });
  const slotRes = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, slot.deps);
  assertEquals(slotRes.status, 409);
  assertEquals((await slotRes.json()).code, 'holiday_card_slot_used');

  const viewer = harness({ role: 'viewer', tables: createTables(cardRow()) });
  assertEquals((await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas' }, viewer.deps)).status, 403);
  assertEquals(viewer.billingCalls, []);

  const billing = harness({
    tables: createTables(cardRow()),
    billing: new Response(JSON.stringify({ code: 'SUBSCRIPTION_REQUIRED' }), { status: 403 }),
  });
  assertEquals((await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas' }, billing.deps)).status, 403);
  assertEquals(billing.fake.rpcCalls, []);
  assertEquals(billing.dispatched, []);

  const bad = harness();
  assertEquals((await call({ op: 'create', familyId: 'nope', greeting: 'christmas' }, bad.deps)).status, 400);
  assertEquals((await call({ op: 'create', familyId: FAMILY_ID, greeting: 'easter' }, bad.deps)).status, 400);
  assertEquals((await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 5 }, bad.deps)).status, 400);
});

Deno.test('create: the card year follows the caller timezone', async () => {
  const card = cardRow({ year: 2027 });
  const h = harness({ tables: createTables(card), rpcs: rpcsForCreate(card) });
  const lateNewYear = { ...h.deps, now: () => new Date('2026-12-31T23:30:00Z') };
  // Dec 31 evening in Chicago is still 2026; in Berlin it would already be 2027.
  await call({ op: 'create', familyId: FAMILY_ID, greeting: 'new-year', timezone: 'America/Chicago' }, lateNewYear);
  assertEquals(h.fake.rpcCalls.find((c) => c.name === 'create_holiday_card')!.args.p_year, 2026);
});

// ── get ──────────────────────────────────────────────────────────────────

function getTables(options: {
  card?: Record<string, unknown>;
  film?: Record<string, unknown> | null;
  revokedAt?: string | null;
  orders?: Array<{ id: string; status: string }>;
} = {}): Record<string, TableHandler> {
  return {
    holiday_cards: () => ({ data: options.card ?? cardRow() }),
    year_films: () => ({ data: options.film ?? null }),
    film_share_tokens: () => ({ data: { revoked_at: options.revokedAt ?? null } }),
    holiday_card_orders: () => ({ data: options.orders ?? [] }),
    memory_media: () => ({
      data: [
        { id: MEDIA_A, object_key: 'owner/memories/m/media/a.jpg', preview_object_key: 'owner/memories/m/media/a-preview.jpg', content_type: 'image/jpeg', memories: { family_id: FAMILY_ID } },
        { id: MEDIA_FOREIGN, object_key: 'other/f.jpg', preview_object_key: null, content_type: 'image/jpeg', memories: { family_id: OTHER_FAMILY_ID } },
        { id: MEDIA_HEIC, object_key: 'owner/h.heic', preview_object_key: 'owner/h-prev.jpg', content_type: 'image/heic', memories: { family_id: FAMILY_ID } },
      ],
    }),
    memories: () => ({ data: [{ id: MEMORY_A, media_key: 'owner/legacy.jpg', media_content_type: 'image/jpeg' }] }),
  };
}

Deno.test('get: a ready film yields the QR url, signed candidate previews, and never leaks private columns', async () => {
  const card = cardRow({
    status: 'ready',
    film_id: FILM_ID,
    share_token: TOKEN,
    edits: { frontImage: MEDIA_A },
    front_candidates: [{ mediaId: MEDIA_A, memoryId: MEMORY_A, rank: 1, cardOrientation: 'landscape', printClass: 'full-bleed', width: 4000, height: 3000 }, { mediaId: MEDIA_FOREIGN, rank: 2 }, { mediaId: MEDIA_HEIC, rank: 3 }, { mediaId: `legacy:${MEMORY_A}`, rank: 4 }],
    letters: [{ tone: 'classic', text: 'Dear friends' }],
  });
  const h = harness({
    tables: getTables({ card, film: { status: 'ready', blocked: false, ready_at: '2026-10-06T14:30:00Z' }, orders: [{ id: 'o1', status: 'draft' }] }),
  });
  const res = await call({ op: 'get', cardId: CARD_ID }, h.deps);
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.film, { state: 'ready', filmId: FILM_ID, readyAt: '2026-10-06T14:30:00Z' });
  assertEquals(json.qrUrl, `https://m.usemomora.com/f/${TOKEN}`);
  assertEquals(json.linkDisabled, false);
  assertEquals(json.hasOpenCheckout, false);
  assertEquals(json.isOrdered, false);
  // Own-family candidate is signed with its PREVIEW key; the foreign id never resolves.
  assertEquals(json.frontCandidates[0].previewUrl, 'https://signed.test/owner/memories/m/media/a-preview.jpg');
  // Foreign, legacy and HEIC candidates are omitted (only printable family photos are offered).
  assertEquals(json.frontCandidates.length, 1);
  assertEquals(json.frontImage, { mediaId: MEDIA_A, previewUrl: 'https://signed.test/owner/memories/m/media/a-preview.jpg' });
  assertEquals(json.card.letters, [{ tone: 'classic', text: 'Dear friends' }]);
  assertEquals(json.card.edits.version, 1);
  assertEquals(json.card.editsVersion, 0);
  const text = JSON.stringify(json);
  for (const secret of ['editor_facts', 'heartbeat_at', 'attempt_id', 'workflow_instance_id', 'share_token', 'shareToken']) {
    assertEquals(text.includes(secret), false, secret);
  }
  // The card query itself never selects private columns.
  const cardQuery = h.fake.queries.find((q) => q.table === 'holiday_cards')!;
  for (const column of ['editor_facts', 'heartbeat_at', 'attempt_id', 'workflow_instance_id']) {
    assertEquals(cardQuery.columns.includes(column), false, column);
  }
});

Deno.test('get: open checkout and ordered flags come from the orders; a revoked link hides the QR', async () => {
  const card = cardRow({ status: 'ready', film_id: FILM_ID, share_token: TOKEN });
  const film = { status: 'ready', blocked: false, ready_at: 'x' };
  const checkout = harness({ tables: getTables({ card, film, orders: [{ id: 'o1', status: 'checkout' }, { id: 'o2', status: 'cancelled' }] }) });
  const a = await (await call({ op: 'get', cardId: CARD_ID }, checkout.deps)).json();
  assertEquals([a.hasOpenCheckout, a.isOrdered], [true, false]);

  const ordered = harness({ tables: getTables({ card, film, orders: [{ id: 'o1', status: 'shipped' }], revokedAt: '2026-10-06T00:00:00Z' }) });
  const b = await (await call({ op: 'get', cardId: CARD_ID }, ordered.deps)).json();
  assertEquals([b.hasOpenCheckout, b.isOrdered, b.linkDisabled, b.qrUrl], [false, true, true, null]);
});

Deno.test('get: a generating card without a film has film state none, no QR, no previews', async () => {
  const h = harness({ tables: getTables() });
  const json = await (await call({ op: 'get', cardId: CARD_ID }, h.deps)).json();
  assertEquals(json.film.state, 'none');
  assertEquals(json.qrUrl, null);
  assertEquals(json.frontCandidates, []);
  assertEquals(json.frontImage, null);
  assertEquals(json.generation.state, 'generating');
});

Deno.test('get: viewers, strangers, deleted and unknown cards are refused', async () => {
  assertEquals((await call({ op: 'get', cardId: CARD_ID }, harness({ role: 'viewer', tables: getTables() }).deps)).status, 403);
  assertEquals((await call({ op: 'get', cardId: CARD_ID }, harness({ role: null, tables: getTables() }).deps)).status, 403);
  const deleted = harness({ tables: getTables({ card: cardRow({ deleted_at: '2026-10-06T00:00:00Z' }) }) });
  const res = await call({ op: 'get', cardId: CARD_ID }, deleted.deps);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).code, 'card_not_found');
  const missing = harness({ tables: { holiday_cards: () => ({ data: null }) } });
  assertEquals((await call({ op: 'get', cardId: CARD_ID }, missing.deps)).status, 404);
  assertEquals((await call({ op: 'get', cardId: 'nope' }, harness().deps)).status, 400);
});

// ── picker_pool ──────────────────────────────────────────────────────────

function poolRow(n: number, memory: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    memory_id: `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`,
    preview_object_key: `owner/p${n}-preview.jpg`,
    object_key: `owner/p${n}.jpg`,
    aspect_ratio: 1.5,
    content_type: 'image/jpeg',
    memories: {
      memory_date: '2026-03-01', family_id: FAMILY_ID, user_id: USER_ID, topics: [], content: 'A good day at the park',
      onboarding_media_pending: false, ...memory,
    },
  };
}

function poolTables(rows: unknown[], extra: { reports?: string[]; milestones?: Array<Record<string, unknown>> } = {}): Record<string, TableHandler> {
  return {
    holiday_cards: () => ({ data: cardRow() }),
    memory_media: () => ({ data: rows }),
    content_reports: () => ({ data: (extra.reports ?? []).map((target_id) => ({ target_id })) }),
    memory_milestones: () => ({ data: extra.milestones ?? [] }),
  };
}

Deno.test('picker_pool: keys only, the card window, and the same share-safety as the card front', async () => {
  const rows = [
    poolRow(1),
    poolRow(2),
    poolRow(3, { topics: ['bath'] }),
    poolRow(4, { content: 'Her first potty success!' }),
    poolRow(5, { user_id: 'blocked-author' }),
    poolRow(6, { onboarding_media_pending: true }),
    poolRow(7),
    poolRow(8),
  ];
  const h = harness({
    tables: poolTables(rows, {
      reports: [rows[1].memory_id],
      milestones: [{ memory_id: rows[6].memory_id, milestone_id: 'first-bath', status: 'confirmed' }, { memory_id: rows[7].memory_id, milestone_id: 'first-bath', status: 'dismissed' }],
    }),
    rpcs: { year_film_parent_blocked_users: () => ({ data: ['blocked-author'] }) },
  });
  const res = await call({ op: 'picker_pool', cardId: CARD_ID, limit: 50 }, h.deps);
  const json = await res.json();
  assertEquals(res.status, 200);
  // 2 reported, 3 bath topic, 4 text, 5 blocked author, 6 onboarding, 7 sensitive milestone dropped; 8 dismissed milestone stays.
  assertEquals(json.items.map((i: { mediaId: string }) => i.mediaId), [rows[0].id, rows[7].id]);
  assertEquals(json.items[0], {
    memoryId: rows[0].memory_id, mediaId: rows[0].id, previewKey: 'owner/p1-preview.jpg', date: '2026-03-01', aspectRatio: 1.5,
  });
  assertEquals(json.nextCursor, null);
  assertEquals(JSON.stringify(json).includes('signed.test'), false);

  const query = h.fake.queries.find((q) => q.table === 'memory_media')!;
  assertEquals(filterValue(query, 'memories.family_id'), FAMILY_ID);
  // Card year 2026: Dec 1 of the previous year -> UTC today (2026-10-06) + 1 day (exclusive end 10-08).
  assertEquals(filterValue(query, 'memories.memory_date'), '2025-12-01');
  assertEquals(query.filters.find(([k, c]) => k === 'lt' && c === 'memories.memory_date')?.[2], '2026-10-08');
  // Only types the print renderer can decode (no HEIC/HEIF).
  assertEquals(query.filters.find(([k, c]) => k === 'in' && c === 'content_type')?.[2], ['image/jpeg', 'image/png', 'image/webp']);
});

Deno.test('picker_pool: a full raw page returns a cursor, the cursor pages by offset, a bad cursor is a 400', async () => {
  const rows = [poolRow(1), poolRow(2)];
  const h = harness({ tables: poolTables(rows), rpcs: { year_film_parent_blocked_users: () => ({ data: [] }) } });
  const first = await (await call({ op: 'picker_pool', cardId: CARD_ID, limit: 2 }, h.deps)).json();
  assertEquals(first.nextCursor, btoa('2'));
  const next = harness({ tables: poolTables(rows), rpcs: { year_film_parent_blocked_users: () => ({ data: [] }) } });
  await call({ op: 'picker_pool', cardId: CARD_ID, limit: 2, cursor: first.nextCursor }, next.deps);
  assertEquals(next.fake.queries.find((q) => q.table === 'memory_media')!.filters.find(([k]) => k === 'range')?.[2], [2, 3]);
  assertEquals((await call({ op: 'picker_pool', cardId: CARD_ID, cursor: '!!!' }, h.deps)).status, 400);
  assertEquals((await call({ op: 'picker_pool', cardId: CARD_ID, cursor: btoa('-3') }, h.deps)).status, 400);
  // Viewers do not browse the pool.
  assertEquals((await call({ op: 'picker_pool', cardId: CARD_ID }, harness({ role: 'viewer', tables: poolTables(rows) }).deps)).status, 403);
});

// ── save_edits ───────────────────────────────────────────────────────────

function editTables(card: Record<string, unknown> = cardRow({ edits_version: 4 }), media: unknown[] | null = null): Record<string, TableHandler> {
  return {
    holiday_cards: () => ({ data: card }),
    memory_media: () => ({
      data: media ?? [
        { id: MEDIA_A, object_key: 'owner/a.jpg', preview_object_key: 'owner/a-prev.jpg', content_type: 'image/jpeg', memories: { family_id: FAMILY_ID } },
        { id: MEDIA_B, object_key: 'owner/b.jpg', preview_object_key: null, content_type: 'image/jpeg', memories: { family_id: FAMILY_ID } },
        { id: MEDIA_FOREIGN, object_key: 'other/f.jpg', preview_object_key: null, content_type: 'image/jpeg', memories: { family_id: OTHER_FAMILY_ID } },
      ],
    }),
    memories: () => ({ data: [] }),
  };
}

const saveRpc = (result: Result = { data: 5 }) => ({ save_holiday_card_edits: () => result });
const saveBody = (edits: unknown, expectedVersion = 4) => ({ op: 'save_edits', cardId: CARD_ID, expectedVersion, edits });

Deno.test('save_edits: normalizes, strips the greeting and client-supplied keys, saves with the expected version', async () => {
  const h = harness({ tables: editTables(), rpcs: saveRpc() });
  const res = await call(
    saveBody({
      text: { 'front.greeting': 'Merry Christmas', 'bogus.target': 'x' },
      letters: { classic: 'Dear all' },
      focalPoints: { [MEDIA_A]: { x: 0.4, y: 1.7 } },
      frontImage: MEDIA_A,
      frontKey: 'other/stolen.jpg',
      previewUrl: 'https://evil.test/x.jpg',
      choices: { layout: 'full-bleed', tone: 'warm', greeting: 'new-year', qr: false, objectKey: 'other/k.jpg' },
    }),
    h.deps,
  );
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.success, true);
  assertEquals(json.editsVersion, 5);
  const saved = h.fake.rpcCalls.find((c) => c.name === 'save_holiday_card_edits')!;
  assertEquals(saved.args.p_card_id, CARD_ID);
  assertEquals(saved.args.p_expected_version, 4);
  assertEquals(saved.args.p_edits, {
    version: 1,
    text: { 'front.greeting': 'Merry Christmas' },
    letters: { classic: 'Dear all' },
    focalPoints: { [MEDIA_A]: { x: 0.4, y: 1 } },
    frontImage: MEDIA_A,
    choices: { layout: 'full-bleed', tone: 'warm', qr: false },
  });
  assertEquals(json.edits, saved.args.p_edits);
  assertEquals(h.billingCalls, ['holiday_card_edit']);
  // The card's own probed candidate list had no dims for A, so the original was probed once.
  assertEquals(h.probed, ['owner/a.jpg']);
});

Deno.test('save_edits: media must belong to the family and be a photo; nothing is saved otherwise', async () => {
  const h = harness({ tables: editTables(), rpcs: saveRpc() });
  const foreign = await call(saveBody({ frontImage: MEDIA_FOREIGN }), h.deps);
  assertEquals(foreign.status, 404);
  assertEquals((await foreign.json()).code, 'MEDIA_NOT_FOUND');
  const unknown = await call(saveBody({ frontImage: '12121212-1212-4212-8212-121212121212' }), h.deps);
  assertEquals(unknown.status, 404);
  const focalForeign = await call(saveBody({ focalPoints: { [MEDIA_FOREIGN]: { x: 0.5, y: 0.5 } } }), h.deps);
  assertEquals(focalForeign.status, 404);
  const badId = await call(saveBody({ frontImage: '../../etc/passwd' }), h.deps);
  assertEquals(badId.status, 400);
  assertEquals((await badId.json()).code, 'invalid_edits');

  const video = harness({
    tables: editTables(cardRow({ edits_version: 4 }), [{ id: MEDIA_A, object_key: 'o/v.mp4', preview_object_key: null, content_type: 'video/mp4', memories: { family_id: FAMILY_ID } }]),
    rpcs: saveRpc(),
  });
  const notPhoto = await call(saveBody({ frontImage: MEDIA_A }), video.deps);
  assertEquals(notPhoto.status, 400);
  assertEquals((await notPhoto.json()).code, 'MEDIA_NOT_PRINTABLE');

  // A video as a FOCAL key is not a photo; HEIC and legacy ids cannot be the printed front.
  const focalVideo = await call(saveBody({ focalPoints: { [MEDIA_A]: { x: 0.5, y: 0.5 } } }), video.deps);
  assertEquals(focalVideo.status, 400);
  assertEquals((await focalVideo.json()).code, 'MEDIA_NOT_PHOTO');
  const heic = harness({
    tables: editTables(cardRow({ edits_version: 4 }), [{ id: MEDIA_A, object_key: 'o/h.heic', preview_object_key: 'o/h.jpg', content_type: 'image/heic', memories: { family_id: FAMILY_ID } }]),
    rpcs: saveRpc(),
  });
  const heicFront = await call(saveBody({ frontImage: MEDIA_A }), heic.deps);
  assertEquals(heicFront.status, 400);
  assertEquals((await heicFront.json()).code, 'MEDIA_NOT_PRINTABLE');
  // ...but HEIC may keep a focal point (any image).
  assertEquals((await call(saveBody({ focalPoints: { [MEDIA_A]: { x: 0.5, y: 0.5 } } }), heic.deps)).status, 200);
  const legacy = await call(saveBody({ frontImage: `legacy:${MEMORY_A}` }), h.deps);
  assertEquals(legacy.status, 400);
  assertEquals((await legacy.json()).code, 'MEDIA_NOT_PRINTABLE');
  for (const png of ['image/png', 'image/webp']) {
    const ok = harness({
      tables: editTables(cardRow({ edits_version: 4 }), [{ id: MEDIA_A, object_key: 'o/p', preview_object_key: null, content_type: png, memories: { family_id: FAMILY_ID } }]),
      rpcs: saveRpc(),
    });
    assertEquals((await call(saveBody({ frontImage: MEDIA_A }), ok.deps)).status, 200, png);
  }

  for (const run of [h, video]) {
    assertEquals(run.fake.rpcCalls.some((c) => c.name === 'save_holiday_card_edits'), false);
  }
});

Deno.test('save_edits: the front must be printable (probed, or taken from the card\'s candidate list; unchanged fronts are not re-measured)', async () => {
  const low = harness({ tables: editTables(), rpcs: saveRpc(), probeResult: { width: 600, height: 400 } });
  const lowRes = await call(saveBody({ frontImage: MEDIA_A }), low.deps);
  assertEquals(lowRes.status, 422);
  assertEquals((await lowRes.json()).code, 'front_low_resolution');

  const unreadable = harness({ tables: editTables(), rpcs: saveRpc(), probeResult: null });
  const unreadableRes = await call(saveBody({ frontImage: MEDIA_A }), unreadable.deps);
  assertEquals(unreadableRes.status, 422);
  assertEquals((await unreadableRes.json()).code, 'front_unreadable');

  // A candidate the pipeline already probed needs no ranged GET.
  const known = harness({
    tables: editTables(cardRow({ edits_version: 4, front_candidates: [{ mediaId: MEDIA_A, width: 4000, height: 3000 }] })),
    rpcs: saveRpc(),
  });
  assertEquals((await call(saveBody({ frontImage: MEDIA_A }), known.deps)).status, 200);
  assertEquals(known.probed, []);

  // The already-saved front is not re-measured on every later save.
  const unchanged = harness({ tables: editTables(cardRow({ edits_version: 4, edits: { frontImage: MEDIA_B } })), rpcs: saveRpc() });
  assertEquals((await call(saveBody({ frontImage: MEDIA_B, text: { 'back.signature': 'Love, us' } }), unchanged.deps)).status, 200);
  assertEquals(unchanged.probed, []);

  // Clearing the front (null) needs no media at all.
  const cleared = harness({ tables: editTables(), rpcs: saveRpc() });
  assertEquals((await call(saveBody({ frontImage: null }), cleared.deps)).status, 200);
  assertEquals(cleared.probed, []);
});

Deno.test('save_edits: maps the RPC errors to 409 (with the current version), 423, 400 and 404', async () => {
  const stale = harness({
    tables: { ...editTables(), holiday_cards: (q) => (q.columns === 'edits_version' ? { data: { edits_version: 9 } } : { data: cardRow({ edits_version: 4 }) }) },
    rpcs: saveRpc({ data: null, error: { code: '40001', hint: 'edits_version_mismatch' } }),
  });
  const staleRes = await call(saveBody({}), stale.deps);
  assertEquals(staleRes.status, 409);
  assertEquals(await staleRes.json(), { error: 'The card changed since you loaded it', code: 'edits_version_mismatch', currentVersion: 9 });

  const locked = await call(saveBody({}), harness({ tables: editTables(), rpcs: saveRpc({ data: null, error: { code: '55000', hint: 'holiday_card_checkout_open' } }) }).deps);
  assertEquals(locked.status, 423);
  assertEquals((await locked.json()).code, 'holiday_card_checkout_open');

  assertEquals((await call(saveBody({}), harness({ tables: editTables(), rpcs: saveRpc({ data: null, error: { code: '22023' } }) }).deps)).status, 400);
  assertEquals((await call(saveBody({}), harness({ tables: editTables(), rpcs: saveRpc({ data: null, error: { code: 'P0002' } }) }).deps)).status, 404);
  assertEquals((await call(saveBody({}), harness({ tables: editTables(), rpcs: saveRpc({ data: null, error: { code: 'XX000' } }) }).deps)).status, 500);
});

Deno.test('save_edits: input validation, billing gate, role gate', async () => {
  const h = harness({ tables: editTables(), rpcs: saveRpc() });
  for (const expectedVersion of [-1, 1.5, '4', null]) {
    assertEquals((await call({ op: 'save_edits', cardId: CARD_ID, expectedVersion, edits: {} }, h.deps)).status, 400);
  }
  assertEquals((await call({ op: 'save_edits', cardId: CARD_ID, expectedVersion: 4, edits: 'x' }, h.deps)).status, 400);
  assertEquals((await call({ op: 'save_edits', cardId: CARD_ID, expectedVersion: 4, edits: [] }, h.deps)).status, 400);
  assertEquals((await call(saveBody({ text: { 'back.heading': 'a'.repeat(501) } }), h.deps)).status, 400);
  assertEquals((await call(saveBody({ text: { 'back.heading': 'bad\u0007char' } }), h.deps)).status, 400);
  assertEquals((await call(saveBody({ letters: { classic: 'a'.repeat(3001) } }), h.deps)).status, 400);
  assertEquals((await call(saveBody({ letters: { 'not a key!': 'x' } }), h.deps)).status, 400);
  assertEquals((await call(saveBody({ blob: 'a'.repeat(70_000) }), h.deps)).status, 400);
  assertEquals(h.fake.rpcCalls, []);

  const noSub = harness({ tables: editTables(), rpcs: saveRpc(), billing: new Response('{"code":"SUBSCRIPTION_REQUIRED"}', { status: 403 }) });
  assertEquals((await call(saveBody({}), noSub.deps)).status, 403);
  assertEquals(noSub.fake.rpcCalls, []);

  assertEquals((await call(saveBody({}), harness({ role: 'viewer', tables: editTables(), rpcs: saveRpc() }).deps)).status, 403);
});

// ── delete ───────────────────────────────────────────────────────────────

const FILM_DIR = `owner-id/year-films/${FILM_ID}`;

function deleteHarness(options: {
  card?: Record<string, unknown>;
  orders?: Array<{ id: string; status: string }>;
  endResult?: Result;
  role?: 'owner' | 'manager' | 'viewer' | null;
} = {}) {
  const updates: Query[] = [];
  const h = harness({
    role: options.role,
    tables: {
      holiday_cards: (q) => {
        if (q.action === 'update') {
          updates.push(q);
          return { data: null };
        }
        return { data: options.card ?? cardRow({ status: 'ready', film_id: FILM_ID, share_token: TOKEN }) };
      },
      holiday_card_orders: () => ({ data: options.orders ?? [] }),
    },
    rpcs: {
      end_holiday_card_film: () =>
        options.endResult ?? {
          data: { ended: true, film_id: FILM_ID, delete_keys: [`${FILM_DIR}/a1/film.mp4`, `${FILM_DIR}/a1/poster.jpg`, `${FILM_DIR}/a1/poster_thumb.jpg`] },
        },
    },
  });
  return { ...h, updates };
}

Deno.test('delete: soft-deletes the card, ends the film, deletes its artifacts', async () => {
  const h = deleteHarness({ orders: [{ id: 'o1', status: 'draft' }, { id: 'o2', status: 'cancelled' }, { id: 'o3', status: 'failed' }, { id: 'o4', status: 'quoted' }] });
  const res = await call({ op: 'delete', cardId: CARD_ID }, h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { success: true, deleted: true, filmEnded: true });
  assertEquals(h.updates.length, 1);
  assertEquals(h.updates[0].patch, { deleted_at: NOW.toISOString() });
  assertEquals(filterValue(h.updates[0], 'id'), CARD_ID);
  assertEquals(h.fake.rpcCalls, [{ name: 'end_holiday_card_film', args: { p_card_id: CARD_ID } }]);
  assertEquals(h.deletedKeys.sort(), [`${FILM_DIR}/a1/film.mp4`, `${FILM_DIR}/a1/poster.jpg`, `${FILM_DIR}/a1/poster_thumb.jpg`]);
  // Billing never blocks a delete (a lapsed family can still remove its card).
  assertEquals(h.billingCalls, []);
});

Deno.test('delete: refused with 409 card_ordered once any order is paid or later, and with 423 while a checkout is open', async () => {
  for (const status of ['paid', 'submitted', 'in_production', 'shipped']) {
    const h = deleteHarness({ orders: [{ id: 'o1', status }] });
    const res = await call({ op: 'delete', cardId: CARD_ID }, h.deps);
    assertEquals(res.status, 409, status);
    assertEquals((await res.json()).code, 'card_ordered');
    assertEquals(h.updates, []);
    assertEquals(h.fake.rpcCalls, []);
    assertEquals(h.deletedKeys, []);
  }
  const open = deleteHarness({ orders: [{ id: 'o1', status: 'checkout' }] });
  const res = await call({ op: 'delete', cardId: CARD_ID }, open.deps);
  assertEquals(res.status, 423);
  assertEquals((await res.json()).code, 'holiday_card_checkout_open');
  assertEquals(open.updates, []);
});

Deno.test('delete: a quoted order with a FRESH create_checkout claim (print_files.claim, CHECKOUT_CLAIM_TTL_MS) blocks with 423; a stale or absent claim does not', async () => {
  const claim = (agoMs: number) => ({ claim: { id: 'claim-1', at: new Date(NOW.getTime() - agoMs).toISOString() } });
  const fresh = deleteHarness({ orders: [{ id: 'o1', status: 'quoted', print_files: claim(60_000) } as never] });
  const res = await call({ op: 'delete', cardId: CARD_ID }, fresh.deps);
  assertEquals(res.status, 423);
  assertEquals((await res.json()).code, 'holiday_card_checkout_open');
  assertEquals(fresh.updates, []);
  assertEquals(fresh.fake.rpcCalls, []);

  for (const printFiles of [claim(CHECKOUT_CLAIM_TTL_MS + 1), null, { files: [] }, { claim: { id: 'x', at: 'garbage' } }]) {
    const h = deleteHarness({ orders: [{ id: 'o1', status: 'quoted', print_files: printFiles } as never] });
    assertEquals((await call({ op: 'delete', cardId: CARD_ID }, h.deps)).status, 200);
  }
  // A claim on a draft order does not count (only quoted orders run create_checkout).
  const draft = deleteHarness({ orders: [{ id: 'o1', status: 'draft', print_files: claim(1000) } as never] });
  assertEquals((await call({ op: 'delete', cardId: CARD_ID }, draft.deps)).status, 200);
});

Deno.test('delete: only keys inside THIS card\'s film directory are ever deleted (never another film, e.g. the dogfood one)', async () => {
  // RPC answers with a foreign film id and keys: nothing is deleted.
  const foreign = deleteHarness({
    endResult: { data: { ended: true, film_id: OTHER_FILM_ID, delete_keys: [`owner-id/year-films/${OTHER_FILM_ID}/a/film.mp4`] } },
  });
  assertEquals((await call({ op: 'delete', cardId: CARD_ID }, foreign.deps)).status, 200);
  assertEquals(foreign.deletedKeys, []);

  // Right film id but a stray key outside its directory: filtered out.
  const stray = deleteHarness({
    endResult: {
      data: {
        ended: true,
        film_id: FILM_ID,
        delete_keys: [`${FILM_DIR}/a/film.mp4`, `owner-id/year-films/${OTHER_FILM_ID}/a/film.mp4`, 'owner-id/memories/m/media.jpg', 42],
      },
    },
  });
  await call({ op: 'delete', cardId: CARD_ID }, stray.deps);
  assertEquals(stray.deletedKeys, [`${FILM_DIR}/a/film.mp4`]);

  // A card with no film: nothing to delete.
  const noFilm = deleteHarness({
    card: cardRow(),
    endResult: { data: { ended: false, film_id: null, delete_keys: [] } },
  });
  assertEquals(await (await call({ op: 'delete', cardId: CARD_ID }, noFilm.deps)).json(), { success: true, deleted: true, filmEnded: false });
});

Deno.test('delete: R2 failures are best effort, a failed film end is reported (and a retry still works on the deleted card)', async () => {
  const h = deleteHarness();
  const failing = { ...h.deps, deleteObject: async () => { throw new Error('r2 down'); } };
  assertEquals((await call({ op: 'delete', cardId: CARD_ID }, failing)).status, 200);

  const endFails = deleteHarness({ endResult: { data: null, error: { code: 'XX000' } } });
  const res = await call({ op: 'delete', cardId: CARD_ID }, endFails.deps);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).code, 'film_end_failed');

  // Retry on an already soft-deleted card: no second update, the film end runs again.
  const retry = deleteHarness({ card: cardRow({ status: 'ready', film_id: FILM_ID, deleted_at: '2026-10-06T10:00:00Z' }) });
  assertEquals((await call({ op: 'delete', cardId: CARD_ID }, retry.deps)).status, 200);
  assertEquals(retry.updates, []);
  assertEquals(retry.fake.rpcCalls.length, 1);
});

Deno.test('delete: viewers and strangers are refused before anything changes', async () => {
  for (const role of ['viewer', null] as const) {
    const h = deleteHarness({ role });
    assertEquals((await call({ op: 'delete', cardId: CARD_ID }, h.deps)).status, 403);
    assertEquals(h.updates, []);
    assertEquals(h.fake.rpcCalls, []);
  }
});

// ── disable_link ─────────────────────────────────────────────────────────

function disableHarness(options: { role?: 'owner' | 'manager' | 'viewer' | null; card?: Record<string, unknown>; revoked?: unknown[] } = {}) {
  const tokenQueries: Query[] = [];
  const h = harness({
    role: options.role,
    tables: {
      holiday_cards: () => ({ data: options.card ?? cardRow({ status: 'ready', film_id: FILM_ID, share_token: TOKEN }) }),
      film_share_tokens: (q) => {
        tokenQueries.push(q);
        return { data: options.revoked ?? [{ token: TOKEN }] };
      },
    },
  });
  return { ...h, tokenQueries };
}

Deno.test('disable_link: owner only, explicit confirmation, revokes the card film\'s token (even when the card is ordered)', async () => {
  const h = disableHarness();
  const res = await call({ op: 'disable_link', cardId: CARD_ID, confirm: true }, h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { success: true, revoked: true, reason: null });
  assertEquals(h.tokenQueries.length, 1);
  assertEquals(h.tokenQueries[0].action, 'update');
  assertEquals(typeof h.tokenQueries[0].patch?.revoked_at, 'string');
  assertEquals(filterValue(h.tokenQueries[0], 'film_id'), FILM_ID);
  assertEquals(filterValue(h.tokenQueries[0], 'revoked_at'), null);
  // The orders table is never consulted: an ordered card can still be disabled.
  assertEquals(h.fake.queries.some((q) => q.table === 'holiday_card_orders'), false);
  assertEquals(h.billingCalls, []);
});

Deno.test('disable_link: managers, viewers and unconfirmed requests are refused; no-link and already-disabled are reported', async () => {
  const manager = disableHarness({ role: 'manager' });
  assertEquals((await call({ op: 'disable_link', cardId: CARD_ID, confirm: true }, manager.deps)).status, 403);
  assertEquals((await call({ op: 'disable_link', cardId: CARD_ID, confirm: true }, disableHarness({ role: 'viewer' }).deps)).status, 403);
  assertEquals(manager.tokenQueries, []);

  const owner = disableHarness();
  for (const confirm of [undefined, false, 'true', 1]) {
    const res = await call({ op: 'disable_link', cardId: CARD_ID, confirm }, owner.deps);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).code, 'confirmation_required');
  }
  assertEquals(owner.tokenQueries, []);

  const noFilm = disableHarness({ card: cardRow() });
  assertEquals(await (await call({ op: 'disable_link', cardId: CARD_ID, confirm: true }, noFilm.deps)).json(), { success: true, revoked: false, reason: 'no_link' });

  const already = disableHarness({ revoked: [] });
  assertEquals(await (await call({ op: 'disable_link', cardId: CARD_ID, confirm: true }, already.deps)).json(), { success: true, revoked: false, reason: 'already_disabled' });
});

Deno.test('log lines carry ids and codes only: no letter text or names reach console.error', async () => {
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    const card = cardRow({ letters: [{ tone: 'classic', text: 'SECRET LETTER TEXT' }], signature: 'The Fictional Family' });
    const h = harness({ tables: createTables(card), rpcs: rpcsForCreate(card), dispatchResult: false });
    await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
    const failing = harness({ tables: editTables(), rpcs: saveRpc({ data: null, error: { code: 'XX000', message: 'SECRET LETTER TEXT' } }) });
    await call(saveBody({ letters: { classic: 'SECRET LETTER TEXT' } }), failing.deps);
  } finally {
    console.error = realError;
  }
  assertEquals(logged.length > 0, true);
  for (const line of logged) {
    assertEquals(line.includes('SECRET'), false, line);
    assertEquals(line.includes('Fictional'), false, line);
  }
  assertStringIncludes(logged.join('\n'), 'holiday-cards');
});
