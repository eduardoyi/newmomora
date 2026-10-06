import { assertEquals } from 'jsr:@std/assert@1';
import { CONFIRM_DEADLINE_MS, decideTrack, filmIsBroken, handleSweepHolidayCardOrders, SWEEP_RENDER_TIMEOUT_MS } from './index.ts';
import { printPipelineFromEnv } from '../_shared/holiday-card-fulfillment.ts';
import { defaultRenderResponse, FakeDb, fakePresign, FROZEN_HASH, IDS, makeGelatoFake, makeR2Fake, makeRenderFake, makeStripeFake, PAY_FIRST_COLUMNS, QUOTED_ORDER, US_ADDRESS } from '../_shared/holiday-card-orders.test-support.ts';

type Row = Record<string, unknown>;

const NOW = Date.parse('2026-10-06T12:30:00.000Z'); // 12:30 UTC: not in the hourly film-check window
const NOW_HOURLY = Date.parse('2026-10-06T13:05:00.000Z');
const minutesAgo = (m: number, from = NOW) => new Date(from - m * 60_000).toISOString();
const daysAgo = (d: number, from = NOW) => new Date(from - d * 86_400_000).toISOString();

const GELATO_ID = 'gel-draft001';

function order(overrides: Row = {}): Row {
  return {
    id: IDS.order,
    card_id: IDS.card,
    family_id: IDS.family,
    requested_by: IDS.user,
    ...QUOTED_ORDER,
    status: 'paid',
    stripe_payment_intent_id: 'pi_test_1',
    stripe_session_id: 'cs_test_000001',
    gelato_order_id: GELATO_ID,
    gelato_status: null,
    snapshot_hash: 'h1',
    refunded_at: null,
    failure_reason: null,
    shipped_at: null,
    print_files: { files: [{ side: 'front', key: `print-orders/${IDS.order}/front.pdf`, sha256: 'a'.repeat(64), bytes: 1 }] },
    updated_at: minutesAgo(10),
    ...overrides,
  };
}

interface Rig {
  db: FakeDb;
  gelato: ReturnType<typeof makeGelatoFake>;
  stripe: ReturnType<typeof makeStripeFake>;
  render: ReturnType<typeof makeRenderFake>;
  r2: ReturnType<typeof makeR2Fake>;
  mails: { to: string; subject: string; body: string }[];
  dispatches: { cardId: string; attemptId: string }[];
  dispatchResult: { ok: boolean };
  pushes: { token: string; title: string; body: string; data?: Row }[];
  pushResult: { ok: boolean | 'throw' };
  run: (options?: { now?: number; nowFn?: () => number; secret?: string | null }) => Promise<Record<string, any>>;
}

function rig(seed: Record<string, Row[]>, options: { gelatoOrder?: { orderType?: 'draft' | 'order'; status?: string; tracking?: Row[]; refusal?: string } | null } = {}): Rig {
  // The database clock follows the tick's `now` (holiday_card_readiness's 75-minute valve reads it).
  const clock = { now: NOW };
  const db = new FakeDb({ holiday_card_orders: [], holiday_cards: [], year_films: [], families: [], user_profiles: [], ...seed }, { nowMs: () => clock.now, clock: () => new Date(clock.now).toISOString() });
  db.users.set(IDS.user, { email: 'buyer@example.com' });
  const gelato = makeGelatoFake();
  const spec = options.gelatoOrder === undefined ? { orderType: 'draft' as const, status: 'created' } : options.gelatoOrder;
  if (spec) {
    gelato.state.orders.set(GELATO_ID, {
      orderType: spec.orderType ?? 'order',
      fulfillmentStatus: spec.status ?? 'created',
      tracking: spec.tracking ?? [],
      refusalReasonCode: spec.refusal,
    });
  }
  const stripe = makeStripeFake();
  const r2 = makeR2Fake([`print-orders/${IDS.order}/front.pdf`, `print-orders/${IDS.order}/back.pdf`]);
  const mails: Rig['mails'] = [];
  const dispatches: Rig['dispatches'] = [];
  const dispatchResult = { ok: true };
  const pushes: Rig['pushes'] = [];
  const pushResult: Rig['pushResult'] = { ok: true };
  const render = makeRenderFake();
  const routed = (async (input: Request | URL | string, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    if (host === 'api.stripe.com') return stripe.fetch(input, init);
    if (host === 'render.test') return render.fetchRender(init);
    return gelato.fetch(input, init);
  }) as typeof fetch;
  db.rpcHandlers.set('increment_holiday_card_generation_attempt', () => 1);
  return {
    db, gelato, stripe, render, r2, mails, dispatches, dispatchResult, pushes, pushResult,
    run: async (opts = {}) => {
      clock.now = opts.nowFn ? opts.nowFn() : opts.now ?? NOW;
      const previous = {
        cron: Deno.env.get('CRON_SECRET'), gelato: Deno.env.get('GELATO_API_KEY'), stripe: Deno.env.get('STRIPE_SECRET_KEY'),
        renderUrl: Deno.env.get('MEMORY_BOOK_RENDER_WORKER_URL'), renderSecret: Deno.env.get('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET'),
      };
      Deno.env.set('CRON_SECRET', 'cron-secret');
      Deno.env.set('GELATO_API_KEY', 'gelato-test-key');
      Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_x');
      Deno.env.set('MEMORY_BOOK_RENDER_WORKER_URL', 'https://render.test');
      Deno.env.set('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET', 'render-secret');
      try {
        const headers: Record<string, string> = {};
        if (opts.secret !== null) headers['x-cron-secret'] = opts.secret ?? 'cron-secret';
        const response = await handleSweepHolidayCardOrders(new Request('http://localhost', { method: 'POST', headers }), {
          createServiceClient: db.client(),
          fetch: routed,
          now: opts.nowFn ?? (() => opts.now ?? NOW),
          sendEmail: async (input) => { mails.push({ to: input.to, subject: input.subject, body: input.htmlBody }); return 'sent'; },
          listKeys: r2.listKeys,
          deleteKey: r2.deleteKey,
          createPresignedGetUrls: fakePresign(),
          headObject: render.headObject,
          dispatchGeneration: async (cardId, attemptId) => { dispatches.push({ cardId, attemptId }); return dispatchResult.ok; },
          sendPush: async (token, title, body, data) => {
            pushes.push({ token, title, body, data: data as Row | undefined });
            if (pushResult.ok === 'throw') throw new Error('network');
            return pushResult.ok;
          },
        });
        return { status: response.status, ...(await response.json()) };
      } finally {
        for (const [key, name] of [['cron', 'CRON_SECRET'], ['gelato', 'GELATO_API_KEY'], ['stripe', 'STRIPE_SECRET_KEY'], ['renderUrl', 'MEMORY_BOOK_RENDER_WORKER_URL'], ['renderSecret', 'MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET']] as const) {
          const value = previous[key];
          if (value === undefined) Deno.env.delete(name); else Deno.env.set(name, value);
        }
      }
    },
  };
}

const row = (r: Rig, id: string = IDS.order) => r.db.row('holiday_card_orders', id);
/** The order's files were released: `print_files` is now the {purgedAt} marker (not null: the prefix is purged once more later). */
const purged = (r: Rig, id: string = IDS.order) => typeof (row(r, id).print_files as { purgedAt?: string } | null)?.purgedAt === 'string';
const patches = (r: Rig) => r.gelato.state.calls.filter((c) => c.method === 'PATCH');
const alertsFor = (r: Rig, reason: string) => r.mails.filter((m) => m.to === 'hello@usemomora.com' && m.subject.includes(reason));

Deno.test('rejects a request without the cron secret', async () => {
  const r = rig({});
  assertEquals((await r.run({ secret: null })).status, 401);
  assertEquals((await r.run({ secret: 'wrong' })).status, 401);
  assertEquals((await r.run()).status, 200);
});

// ── 1. confirm ───────────────────────────────────────────────────────────

Deno.test('confirm: a paid order the webhook missed is PATCHed once (from draft) and submitted + emailed', async () => {
  const r = rig({ holiday_card_orders: [order()] });
  const result = await r.run();
  assertEquals(result.confirm.submitted, 1);
  assertEquals(row(r).status, 'submitted');
  assertEquals(patches(r).length, 1);
  assertEquals(r.mails.filter((m) => m.to === 'buyer@example.com').length, 1);
  // A second tick finds nothing to confirm.
  await r.run();
  assertEquals(patches(r).length, 1);
});

Deno.test('confirm: a Gelato order that is no longer a draft is not PATCHed again', async () => {
  const r = rig({ holiday_card_orders: [order()] }, { gelatoOrder: { orderType: 'order', status: 'passed' } });
  await r.run();
  assertEquals(patches(r).length, 0);
  // The confirm pass runs LAST: submitted this tick, advanced by the track pass of the next one (Gelato says `passed`).
  assertEquals(row(r).status, 'submitted');
  await r.run();
  assertEquals(row(r).status, 'in_production');
});

