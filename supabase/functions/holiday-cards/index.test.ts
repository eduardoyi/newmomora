import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { CHECKOUT_CLAIM_TTL_MS } from '../_shared/holiday-card-fulfillment.ts';
import { buildCardSnapshot } from '../_shared/holiday-card-snapshot.ts';
import {
  CARD_CLAIM_FRESH_MS,
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
  orders: Array<[string, boolean]>;
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
      const query: Query = { table, action: 'select', columns: '', filters: [], orders: [] };
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
        order: (column: string, options?: { ascending?: boolean }) => (query.orders.push([column, options?.ascending !== false]), chain),
        limit: (n: number) => (query.filters.push(['limit', 'limit', n]), chain),
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

const rpcsForCreate = (card: Record<string, unknown>, attempt: number | null = 1, enabled = true) => ({
  holiday_card_family_enabled: () => ({ data: enabled }),
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
      holiday_card_family_enabled: () => ({ data: true }),
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

const MEDIA_PICK = '99999999-9999-4999-8999-999999999999';
const USER_OTHER = '12121212-1212-4212-8212-121212121212';
const MEMBER_MARTA = 'a1a1a1a1-1111-4111-8111-111111111111';
const MEMBER_LUCIA = 'a2a2a2a2-2222-4222-8222-222222222222';

type OrderFixture = {
  id: string;
  status: string;
  packs?: number | null;
  price_cents?: number | null;
  requested_by?: string | null;
  created_at?: string;
  snapshot_hash?: string | null;
  format?: string | null;
  region?: string | null;
  card_snapshot?: unknown;
};

/** Emulates the filters the handler puts on holiday_card_orders (status `in`, ordering, limit). */
function ordersHandler(rows: OrderFixture[]): TableHandler {
  return (q) => {
    let out = rows.map((r) => ({
      packs: null, price_cents: null, requested_by: USER_OTHER, created_at: '2026-10-06T14:10:00Z', snapshot_hash: null, format: null, region: null, card_snapshot: null, ...r,
    }));
    const statuses = q.filters.find(([k, c]) => k === 'in' && c === 'status')?.[2] as string[] | undefined;
    if (statuses) out = out.filter((r) => statuses.includes(r.status));
    const [first] = q.orders;
    if (first?.[0] === 'created_at') out.sort((a, b) => (first[1] ? 1 : -1) * (Date.parse(a.created_at) - Date.parse(b.created_at)));
    const limit = q.filters.find(([k]) => k === 'limit')?.[2] as number | undefined;
    return { data: limit ? out.slice(0, limit) : out };
  };
}

function getTables(options: {
  card?: Record<string, unknown>;
  film?: Record<string, unknown> | null;
  revokedAt?: string | null;
  tokenRow?: 'missing';
  orders?: OrderFixture[];
  media?: unknown[];
  shipByNote?: string | null;
} = {}): Record<string, TableHandler> {
  const media = options.media ?? [
    { id: MEDIA_A, memory_id: MEMORY_A, object_key: 'owner/memories/m/media/a.jpg', preview_object_key: 'owner/memories/m/media/a-preview.jpg', aspect_ratio: 1.33, content_type: 'image/jpeg', memories: { family_id: FAMILY_ID, memory_date: '2026-07-04' } },
    { id: MEDIA_B, memory_id: MEMORY_A, object_key: 'owner/memories/m/media/b.png', preview_object_key: null, aspect_ratio: 0.75, content_type: 'image/png', memories: { family_id: FAMILY_ID, memory_date: '2026-08-15' } },
    { id: MEDIA_PICK, memory_id: MEMORY_A, object_key: 'owner/memories/m/media/pick.jpg', preview_object_key: 'owner/memories/m/media/pick-preview.jpg', aspect_ratio: 0.5, content_type: 'image/jpeg', memories: { family_id: FAMILY_ID, memory_date: '2026-09-01' } },
    { id: MEDIA_FOREIGN, memory_id: MEMORY_A, object_key: 'other/f.jpg', preview_object_key: null, aspect_ratio: 1, content_type: 'image/jpeg', memories: { family_id: OTHER_FAMILY_ID, memory_date: '2026-01-01' } },
    { id: MEDIA_HEIC, memory_id: MEMORY_A, object_key: 'owner/h.heic', preview_object_key: 'owner/h-prev.jpg', aspect_ratio: 1.33, content_type: 'image/heic', memories: { family_id: FAMILY_ID, memory_date: '2026-02-02' } },
  ];
  return {
    holiday_cards: () => ({ data: options.card ?? cardRow() }),
    year_films: () => ({ data: options.film ?? null }),
    film_share_tokens: () => ({ data: options.tokenRow === 'missing' ? null : { revoked_at: options.revokedAt ?? null } }),
    holiday_card_orders: ordersHandler(options.orders ?? []),
    memory_media: (q) => {
      const ids = q.filters.find(([k, c]) => k === 'in' && c === 'id')?.[2] as string[] | undefined;
      return { data: ids ? media.filter((m) => ids.includes((m as { id: string }).id)) : media };
    },
    memories: () => ({ data: [{ id: MEMORY_A, media_key: 'owner/legacy.jpg', media_content_type: 'image/jpeg' }] }),
    families: () => ({ data: { name: 'Rivera Soto' } }),
    holiday_card_settings: () => ({ data: { ship_by_note: options.shipByNote ?? null } }),
    family_members: () => ({
      data: [
        { id: MEMBER_MARTA, name: 'Marta Rivera', date_of_birth: '1989-05-05', relationship: 'parent', illustrated_profile_key: 'owner/portraits/marta.png', illustrated_profile_status: 'ready' },
        { id: MEMBER_LUCIA, name: 'Lucia Rivera', date_of_birth: '2022-03-02', relationship: 'child', illustrated_profile_key: 'owner/portraits/lucia-now.png', illustrated_profile_status: 'ready' },
      ],
    }),
    family_member_portrait_versions: () => ({
      data: [
        { id: 'v1', family_member_id: MEMBER_LUCIA, reference_date: '2026-01-01', profile_picture_key: 'owner/in/lucia.jpg', illustrated_profile_key: 'owner/portraits/lucia-jan.png', illustrated_profile_status: 'ready', deletion_token: null, created_at: '2026-01-02T00:00:00Z' },
      ],
    }),
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
    tables: getTables({ card, film: { status: 'ready', blocked: false, ready_at: '2026-10-06T14:30:00Z', video_key: 'films/a.mp4' }, orders: [{ id: 'o1', status: 'draft' }] }),
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
  // The editor view: unordered, one printable candidate, the chosen front signed from its ORIGINAL, QR on.
  assertEquals(json.editorView.locked, false);
  assertEquals(json.editorView.qrState, 'on');
  assertEquals(json.editorView.frontMissing, false);
  assertEquals(json.editorView.cardData.frontOptions.map((o: { id: string }) => o.id), [MEDIA_A]);
  assertEquals(json.editorView.assets['assets/photo-55555555.jpg'], 'https://signed.test/owner/memories/m/media/a.jpg');
  assertEquals(json.editorView.cardData.qr.url, `https://m.usemomora.com/f/${TOKEN}`);
  assertEquals(json.openCheckout, null);
  assertEquals(json.myOrders, []);
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
  // An ordered card whose frozen snapshot is unreadable still answers (status/orders), without a made-up view.
  assertEquals(b.editorView, null);
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
    memory_media: (q) => {
      // Honour the .range() the handler asks for (the real table pages by offset).
      const range = q.filters.find(([k]) => k === 'range')?.[2] as [number, number] | undefined;
      return { data: range ? rows.slice(range[0], range[1] + 1) : rows };
    },
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

Deno.test('picker_pool: newest first (date desc, id desc) and each photo carries its aspect ratio (null allowed)', async () => {
  const rows = [poolRow(1), { ...poolRow(2), aspect_ratio: null }];
  const h = harness({ tables: poolTables(rows), rpcs: { year_film_parent_blocked_users: () => ({ data: [] }) } });
  const json = await (await call({ op: 'picker_pool', cardId: CARD_ID }, h.deps)).json();
  assertEquals(json.items.map((i: { aspectRatio: number | null }) => i.aspectRatio), [1.5, null]);
  const query = h.fake.queries.find((q) => q.table === 'memory_media')!;
  assertEquals(query.orders, [['memories(memory_date)', false], ['id', false]]);
});

Deno.test('picker_pool: the cursor points at the first photo NOT returned, so a cursor never leads to an empty page', async () => {
  const rows = [poolRow(1), poolRow(2), poolRow(3)];
  const rpcs = { year_film_parent_blocked_users: () => ({ data: [] }) };
  const first = await (await call({ op: 'picker_pool', cardId: CARD_ID, limit: 2 }, harness({ tables: poolTables(rows), rpcs }).deps)).json();
  assertEquals(first.items.map((i: { mediaId: string }) => i.mediaId), [rows[0].id, rows[1].id]);
  assertEquals(first.nextCursor, btoa('2'));
  const second = await (await call({ op: 'picker_pool', cardId: CARD_ID, limit: 2, cursor: first.nextCursor }, harness({ tables: poolTables(rows), rpcs }).deps)).json();
  assertEquals(second.items.map((i: { mediaId: string }) => i.mediaId), [rows[2].id]);
  assertEquals(second.nextCursor, null);

  // Exactly `limit` photos left: no cursor (nothing more to show).
  const exact = await (await call({ op: 'picker_pool', cardId: CARD_ID, limit: 3 }, harness({ tables: poolTables(rows), rpcs }).deps)).json();
  assertEquals([exact.items.length, exact.nextCursor], [3, null]);

  const bad = harness({ tables: poolTables(rows), rpcs });
  assertEquals((await call({ op: 'picker_pool', cardId: CARD_ID, cursor: '!!!' }, bad.deps)).status, 400);
  assertEquals((await call({ op: 'picker_pool', cardId: CARD_ID, cursor: btoa('-3') }, bad.deps)).status, 400);
  // Viewers do not browse the pool.
  assertEquals((await call({ op: 'picker_pool', cardId: CARD_ID }, harness({ role: 'viewer', tables: poolTables(rows) }).deps)).status, 403);
});

Deno.test('picker_pool: unsafe rows are skipped server-side across raw pages: the page fills up to the limit, never empty while photos remain', async () => {
  // 60 raw rows: the first 55 are unsafe (a bath topic), then 5 fine ones. A page of 3 must come back full (raw batches are 50).
  const rows = Array.from({ length: 60 }, (_, i) => poolRow(i + 1, i < 55 ? { topics: ['bath'] } : {}));
  const rpcs = { year_film_parent_blocked_users: () => ({ data: [] }) };
  const h = harness({ tables: poolTables(rows), rpcs });
  const json = await (await call({ op: 'picker_pool', cardId: CARD_ID, limit: 3 }, h.deps)).json();
  assertEquals(json.items.map((i: { mediaId: string }) => i.mediaId), [rows[55].id, rows[56].id, rows[57].id]);
  // The cursor resumes at the first photo not returned (raw offset 58), and the next page has the remaining two.
  assertEquals(json.nextCursor, btoa('58'));
  const next = await (await call({ op: 'picker_pool', cardId: CARD_ID, limit: 3, cursor: json.nextCursor }, harness({ tables: poolTables(rows), rpcs }).deps)).json();
  assertEquals(next.items.length, 2);
  assertEquals(next.nextCursor, null);
  // Everything unsafe: an empty pool ends with no cursor instead of an endless chain of empty pages.
  const none = await (await call({ op: 'picker_pool', cardId: CARD_ID, limit: 3 }, harness({ tables: poolTables(rows.slice(0, 10)), rpcs }).deps)).json();
  assertEquals([none.items, none.nextCursor], [[], null]);
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

Deno.test('delete: a fresh CARD-level checkout claim (checkout_order_id + checkout_claimed_at < 10 min) blocks with 423; a stale or absent claim does not', async () => {
  const claimed = (agoMs: number | null, orderId: string | null = 'o1') =>
    cardRow({ status: 'ready', film_id: FILM_ID, share_token: TOKEN, checkout_order_id: orderId, checkout_claimed_at: agoMs === null ? null : new Date(NOW.getTime() - agoMs).toISOString() });
  const fresh = deleteHarness({ card: claimed(60_000), orders: [{ id: 'o1', status: 'quoted' }] });
  const res = await call({ op: 'delete', cardId: CARD_ID }, fresh.deps);
  assertEquals(res.status, 423);
  assertEquals((await res.json()).code, 'holiday_card_checkout_open');
  assertEquals(fresh.updates, []);
  assertEquals(fresh.fake.rpcCalls, []);
  for (const card of [claimed(CARD_CLAIM_FRESH_MS + 1), claimed(null), claimed(60_000, null)]) {
    const h = deleteHarness({ card, orders: [{ id: 'o1', status: 'quoted' }] });
    assertEquals((await call({ op: 'delete', cardId: CARD_ID }, h.deps)).status, 200);
  }
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

// ── create: the server switch ────────────────────────────────────────────

Deno.test('create: refuses a NEW card with 403 HOLIDAY_CARDS_DISABLED when the switch is off for the family', async () => {
  const card = cardRow();
  const h = harness({ tables: createTables(card), rpcs: rpcsForCreate(card, 1, false) });
  const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, 'HOLIDAY_CARDS_DISABLED');
  assertEquals(h.fake.rpcCalls.map((c) => c.name), ['holiday_card_family_enabled']);
  assertEquals(h.fake.rpcCalls[0].args, { p_family_id: FAMILY_ID });
  assertEquals(h.dispatched, []);
});

Deno.test('create: with the switch off an EXISTING card is still returned (checked after the existing-card lookup)', async () => {
  const existing = cardRow({ generation_attempts: 1 });
  const h = harness({
    tables: createTables(existing, { existing: { id: CARD_ID, deleted_at: null } }),
    rpcs: rpcsForCreate(existing, 2, false),
  });
  const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals([json.created, json.card.id], [false, CARD_ID]);
  assertEquals(h.fake.rpcCalls.some((c) => c.name === 'holiday_card_family_enabled'), false);
});

Deno.test('create: a failing switch lookup fails closed (500, nothing created)', async () => {
  const card = cardRow();
  const h = harness({
    tables: createTables(card),
    rpcs: { ...rpcsForCreate(card), holiday_card_family_enabled: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) },
  });
  const res = await call({ op: 'create', familyId: FAMILY_ID, greeting: 'christmas', timezone: 'America/Denver' }, h.deps);
  assertEquals(res.status, 500);
  assertEquals(h.fake.rpcCalls.some((c) => c.name === 'create_holiday_card'), false);
});

// ── save_edits: ordered cards ────────────────────────────────────────────

Deno.test('save_edits: card_ordered (message or hint) is a 409 card_ordered; the open-checkout lock stays 423', async () => {
  for (const error of [
    { code: 'P0001', message: 'card_ordered', hint: 'card_ordered' },
    { code: 'P0001', message: 'card_ordered' },
    { code: 'P0001', hint: 'card_ordered' },
  ]) {
    const h = harness({ tables: editTables(), rpcs: saveRpc({ data: null, error }) });
    const res = await call(saveBody({ letters: { classic: 'x' } }), h.deps);
    assertEquals(res.status, 409);
    assertEquals((await res.json()).code, 'card_ordered');
  }
  const locked = harness({ tables: editTables(), rpcs: saveRpc({ data: null, error: { code: '55000', message: 'holiday_card_checkout_open', hint: 'holiday_card_checkout_open' } }) });
  const res = await call(saveBody({ letters: { classic: 'x' } }), locked.deps);
  assertEquals(res.status, 423);
  assertEquals((await res.json()).code, 'holiday_card_checkout_open');
});

// ── get: the editor view ─────────────────────────────────────────────────

const PUBLISHED_FILM = { status: 'ready', blocked: false, ready_at: '2026-10-06T14:30:00Z', video_key: 'films/a.mp4' };

function readyCard(overrides: Record<string, unknown> = {}) {
  return cardRow({
    status: 'ready',
    film_id: FILM_ID,
    share_token: TOKEN,
    front_candidates: [
      { mediaId: MEDIA_A, memoryId: MEMORY_A, rank: 1, width: 4000, height: 3000 },
      { mediaId: MEDIA_B, memoryId: MEMORY_A, rank: 2, width: 3000, height: 4000 },
      { mediaId: MEDIA_HEIC, rank: 3, width: 4000, height: 3000 },
    ],
    letters: [{ tone: 'classic', text: 'Dear friends' }, { tone: 'warm', text: 'Dearest ones' }, { tone: 'playful', text: 'Hi hi' }],
    signature: 'Marta and Lucia',
    qr_caption: 'Watch our year',
    ...overrides,
  });
}

const getView = async (h: Harness) => await (await call({ op: 'get', cardId: CARD_ID }, h.deps)).json();

Deno.test('get editorView: every printable candidate plus the saved non-candidate front; the chosen front signed from its original', async () => {
  const card = readyCard({ edits: { frontImage: MEDIA_PICK, focalPoints: { [MEDIA_PICK]: { x: 0.3, y: 0.6 } }, choices: { tone: 'warm', layout: 'full-bleed' } } });
  const h = harness({ tables: getTables({ card, film: PUBLISHED_FILM }) });
  const json = await getView(h);
  const view = json.editorView;
  assertEquals(view.locked, false);
  // The HEIC candidate cannot be printed: absent. The pick (not a candidate) is appended, sized from its aspect ratio 0.5.
  assertEquals(view.cardData.frontOptions.map((o: { id: string }) => o.id), [MEDIA_A, MEDIA_B, MEDIA_PICK]);
  assertEquals(view.cardData.frontOptions.map((o: { rank?: number }) => o.rank), [1, 2, undefined]);
  assertEquals(view.cardData.frontOptions[0], {
    id: MEDIA_A, kind: 'photo', file: 'assets/photo-55555555.jpg', thumb: 'assets/thumb-55555555.jpg', width: 4000, height: 3000, date: '2026-07-04', rank: 1,
  });
  assertEquals(view.cardData.frontOptions[2], {
    id: MEDIA_PICK, kind: 'photo', file: 'assets/photo-99999999.jpg', thumb: 'assets/thumb-99999999.jpg', width: 1500, height: 3000, date: '2026-09-01',
  });
  // The default photo (no pick) is candidate #1; the saved pick is the chosen front.
  assertEquals(view.cardData.photo.mediaId, MEDIA_A);
  assertEquals(view.frontMissing, false);
  assertEquals(view.edits.frontImage, MEDIA_PICK);
  assertEquals(view.edits.focalPoints, { [MEDIA_PICK]: { x: 0.3, y: 0.6 } });
  // Assets: chosen front from its ORIGINAL, other options from their PREVIEW (the original when there is none), thumbs from previews.
  assertEquals(view.assets['assets/photo-99999999.jpg'], 'https://signed.test/owner/memories/m/media/pick.jpg');
  assertEquals(view.assets['assets/thumb-99999999.jpg'], 'https://signed.test/owner/memories/m/media/pick-preview.jpg');
  assertEquals(view.assets['assets/photo-55555555.jpg'], 'https://signed.test/owner/memories/m/media/a-preview.jpg');
  assertEquals(view.assets['assets/photo-66666666.png'], 'https://signed.test/owner/memories/m/media/b.png');
  // Card content: stored writer tone `warm` is the renderer's `reflective`, in the letters and in the edits.
  assertEquals(view.cardData.letters.map((l: { tone: string }) => l.tone), ['classic', 'reflective', 'playful']);
  assertEquals(view.edits.choices.tone, 'reflective');
  assertEquals(
    [view.cardData.format, view.cardData.familyName, view.cardData.greeting, view.cardData.signature, view.cardData.qrCaption, view.cardData.year, view.cardData.slug],
    ['5R', 'Rivera Soto', 'christmas', 'Marta and Lucia', 'Watch our year', 2026, CARD_ID],
  );
});

Deno.test('get editorView: portraits as of the card date (dated version wins), square 1024 without any R2 probe', async () => {
  let fetched = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => { fetched++; return Promise.reject(new Error('no network')); }) as typeof fetch;
  try {
    const h = harness({ tables: getTables({ card: readyCard(), film: PUBLISHED_FILM }) });
    const view = (await getView(h)).editorView;
    assertEquals(view.cardData.portraits.map((p: { name: string; role: string; file: string; width: number; height: number }) => [p.name, p.role, p.file, p.width, p.height]), [
      ['Marta', 'parent', 'assets/portrait-a1a1a1a1.png', 1024, 1024],
      ['Lucia', 'child', 'assets/portrait-a2a2a2a2.png', 1024, 1024],
    ]);
    // Lucia's dated version applies, not her current portrait.
    assertEquals(view.assets['assets/portrait-a2a2a2a2.png'], 'https://signed.test/owner/portraits/lucia-jan.png');
    assertEquals(view.assets['assets/portrait-a1a1a1a1.png'], 'https://signed.test/owner/portraits/marta.png');
    assertEquals(h.probed, []);
    assertEquals(fetched, 0);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('get editorView: frontMissing when the saved front (or, with no pick, the default front) is not a printable family photo', async () => {
  // A pick that is HEIC, foreign or gone.
  for (const frontImage of [MEDIA_HEIC, MEDIA_FOREIGN, '12345678-1234-4234-8234-123456789012', `legacy:${MEMORY_A}`]) {
    const h = harness({ tables: getTables({ card: readyCard({ edits: { frontImage } }), film: PUBLISHED_FILM }) });
    const view = (await getView(h)).editorView;
    assertEquals(view.frontMissing, true, frontImage);
    // The other candidates are still offered and the default photo exists (the editor forces a re-pick).
    assertEquals(view.cardData.frontOptions.map((o: { id: string }) => o.id), [MEDIA_A, MEDIA_B]);
  }
  // No pick and NO candidate printable: missing.
  const allHeic = readyCard({ front_candidates: [{ mediaId: MEDIA_HEIC, rank: 1, width: 4000, height: 3000 }] });
  assertEquals((await getView(harness({ tables: getTables({ card: allHeic, film: PUBLISHED_FILM }) }))).editorView.frontMissing, true);
  // No candidates at all: missing with a zero-size placeholder photo.
  const none = (await getView(harness({ tables: getTables({ card: readyCard({ front_candidates: [] }), film: PUBLISHED_FILM }) }))).editorView;
  assertEquals([none.frontMissing, none.cardData.frontOptions, none.cardData.photo.width], [true, [], 0]);
  // Pick = candidate #1 explicitly, and no pick: both fine.
  for (const edits of [{ frontImage: MEDIA_A }, {}]) {
    const ok = (await getView(harness({ tables: getTables({ card: readyCard({ edits }), film: PUBLISHED_FILM }) }))).editorView;
    assertEquals(ok.frontMissing, false);
  }
});

Deno.test('get editorView: no pick and candidate #1 unusable -> the first USABLE candidate is the front, not missing; an unusable pick still is', async () => {
  const heicFirst = readyCard({ front_candidates: [{ mediaId: MEDIA_HEIC, rank: 1, width: 4000, height: 3000 }, { mediaId: MEDIA_B, rank: 2, width: 3000, height: 4000 }] });
  const view = (await getView(harness({ tables: getTables({ card: heicFirst, film: PUBLISHED_FILM }) }))).editorView;
  assertEquals([view.frontMissing, view.cardData.photo.mediaId], [false, MEDIA_B]);
  // Re-picking that same photo (saved as no pick) is stable: still not missing.
  assertEquals(view.assets['assets/photo-66666666.png'], 'https://signed.test/owner/memories/m/media/b.png');
  // An explicit pick that is unusable stays missing (never silently replaced).
  const badPick = readyCard({ edits: { frontImage: MEDIA_HEIC } });
  assertEquals((await getView(harness({ tables: getTables({ card: badPick, film: PUBLISHED_FILM }) }))).editorView.frontMissing, true);
});

Deno.test('get: shipByNote comes from holiday_card_settings (trimmed), null when empty or unreadable', async () => {
  const note = await getView(harness({ tables: getTables({ card: readyCard(), shipByNote: '  Order by Dec 10 for Christmas delivery  ' }) }));
  assertEquals(note.shipByNote, 'Order by Dec 10 for Christmas delivery');
  assertEquals((await getView(harness({ tables: getTables({ card: readyCard() }) }))).shipByNote, null);
  assertEquals((await getView(harness({ tables: getTables({ card: readyCard(), shipByNote: '   ' }) }))).shipByNote, null);
  const broken = harness({ tables: { ...getTables({ card: readyCard() }), holiday_card_settings: () => ({ data: null, error: { code: 'XX000' } }) } });
  const res = await call({ op: 'get', cardId: CARD_ID }, broken.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).shipByNote, null);
  // Also present while the card is generating.
  assertEquals((await getView(harness({ tables: getTables({ shipByNote: 'x' }) }))).shipByNote, 'x');
});

Deno.test('get editorView: absent while generating, absent without letters', async () => {
  const generating = await getView(harness({ tables: getTables({ card: readyCard({ status: 'generating' }) }) }));
  assertEquals(generating.editorView, null);
  const failedEarly = await getView(harness({ tables: getTables({ card: readyCard({ status: 'failed', letters: null }) }) }));
  assertEquals(failedEarly.editorView, null);
  assertEquals(failedEarly.generation.state, 'failed');
});

Deno.test('get editorView: qrState follows the token, the choice and the film (carried url even when off)', async () => {
  const state = async (opts: { card?: Record<string, unknown>; film?: Record<string, unknown> | null; revokedAt?: string | null; tokenRow?: 'missing' }) => {
    const view = (await getView(harness({ tables: getTables({ card: opts.card ?? readyCard(), film: opts.film === undefined ? PUBLISHED_FILM : opts.film, revokedAt: opts.revokedAt, tokenRow: opts.tokenRow }) }))).editorView;
    return [view.qrState, view.cardData.qr.enabled, view.cardData.qr.url] as const;
  };
  const url = `https://m.usemomora.com/f/${TOKEN}`;
  assertEquals(await state({}), ['on', true, url]);
  assertEquals(await state({ film: { status: 'rendering', blocked: false, ready_at: null, video_key: null } }), ['waiting_film', true, url]);
  assertEquals(await state({ card: readyCard({ edits: { choices: { qr: false } } }) }), ['off', true, url]);
  assertEquals(await state({ revokedAt: '2026-10-06T00:00:00Z' }), ['off', false, url]);
  assertEquals(await state({ film: { ...PUBLISHED_FILM, blocked: true } }), ['unavailable', false, url]);
  assertEquals(await state({ film: { status: 'failed', blocked: false, ready_at: null, video_key: null } }), ['unavailable', false, url]);
  assertEquals(await state({ tokenRow: 'missing' }), ['unavailable', false, url]);
  assertEquals(await state({ card: readyCard({ film_id: null, share_token: null }), film: null }), ['unavailable', false, '']);
});

// ── get: ordered cards read the first paid order's frozen snapshot ───────

function frozen(letter: string, extra: { mediaKey?: string } = {}) {
  const snap = buildCardSnapshot({
    cardId: CARD_ID,
    year: 2026,
    language: 'en',
    locale: 'en-US',
    greeting: 'christmas',
    familyName: 'Rivera Soto',
    signature: 'Marta and Lucia',
    qrCaption: 'Watch our year',
    shareToken: TOKEN,
    format: '5R',
    letters: [{ tone: 'classic', text: letter }],
    edits: { frontImage: MEDIA_A },
    frontCandidateIds: [MEDIA_A],
    media: [{ id: MEDIA_A, originalKey: extra.mediaKey ?? 'owner/frozen/front.jpg', previewKey: 'owner/frozen/front-prev.jpg', width: 4000, height: 3000, date: '2026-07-04' }],
    people: [{ id: MEMBER_MARTA, name: 'Marta', dateOfBirth: '1989-05-05', relationship: 'parent', illustratedProfileKey: 'owner/frozen/marta.png', illustratedProfileStatus: 'ready' }],
    portraitVersions: [],
    portraitDimensions: { 'owner/frozen/marta.png': { width: 800, height: 900 } },
    asOfDate: '2026-10-06',
  });
  return { card: snap.card, edits: snap.edits, assets: snap.assets, qrUrl: snap.qrUrl, front: snap.front };
}

Deno.test('get: an ordered card shows the FIRST paid order\'s frozen snapshot (locked), signed from the snapshot keys', async () => {
  const card = readyCard({ edits: { letters: { classic: 'EDITED AFTER THE ORDER' } } });
  const orders: OrderFixture[] = [
    // Cancelled and refunded-looking orders never lock and are never "first"; the oldest PAID order wins.
    { id: 'o0', status: 'cancelled', created_at: '2026-09-28T10:00:00Z', card_snapshot: frozen('Cancelled order letter') },
    { id: 'o1', status: 'shipped', created_at: '2026-10-01T10:00:00Z', packs: 2, price_cents: 4980, requested_by: USER_ID, card_snapshot: frozen('First order letter') },
    { id: 'o2', status: 'paid', created_at: '2026-10-03T10:00:00Z', packs: 3, price_cents: 7470, requested_by: USER_ID, card_snapshot: frozen('Reorder letter', { mediaKey: 'owner/frozen/other.jpg' }) },
  ];
  const h = harness({ tables: getTables({ card, film: PUBLISHED_FILM, orders }) });
  const json = await getView(h);
  const view = json.editorView;
  assertEquals(json.isOrdered, true);
  assertEquals(view.locked, true);
  assertEquals(view.cardData.letters, [{ tone: 'classic', text: 'First order letter' }]);
  assertEquals(view.edits.frontImage, MEDIA_A);
  assertEquals(view.frontMissing, false);
  assertEquals(view.qrState, 'on');
  assertEquals(view.assets, {
    'assets/photo-55555555.jpg': 'https://signed.test/owner/frozen/front.jpg',
    'assets/portrait-a1a1a1a1.png': 'https://signed.test/owner/frozen/marta.png',
  });
  // The frozen view never touches the live card rows.
  for (const table of ['families', 'family_members', 'family_member_portrait_versions']) {
    assertEquals(h.fake.queries.some((q) => q.table === table), false, table);
  }
  const snapshotQuery = h.fake.queries.filter((q) => q.table === 'holiday_card_orders').find((q) => q.columns.includes('card_snapshot'))!;
  assertEquals(snapshotQuery.filters.find(([k, c]) => k === 'in' && c === 'status')?.[2], ['paid', 'submitted', 'in_production', 'shipped']);
  assertEquals(snapshotQuery.orders[0], ['created_at', true]);
});

Deno.test('get: only cancelled / failed / unpaid orders do not lock the card (live editable view)', async () => {
  const orders: OrderFixture[] = [
    { id: 'o0', status: 'cancelled', created_at: '2026-09-28T10:00:00Z', card_snapshot: frozen('Cancelled order letter') },
    { id: 'o1', status: 'failed', created_at: '2026-09-29T10:00:00Z', card_snapshot: frozen('Failed order letter') },
    { id: 'o2', status: 'quoted', created_at: '2026-09-30T10:00:00Z' },
  ];
  const json = await getView(harness({ tables: getTables({ card: readyCard(), film: PUBLISHED_FILM, orders }) }));
  assertEquals(json.isOrdered, false);
  assertEquals(json.editorView.locked, false);
  assertEquals(json.editorView.cardData.letters[0].text, 'Dear friends');
});

Deno.test('get: a frozen snapshot whose QR printed is live-checked (revoked link -> off); one that printed no QR stays off', async () => {
  const printedQr = frozen('Letter');
  const orders: OrderFixture[] = [{ id: 'o1', status: 'paid', created_at: '2026-10-01T10:00:00Z', card_snapshot: printedQr }];
  const revoked = await getView(harness({ tables: getTables({ card: readyCard(), film: PUBLISHED_FILM, orders, revokedAt: '2026-10-06T00:00:00Z' }) }));
  assertEquals(revoked.editorView.qrState, 'off');
  const noQr = { ...printedQr, card: { ...printedQr.card, qr: { enabled: false, token: '', url: '' } } };
  const printedNone = await getView(harness({ tables: getTables({ card: readyCard(), film: PUBLISHED_FILM, orders: [{ ...orders[0], card_snapshot: noQr }] }) }));
  assertEquals(printedNone.editorView.qrState, 'off');
});

// ── get: openCheckout + myOrders ─────────────────────────────────────────

Deno.test('get: openCheckout names the open order (mine only for its buyer) or a fresh card-level claim; myOrders are the caller\'s, newest first', async () => {
  const film = PUBLISHED_FILM;
  const orders: OrderFixture[] = [
    { id: 'o-old', status: 'shipped', created_at: '2026-10-01T10:00:00Z', packs: 2, price_cents: 4980, requested_by: USER_ID, card_snapshot: frozen('L') },
    { id: 'o-other', status: 'checkout', created_at: '2026-10-05T10:00:00Z', packs: 5, price_cents: 12450, requested_by: USER_OTHER },
    { id: 'o-new', status: 'draft', created_at: '2026-10-06T09:00:00Z', packs: null, price_cents: null, requested_by: USER_ID },
  ];
  const json = await getView(harness({ tables: getTables({ card: readyCard(), film, orders }) }));
  assertEquals(json.openCheckout, { orderId: 'o-other', mine: false });
  assertEquals(json.hasOpenCheckout, true);
  assertEquals(json.myOrders, [
    { id: 'o-new', status: 'draft', packs: null, cards: null, priceCents: null, createdAt: '2026-10-06T09:00:00Z' },
    { id: 'o-old', status: 'shipped', packs: 2, cards: 20, priceCents: 4980, createdAt: '2026-10-01T10:00:00Z' },
  ]);

  const mine = await getView(harness({ tables: getTables({ card: readyCard(), film, orders: [{ id: 'o-mine', status: 'checkout', requested_by: USER_ID, packs: 3, price_cents: 7470 }] }) }));
  assertEquals(mine.openCheckout, { orderId: 'o-mine', mine: true });

  // No order in `checkout` yet, but create_checkout holds the card (fresh claim): open. A stale claim is not.
  const claimed = (at: string) => readyCard({ checkout_order_id: 'o-claim', checkout_claimed_at: at });
  const claimOrders: OrderFixture[] = [{ id: 'o-claim', status: 'quoted', requested_by: USER_ID, packs: 2, price_cents: 4980 }];
  const fresh = await getView(harness({ tables: getTables({ card: claimed('2026-10-06T14:55:00Z'), film, orders: claimOrders }) }));
  assertEquals([fresh.openCheckout, fresh.hasOpenCheckout], [{ orderId: 'o-claim', mine: true }, true]);
  const stale = await getView(harness({ tables: getTables({ card: claimed('2026-10-06T14:49:00Z'), film, orders: claimOrders }) }));
  assertEquals([stale.openCheckout, stale.hasOpenCheckout], [null, false]);
  const noClaim = await getView(harness({ tables: getTables({ card: readyCard(), film, orders: claimOrders }) }));
  assertEquals(noClaim.openCheckout, null);
});

Deno.test('get: a database failure while building the editor view is a 500 (never a silent empty view)', async () => {
  const tables = getTables({ card: readyCard(), film: PUBLISHED_FILM });
  const res = await call({ op: 'get', cardId: CARD_ID }, harness({ tables: { ...tables, family_members: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) } }).deps);
  assertEquals(res.status, 500);
});
