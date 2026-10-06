import { assertEquals } from 'jsr:@std/assert@1';
import { decideTrack, filmIsBroken, handleSweepHolidayCardOrders } from './index.ts';
import { FakeDb, IDS, makeGelatoFake, makeR2Fake, makeStripeFake, QUOTED_ORDER, US_ADDRESS } from '../_shared/holiday-card-orders.test-support.ts';

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
  r2: ReturnType<typeof makeR2Fake>;
  mails: { to: string; subject: string; body: string }[];
  dispatches: { cardId: string; attemptId: string }[];
  dispatchResult: { ok: boolean };
  run: (options?: { now?: number; secret?: string | null }) => Promise<Record<string, any>>;
}

function rig(seed: Record<string, Row[]>, options: { gelatoOrder?: { orderType?: 'draft' | 'order'; status?: string; tracking?: Row[]; refusal?: string } | null } = {}): Rig {
  const db = new FakeDb({ holiday_card_orders: [], holiday_cards: [], year_films: [], families: [], ...seed });
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
  const routed = (async (input: Request | URL | string, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    if (host === 'api.stripe.com') return stripe.fetch(input, init);
    return gelato.fetch(input, init);
  }) as typeof fetch;
  db.rpcHandlers.set('increment_holiday_card_generation_attempt', () => 1);
  return {
    db, gelato, stripe, r2, mails, dispatches, dispatchResult,
    run: async (opts = {}) => {
      const previous = { cron: Deno.env.get('CRON_SECRET'), gelato: Deno.env.get('GELATO_API_KEY'), stripe: Deno.env.get('STRIPE_SECRET_KEY') };
      Deno.env.set('CRON_SECRET', 'cron-secret');
      Deno.env.set('GELATO_API_KEY', 'gelato-test-key');
      Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_x');
      try {
        const headers: Record<string, string> = {};
        if (opts.secret !== null) headers['x-cron-secret'] = opts.secret ?? 'cron-secret';
        const response = await handleSweepHolidayCardOrders(new Request('http://localhost', { method: 'POST', headers }), {
          createServiceClient: db.client(),
          fetch: routed,
          now: () => opts.now ?? NOW,
          sendEmail: async (input) => { mails.push({ to: input.to, subject: input.subject, body: input.htmlBody }); return 'sent'; },
          listKeys: r2.listKeys,
          deleteKey: r2.deleteKey,
          dispatchGeneration: async (cardId, attemptId) => { dispatches.push({ cardId, attemptId }); return dispatchResult.ok; },
        });
        return { status: response.status, ...(await response.json()) };
      } finally {
        for (const [key, name] of [['cron', 'CRON_SECRET'], ['gelato', 'GELATO_API_KEY'], ['stripe', 'STRIPE_SECRET_KEY']] as const) {
          const value = previous[key];
          if (value === undefined) Deno.env.delete(name); else Deno.env.set(name, value);
        }
      }
    },
  };
}

const row = (r: Rig, id: string = IDS.order) => r.db.row('holiday_card_orders', id);
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
  // Submitted by the confirm pass, then advanced by the track pass of the same tick (Gelato says `passed`).
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

Deno.test('confirm: a rejected PATCH or a missing draft marks the order failed with an alert', async () => {
  const rejected = rig({ holiday_card_orders: [order()] });
  rejected.gelato.state.forceStatus.set(`PATCH /orders/${GELATO_ID}`, 400);
  await rejected.run();
  assertEquals(row(rejected).status, 'failed');
  assertEquals(String(row(rejected).failure_reason).startsWith('GELATO_CONFIRM_REJECTED'), true);

  const missing = rig({ holiday_card_orders: [order()] }, { gelatoOrder: null });
  await missing.run();
  assertEquals(row(missing).failure_reason, 'GELATO_DRAFT_MISSING');
  assertEquals(alertsFor(missing, 'GELATO_DRAFT_MISSING').length, 1);
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
  assertEquals(aged.print_files, null);
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

Deno.test('retention: print files are deleted 30 days after shipped_at and print_files is nulled so it never repeats', async () => {
  const r = rig({
    holiday_card_orders: [
      order({ status: 'shipped', shipped_at: daysAgo(31), updated_at: daysAgo(31) }),
      order({ id: '10000000-0000-4000-8000-000000000008', status: 'shipped', shipped_at: daysAgo(10) }),
    ],
  });
  r.r2.keys.add('print-orders/10000000-0000-4000-8000-000000000008/front.pdf');
  const result = await r.run();
  assertEquals(result.cleanup.filesDeleted, 1);
  assertEquals(row(r).print_files, null);
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
  assertEquals(row(r).print_files, null);
  assertEquals(row(r, '10000000-0000-4000-8000-000000000007').print_files, null);
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
  assertEquals(row(old).print_files, null);
  assertEquals(old.r2.keys.size, 0);

  const refunded = rig({ holiday_card_orders: [order({ status: 'failed', failure_reason: 'CONFIRM_TIMEOUT', refunded_at: minutesAgo(3), updated_at: daysAgo(1) })] });
  await refunded.run();
  assertEquals(row(refunded).print_files, null);
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