Deno.test('confirm: leaves a too-young, refunded or flagged order alone, and never looks at families.deleted_at', async () => {
  const r = rig({
    holiday_card_orders: [
      order({ id: '10000000-0000-4000-8000-000000000001', updated_at: minutesAgo(1) }),
      order({ id: '10000000-0000-4000-8000-000000000002', refunded_at: minutesAgo(5), gelato_order_id: null }),
      order({ id: '10000000-0000-4000-8000-000000000003', failure_reason: 'PAYMENT_MISMATCH_AMOUNT' }),
      order({ id: '10000000-0000-4000-8000-000000000004', gelato_order_id: GELATO_ID }),
    ],
    families: [{ id: IDS.family, name: 'Gone', deleted_at: minutesAgo(60) }],
  });
  const result = await r.run();
  assertEquals(result.confirm.submitted, 1);
  assertEquals(row(r, '10000000-0000-4000-8000-000000000004').status, 'submitted');
  for (const id of ['1', '3']) assertEquals(row(r, `10000000-0000-4000-8000-00000000000${id}`).status, 'paid');
  // Refunded: never confirmed; the refund pass cancels it instead.
  assertEquals(row(r, '10000000-0000-4000-8000-000000000002').status, 'cancelled');
  assertEquals(patches(r).length, 1);
});

Deno.test('confirm: Gelato down keeps the order paid; the 30-minute tick alerts once, 6 hours marks it failed', async () => {
  const r = rig({ holiday_card_orders: [order({ updated_at: minutesAgo(35) })] });
  r.gelato.state.forceStatus.set(`GET /orders/${GELATO_ID}`, 503);
  const first = await r.run();
  assertEquals(first.confirm.retry, 1);
  assertEquals(first.confirm.alerted, 1);
  assertEquals(row(r).status, 'paid');
  assertEquals(alertsFor(r, 'PAID_NOT_SUBMITTED').length, 1);
  // The next tick (10 min later) is past the alert window: no second alert.
  await r.run({ now: NOW + 10 * 60_000 });
  assertEquals(alertsFor(r, 'PAID_NOT_SUBMITTED').length, 1);

  const stuck = rig({ holiday_card_orders: [order({ updated_at: minutesAgo(7 * 60) })] });
  stuck.gelato.state.forceStatus.set(`GET /orders/${GELATO_ID}`, 503);
  await stuck.run();
  assertEquals(row(stuck).status, 'failed');
  assertEquals(row(stuck).failure_reason, 'CONFIRM_TIMEOUT');
  assertEquals(alertsFor(stuck, 'CONFIRM_TIMEOUT').length, 1);
});

Deno.test('confirm: a rejected PATCH fails the order with an alert; a draft Gelato lost is forgotten and rebuilt, never failed', async () => {
  const rejected = rig({ holiday_card_orders: [order()] });
  rejected.gelato.state.forceStatus.set(`PATCH /orders/${GELATO_ID}`, 400);
  await rejected.run();
  assertEquals(row(rejected).status, 'failed');
  assertEquals(String(row(rejected).failure_reason).startsWith('GELATO_CONFIRM_REJECTED'), true);

  const missing = rig({ holiday_card_orders: [order()] }, { gelatoOrder: null });
  await missing.run();
  assertEquals(row(missing).status, 'paid');
  assertEquals(row(missing).failure_reason, null);
  assertEquals(row(missing).gelato_order_id, null);
  assertEquals(alertsFor(missing, 'GELATO_DRAFT_MISSING').length, 0);
});

// ── 2. track ─────────────────────────────────────────────────────────────

Deno.test('track: passed -> in_production and gelato_status is persisted', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'submitted' })] }, { gelatoOrder: { orderType: 'order', status: 'passed' } });
  const result = await r.run();
  assertEquals(result.track.advanced, 1);
  assertEquals(row(r).status, 'in_production');
  assertEquals(row(r).gelato_status, 'passed');
});

Deno.test('track: a pending order stays submitted but its Gelato status is recorded; no write when nothing changed', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'submitted', gelato_status: 'created' })] }, { gelatoOrder: { orderType: 'order', status: 'pending' } });
  await r.run();
  assertEquals(row(r).status, 'submitted');
  assertEquals(row(r).gelato_status, 'pending');
  const writes = r.db.log.length;
  await r.run();
  assertEquals(r.db.log.length, writes);
});

Deno.test('track: shipped with tracking -> shipped + shipped_at + tracking fields + one email', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'in_production', gelato_status: 'in_production' })] }, {
    gelatoOrder: { orderType: 'order', status: 'shipped', tracking: [{ trackingCode: 'TRK-1', trackingUrl: 'https://track.example.test/TRK-1', carrier: 'USPS' }] },
  });
  const result = await r.run();
  assertEquals(result.track.shipped, 1);
  const updated = row(r);
  assertEquals(updated.status, 'shipped');
  assertEquals(updated.shipped_at, new Date(NOW).toISOString());
  assertEquals(updated.tracking_number, 'TRK-1');
  assertEquals(updated.tracking_url, 'https://track.example.test/TRK-1');
  assertEquals(updated.carrier, 'USPS');
  const shippedMails = r.mails.filter((m) => m.subject.includes('shipped'));
  assertEquals(shippedMails.length, 1);
  assertEquals(shippedMails[0].body.includes('https://track.example.test/TRK-1'), true);
  await r.run();
  assertEquals(r.mails.filter((m) => m.subject.includes('shipped')).length, 1);
});

Deno.test('track: shipped without tracking waits, then ships without it after a day', async () => {
  const waiting = rig({ holiday_card_orders: [order({ status: 'in_production', gelato_status: 'shipped', updated_at: minutesAgo(30) })] }, {
    gelatoOrder: { orderType: 'order', status: 'shipped' },
  });
  await waiting.run();
  assertEquals(row(waiting).status, 'in_production');
  const overdue = rig({ holiday_card_orders: [order({ status: 'in_production', gelato_status: 'shipped', updated_at: minutesAgo(25 * 60) })] }, {
    gelatoOrder: { orderType: 'order', status: 'shipped' },
  });
  await overdue.run();
  assertEquals(row(overdue).status, 'shipped');
  assertEquals(row(overdue).tracking_number, null);
});

Deno.test('track: failed and canceled orders become failed with a reason and an owner alert', async () => {
  for (const [gelatoStatus, reason] of [['failed', 'GELATO_FAILED:capability'], ['canceled', 'GELATO_CANCELED']] as const) {
    const r = rig({ holiday_card_orders: [order({ status: 'submitted' })] }, {
      gelatoOrder: { orderType: 'order', status: gelatoStatus, refusal: gelatoStatus === 'failed' ? 'capability' : undefined },
    });
    await r.run();
    assertEquals(row(r).status, 'failed');
    assertEquals(row(r).failure_reason, reason);
    assertEquals(alertsFor(r, reason).length, 1);
  }
});

Deno.test('track: on_hold is NOT terminal: one alert, the order keeps being polled, and the marker clears when the hold lifts', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'submitted' })] }, { gelatoOrder: { orderType: 'order', status: 'on_hold' } });
  const first = await r.run();
  assertEquals(first.track.held, 1);
  assertEquals(row(r).status, 'submitted');
  assertEquals(row(r).failure_reason, 'GELATO_ON_HOLD');
  assertEquals(alertsFor(r, 'GELATO_ON_HOLD').length, 1);
  await r.run();
  assertEquals(alertsFor(r, 'GELATO_ON_HOLD').length, 1); // not alerted again
  assertEquals(row(r).status, 'submitted');

  // Gelato releases the hold and production starts.
  r.gelato.state.orders.get(GELATO_ID)!.fulfillmentStatus = 'in_production';
  await r.run();
  assertEquals(row(r).status, 'in_production');
  assertEquals(row(r).failure_reason, null);
});

Deno.test('track: a submitted order that vanished at Gelato fails after the grace window, not before', async () => {
  const young = rig({ holiday_card_orders: [order({ status: 'submitted', updated_at: minutesAgo(5) })] }, { gelatoOrder: null });
  await young.run();
  assertEquals(row(young).status, 'submitted');
  const old = rig({ holiday_card_orders: [order({ status: 'submitted', updated_at: minutesAgo(60) })] }, { gelatoOrder: null });
  await old.run();
  assertEquals(row(old).failure_reason, 'GELATO_ORDER_MISSING');
});

Deno.test('decideTrack is pure: unknown statuses change nothing but the recorded status', () => {
  const base = { id: 'o', status: 'submitted', gelato_order_id: 'g', gelato_status: 'pending', requested_by: null, failure_reason: null, updated_at: minutesAgo(1) };
  const order = { fulfillmentStatus: 'unknown', rawFulfillmentStatus: 'brand_new', tracking: [] } as never;
  assertEquals(decideTrack(base, order, NOW)?.patch, { gelato_status: 'brand_new' });
  assertEquals(decideTrack({ ...base, gelato_status: 'brand_new' }, order, NOW), null);
});

// ── 3. aging ─────────────────────────────────────────────────────────────

