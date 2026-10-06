import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import { handleWorkflowYearFilmBridge } from './index.ts';
import { sanitizeFront, sanitizeLetters } from './card-ops.ts';

// Fictional ids only (the repo is public).
const SECRET = 'test-secret';
const CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ATTEMPT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FAMILY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FILM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const FILM_ATTEMPT = '11111111-1111-4111-8111-111111111111';
const MEDIA_A = '22222222-2222-4222-8222-222222222222';
const MEMORY_A = '33333333-3333-4333-8333-333333333333';
const MEDIA_FOREIGN = '44444444-4444-4444-8444-444444444444';
const MEMORY_FOREIGN = '55555555-5555-4555-8555-555555555555';

async function sign(body: string) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`));
  const signature = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('http://localhost/workflow-year-film-bridge', {
    method: 'POST',
    headers: { 'x-workflow-timestamp': timestamp, 'x-workflow-nonce': nonce, 'x-workflow-signature': signature },
    body,
  });
}

type Row = Record<string, unknown>;
interface Predicate { op: string; col: string; value: unknown; any?: Predicate[] }
interface Query { table: string; predicates: Predicate[]; patch?: Row; columns?: string }

/** A tiny in-memory PostgREST stand-in: filters (eq/is/in/gte/lt), update + select + maybeSingle, paging. */
class Fake {
  rpcCalls: { name: string; args: Row }[] = [];
  queries: Query[] = [];
  tables: Record<string, Row[]>;
  rpcResults: Record<string, { data?: unknown; error?: { code?: string; message: string } | null }> = {};

  constructor(card: Row | null = {}, extra: Record<string, Row[]> = {}) {
    this.tables = {
      holiday_cards: card
        ? [{
          id: CARD, family_id: FAMILY, created_by: OWNER, year: 2026, greeting: 'christmas', language: 'es', locale: 'es-CO',
          film_id: null, share_token: null, status: 'generating', attempt_id: ATTEMPT, deleted_at: null,
          heartbeat_at: null, workflow_instance_id: ATTEMPT, letters: null, front_candidates: null, qr_caption: null,
          signature: null, editor_facts: null, last_failure_code: null, ...card,
        }]
        : [],
      families: [{ id: FAMILY, name: 'Familia Rivera Soto', gallery_caption_language: 'es-CO', gallery_caption_instructions: 'short', owner_id: OWNER, deleted_at: null }],
      ...extra,
    };
  }

  get card(): Row {
    return this.tables.holiday_cards[0];
  }

  from(table: string) {
    const fake = this;
    const query: Query = { table, predicates: [] };
    let mode: 'select' | 'update' = 'select';
    const test = (row: Row, p: Predicate): boolean => {
      const v = row[p.col];
      if (p.op === 'or') return (p.any ?? []).some((alt) => test(row, alt));
      if (p.op === 'eq') return v === p.value;
      if (p.op === 'is') return (v ?? null) === p.value;
      if (p.op === 'in') return (p.value as unknown[]).includes(v);
      if (p.op === 'gte') return String(v) >= String(p.value);
      // A null column never satisfies a comparison (SQL semantics).
      if (p.op === 'lt') return v !== null && v !== undefined && String(v) < String(p.value);
      return true;
    };
    const matches = (row: Row) => query.predicates.every((p) => test(row, p));
    const run = (): Row[] => {
      fake.queries.push(query);
      const rows = (fake.tables[table] ?? []).filter(matches);
      if (mode === 'update') {
        for (const row of rows) Object.assign(row, query.patch);
      }
      return rows.map((r) => ({ ...r }));
    };
    const chain: Record<string, unknown> = {
      select: (columns?: string) => { query.columns = columns; return chain; },
      update: (patch: Row) => { mode = 'update'; query.patch = patch; return chain; },
      eq: (col: string, value: unknown) => { query.predicates.push({ op: 'eq', col, value }); return chain; },
      is: (col: string, value: unknown) => { query.predicates.push({ op: 'is', col, value }); return chain; },
      in: (col: string, value: unknown[]) => { query.predicates.push({ op: 'in', col, value }); return chain; },
      gte: (col: string, value: unknown) => { query.predicates.push({ op: 'gte', col, value }); return chain; },
      lt: (col: string, value: unknown) => { query.predicates.push({ op: 'lt', col, value }); return chain; },
      // PostgREST `col.op.value,col.op.value` (op: eq | is | lt).
      or: (filter: string) => {
        const any = filter.split(',').map((part): Predicate => {
          const [col, op, ...rest] = part.split('.');
          const raw = rest.join('.');
          return { op, col, value: op === 'is' && raw === 'null' ? null : raw };
        });
        query.predicates.push({ op: 'or', col: '', value: null, any });
        return chain;
      },
      order: () => chain,
      range: (from: number, to: number) => Promise.resolve({ data: run().slice(from, to + 1), error: null }),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return chain;
  }

  rpc(name: string, args: Row) {
    this.rpcCalls.push({ name, args });
    if (name === 'record_year_film_bridge_nonce') return Promise.resolve({ data: true, error: null });
    const result = this.rpcResults[name];
    return Promise.resolve({ data: result?.data ?? null, error: result?.error ?? null });
  }
}

const call = async (body: Row, fake: Fake) =>
  handleWorkflowYearFilmBridge(await sign(JSON.stringify({ cardId: CARD, attemptId: ATTEMPT, ...body })), {
    createServiceClient: () => fake as never,
    secret: SECRET,
  });

const writes = (fake: Fake) => fake.queries.filter((q) => q.patch && !('heartbeat_at' in q.patch && Object.keys(q.patch).length === 1));

const candidate = (extra: Row = {}) => ({
  mediaId: MEDIA_A, memoryId: MEMORY_A, rank: 1, score: 14.25, cardOrientation: 'landscape', printClass: 'full-bleed', width: 4032, height: 3024,
  verdict: {
    cardScore: 9, peopleVisible: 4, allFacesVisible: true, eyesOpenMostly: true, lookingAtCamera: 'most', light: 'good', sharp: true, cropRisk: false,
    why: 'a free text reason', setting: 'living room',
  },
  ...extra,
});

Deno.test('card ops need a card id and attempt id; film ops still need a film id', async () => {
  const fake = new Fake();
  const noCard = await handleWorkflowYearFilmBridge(await sign(JSON.stringify({ operation: 'card_heartbeat', attemptId: ATTEMPT })), { createServiceClient: () => fake as never, secret: SECRET });
  assertEquals(noCard.status, 400);
  const filmId = await handleWorkflowYearFilmBridge(await sign(JSON.stringify({ operation: 'card_heartbeat', filmId: FILM, attemptId: ATTEMPT })), { createServiceClient: () => fake as never, secret: SECRET });
  assertEquals(filmId.status, 400);
  const cardForFilmOp = await handleWorkflowYearFilmBridge(await sign(JSON.stringify({ operation: 'heartbeat', cardId: CARD, attemptId: ATTEMPT })), { createServiceClient: () => fake as never, secret: SECRET });
  assertEquals(cardForFilmOp.status, 400);
  assertEquals((await call({ operation: 'card_heartbeat', attemptId: 'nope' }, fake)).status, 400);
  assertEquals((await call({ operation: 'card_drop_table' }, fake)).status, 400);
});

Deno.test('card_start claims the lease for a dispatched attempt (the callers write no lease); a fresh lease held by another attempt wins', async () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  {
    // Never leased: no attempt, no heartbeat -> claimed.
    const fresh = new Fake({ attempt_id: null, workflow_instance_id: null, heartbeat_at: null });
    const claimed = await call({ operation: 'card_start' }, fresh);
    assertEquals(claimed.status, 200);
    assertEquals((await claimed.json()).state, 'ok');
    assertEquals([fresh.card.attempt_id, fresh.card.workflow_instance_id], [ATTEMPT, ATTEMPT]);
    assert(typeof fresh.card.heartbeat_at === 'string');
    // ... and it is idempotent for the same attempt (a replayed init step).
    assertEquals((await (await call({ operation: 'card_start' }, fresh)).json()).state, 'ok');
    // The claimed lease works for the next operation.
    assertEquals((await call({ operation: 'card_save_front', front: { candidates: [candidate()], counts: {}, dropped: {} } }, fresh)).status, 200);

    // Another attempt with a FRESH heartbeat keeps the card; this attempt is superseded and writes nothing.
    const held = new Fake({ attempt_id: OTHER_ATTEMPT, heartbeat_at: minutesAgo(1) });
    const lost = await call({ operation: 'card_start' }, held);
    assertEquals((await lost.json()).state, 'superseded');
    assertEquals(held.card.attempt_id, OTHER_ATTEMPT);
    assertEquals((await call({ operation: 'card_save_front', front: { candidates: [candidate()], counts: {}, dropped: {} } }, held)).status, 409);

    // A lease whose heartbeat went stale (the sweep re-dispatched) is taken over.
    const stale = new Fake({ attempt_id: OTHER_ATTEMPT, heartbeat_at: minutesAgo(21) });
    assertEquals((await (await call({ operation: 'card_start' }, stale)).json()).state, 'ok');
    assertEquals(stale.card.attempt_id, ATTEMPT);

    // Deleted / no longer generating cards are never claimed.
    const deleted = new Fake({ attempt_id: null, deleted_at: '2026-10-06T11:00:00Z' });
    assertEquals((await (await call({ operation: 'card_start' }, deleted)).json()).state, 'deleted');
    assertEquals(deleted.card.attempt_id, null);
    const done = new Fake({ attempt_id: null, status: 'ready' });
    assertEquals((await (await call({ operation: 'card_start' }, done)).json()).state, 'superseded');
    assertEquals(done.card.attempt_id, null);
    assertEquals((await (await call({ operation: 'card_start' }, new Fake(null))).json()).state, 'deleted');
  }
});

Deno.test('card lease: heartbeat touches the live card; deleted / superseded / not-generating cards stop the Workflow and nothing is written', async () => {
  const live = new Fake();
  const res = await call({ operation: 'card_heartbeat' }, live);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { state: 'ok', card: { year: 2026, greeting: 'christmas', language: 'es', locale: 'es-CO', filmId: null } });
  assert(typeof live.card.heartbeat_at === 'string');

  for (
    const [state, card, attempt] of [
      ['deleted', { deleted_at: '2026-10-01T00:00:00Z' }, ATTEMPT],
      ['superseded', {}, OTHER_ATTEMPT],
      ['superseded', { status: 'ready', attempt_id: null }, ATTEMPT],
      ['superseded', { status: 'failed' }, ATTEMPT],
    ] as const
  ) {
    const fake = new Fake(card);
    const hb = await call({ operation: 'card_heartbeat', attemptId: attempt }, fake);
    assertEquals(hb.status, 200);
    assertEquals((await hb.json()).state, state);
    const work = await call({ operation: 'card_save_front', attemptId: attempt, front: { candidates: [candidate()], counts: {}, dropped: {} } }, fake);
    assertEquals(work.status, 409);
    assertEquals(await work.json(), { state });
    assertEquals(fake.card.heartbeat_at, null);
    assertEquals(fake.card.front_candidates, null);
    assertEquals(writes(fake).length, 0);
  }
  // A card row that no longer exists is "deleted".
  const gone = new Fake(null);
  assertEquals((await (await call({ operation: 'card_heartbeat' }, gone)).json()).state, 'deleted');
});

Deno.test('card_save_front stores ids, numbers and enums only (model text is dropped)', async () => {
  const fake = new Fake();
  const res = await call({ operation: 'card_save_front', front: { candidates: [candidate()], counts: { picks: 1, judged: 8, bogus: 5 }, dropped: { 'low-print': 3, 'free text': 2 } } }, fake);
  assertEquals(res.status, 200);
  const stored = fake.card.front_candidates as { candidates: { verdict: Row }[]; counts: Row; dropped: Row };
  assertEquals(Object.keys(stored.candidates[0].verdict).sort(), ['allFacesVisible', 'cardScore', 'cropRisk', 'eyesOpenMostly', 'light', 'lookingAtCamera', 'peopleVisible', 'sharp']);
  assertEquals(stored.counts, { judged: 8, picks: 1 });
  assertEquals(stored.dropped, { 'low-print': 3 });
  assertFalse(JSON.stringify(stored).includes('living room'));
  assertFalse(JSON.stringify(stored).includes('free text reason'));

  // Bad shapes are refused, not coerced.
  for (const front of [null, { candidates: 'x' }, { candidates: [candidate({ mediaId: 'not-a-uuid' })] }, { candidates: Array.from({ length: 13 }, () => candidate()) }, { candidates: [candidate({ printClass: 'poster' })] }]) {
    assertEquals(sanitizeFront(front), null);
  }
});

Deno.test('card_create_film uses the card greeting (never the body), maps a deleted card, and is claimed only for the card own film', async () => {
  const fake = new Fake();
  fake.rpcResults.create_holiday_card_film = { data: [{ film_id: FILM, token: 'tok' }] };
  const res = await call({ operation: 'card_create_film', scopeStart: '2026-01-01', scopeEnd: '2026-10-07', closeMedia: [MEDIA_A], greeting: 'new-year' }, fake);
  assertEquals(await res.json(), { filmId: FILM });
  assertEquals(fake.rpcCalls.find((c) => c.name === 'create_holiday_card_film')?.args, {
    p_card_id: CARD, p_scope_start: '2026-01-01', p_scope_end: '2026-10-07', p_greeting: 'christmas', p_close_media: [MEDIA_A],
  });

  for (const body of [{ scopeStart: '2026-10-07', scopeEnd: '2026-01-01', closeMedia: [] }, { scopeStart: '2026-01-01', scopeEnd: '2026-10-07', closeMedia: ['x'] }, { scopeStart: 'bad', scopeEnd: '2026-10-07', closeMedia: [] }]) {
    assertEquals((await call({ operation: 'card_create_film', ...body }, new Fake())).status, 400);
  }

  const deleted = new Fake();
  deleted.rpcResults.create_holiday_card_film = { error: { code: 'P0002', message: 'holiday_card_not_found' } };
  const gone = await call({ operation: 'card_create_film', scopeStart: '2026-01-01', scopeEnd: '2026-10-07', closeMedia: [] }, deleted);
  assertEquals(gone.status, 409);
  assertEquals(await gone.json(), { state: 'deleted' });

  // No film yet -> nothing to claim.
  assertEquals((await call({ operation: 'card_claim_film' }, new Fake())).status, 400);

  const withFilm = new Fake({ film_id: FILM });
  withFilm.rpcResults.claim_year_film_by_id = { data: [{ film_id: FILM, attempt_id: FILM_ATTEMPT, family_id: FAMILY }] };
  assertEquals(await (await call({ operation: 'card_claim_film', filmId: 'ignored' }, withFilm)).json(), { claimed: true, filmId: FILM, filmAttemptId: FILM_ATTEMPT });
  assertEquals(withFilm.rpcCalls.find((c) => c.name === 'claim_year_film_by_id')?.args, { p_film_id: FILM });

  // Zero rows = the hourly cron claimed it first: a normal outcome.
  const lost = new Fake({ film_id: FILM });
  lost.rpcResults.claim_year_film_by_id = { data: [] };
  assertEquals(await (await call({ operation: 'card_claim_film' }, lost)).json(), { claimed: false, filmId: FILM });
});

Deno.test('card_end_film_cycle aborts the claimed attempt like the cron dispatch failure, for the card own film only', async () => {
  const fake = new Fake({ film_id: FILM });
  fake.rpcResults.year_film_end_cycle = { data: { status: 'queued' } };
  const res = await call({ operation: 'card_end_film_cycle', filmAttemptId: FILM_ATTEMPT, filmId: 'ignored', code: 'OTHER', outcome: 'failed' }, fake);
  assertEquals(res.status, 200);
  assertEquals(fake.rpcCalls.find((c) => c.name === 'year_film_end_cycle')?.args, {
    p_film_id: FILM, p_attempt_id: FILM_ATTEMPT, p_outcome: 'aborted', p_code: 'DISPATCH_FAILED',
  });
  assertEquals((await call({ operation: 'card_end_film_cycle', filmAttemptId: 'nope' }, new Fake({ film_id: FILM }))).status, 400);
  assertEquals((await call({ operation: 'card_end_film_cycle', filmAttemptId: FILM_ATTEMPT }, new Fake())).status, 400);
});

const lettersBody = (extra: Row = {}) => ({
  operation: 'card_save_letters',
  letters: [
    { tone: 'classic', text: 'Querida familia, un año de primeros pasos.', chars: 3, softFlags: [{ code: 'mood_words', detail: 'tierno' }] },
    { tone: 'reflective', text: 'Otro texto.', chars: 11, softFlags: [] },
  ],
  qrCaption: 'Mira nuestro año',
  signature: 'Con cariño, la familia Rivera Soto',
  editorFacts: { facts: [{ about: 'Tomás', kind: 'first', fact: 'Dio sus primeros pasos.', evidence: ['m1'] }], broadStrokes: 'Un año de juegos.', lineOfYear: null },
  ...extra,
});

Deno.test('card_save_letters stores letters, signature and facts; the QR caption only exists with a film', async () => {
  const withFilm = new Fake({ film_id: FILM });
  assertEquals((await call(lettersBody(), withFilm)).status, 200);
  const letters = withFilm.card.letters as Row[];
  assertEquals(letters.map((l) => l.tone), ['classic', 'reflective']);
  assertEquals(letters[0].chars, Array.from('Querida familia, un año de primeros pasos.').length); // recomputed, not trusted
  assertEquals(letters[0].softFlags, [{ code: 'mood_words', detail: 'tierno' }]);
  assertEquals(withFilm.card.qr_caption, 'Mira nuestro año');
  assertEquals(withFilm.card.signature, 'Con cariño, la familia Rivera Soto');
  assertEquals((withFilm.card.editor_facts as Row).broadStrokes, 'Un año de juegos.');

  const noFilm = new Fake();
  assertEquals((await call(lettersBody(), noFilm)).status, 200);
  assertEquals(noFilm.card.qr_caption, null);

  assertEquals(sanitizeLetters({ ...lettersBody(), letters: [{ tone: 'shouting', text: 'x', softFlags: [] }] }), null);
  assertEquals(sanitizeLetters({ ...lettersBody(), signature: '' }), null);
  assertEquals(sanitizeLetters({ ...lettersBody(), letters: [{ tone: 'classic', text: 'a'.repeat(4001), softFlags: [] }] }), null);
  assertEquals(sanitizeLetters({ ...lettersBody(), letters: [lettersBody().letters[0], lettersBody().letters[0]] }), null);
  assertEquals((await call(lettersBody({ signature: 5 }), new Fake())).status, 400);
});

Deno.test('card_finish: ready and failed clear the lease; later calls see a superseded attempt', async () => {
  const ready = new Fake({ heartbeat_at: '2026-10-06T10:00:00Z' });
  assertEquals((await call({ operation: 'card_finish', outcome: 'ready' }, ready)).status, 200);
  assertEquals([ready.card.status, ready.card.attempt_id, ready.card.workflow_instance_id, ready.card.heartbeat_at, ready.card.last_failure_code], ['ready', null, null, null, null]);
  const after = await call({ operation: 'card_heartbeat' }, ready);
  assertEquals((await after.json()).state, 'superseded');
  assertEquals((await call({ operation: 'card_finish', outcome: 'ready' }, ready)).status, 409);

  const failed = new Fake();
  assertEquals((await call({ operation: 'card_finish', outcome: 'failed', code: 'LETTERS_FAILED' }, failed)).status, 200);
  assertEquals([failed.card.status, failed.card.last_failure_code, failed.card.attempt_id], ['failed', 'LETTERS_FAILED', null]);

  for (const body of [{ outcome: 'failed', code: 'raw error text' }, { outcome: 'failed' }, { outcome: 'done' }]) {
    assertEquals((await call({ operation: 'card_finish', ...body }, new Fake())).status, 400);
  }
  // A card deleted mid-generation is not resurrected.
  const deleted = new Fake({ deleted_at: '2026-10-06T10:00:00Z' });
  const res = await call({ operation: 'card_finish', outcome: 'ready' }, deleted);
  assertEquals(res.status, 409);
  assertEquals(deleted.card.status, 'generating');
});

Deno.test('card_record_usage: only the card operations, recorded against the card family', async () => {
  const fake = new Fake();
  const usage = { prompt_tokens: 100, completion_tokens: 20 };
  const body = { operation: 'card_record_usage', aiCallId: crypto.randomUUID(), usageOperation: 'holiday_card_writer', model: 'gpt-6.1-sol', success: true, usage };
  assertEquals((await call(body, fake)).status, 200);
  const rpc = fake.rpcCalls.find((c) => c.name === 'record_ai_usage_event_detailed')!;
  assertEquals([rpc.args.p_family_id, rpc.args.p_actor_user_id, rpc.args.p_operation, rpc.args.p_model], [FAMILY, OWNER, 'holiday_card_writer', 'gpt-6.1-sol']);
  // Film operations are not card operations, and vice versa.
  assertEquals((await call({ ...body, usageOperation: 'year_film_vision' }, new Fake())).status, 400);
  assertEquals((await call({ ...body, usageOperation: 'holiday_card_nope' }, new Fake())).status, 400);
  assertEquals((await call({ ...body, aiCallId: 'x' }, new Fake())).status, 400);
});

Deno.test('card_load_media resolves only media of memories in the card family', async () => {
  const fake = new Fake({}, {
    memory_media: [
      { id: MEDIA_A, memory_id: MEMORY_A, object_key: 'u/a.jpg', preview_object_key: 'u/a-preview.jpg', aspect_ratio: 1.33 },
      { id: MEDIA_FOREIGN, memory_id: MEMORY_FOREIGN, object_key: 'x/b.jpg', preview_object_key: null, aspect_ratio: null },
    ],
    memories: [{ id: MEMORY_A, family_id: FAMILY }, { id: MEMORY_FOREIGN, family_id: 'other-family' }],
  });
  const res = await call({ operation: 'card_load_media', mediaIds: [MEDIA_A, MEDIA_FOREIGN] }, fake);
  assertEquals((await res.json()).media, [{ id: MEDIA_A, memoryId: MEMORY_A, objectKey: 'u/a.jpg', previewKey: 'u/a-preview.jpg', aspectRatio: 1.33 }]);
  assertEquals((await call({ operation: 'card_load_media', mediaIds: [] }, fake)).status, 400);
  assertEquals((await call({ operation: 'card_load_media', mediaIds: ['x'] }, fake)).status, 400);
  assertEquals((await call({ operation: 'card_load_media', mediaIds: Array.from({ length: 201 }, () => MEDIA_A) }, fake)).status, 400);
});

Deno.test('card_load_context: family rows from the window start (previous Dec 1 or 12 months), caption instructions, no portraits', async () => {
  const fake = new Fake({}, {
    family_members: [{ id: 'm1', name: 'Tomás', date_of_birth: '2021-10-02', relationship: 'child', created_at: '2024-01-01', family_id: FAMILY }],
    memories: [
      { id: MEMORY_A, family_id: FAMILY, memory_date: '2026-09-01', content: 'a' },
      { id: 'old', family_id: FAMILY, memory_date: '2025-09-01', content: 'too old' },
    ],
    memory_media: [], memory_family_members: [], memory_milestones: [], content_reports: [],
  });
  fake.rpcResults.year_film_parent_blocked_users = { data: ['blocked-user'] };
  const res = await call({ operation: 'card_load_context', today: '2026-10-06' }, fake);
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.card, { id: CARD, familyId: FAMILY, ownerId: OWNER, year: 2026, greeting: 'christmas', language: 'es', locale: 'es-CO', filmId: null, shareToken: null });
  assertEquals(json.captionInstructions, 'short');
  assertEquals(json.rows.family, { id: FAMILY, name: 'Familia Rivera Soto', gallery_caption_language: 'es-CO' });
  assertEquals(json.rows.memories.map((m: Row) => m.id), [MEMORY_A]);
  assertEquals(json.rows.portraits, []);
  assertEquals(json.rows.blockedAuthorIds, ['blocked-user']);
  const memories = fake.queries.find((q) => q.table === 'memories')!;
  assertEquals(memories.predicates.filter((p) => p.col === 'memory_date').map((p) => [p.op, p.value]), [['gte', '2025-10-06'], ['lt', '2026-10-07']]);
  assert(memories.columns?.includes('labels'));
  assert(fake.queries.find((q) => q.table === 'family_members')!.columns?.includes('nicknames'));
  assertFalse(fake.queries.some((q) => q.table === 'family_member_portrait_versions'));

  // In December the previous Dec 1 is the (earlier) window start.
  const dec = new Fake();
  dec.tables.memories = [];
  dec.tables.family_members = [];
  for (const t of ['memory_media', 'memory_family_members', 'memory_milestones', 'content_reports']) dec.tables[t] = [];
  await call({ operation: 'card_load_context', today: '2026-12-20' }, dec);
  assertEquals(dec.queries.find((q) => q.table === 'memories')!.predicates.find((p) => p.op === 'gte')!.value, '2025-12-01');

  assertEquals((await call({ operation: 'card_load_context', today: 'yesterday' }, new Fake())).status, 400);
});

Deno.test('film load_film_context (refactored loader) still serves the film rows, portraits and readyAt', async () => {
  const film = {
    id: FILM, family_id: FAMILY, kind: 'family_holiday', family_member_id: null, age_year: null, scope_start_date: '2026-01-01',
    scope_end_exclusive: '2026-10-07', language: 'es', music_bed_id: null, quote_candidates: null,
    edits: { greeting: 'christmas', preferredCloseMedia: [MEDIA_A] }, edits_version: 0, pool_cutoff_at: null, content_epoch: 0, ai_checks: {},
    generation_started_at: '2026-10-06T10:00:00Z', ready_at: '2026-10-06T12:00:00Z', attempt_id: FILM_ATTEMPT, status: 'curating', video_key: null,
  };
  const fake = new Fake(null, {
    year_films: [film],
    family_members: [{ id: 'm1', name: 'Tomás', family_id: FAMILY }],
    memories: [{ id: MEMORY_A, family_id: FAMILY, memory_date: '2026-09-01', content: 'a' }],
    memory_media: [], memory_family_members: [], memory_milestones: [], content_reports: [],
    family_member_portrait_versions: [{ id: 'pv', family_member_id: 'm1', family_id: FAMILY }],
  });
  fake.rpcResults.year_film_heartbeat = { data: 'ok' };
  const res = await handleWorkflowYearFilmBridge(await sign(JSON.stringify({ operation: 'load_film_context', filmId: FILM, attemptId: FILM_ATTEMPT })), { createServiceClient: () => fake as never, secret: SECRET });
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.film.readyAt, '2026-10-06T12:00:00Z');
  assertEquals(json.film.edits, film.edits);
  assertEquals(json.film.poolCutoffAt, '2026-10-06T10:00:00Z');
  assertEquals(json.rows.memories.map((m: Row) => m.id), [MEMORY_A]);
  assertEquals(json.rows.portraits.length, 1);
  const memberQuery = fake.queries.find((q) => q.table === 'family_members')!;
  assertEquals(memberQuery.columns, 'id, name, date_of_birth, relationship, created_at'); // film columns unchanged
});