Deno.test('aging: a quoted order older than 48h is cancelled and its draft and files are deleted; a fresh one is left', async () => {
  const r = rig({
    holiday_card_orders: [
      order({ status: 'quoted', stripe_payment_intent_id: null, stripe_session_id: null, updated_at: minutesAgo(49 * 60) }),
      order({ id: '10000000-0000-4000-8000-000000000009', status: 'quoted', gelato_order_id: null, print_files: null, stripe_payment_intent_id: null, updated_at: minutesAgo(47 * 60) }),
    ],
  });
  const result = await r.run();
  assertEquals(result.aging.cancelled, 1);
  const aged = row(r);
  assertEquals(aged.status, 'cancelled');
  assertEquals(aged.gelato_order_id, null);
  assertEquals(purged(r), true);
  assertEquals(r.gelato.state.orders.size, 0);
  assertEquals(r.r2.keys.size, 0);
  assertEquals(row(r, '10000000-0000-4000-8000-000000000009').status, 'quoted');
});

Deno.test('aging: an old checkout whose Stripe session is open is expired, then cancelled', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'checkout', stripe_payment_intent_id: null, updated_at: minutesAgo(49 * 60) })] });
  r.stripe.state.sessions.set('cs_test_000001', { status: 'open', payment_status: 'unpaid', url: 'u', metadata: {}, payment_intent: null });
  await r.run();
  assertEquals(r.stripe.state.sessions.get('cs_test_000001')?.status, 'expired');
  assertEquals(row(r).status, 'cancelled');
  assertEquals(r.gelato.state.orders.size, 0);
});

Deno.test('aging: an old checkout whose session is PAID is never cancelled; the owner is alerted exactly once', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'checkout', stripe_payment_intent_id: null, updated_at: minutesAgo(49 * 60) })] });
  r.stripe.state.sessions.set('cs_test_000001', { status: 'complete', payment_status: 'paid', url: 'u', metadata: {}, payment_intent: 'pi_test_1' });
  const first = await r.run();
  assertEquals(first.aging.paidWebhookMissed, 1);
  assertEquals(row(r).status, 'checkout');
  assertEquals(row(r).failure_reason, 'PAID_WEBHOOK_MISSED');
  assertEquals(r.gelato.state.orders.size, 1); // the draft of a paid order is untouched
  await r.run();
  assertEquals(alertsFor(r, 'PAID_WEBHOOK_MISSED').length, 1);
});

// ── 4. clean-up and retention ────────────────────────────────────────────

Deno.test('retention: print files are deleted 30 days after shipped_at and print_files becomes a purge marker so it never repeats', async () => {
  const r = rig({
    holiday_card_orders: [
      order({ status: 'shipped', shipped_at: daysAgo(31), updated_at: daysAgo(31) }),
      order({ id: '10000000-0000-4000-8000-000000000008', status: 'shipped', shipped_at: daysAgo(10) }),
    ],
  });
  r.r2.keys.add('print-orders/10000000-0000-4000-8000-000000000008/front.pdf');
  const result = await r.run();
  assertEquals(result.cleanup.filesDeleted, 1);
  assertEquals(purged(r), true);
  assertEquals(r.r2.keys.has(`print-orders/${IDS.order}/front.pdf`), false);
  assertEquals(r.r2.keys.has('print-orders/10000000-0000-4000-8000-000000000008/front.pdf'), true);
  assertEquals(row(r, '10000000-0000-4000-8000-000000000008').print_files === null, false);
  const deletes = r.r2.deleted.length;
  await r.run();
  assertEquals(r.r2.deleted.length, deletes);
});

Deno.test('retention: never-paid failed/cancelled and refunded orders lose their files at once; Gelato is left alone', async () => {
  const r = rig({
    holiday_card_orders: [
      order({ status: 'failed', failure_reason: 'GELATO_FAILED', stripe_payment_intent_id: null }),
      // Cancelled AFTER payment (refund): files go, the Gelato order id is not a draft to delete.
      order({ id: '10000000-0000-4000-8000-000000000007', status: 'cancelled', refunded_at: minutesAgo(10), gelato_order_id: 'gel-refunded1', print_files: { files: [] } }),
    ],
  });
  r.gelato.state.orders.set('gel-refunded1', { orderType: 'order', fulfillmentStatus: 'canceled', tracking: [] });
  r.r2.keys.add('print-orders/10000000-0000-4000-8000-000000000007/front.pdf');
  await r.run();
  assertEquals(purged(r), true);
  assertEquals(purged(r, '10000000-0000-4000-8000-000000000007'), true);
  assertEquals(r.r2.keys.size, 0);
  assertEquals(r.gelato.state.calls.some((c) => c.method === 'DELETE'), false);
  assertEquals(row(r, '10000000-0000-4000-8000-000000000007').gelato_order_id, 'gel-refunded1');
});

Deno.test('retention: a PAID order that failed keeps its print files until refunded or 30 days after the failure', async () => {
  const keep = rig({ holiday_card_orders: [order({ status: 'failed', failure_reason: 'CONFIRM_TIMEOUT', updated_at: daysAgo(5) })] });
  await keep.run();
  assertEquals(row(keep).print_files === null, false);
  assertEquals(keep.r2.keys.size, 2);

  const old = rig({ holiday_card_orders: [order({ status: 'failed', failure_reason: 'GELATO_ORDER_MISSING', updated_at: daysAgo(31) })] });
  await old.run();
  assertEquals(purged(old), true);
  assertEquals(old.r2.keys.size, 0);

  const refunded = rig({ holiday_card_orders: [order({ status: 'failed', failure_reason: 'CONFIRM_TIMEOUT', refunded_at: minutesAgo(3), updated_at: daysAgo(1) })] });
  await refunded.run();
  assertEquals(purged(refunded), true);
});

Deno.test('clean-up: a cancelled, never-paid order that still holds a draft is retried', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'cancelled', stripe_payment_intent_id: null, updated_at: minutesAgo(10) })] });
  const result = await r.run();
  assertEquals(result.cleanup.unpaidReleased, 1);
  assertEquals(row(r).gelato_order_id, null);
  assertEquals(r.gelato.state.orders.size, 0);
});

// ── 5. stuck generation ──────────────────────────────────────────────────

const card = (overrides: Row = {}): Row => ({
  id: IDS.card, family_id: IDS.family, status: 'generating', deleted_at: null, heartbeat_at: minutesAgo(25), created_at: minutesAgo(60), updated_at: minutesAgo(60), generation_attempts: 1, last_failure_code: null, film_id: null, ...overrides,
});

Deno.test('generation: a stale heartbeat bumps the attempt counter and re-dispatches with a fresh attempt id', async () => {
  const r = rig({ holiday_cards: [card()] });
  const result = await r.run();
  assertEquals(result.generation.redispatched, 1);
  assertEquals(r.db.rpcCalls[0], { name: 'increment_holiday_card_generation_attempt', args: { p_card_id: IDS.card, p_cap: 3 } });
  assertEquals(r.dispatches.length, 1);
  assertEquals(r.dispatches[0].cardId, IDS.card);
  assertEquals(/^[0-9a-f-]{36}$/.test(r.dispatches[0].attemptId), true);
});

Deno.test('generation: a card never leased for 10 minutes is dispatched, a healthy or young or deleted one is not', async () => {
  const r = rig({
    holiday_cards: [
      card({ id: 'c0000000-0000-4000-8000-000000000001', heartbeat_at: null, updated_at: minutesAgo(11) }),
      card({ id: 'c0000000-0000-4000-8000-000000000002', heartbeat_at: null, updated_at: minutesAgo(5) }),
      card({ id: 'c0000000-0000-4000-8000-000000000003', heartbeat_at: minutesAgo(2) }),
      card({ id: 'c0000000-0000-4000-8000-000000000004', heartbeat_at: minutesAgo(40), deleted_at: minutesAgo(30) }),
      card({ id: 'c0000000-0000-4000-8000-000000000005', status: 'ready', heartbeat_at: minutesAgo(60) }),
    ],
  });
  await r.run();
  assertEquals(r.dispatches.map((d) => d.cardId), ['c0000000-0000-4000-8000-000000000001']);
});

Deno.test('generation: attempts exhausted (the RPC answers NULL) fails the card and does not dispatch', async () => {
  const r = rig({ holiday_cards: [card()] });
  r.db.rpcHandlers.set('increment_holiday_card_generation_attempt', () => null);
  const result = await r.run();
  assertEquals(result.generation.exhausted, 1);
  assertEquals(r.dispatches.length, 0);
  const failed = r.db.row('holiday_cards', IDS.card);
  assertEquals(failed.status, 'failed');
  assertEquals(failed.last_failure_code, 'generation_attempts_exhausted');
});

Deno.test('generation: a failed dispatch is counted and retried on the next tick (the attempt cap bounds it)', async () => {
  const r = rig({ holiday_cards: [card()] });
  r.dispatchResult.ok = false;
  const result = await r.run();
  assertEquals(result.generation.dispatchFailed, 1);
  assertEquals(r.db.row('holiday_cards', IDS.card).status, 'generating');
});

// ── 6. ordered films ─────────────────────────────────────────────────────

Deno.test('ordered films: a failed film behind an ordered card alerts once (hourly tick only)', async () => {
  const seed = {
    holiday_card_orders: [order({ status: 'shipped', shipped_at: daysAgo(2), print_files: null })],
    holiday_cards: [card({ status: 'ready', film_id: IDS.film, heartbeat_at: null })],
    year_films: [{ id: IDS.film, status: 'failed', video_key: 'films/x.mp4', ready_at: daysAgo(5) }],
  };
  const offHour = rig(seed);
  assertEquals((await offHour.run()).films, null);
  assertEquals(alertsFor(offHour, 'ORDERED_FILM_UNAVAILABLE').length, 0);

  const r = rig(seed);
  const first = await r.run({ now: NOW_HOURLY });
  assertEquals(first.films.alerted, 1);
  assertEquals(r.db.row('holiday_cards', IDS.card).last_failure_code, 'ordered_film_unavailable');
  await r.run({ now: NOW_HOURLY + 3_600_000 });
  assertEquals(alertsFor(r, 'ORDERED_FILM_UNAVAILABLE').length, 1);
});

Deno.test('ordered films: a healthy film, a card with no order, and a published film that lost its video', async () => {
  const healthy = rig({
    holiday_card_orders: [order({ status: 'shipped', print_files: null })],
    holiday_cards: [card({ status: 'ready', film_id: IDS.film })],
    year_films: [{ id: IDS.film, status: 'ready', video_key: 'films/x.mp4', ready_at: daysAgo(5) }],
  });
  assertEquals((await healthy.run({ now: NOW_HOURLY })).films.alerted, 0);

  const unordered = rig({
    holiday_cards: [card({ status: 'ready', film_id: IDS.film })],
    year_films: [{ id: IDS.film, status: 'failed', video_key: null, ready_at: null }],
  });
  assertEquals((await unordered.run({ now: NOW_HOURLY })).films.checked, 0);

  assertEquals(filmIsBroken({ id: 'f', status: 'ready', video_key: null, ready_at: daysAgo(1) }), true);
  assertEquals(filmIsBroken({ id: 'f', status: 'rendering', video_key: 'k', ready_at: daysAgo(1) }), false);
  assertEquals(filmIsBroken({ id: 'f', status: 'queued', video_key: null, ready_at: null }), false);
});

Deno.test('the sweep response never carries addresses or other order details', async () => {
  const r = rig({ holiday_card_orders: [order()] });
  const result = await r.run();
  const text = JSON.stringify(result);
  assertEquals(text.includes(US_ADDRESS.line1), false);
  assertEquals(text.includes(IDS.order), false);
});

// ── Refunds that did not finish ──────────────────────────────────────────

Deno.test('refunds: a refunded paid order still holding a draft is finished by the sweep (draft deleted, cancelled, never confirmed)', async () => {
  const r = rig({ holiday_card_orders: [order({ refunded_at: minutesAgo(20) })] });
  const result = await r.run();
  assertEquals(result.refunds.cancelled, 1);
  assertEquals(row(r).status, 'cancelled');
  assertEquals(r.gelato.state.orders.size, 0);
  assertEquals(patches(r).length, 0);
});

Deno.test('refunds: a confirmed refunded order is cancelled at Gelato', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'in_production', refunded_at: minutesAgo(20) })] }, { gelatoOrder: { orderType: 'order', status: 'in_production' } });
  await r.run();
  assertEquals(r.gelato.state.calls.some((c) => c.method === 'POST' && c.path === `/orders/${GELATO_ID}:cancel`), true);
  assertEquals(row(r).status, 'cancelled');
});

Deno.test('refunds: Gelato unreachable is retried silently for 30 minutes, then alerted exactly once; the order keeps being retried', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'submitted', refunded_at: minutesAgo(5) })] }, { gelatoOrder: { orderType: 'order', status: 'pending' } });
  r.gelato.state.forceStatus.set(`GET /orders/${GELATO_ID}`, 503);
  await r.run();
  assertEquals(row(r).status, 'submitted');
  assertEquals(alertsFor(r, 'REFUND_NOT_CANCELLED').length, 0);
  const later = await r.run({ now: NOW + 40 * 60_000 });
  assertEquals(later.refunds.flagged, 1);
  await r.run({ now: NOW + 50 * 60_000 });
  assertEquals(alertsFor(r, 'REFUND_NOT_CANCELLED').length, 1);
  // Gelato recovers: the transition finishes.
  r.gelato.state.forceStatus.clear();
  await r.run({ now: NOW + 60 * 60_000 });
  assertEquals(row(r).status, 'cancelled');
});

Deno.test('refunds: a Gelato refusal alerts at once (once)', async () => {
  const r = rig({ holiday_card_orders: [order({ status: 'in_production', refunded_at: minutesAgo(5) })] }, { gelatoOrder: { orderType: 'order', status: 'in_production' } });
  r.gelato.state.forceStatus.set(`POST /orders/${GELATO_ID}:cancel`, 400);
  await r.run();
  await r.run();
  assertEquals(alertsFor(r, 'REFUND_NOT_CANCELLED').length, 1);
  assertEquals(row(r).status, 'in_production');
});

Deno.test('confirm: a payment refunded at Stripe before the confirm is cancelled, never confirmed (out-of-order events)', async () => {
  const r = rig({ holiday_card_orders: [order()] });
  r.stripe.state.paymentIntents.set('pi_test_1', { amount: 4980, amount_refunded: 4980 });
  await r.run();
  assertEquals(row(r).status, 'cancelled');
  assertEquals(typeof row(r).refunded_at, 'string');
  assertEquals(patches(r).length, 0);
  assertEquals(alertsFor(r, 'REFUNDED_BEFORE_CONFIRM').length, 1);
});

// ── Failed card generation is retried ────────────────────────────────────

const failedCard = (overrides: Row = {}): Row => card({
  status: 'failed', last_failure_code: 'LETTERS_FAILED', heartbeat_at: null, attempt_id: 'old', workflow_instance_id: 'wf', updated_at: minutesAgo(20), generation_attempts: 1, ...overrides,
});

Deno.test('generation retry: a failed card with a retryable code is reset to generating in one guarded UPDATE, counted and re-dispatched', async () => {
  const r = rig({ holiday_cards: [failedCard()] });
  const result = await r.run();
  assertEquals(result.generation.retriedFailed, 1);
  const reset = r.db.row('holiday_cards', IDS.card);
  assertEquals(reset.status, 'generating');
  assertEquals(reset.last_failure_code, null);
  assertEquals(reset.attempt_id, null);
  assertEquals(reset.workflow_instance_id, null);
  assertEquals(reset.heartbeat_at, null);
  assertEquals(r.db.rpcCalls.map((c) => c.name), ['increment_holiday_card_generation_attempt']);
  assertEquals(r.dispatches.length, 1); // exactly one dispatch: the stale pass does not pick the reset card in the same tick
  // The guard names the status AND the code we read.
  const update = r.db.log.find((l) => l.table === 'holiday_cards' && l.op === 'update' && l.patch.status === 'generating');
  assertEquals(update?.matched, 1);
});

Deno.test('generation retry: every retryable code is retried; NO_LETTERS and exhausted are terminal', async () => {
  for (const code of ['CONTEXT_LOAD_FAILED', 'FRONT_PICK_FAILED', 'FILM_SETUP_FAILED', 'LETTERS_FAILED', 'UNKNOWN_ERROR']) {
    const r = rig({ holiday_cards: [failedCard({ last_failure_code: code })] });
    await r.run();
    assertEquals(r.dispatches.length, 1);
  }
  for (const code of ['NO_LETTERS', 'generation_attempts_exhausted', null]) {
    const r = rig({ holiday_cards: [failedCard({ last_failure_code: code })] });
    await r.run();
    assertEquals(r.dispatches.length, 0);
    assertEquals(r.db.row('holiday_cards', IDS.card).status, 'failed');
  }
});

Deno.test('generation retry: waits 10 minutes after the failure, stops at 3 attempts, skips deleted cards', async () => {
  const young = rig({ holiday_cards: [failedCard({ updated_at: minutesAgo(5) })] });
  await young.run();
  assertEquals(young.dispatches.length, 0);
  const spent = rig({ holiday_cards: [failedCard({ generation_attempts: 3 })] });
  await spent.run();
  assertEquals(spent.dispatches.length, 0);
  const deleted = rig({ holiday_cards: [failedCard({ deleted_at: minutesAgo(15) })] });
  await deleted.run();
  assertEquals(deleted.dispatches.length, 0);
});

Deno.test('generation retry: a card whose status or code changed under us is left alone (CAS)', async () => {
  const r = rig({ holiday_cards: [failedCard()] });
  // Another writer moves the card between our SELECT and the guarded UPDATE.
  const realBuild = r.db.build.bind(r.db);
  r.db.build = () => {
    const client = realBuild();
    const from = client.from.bind(client);
    client.from = (table: string) => {
      if (table === 'holiday_cards') r.db.row('holiday_cards', IDS.card).last_failure_code = 'NO_LETTERS';
      return from(table);
    };
    return client;
  };
  await r.run();
  assertEquals(r.dispatches.length, 0);
  assertEquals(r.db.row('holiday_cards', IDS.card).last_failure_code, 'NO_LETTERS');
});


// ── Checkout aging by the Stripe session's own expiry ────────────────────

const CLAIMED = (orderId: string, ageMin: number): Row => ({
  id: IDS.card, family_id: IDS.family, status: 'ready', deleted_at: null, checkout_order_id: orderId, checkout_claimed_at: minutesAgo(ageMin), heartbeat_at: null, film_id: null,
});
const checkoutWithExpiry = (expiresMinutesAgo: number, overrides: Row = {}): Row =>
  order({
    status: 'checkout',
    stripe_payment_intent_id: null,
    updated_at: minutesAgo(30),
    print_files: { files: [], snapshotHash: 'h1', sessionExpiresAt: minutesAgo(expiresMinutesAgo) },
    ...overrides,
  });
const openSession = (r: Rig) => r.stripe.state.sessions.set('cs_test_000001', { status: 'open', payment_status: 'unpaid', url: 'u', metadata: {}, payment_intent: null });

Deno.test('aging: a checkout is aged 1 hour AFTER its session expires_at (not 48 h after it was created), and its card claim is released', async () => {
  // Expired 61 minutes ago: due, although the order is only 30 minutes old.
  const due = rig({ holiday_card_orders: [checkoutWithExpiry(61)], holiday_cards: [CLAIMED(IDS.order, 100)] });
  openSession(due);
  const result = await due.run();
  assertEquals(result.aging.cancelled, 1);
  assertEquals(row(due).status, 'cancelled');
  assertEquals(due.stripe.state.sessions.get('cs_test_000001')?.status, 'expired');
  assertEquals(due.gelato.state.orders.size, 0);
  assertEquals(due.db.row('holiday_cards', IDS.card).checkout_order_id, null);

  // Expired 59 minutes ago: the webhook's `expired` event has had its hour; not yet the backstop's turn.
  const early = rig({ holiday_card_orders: [checkoutWithExpiry(59)], holiday_cards: [CLAIMED(IDS.order, 100)] });
  openSession(early);
  assertEquals((await early.run()).aging.cancelled, 0);
  assertEquals(row(early).status, 'checkout');
  assertEquals(early.db.row('holiday_cards', IDS.card).checkout_order_id, IDS.order);

  // Still open (expires in the future).
  const live = rig({ holiday_card_orders: [checkoutWithExpiry(-20)] });
  openSession(live);
  assertEquals((await live.run()).aging.cancelled, 0);
  assertEquals(row(live).status, 'checkout');
});

Deno.test('aging: a checkout with no stored expiry falls back to the 48 h rule; a flagged one waits for a human', async () => {
  const legacy = rig({ holiday_card_orders: [order({ status: 'checkout', stripe_payment_intent_id: null, updated_at: minutesAgo(10 * 60) })] });
  openSession(legacy);
  assertEquals((await legacy.run()).aging.cancelled, 0);

  const flagged = rig({ holiday_card_orders: [checkoutWithExpiry(120, { failure_reason: 'PAID_WEBHOOK_MISSED' })] });
  openSession(flagged);
  assertEquals((await flagged.run()).aging.cancelled, 0);
  assertEquals(row(flagged).status, 'checkout');
});

Deno.test('aging: a checkout past its expiry whose session turns out PAID is still never cancelled', async () => {
  const r = rig({ holiday_card_orders: [checkoutWithExpiry(90)], holiday_cards: [CLAIMED(IDS.order, 100)] });
  r.stripe.state.sessions.set('cs_test_000001', { status: 'complete', payment_status: 'paid', url: 'u', metadata: {}, payment_intent: 'pi_test_1' });
  const result = await r.run();
  assertEquals(result.aging.paidWebhookMissed, 1);
  assertEquals(row(r).status, 'checkout');
  assertEquals(row(r).failure_reason, 'PAID_WEBHOOK_MISSED');
  assertEquals(r.gelato.state.orders.size, 1);
  assertEquals(r.db.row('holiday_cards', IDS.card).checkout_order_id, IDS.order); // the order is still the card's checkout
});

Deno.test('aging: an old quoted order also gives back a card claim a crashed create_checkout left', async () => {
  const r = rig({
    holiday_card_orders: [order({ status: 'quoted', stripe_payment_intent_id: null, stripe_session_id: null, updated_at: minutesAgo(49 * 60) })],
    holiday_cards: [CLAIMED(IDS.order, 100)],
  });
  await r.run();
  assertEquals(row(r).status, 'cancelled');
  assertEquals(r.db.row('holiday_cards', IDS.card).checkout_order_id, null);
});

// ── Stale card-level checkout claims ─────────────────────────────────────

Deno.test('card claims: a claim older than 10 minutes whose order is not in checkout is released; live ones are kept', async () => {
  const id = (n: number) => `c0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const oid = (n: number) => `d0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const claimCard = (n: number, orderId: string, ageMin: number): Row => ({ ...CLAIMED(orderId, ageMin), id: id(n) });
  const claimOrder = (n: number, overrides: Row): Row => order({ id: oid(n), card_id: id(n), stripe_payment_intent_id: null, ...overrides });
  const r = rig({
    holiday_cards: [
      claimCard(1, oid(1), 11), // cancelled order: stale -> released
      claimCard(2, oid(2), 11), // order in checkout: the live claim -> kept
      claimCard(3, oid(3), 5), // young -> kept
      claimCard(4, oid(4), 11), // quoted with a fresh create_checkout claim -> kept
      claimCard(5, oid(5), 11), // quoted, no live work -> released
      claimCard(6, oid(6), 11), // paid order -> released
      claimCard(7, oid(7), 11), // order row gone -> released
      claimCard(8, oid(8), 11), // quoted with an OLD create_checkout claim -> released
    ],
    holiday_card_orders: [
      claimOrder(1, { status: 'cancelled' }),
      claimOrder(2, { status: 'checkout', print_files: { files: [], sessionExpiresAt: minutesAgo(-20) } }),
      claimOrder(3, { status: 'cancelled' }),
      claimOrder(4, { status: 'quoted', print_files: { claim: { id: 'x', at: minutesAgo(3) } }, updated_at: minutesAgo(3) }),
      claimOrder(5, { status: 'quoted', print_files: null, updated_at: minutesAgo(11) }),
      claimOrder(6, { status: 'paid', failure_reason: 'HELD_FOR_CANARY' }),
      claimOrder(8, { status: 'quoted', print_files: { claim: { id: 'x', at: minutesAgo(20) } }, updated_at: minutesAgo(20) }),
    ],
  });
  const result = await r.run();
  assertEquals(result.claims.released, 5);
  const owner = (n: number) => r.db.row('holiday_cards', id(n)).checkout_order_id;
  assertEquals([1, 2, 3, 4, 5, 6, 7, 8].map(owner), [null, oid(2), oid(3), oid(4), null, null, null, null]);
  // Each release is the by-order RPC (a stale release can never clear another order's claim).
  assertEquals(r.db.rpcCalls.filter((c) => c.name === 'release_holiday_card_checkout').map((c) => c.args.p_order_id).sort(), [oid(1), oid(5), oid(6), oid(7), oid(8)].sort());
  // Idempotent.
  assertEquals((await r.run()).claims.released, 0);
});

// ── Held canary ──────────────────────────────────────────────────────────

const HOLD_SETTINGS: Row = { id: true, mode: 'canary', orders_enabled: true, hold_confirm_family_ids: [IDS.family], canary_family_ids: [IDS.family] };

Deno.test('held canary: the sweep flags a held family\'s paid order once, alerts once, never touches Stripe or Gelato, and never fails it by age', async () => {
  const r = rig({ holiday_card_orders: [order()], holiday_card_settings: [HOLD_SETTINGS] });
  const first = await r.run();
  assertEquals(first.confirm.submitted, 0);
  assertEquals(row(r).status, 'paid');
  assertEquals(row(r).failure_reason, 'HELD_FOR_CANARY');
  assertEquals(alertsFor(r, 'HELD_FOR_CANARY').length, 1);
  assertEquals(r.mails.find((m) => m.subject.includes('HELD_FOR_CANARY'))?.body.includes('paid order held before Gelato confirm (canary)'), true);
  assertEquals(patches(r).length, 0);
  assertEquals(r.gelato.state.calls.length, 0);
  assertEquals(r.stripe.state.calls.length, 0);
  // Later ticks (even 7 hours later) leave it alone: no alert, no failure, no PATCH.
  await r.run({ now: NOW + 20 * 60_000 });
  await r.run({ now: NOW + 7 * 60 * 60_000 });
  assertEquals(alertsFor(r, 'HELD_FOR_CANARY').length, 1);
  assertEquals(row(r).status, 'paid');
  assertEquals(patches(r).length, 0);
  assertEquals(r.gelato.state.calls.length, 0);
});

Deno.test('held canary: an unreadable hold list leaves the order alone this tick (no PATCH, no flag) and a listed-elsewhere family is unaffected', async () => {
  const broken = rig({ holiday_card_orders: [order()], holiday_card_settings: [HOLD_SETTINGS] });
  broken.db.rpcFailures.set('holiday_card_hold_confirm', { message: 'boom' });
  const result = await broken.run();
  assertEquals(result.confirm.retry, 1);
  assertEquals(row(broken).status, 'paid');
  assertEquals(row(broken).failure_reason, null);
  assertEquals(patches(broken).length, 0);
  assertEquals(broken.gelato.state.calls.length, 0);

  const unlisted = rig({ holiday_card_orders: [order()], holiday_card_settings: [{ ...HOLD_SETTINGS, hold_confirm_family_ids: ['99999999-0000-4000-8000-000000000009'] }] });
  await unlisted.run();
  assertEquals(row(unlisted).status, 'submitted');
  assertEquals(patches(unlisted).length, 1);
});

Deno.test('held canary: the sweep finishes the refund of a held order (draft deleted, cancelled); a refusal flags REFUND_NOT_CANCELLED once even though HELD_FOR_CANARY was set', async () => {
  const ok = rig({ holiday_card_orders: [order({ failure_reason: 'HELD_FOR_CANARY', refunded_at: minutesAgo(20) })], holiday_card_settings: [HOLD_SETTINGS], holiday_cards: [CLAIMED(IDS.order, 30)] });
  const done = await ok.run();
  assertEquals(done.refunds.cancelled, 1);
  assertEquals(row(ok).status, 'cancelled');
  assertEquals(ok.gelato.state.orders.size, 0);
  assertEquals(patches(ok).length, 0);

  const refused = rig({ holiday_card_orders: [order({ failure_reason: 'HELD_FOR_CANARY', refunded_at: minutesAgo(20) })], holiday_card_settings: [HOLD_SETTINGS] });
  refused.gelato.state.forceStatus.set(`DELETE /orders/${GELATO_ID}`, 400);
  const first = await refused.run();
  assertEquals(first.refunds.flagged, 1);
  assertEquals(row(refused).failure_reason, 'REFUND_NOT_CANCELLED');
  await refused.run();
  assertEquals(alertsFor(refused, 'REFUND_NOT_CANCELLED').length, 1);

  // Another reason is never overwritten by the refund flag.
  const mismatch = rig({ holiday_card_orders: [order({ failure_reason: 'PAYMENT_MISMATCH_AMOUNT', refunded_at: minutesAgo(20) })] });
  mismatch.gelato.state.forceStatus.set(`DELETE /orders/${GELATO_ID}`, 400);
  await mismatch.run();
  assertEquals(row(mismatch).failure_reason, 'PAYMENT_MISMATCH_AMOUNT');
});

// ── 5c. "your card is ready" push ────────────────────────────────────────

const CARD_FILM_ID = IDS.film;
const READY_CARD = (overrides: Row = {}): Row => ({
  id: IDS.card, family_id: IDS.family, created_by: IDS.user, language: 'en', status: 'ready', film_id: CARD_FILM_ID,
  deleted_at: null, ready_notified_at: null, heartbeat_at: null, created_at: minutesAgo(30), updated_at: minutesAgo(5), generation_attempts: 1, last_failure_code: null, ...overrides,
});
const FILM = (overrides: Row = {}): Row => ({ id: CARD_FILM_ID, status: 'rendering', blocked: false, video_key: null, ready_at: null, ...overrides });
const PUBLISHED = { status: 'ready', video_key: 'o/film.mp4', ready_at: minutesAgo(1) };
const PROFILE = (overrides: Row = {}): Row => ({ id: IDS.user, expo_push_token: 'ExponentPushToken[fictional-token-1]', deleted_at: null, ...overrides });
const readyCard = (r: Rig) => r.db.row('holiday_cards', IDS.card);

Deno.test('card ready push: a card whose film is published notifies its creator once, with the route payload', async () => {
  const r = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  const first = await r.run();
  assertEquals(first.ready, { considered: 1, waiting: 0, claimed: 1, sent: 1, failed: 0 });
  assertEquals(r.pushes.length, 1);
  assertEquals(r.pushes[0], {
    token: 'ExponentPushToken[fictional-token-1]',
    title: 'Your holiday card is ready',
    body: 'Open it to review and order.',
    data: { route: 'holiday-card', cardId: IDS.card, familyId: IDS.family },
  });
  assertEquals(typeof readyCard(r).ready_notified_at, 'string');
  // The next ticks find nothing to do.
  await r.run();
  await r.run({ now: NOW + 10 * 60_000 });
  assertEquals(r.pushes.length, 1);
});

Deno.test('card ready push: Spanish cards get the Spanish copy; anything else English', async () => {
  const es = rig({ holiday_cards: [READY_CARD({ language: 'es' })], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  await es.run();
  assertEquals([es.pushes[0].title, es.pushes[0].body], ['Tu tarjeta de fiestas está lista', 'Ábrela para revisarla y pedirla.']);
  const other = rig({ holiday_cards: [READY_CARD({ language: 'fr' })], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  await other.run();
  assertEquals(other.pushes[0].title, 'Your holiday card is ready');
});

Deno.test('card ready push: cards without a film (ready in ~2 minutes while the parent watched) never push and are not marked', async () => {
  const r = rig({ holiday_cards: [READY_CARD({ film_id: null })], user_profiles: [PROFILE()] });
  const result = await r.run();
  assertEquals(result.ready.considered, 0);
  assertEquals(r.pushes.length, 0);
  assertEquals(readyCard(r).ready_notified_at, null);
});

Deno.test('card ready push: waits while the film is still being made, then pushes once it is published', async () => {
  const r = rig({ holiday_cards: [READY_CARD()], year_films: [FILM()], user_profiles: [PROFILE()] });
  const waiting = await r.run();
  assertEquals(waiting.ready, { considered: 1, waiting: 1, claimed: 0, sent: 0, failed: 0 });
  assertEquals(r.pushes.length, 0);
  assertEquals(readyCard(r).ready_notified_at, null);

  Object.assign(r.db.row('year_films', CARD_FILM_ID), PUBLISHED);
  const done = await r.run({ now: NOW + 10 * 60_000 });
  assertEquals(done.ready.sent, 1);
  assertEquals(r.pushes.length, 1);
});

Deno.test('card ready push: a film that failed, was skipped/ended or blocked, or the 75-minute valve, also counts as ready', async () => {
  for (const film of [{ status: 'failed' }, { status: 'skipped' }, { status: 'ended' }, { blocked: true }]) {
    const r = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(film)], user_profiles: [PROFILE()] });
    await r.run();
    assertEquals(r.pushes.length, 1, JSON.stringify(film));
  }
  // A film stuck rendering: held at 74 minutes, released by the valve after 75.
  const stuck = rig({ holiday_cards: [READY_CARD({ created_at: minutesAgo(74) })], year_films: [FILM()], user_profiles: [PROFILE()] });
  await stuck.run();
  assertEquals(stuck.pushes.length, 0);
  await stuck.run({ now: NOW + 2 * 60_000 });
  assertEquals(stuck.pushes.length, 1);
});

Deno.test('card ready push: the CAS decides: a card already claimed by another tick is never pushed again', async () => {
  const r = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  // Another tick wins the claim between this tick's read and its CAS.
  const original = r.db.rpcHandlers.get('holiday_card_readiness');
  r.db.rpcHandlers.set('holiday_card_readiness', (args) => {
    readyCard(r).ready_notified_at = minutesAgo(0);
    return original ? original(args) : 'ready';
  });
  const result = await r.run();
  assertEquals(result.ready.claimed, 0);
  assertEquals(r.pushes.length, 0);

  // Two concurrent ticks over the same card: exactly one push.
  const pair = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  await Promise.all([pair.run(), pair.run()]);
  assertEquals(pair.pushes.length, 1);
});

Deno.test('card ready push: the claim is written BEFORE the send, a failed send is not retried, and the failure is logged by id only', async () => {
  const r = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  r.pushResult.ok = 'throw';
  const first = await r.run();
  assertEquals([first.ready.claimed, first.ready.sent, first.ready.failed], [1, 0, 1]);
  assertEquals(typeof readyCard(r).ready_notified_at, 'string');
  r.pushResult.ok = true;
  await r.run();
  assertEquals(r.pushes.length, 1); // only the failed attempt
  const rejected = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  rejected.pushResult.ok = false;
  assertEquals((await rejected.run()).ready.failed, 1);
});

Deno.test('card ready push: no token, a deleted profile, a missing creator and old/deleted cards are skipped (the claim is still taken)', async () => {
  const noToken = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE({ expo_push_token: null })] });
  const a = await noToken.run();
  assertEquals([a.ready.claimed, a.ready.sent, noToken.pushes.length], [1, 0, 0]);
  assertEquals(typeof readyCard(noToken).ready_notified_at, 'string');

  const deletedProfile = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE({ deleted_at: minutesAgo(5) })] });
  await deletedProfile.run();
  assertEquals(deletedProfile.pushes.length, 0);

  const noCreator = rig({ holiday_cards: [READY_CARD({ created_by: null })], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  await noCreator.run();
  assertEquals(noCreator.pushes.length, 0);

  const old = rig({ holiday_cards: [READY_CARD({ created_at: daysAgo(3) })], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  assertEquals((await old.run()).ready.considered, 0);
  const deleted = rig({ holiday_cards: [READY_CARD({ deleted_at: minutesAgo(5) })], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  assertEquals((await deleted.run()).ready.considered, 0);
  const alreadyNotified = rig({ holiday_cards: [READY_CARD({ ready_notified_at: minutesAgo(20) })], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  assertEquals((await alreadyNotified.run()).ready.considered, 0);
  const generating = rig({ holiday_cards: [READY_CARD({ status: 'generating' })], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  assertEquals((await generating.run()).ready.considered, 0);
});

Deno.test('card ready push: the batch is bounded and a readiness RPC failure leaves the card for the next tick', async () => {
  const cards = Array.from({ length: 30 }, (_, i) => READY_CARD({
    id: `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    film_id: `50000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    created_at: minutesAgo(30 - i / 100),
  }));
  const films = cards.map((c) => FILM({ ...PUBLISHED, id: c.film_id }));
  const r = rig({ holiday_cards: cards, year_films: films, user_profiles: [PROFILE()] });
  const result = await r.run();
  assertEquals(result.ready.considered, 25);
  assertEquals(r.pushes.length, 25);
  assertEquals((await r.run()).ready.considered, 5);

  const broken = rig({ holiday_cards: [READY_CARD()], year_films: [FILM(PUBLISHED)], user_profiles: [PROFILE()] });
  broken.db.rpcFailures.set('holiday_card_readiness', { message: 'boom', code: 'XX000' });
  const out = await broken.run();
  assertEquals([out.ready.claimed, broken.pushes.length], [0, 0]);
  assertEquals(readyCard(broken).ready_notified_at, null);
});


// ── Pay first: the sweep resumes the whole print pipeline ────────────────

const payFirst = (overrides: Row = {}): Row => order({ ...PAY_FIRST_COLUMNS, gelato_order_id: null, snapshot_hash: FROZEN_HASH, print_files: { snapshotHash: FROZEN_HASH }, ...overrides });
const draftCalls = (r: Rig) => r.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders');

Deno.test('pay first: the sweep renders, creates the draft and confirms a paid order the webhook never got to (one render, one draft, one PATCH)', async () => {
  const r = rig({ holiday_card_orders: [payFirst()] }, { gelatoOrder: null });
  const result = await r.run();
  assertEquals(result.confirm.submitted, 1);
  assertEquals(row(r).status, 'submitted');
  assertEquals(r.render.renderCalls.length, 1);
  assertEquals(draftCalls(r).length, 1);
  assertEquals(patches(r).length, 1);
  assertEquals(r.mails.filter((m) => m.to === 'buyer@example.com').length, 1);
  await r.run();
  assertEquals(r.render.renderCalls.length, 1);
  assertEquals(draftCalls(r).length, 1);
});

Deno.test('pay first: a transient render failure is retried every tick (still paid), alerts once at ~30 minutes and fails the order at 6 hours', async () => {
  const r = rig({ holiday_card_orders: [payFirst({ updated_at: minutesAgo(10) })] }, { gelatoOrder: null });
  r.render.setRender(() => new Response('down', { status: 503 }));
  const first = await r.run();
  assertEquals(first.confirm.retry, 1);
  assertEquals(row(r).status, 'paid');
  assertEquals(alertsFor(r, 'PAID_NOT_SUBMITTED').length, 0);
  await r.run({ now: NOW + 32 * 60_000 }); // the first pipeline run (the stable clock) was 32 minutes ago
  assertEquals(alertsFor(r, 'PAID_NOT_SUBMITTED').length, 1);
  await r.run({ now: NOW + 50 * 60_000 }); // outside the alert window: quiet
  assertEquals(alertsFor(r, 'PAID_NOT_SUBMITTED').length, 1);
  assertEquals(draftCalls(r).length, 0);
  // The render recovers: the next tick completes it.
  r.render.setRender(defaultRenderResponse);
  await r.run({ now: NOW + 60 * 60_000 });
  assertEquals(row(r).status, 'submitted');

  const stuck = rig({ holiday_card_orders: [payFirst({ updated_at: minutesAgo(10) })] }, { gelatoOrder: null });
  stuck.render.setRender(() => new Response('down', { status: 503 }));
  await stuck.run({ now: NOW + 7 * 60 * 60_000 });
  assertEquals(row(stuck).status, 'failed');
  assertEquals(row(stuck).failure_reason, 'CONFIRM_TIMEOUT');
  assertEquals(alertsFor(stuck, 'CONFIRM_TIMEOUT').length, 1);
});

Deno.test('pay first: a render content refusal fails the order at once with one owner alert (like the book: manual refund)', async () => {
  const r = rig({ holiday_card_orders: [payFirst()] }, { gelatoOrder: null });
  r.render.setRender(() => new Response(JSON.stringify({ ok: false, code: 'LETTER_OVERFLOW', message: 'x' }), { status: 422 }));
  const result = await r.run();
  assertEquals(result.confirm.failed, 1);
  assertEquals(row(r).status, 'failed');
  assertEquals(row(r).failure_reason, 'RENDER_REFUSED:LETTER_OVERFLOW');
  assertEquals(alertsFor(r, 'RENDER_REFUSED').length, 1);
  assertEquals(r.mails.some((m) => m.to === 'buyer@example.com'), false);
  await r.run();
  assertEquals(alertsFor(r, 'RENDER_REFUSED').length, 1);
  assertEquals(r.stripe.state.calls.length, 0);
});

Deno.test('pay first: Gelato refusing the draft fails the order; the files stay for the owner; Gelato down is retried', async () => {
  const refused = rig({ holiday_card_orders: [payFirst()] }, { gelatoOrder: null });
  refused.gelato.state.forceStatus.set('POST /orders', 400);
  await refused.run();
  assertEquals(row(refused).status, 'failed');
  assertEquals(String(row(refused).failure_reason).startsWith('GELATO_DRAFT_REJECTED'), true);
  assertEquals(alertsFor(refused, 'GELATO_DRAFT_REJECTED').length, 1);

  const down = rig({ holiday_card_orders: [payFirst()] }, { gelatoOrder: null });
  down.gelato.state.forceStatus.set('POST /orders', 503);
  const result = await down.run();
  assertEquals(result.confirm.retry, 1);
  assertEquals(row(down).status, 'paid');
  // The files rendered once survive: the next tick reuses them.
  down.gelato.state.forceStatus.clear();
  await down.run({ now: NOW + 6 * 60_000 });
  assertEquals(down.render.renderCalls.length, 1);
  assertEquals(row(down).status, 'submitted');
});

Deno.test('pay first: the held canary stops after the files and the draft exist; later ticks never repeat the work', async () => {
  const r = rig({ holiday_card_orders: [payFirst()], holiday_card_settings: [HOLD_SETTINGS] }, { gelatoOrder: null });
  await r.run();
  assertEquals(row(r).status, 'paid');
  assertEquals(row(r).failure_reason, 'HELD_FOR_CANARY');
  assertEquals(r.render.renderCalls.length, 1);
  assertEquals(draftCalls(r).length, 1);
  assertEquals(patches(r).length, 0);
  assertEquals(alertsFor(r, 'HELD_FOR_CANARY').length, 1);
  await r.run({ now: NOW + 20 * 60_000 });
  assertEquals(r.render.renderCalls.length, 1);
  assertEquals(draftCalls(r).length, 1);
  assertEquals(alertsFor(r, 'HELD_FOR_CANARY').length, 1);
});

Deno.test('pay first: an order that is refunded before the sweep reaches it is cancelled without rendering anything', async () => {
  const r = rig({ holiday_card_orders: [payFirst({ refunded_at: minutesAgo(5) })] }, { gelatoOrder: null });
  const result = await r.run();
  assertEquals(row(r).status, 'cancelled');
  assertEquals(r.render.renderCalls.length, 0);
  assertEquals(draftCalls(r).length, 0);
  assertEquals(result.refunds.cancelled, 1);
});

Deno.test('pay first: a checkout that was never paid has nothing to clean up (no draft, no files) when aged', async () => {
  const r = rig({
    holiday_card_orders: [order({ status: 'checkout', stripe_payment_intent_id: null, gelato_order_id: null, updated_at: minutesAgo(30), print_files: { snapshotHash: FROZEN_HASH, sessionExpiresAt: minutesAgo(61) } })],
  }, { gelatoOrder: null });
  r.stripe.state.sessions.set('cs_test_000001', { status: 'expired', payment_status: 'unpaid', url: 'u', metadata: {}, payment_intent: null });
  await r.run();
  assertEquals(row(r).status, 'cancelled');
  assertEquals(r.gelato.state.calls.length, 0);
});

// ═══ Pipeline hardening (review round) ═══

const ORDER_X = (n: number) => `d0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

Deno.test('the confirm/print pass runs LAST under a deadline: one slow render defers the rest, and the cheap passes (refunds, aging, claims) were already done', async () => {
  let jump = 0;
  const r = rig({
    holiday_card_orders: [
      payFirst({ id: ORDER_X(1), updated_at: minutesAgo(30) }),
      payFirst({ id: ORDER_X(2), updated_at: minutesAgo(29) }),
      // The refund backstop and a stale quoted order: cheap passes that must not wait for the renders.
      order({ id: ORDER_X(3), refunded_at: minutesAgo(20), updated_at: minutesAgo(30) }),
      order({ id: ORDER_X(4), status: 'quoted', stripe_payment_intent_id: null, stripe_session_id: null, gelato_order_id: null, print_files: null, updated_at: minutesAgo(49 * 60) }),
    ],
  }, { gelatoOrder: { orderType: 'draft', status: 'created' } });
  // The first render takes "100 seconds" of the invocation (the deadline is 75 s).
  r.render.setRender((call) => { jump += 100_000; return defaultRenderResponse(call); });
  const result = await r.run({ nowFn: () => NOW + jump });
  assertEquals(result.refunds.cancelled, 1);
  assertEquals(row(r, ORDER_X(3)).status, 'cancelled');
  assertEquals(result.aging.cancelled, 1);
  assertEquals(result.confirm.submitted, 1);
  assertEquals(result.confirm.deferred, 1);
  assertEquals(r.render.renderCalls.length, 1);
  assertEquals(row(r, ORDER_X(2)).status, 'paid'); // not started, not harmed
  // Next tick (the clock moved on, the first one is submitted): the deferred order is done.
  jump = 0;
  await r.run({ now: NOW + 15 * 60_000 });
  assertEquals(row(r, ORDER_X(2)).status, 'submitted');
});

Deno.test('the confirm pass rotates by print_files.pipelineAttemptAt (never-tried first, then the oldest attempt), not by updated_at', async () => {
  let jump = 0;
  const attempted = (at: string | null) => ({ snapshotHash: FROZEN_HASH, ...(at ? { pipelineAttemptAt: at, pipelineStartedAt: at } : {}) });
  const r = rig({
    holiday_card_orders: [
      // Oldest updated_at but attempted most recently.
      payFirst({ id: ORDER_X(1), updated_at: minutesAgo(90), print_files: attempted(minutesAgo(10)) }),
      payFirst({ id: ORDER_X(2), updated_at: minutesAgo(40), print_files: attempted(minutesAgo(35)) }),
      payFirst({ id: ORDER_X(3), updated_at: minutesAgo(30), print_files: attempted(null) }),
    ],
  }, { gelatoOrder: null });
  r.render.setRender(() => { jump += 100_000; return new Response('down', { status: 503 }); }); // one order per tick
  const rendered = () => r.render.renderCalls.map((c) => String(c.body.orderId));
  await r.run({ nowFn: () => NOW + jump });
  assertEquals(rendered(), [ORDER_X(3)]); // never tried first
  jump = 0;
  await r.run({ nowFn: () => NOW + 12 * 60_000 + jump });
  assertEquals(rendered(), [ORDER_X(3), ORDER_X(2)]); // then the oldest attempt (not the oldest updated_at)
  jump = 0;
  await r.run({ nowFn: () => NOW + 24 * 60_000 + jump });
  assertEquals(rendered().slice(2), [ORDER_X(1)]);
  assertEquals(typeof (row(r, ORDER_X(3)).print_files as { pipelineAttemptAt?: string }).pipelineAttemptAt, 'string');
});

Deno.test('the sweep renders with its own short timeout (<= 60 s), shorter than the webhook\'s', () => {
  assertEquals(SWEEP_RENDER_TIMEOUT_MS <= 60_000, true);
  assertEquals(CONFIRM_DEADLINE_MS <= 90_000 && CONFIRM_DEADLINE_MS >= 60_000, true);
  Deno.env.set('MEMORY_BOOK_RENDER_WORKER_URL', 'https://render.test');
  Deno.env.set('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET', 's');
  try {
    const pipeline = printPipelineFromEnv({ createPresignedGetUrls: fakePresign(), headObject: async () => null }, { renderTimeoutMs: SWEEP_RENDER_TIMEOUT_MS });
    assertEquals(pipeline?.renderTimeoutMs, SWEEP_RENDER_TIMEOUT_MS);
    assertEquals(printPipelineFromEnv({ createPresignedGetUrls: fakePresign(), headObject: async () => null })?.renderTimeoutMs, undefined);
  } finally {
    Deno.env.delete('MEMORY_BOOK_RENDER_WORKER_URL');
    Deno.env.delete('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET');
  }
});

Deno.test('the sweep leaves a paid order alone for 5 minutes (the webhook\'s own run gets first go)', async () => {
  const young = rig({ holiday_card_orders: [payFirst({ updated_at: minutesAgo(4) })] }, { gelatoOrder: null });
  await young.run();
  assertEquals(row(young).status, 'paid');
  assertEquals(young.render.renderCalls.length, 0);
  const old = rig({ holiday_card_orders: [payFirst({ updated_at: minutesAgo(6) })] }, { gelatoOrder: null });
  await old.run();
  assertEquals(row(old).status, 'submitted');
});

Deno.test('the sweep picks up a held partial refund once the owner sets PARTIAL_REFUND_OK, and prints it', async () => {
  const r = rig({ holiday_card_orders: [payFirst({ failure_reason: 'PARTIAL_REFUND_OK' })] }, { gelatoOrder: null });
  r.stripe.state.paymentIntents.set('pi_test_1', { amount: 4980, amount_refunded: 500 });
  const result = await r.run();
  assertEquals(result.confirm.submitted, 1);
  assertEquals(row(r).status, 'submitted');
  assertEquals(row(r).failure_reason, null);
  // A flagged order that is NOT acknowledged is still skipped.
  const held = rig({ holiday_card_orders: [payFirst({ failure_reason: 'PARTIAL_REFUND_BEFORE_CONFIRM' })] }, { gelatoOrder: null });
  await held.run();
  assertEquals(row(held).status, 'paid');
  assertEquals(held.render.renderCalls.length, 0);
});

Deno.test('orphaned print files: a cancelled/failed order is purged again >= 1 h after its first purge (a late render can write after it), once', async () => {
  const cancelled = (id: string, purgedMinutesAgo: number | null, extra: Row = {}) => order({
    id, status: 'cancelled', stripe_payment_intent_id: null, gelato_order_id: null, updated_at: minutesAgo(5),
    print_files: purgedMinutesAgo === null ? { files: [] } : { purgedAt: minutesAgo(purgedMinutesAgo), ...extra }, ...(purgedMinutesAgo === null ? {} : {}),
  });
  const r = rig({ holiday_card_orders: [cancelled(ORDER_X(1), 61), cancelled(ORDER_X(2), 30), cancelled(ORDER_X(3), 120, { repurgedAt: minutesAgo(10) })] });
  // A render that finished AFTER the first purge wrote its PDF under each prefix.
  for (const n of [1, 2, 3]) r.r2.keys.add(`print-orders/${ORDER_X(n)}/late/card.pdf`);
  const result = await r.run();
  assertEquals(result.cleanup.repurged, 1);
  assertEquals(r.r2.keys.has(`print-orders/${ORDER_X(1)}/late/card.pdf`), false); // purged again
  assertEquals(r.r2.keys.has(`print-orders/${ORDER_X(2)}/late/card.pdf`), true); // not yet 1 h
  assertEquals(r.r2.keys.has(`print-orders/${ORDER_X(3)}/late/card.pdf`), true); // already re-purged once: done
  assertEquals(typeof (row(r, ORDER_X(1)).print_files as { repurgedAt?: string }).repurgedAt, 'string');
  assertEquals(typeof (row(r, ORDER_X(1)).print_files as { purgedAt?: string }).purgedAt, 'string');
  r.r2.keys.add(`print-orders/${ORDER_X(1)}/later/card.pdf`);
  assertEquals((await r.run()).cleanup.repurged, 0);
  assertEquals(r.r2.keys.has(`print-orders/${ORDER_X(1)}/later/card.pdf`), true); // once only
  // 30 minutes later the second order is due.
  const later = await r.run({ now: NOW + 35 * 60_000 });
  assertEquals(later.cleanup.repurged, 1);
  assertEquals(r.r2.keys.has(`print-orders/${ORDER_X(2)}/late/card.pdf`), false);
});

Deno.test('orphaned print files end to end: a refunded order is released, a late render writes afterwards, and the second purge removes it', async () => {
  const r = rig({ holiday_card_orders: [order({ refunded_at: minutesAgo(20), print_files: { snapshotHash: FROZEN_HASH } })] });
  await r.run(); // refund backstop: draft deleted, cancelled
  assertEquals(row(r).status, 'cancelled');
  await r.run({ now: NOW + 10 * 60_000 }); // retention: files released, marker set
  assertEquals(purged(r), true);
  r.r2.keys.add(`print-orders/${IDS.order}/late/card.pdf`); // the render that was still running
  await r.run({ now: NOW + 30 * 60_000 });
  assertEquals(r.r2.keys.has(`print-orders/${IDS.order}/late/card.pdf`), true);
  await r.run({ now: NOW + 80 * 60_000 });
  assertEquals(r.r2.keys.has(`print-orders/${IDS.order}/late/card.pdf`), false);
});
