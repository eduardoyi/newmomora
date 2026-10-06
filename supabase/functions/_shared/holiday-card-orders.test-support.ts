// Test-only fakes for the holiday-card order flow (holiday-card-orders,
// sweep-holiday-card-orders, stripe-webhook): a small in-memory stand-in for the
// supabase-js query builder, a recording Gelato fetch, an R2 object store and
// a Stripe fetch. Fictional data only (the repository is public).
//
// The query builder is deliberately CAS-realistic: every filter is applied when
// the chain is awaited, `update(...).eq('status', x).select().maybeSingle()`
// returns null when no row matches (a lost compare-and-set), and an UPDATE bumps
// `updated_at` like the real `set_updated_at` trigger.

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface FakeDbOptions {
  /** `updated_at` stamp for updates (default: the real clock). */
  clock?: () => string;
  /** The database's `now()` in ms, used by the built-in claim RPCs (default: the real clock). */
  nowMs?: () => number;
  /**
   * Return true to make this write fail with a database error, or `{ code }` for a
   * database error with that SQLSTATE (e.g. '23505').
   */
  failWrite?: (table: string, op: 'update' | 'insert', patch: Row) => boolean | { code: string; /** apply the write, THEN report the error (a lost response) */ applied?: boolean };
  /** Return true to make this SELECT (of these columns) fail with a database error. */
  failRead?: (table: string, columns: string | null) => boolean;
}

/** What a failing RPC answers: supabase-js puts the Postgres SQLSTATE in `code` and the RAISE hint in `hint`. */
export class FakeRpcError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint: string | null = message) {
    super(message);
  }
}

/** Column accessor: `col` or the PostgREST JSON path `col->>key`. */
function valueAt(row: Row, col: string): unknown {
  const at = col.indexOf('->>');
  if (at < 0) return row[col] ?? null;
  const outer = row[col.slice(0, at)];
  const inner = typeof outer === 'object' && outer !== null ? (outer as Row)[col.slice(at + 3)] : null;
  return inner ?? null;
}

const CLAIM_FRESH_MS = 10 * 60_000;

export interface WriteLogEntry {
  table: string;
  op: 'update' | 'insert' | 'delete';
  patch: Row;
  matched: number;
}

export class FakeDb {
  readonly tables = new Map<string, Row[]>();
  readonly log: WriteLogEntry[] = [];
  readonly rpcCalls: { name: string; args: Row }[] = [];
  readonly rpcHandlers = new Map<string, (args: Row) => unknown>();
  readonly users = new Map<string, { email: string | null }>();
  /** Make an RPC fail with this database error (a settings read error, a claim RPC outage...). */
  readonly rpcFailures = new Map<string, { message: string; code?: string; hint?: string | null }>();

  /** The database clock (ms). */
  now(): number {
    return (this.options.nowMs ?? Date.now)();
  }

  /**
   * Behaviour of the P2 RPCs (migration 20261007120000), mirrored from the SQL so the
   * order flow is tested against the real rules; `rpcHandlers` / `rpcFailures` override.
   */
  private readonly builtinRpcs: Record<string, (args: Row) => unknown> = {
    holiday_card_orders_enabled: () => {
      const settings = this.rows('holiday_card_settings')[0];
      return settings ? settings.orders_enabled !== false : false;
    },
    holiday_card_hold_confirm: (args) => {
      const settings = this.rows('holiday_card_settings')[0];
      const list = (settings?.hold_confirm_family_ids ?? []) as string[];
      return list.includes(String(args.p_family_id));
    },
    // Mirrors holiday_card_readiness (migration 20261008120000).
    holiday_card_readiness: (args) => {
      const card = this.rows('holiday_cards').find((c) => c.id === args.p_card_id);
      if (!card) return null;
      if (card.status === 'generating') return 'generating';
      if (card.status === 'failed') return 'failed';
      if (!card.film_id) return 'ready';
      if (Date.parse(String(card.created_at)) < this.now() - 75 * 60_000) return 'ready';
      const film = this.rows('year_films').find((f) => f.id === card.film_id);
      if (!film || film.blocked || ['failed', 'skipped', 'ended'].includes(String(film.status))) return 'ready';
      return film.video_key && film.ready_at ? 'ready' : 'film';
    },
    claim_holiday_card_checkout: (args) => {
      const orderId = String(args.p_order_id);
      const order = this.rows('holiday_card_orders').find((o) => o.id === orderId);
      const card = order?.card_id ? this.rows('holiday_cards').find((c) => c.id === order.card_id) : undefined;
      if (!order || !card || card.deleted_at) throw new FakeRpcError('P0002', 'card_not_found');
      if ((card.edits_version ?? 0) !== args.p_expected_version) throw new FakeRpcError('40001', 'CARD_CHANGED');
      const claimAt = card.checkout_claimed_at ? Date.parse(String(card.checkout_claimed_at)) : NaN;
      const otherCheckout = this.rows('holiday_card_orders').some((o) => o.card_id === card.id && o.status === 'checkout' && o.id !== orderId);
      const freshOtherClaim = card.checkout_order_id && card.checkout_order_id !== orderId && Number.isFinite(claimAt) &&
        claimAt > this.now() - CLAIM_FRESH_MS;
      if (otherCheckout || freshOtherClaim) throw new FakeRpcError('55000', 'CHECKOUT_OPEN_ELSEWHERE');
      card.checkout_order_id = orderId;
      card.checkout_claimed_at = new Date(this.now()).toISOString();
      return [{ edits_version: 0, ...card }];
    },
    release_holiday_card_checkout: (args) => {
      for (const card of this.rows('holiday_cards')) {
        if (card.checkout_order_id === args.p_order_id) {
          card.checkout_order_id = null;
          card.checkout_claimed_at = null;
        }
      }
      return null;
    },
  };

  constructor(seed: Record<string, Row[]> = {}, private readonly options: FakeDbOptions = {}) {
    for (const [table, rows] of Object.entries(seed)) this.tables.set(table, rows.map((row) => ({ ...row })));
  }

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  row(table: string, id: string): Row {
    const found = this.rows(table).find((r) => r.id === id);
    if (!found) throw new Error(`no ${table} row ${id}`);
    return found;
  }

  /** `createServiceClient`-compatible factory. */
  client() {
    // deno-lint-ignore no-explicit-any
    return (() => this.build()) as any;
  }

  // deno-lint-ignore no-explicit-any
  build(): any {
    return {
      from: (table: string) => this.query(table),
      rpc: (name: string, args: Row) => {
        this.rpcCalls.push({ name, args });
        const forced = this.rpcFailures.get(name);
        if (forced) return Promise.resolve({ data: null, error: { message: forced.message, code: forced.code, hint: forced.hint ?? null } });
        const handler = this.rpcHandlers.get(name) ?? this.builtinRpcs[name];
        try {
          return Promise.resolve({ data: handler ? handler(args) : null, error: null });
        } catch (error) {
          if (error instanceof FakeRpcError) return Promise.resolve({ data: null, error: { message: error.message, code: error.code, hint: error.hint } });
          throw error;
        }
      },
      auth: {
        admin: {
          getUserById: (id: string) => {
            const user = this.users.get(id);
            return Promise.resolve({ data: { user: user ? { id, email: user.email } : null }, error: null });
          },
        },
      },
    };
  }

  private query(table: string) {
    const db = this;
    const filters: Filter[] = [];
    let mode: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let patch: Row = {};
    let columns: string | null = null;
    const orderBy: { col: string; ascending: boolean; nullsFirst: boolean }[] = [];
    let limitN: number | null = null;
    let wantsRows = false;

    const project = (row: Row): Row => {
      if (!columns || columns === '*') return { ...row };
      const out: Row = {};
      for (const col of columns.split(',').map((c) => c.trim())) out[col] = row[col] ?? null;
      return out;
    };

    const exec = (): { data: Row[]; error: { message: string; code?: string } | null } => {
      const all = db.rows(table);
      const failure = (op: 'update' | 'insert') => {
        const failed = db.options.failWrite?.(table, op, patch);
        if (!failed) return null;
        if (typeof failed === 'object' && failed.applied && op === 'update') {
          for (const row of all.filter((r) => filters.every((f) => f(r)))) {
            Object.assign(row, patch);
            if (!('updated_at' in patch)) row.updated_at = (db.options.clock ?? (() => new Date().toISOString()))();
          }
        }
        return { data: [] as Row[], error: { message: `${op} failed`, ...(typeof failed === 'object' ? { code: failed.code } : {}) } };
      };
      if (mode === 'insert') {
        const failed = failure('insert');
        if (failed) return failed;
        const defaults: Row = table === 'holiday_card_orders' ? { status: 'draft' } : {};
        const row: Row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...defaults, ...patch };
        all.push(row);
        db.log.push({ table, op: 'insert', patch, matched: 1 });
        return { data: [project(row)], error: null };
      }
      if (mode === 'select' && db.options.failRead?.(table, columns)) return { data: [], error: { message: 'select failed' } };
      let matched = all.filter((row) => filters.every((f) => f(row)));
      if (mode === 'update') {
        const failed = failure('update');
        if (failed) return failed;
        // holiday_card_orders_one_checkout_per_card: at most one 'checkout' order per card.
        if (table === 'holiday_card_orders' && patch.status === 'checkout') {
          for (const row of matched) {
            const clash = all.some((other) => other !== row && other.card_id === row.card_id && other.status === 'checkout');
            if (clash) return { data: [], error: { message: 'duplicate key value violates unique constraint "holiday_card_orders_one_checkout_per_card"', code: '23505' } };
          }
        }
        for (const row of matched) {
          Object.assign(row, patch);
          if (!('updated_at' in patch)) row.updated_at = (db.options.clock ?? (() => new Date().toISOString()))();
        }
        db.log.push({ table, op: 'update', patch, matched: matched.length });
        return { data: matched.map(project), error: null };
      }
      if (mode === 'delete') {
        for (const row of matched) all.splice(all.indexOf(row), 1);
        db.log.push({ table, op: 'delete', patch: {}, matched: matched.length });
        return { data: matched.map(project), error: null };
      }
      if (orderBy.length > 0) {
        // Every `.order()` call is a tie-breaker for the one before it, like PostgREST.
        matched = [...matched].sort((a, b) => {
          for (const { col, ascending, nullsFirst } of orderBy) {
            const left = valueAt(a, col) as string | number | null;
            const right = valueAt(b, col) as string | number | null;
            if (left === right) continue;
            if (left === null || left === undefined) return nullsFirst ? -1 : 1;
            if (right === null || right === undefined) return nullsFirst ? 1 : -1;
            return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
      }
      if (limitN !== null) matched = matched.slice(0, limitN);
      return { data: matched.map(project), error: null };
    };

    // deno-lint-ignore no-explicit-any
    const chain: any = {
      select: (cols?: string) => {
        columns = cols ?? null;
        wantsRows = true;
        return chain;
      },
      insert: (row: Row) => {
        mode = 'insert';
        patch = row;
        return chain;
      },
      update: (p: Row) => {
        mode = 'update';
        patch = p;
        return chain;
      },
      delete: () => {
        mode = 'delete';
        return chain;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => valueAt(r, col) === val);
        return chain;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => (r[col] ?? null) !== val);
        return chain;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => valueAt(r, col) === val);
        return chain;
      },
      not: (col: string, op: string, val: unknown) => {
        if (op !== 'is') throw new Error('fake db: only not(col, "is", x) is supported');
        filters.push((r) => valueAt(r, col) !== val);
        return chain;
      },
      lt: (col: string, val: string | number) => {
        filters.push((r) => valueAt(r, col) !== null && (valueAt(r, col) as string | number) < val);
        return chain;
      },
      // Only `col.is.null` and `col.eq.value` terms (what the order flow uses).
      or: (expression: string) => {
        const terms = expression.split(',').map((term) => {
          const [col, op, ...rest] = term.split('.');
          const value = rest.join('.');
          if (op === 'is' && value === 'null') return (r: Row) => valueAt(r, col) === null;
          if (op === 'eq') return (r: Row) => String(valueAt(r, col)) === value;
          throw new Error(`fake db: unsupported or() term ${term}`);
        });
        filters.push((r) => terms.some((t) => t(r)));
        return chain;
      },
      lte: (col: string, val: string | number) => {
        filters.push((r) => r[col] !== null && r[col] !== undefined && (r[col] as string | number) <= val);
        return chain;
      },
      gt: (col: string, val: string | number) => {
        filters.push((r) => r[col] !== null && r[col] !== undefined && (r[col] as string | number) > val);
        return chain;
      },
      order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
        // PostgREST default: nulls last when ascending, first when descending.
        orderBy.push({ col, ascending: opts?.ascending !== false, nullsFirst: opts?.nullsFirst ?? opts?.ascending === false });
        return chain;
      },
      limit: (n: number) => {
        limitN = n;
        return chain;
      },
      returns: () => chain,
      maybeSingle: () => {
        const result = exec();
        if (result.error) return Promise.resolve({ data: null, error: result.error });
        return Promise.resolve({ data: result.data[0] ?? null, error: null });
      },
      single: () => {
        const result = exec();
        if (result.error) return Promise.resolve({ data: null, error: result.error });
        return Promise.resolve(result.data[0]
          ? { data: result.data[0], error: null }
          : { data: null, error: { message: 'no rows', code: 'PGRST116' } });
      },
      // deno-lint-ignore no-explicit-any
      then: (resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) => {
        void wantsRows;
        return Promise.resolve(exec()).then(resolve, reject);
      },
    };
    return chain;
  }
}

// ── Gelato fake ──────────────────────────────────────────────────────────

export interface GelatoFakeState {
  /** Recorded requests: method + path (no bodies, no addresses). */
  calls: { method: string; path: string; body?: Row }[];
  orders: Map<string, { orderType: 'draft' | 'order'; fulfillmentStatus: string; tracking: Row[]; refusalReasonCode?: string; items?: Row[] }>;
  /** Force an HTTP status for a path suffix (e.g. 'PATCH /orders/abc'). */
  forceStatus: Map<string, number>;
  quote: Row | null;
  nextId: number;
  /** PATCH confirms the order at Gelato but answers 400 (a concurrent confirm won the race). */
  patchConfirmsThenFails: boolean;
}

export function makeGelatoFake(): { state: GelatoFakeState; fetch: typeof fetch } {
  const state: GelatoFakeState = { calls: [], orders: new Map(), forceStatus: new Map(), quote: null, nextId: 1, patchConfirmsThenFails: false };
  const json = (status: number, body: unknown) => status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fakeFetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/v4/, '');
    const body = init?.body ? JSON.parse(String(init.body)) as Row : undefined;
    state.calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const forced = state.forceStatus.get(key);
    if (forced !== undefined) return json(forced, { code: 'forced_error' });

    if (method === 'POST' && path === '/orders:quote') {
      return json(200, state.quote ?? {
        quotes: [{
          fulfillmentCountry: 'US',
          products: [{ price: 11.68, currency: 'USD' }],
          shipmentMethods: [{ shipmentMethodUid: 'ground', name: 'Ground', price: 7.03, minDeliveryDays: 3, maxDeliveryDays: 6, type: 'normal' }],
        }],
      });
    }
    if (method === 'POST' && path === '/orders') {
      const id = `gel-${String(state.nextId++).padStart(8, '0')}`;
      state.orders.set(id, { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] });
      return json(200, { id, orderType: 'draft', fulfillmentStatus: 'created', items: [{ id: 'item-1', itemReferenceId: 'cards', quantity: (body?.items as Row[] | undefined)?.[0]?.quantity ?? 1, fulfillmentStatus: 'created' }] });
    }
    const orderMatch = /^\/orders\/([A-Za-z0-9-]+)(:cancel)?$/.exec(path);
    if (orderMatch) {
      const id = orderMatch[1];
      const order = state.orders.get(id);
      if (!order) return json(404, { code: 'not_found' });
      const view = () => ({
        id,
        orderType: order.orderType,
        fulfillmentStatus: order.fulfillmentStatus,
        refusalReasonCode: order.refusalReasonCode,
        items: order.items ?? [{ id: 'item-1', itemReferenceId: 'cards', quantity: 2, fulfillmentStatus: order.fulfillmentStatus }],
        fulfillments: order.tracking,
      });
      if (method === 'GET') return json(200, view());
      if (method === 'PATCH') {
        order.orderType = 'order';
        order.fulfillmentStatus = 'pending';
        if (state.patchConfirmsThenFails) return json(400, { code: 'already_confirmed' });
        return json(200, view());
      }
      if (method === 'DELETE') {
        if (order.orderType !== 'draft') return json(400, { code: 'not_a_draft' });
        state.orders.delete(id);
        return json(204, null);
      }
      if (method === 'POST' && orderMatch[2] === ':cancel') {
        order.fulfillmentStatus = 'canceled';
        return json(200, view());
      }
    }
    return json(404, { code: 'unknown_route' });
  }) as typeof fetch;
  return { state, fetch: fakeFetch };
}

// ── R2 fake ──────────────────────────────────────────────────────────────

export function makeR2Fake(initialKeys: string[] = []) {
  const keys = new Set(initialKeys);
  const deleted: string[] = [];
  return {
    keys,
    deleted,
    listKeys: (prefix: string) => Promise.resolve([...keys].filter((k) => k.startsWith(prefix))),
    deleteKey: (key: string) => {
      keys.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
  };
}

// ── Stripe fake ──────────────────────────────────────────────────────────

export interface StripeFakeState {
  calls: { method: string; path: string; body: string; idempotencyKey: string | null }[];
  sessions: Map<string, { status: string; payment_status: string; url: string; metadata: Record<string, string>; payment_intent: string | null }>;
  nextSession: number;
  /** Status to answer for `POST /checkout/sessions/{id}/expire` (400 = the session is already complete). */
  expireStatus: number;
  /** `GET /payment_intents/{id}`: amount and refunded amount (default 4980 / 0). */
  paymentIntents: Map<string, { amount: number; amount_refunded: number }>;
  /** Make every payment intent read fail with this HTTP status. */
  paymentIntentStatus: number;
  /** When set, a NEW session (not an idempotent replay) must expire at least 30 minutes after this clock (Stripe's rule). */
  now: (() => number) | null;
}

export function makeStripeFake(): { state: StripeFakeState; fetch: typeof fetch } {
  const state: StripeFakeState = { calls: [], sessions: new Map(), nextSession: 1, expireStatus: 200, paymentIntents: new Map(), paymentIntentStatus: 200, now: null };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const idempotent = new Map<string, Response>();
  const fakeFetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    const idempotencyKey = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] ?? null;
    state.calls.push({ method, path, body, idempotencyKey });
    if (idempotencyKey && idempotent.has(`${path}:${idempotencyKey}`)) return idempotent.get(`${path}:${idempotencyKey}`)!.clone();
    let response: Response;
    if (method === 'POST' && path === '/customers') {
      response = json(200, { id: `cus_${state.calls.length}` });
    } else if (method === 'POST' && path === '/checkout/sessions') {
      const expiresAt = Number(new URLSearchParams(body).get('expires_at'));
      if (state.now && Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 - state.now() < 30 * 60_000) {
        return json(400, { error: { message: 'The `expires_at` timestamp must be at least 30 minutes in the future.' } });
      }
      const id = `cs_test_${String(state.nextSession++).padStart(6, '0')}`;
      const params = new URLSearchParams(body);
      state.sessions.set(id, {
        status: 'open',
        payment_status: 'unpaid',
        url: `https://checkout.stripe.test/${id}`,
        metadata: { productType: params.get('metadata[productType]') ?? '', orderId: params.get('metadata[orderId]') ?? '', snapshotHash: params.get('metadata[snapshotHash]') ?? '' },
        payment_intent: null,
      });
      response = json(200, { id, url: `https://checkout.stripe.test/${id}` });
    } else {
      const expire = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/expire$/.exec(path);
      const get = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
      const intent = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
      if (intent) {
        if (state.paymentIntentStatus !== 200) return json(state.paymentIntentStatus, { error: { message: 'down' } });
        const pi = state.paymentIntents.get(intent[1]) ?? { amount: 4980, amount_refunded: 0 };
        return json(200, { id: intent[1], amount: pi.amount, latest_charge: { id: 'ch_test', amount_refunded: pi.amount_refunded } });
      }
      if (expire) {
        const session = state.sessions.get(expire[1]);
        if (!session) return json(404, { error: { message: 'no such session' } });
        if (state.expireStatus !== 200) return json(state.expireStatus, { error: { message: 'cannot expire' } });
        session.status = 'expired';
        response = json(200, { id: expire[1], status: 'expired', payment_status: session.payment_status, metadata: session.metadata });
      } else if (get) {
        const session = state.sessions.get(get[1]);
        if (!session) return json(404, { error: { message: 'no such session' } });
        response = json(200, { id: get[1], status: session.status, payment_status: session.payment_status, url: session.status === 'open' ? session.url : null, metadata: session.metadata, payment_intent: session.payment_intent });
      } else {
        return json(404, { error: { message: 'unknown route' } });
      }
    }
    if (idempotencyKey) idempotent.set(`${path}:${idempotencyKey}`, response.clone());
    return response;
  }) as typeof fetch;
  return { state, fetch: fakeFetch };
}

// ── Common fixtures (fictional) ──────────────────────────────────────────

export const IDS = {
  user: '11111111-1111-4111-8111-111111111111',
  otherUser: '99999999-9999-4999-8999-999999999999',
  family: '22222222-2222-4222-8222-222222222222',
  card: '33333333-3333-4333-8333-333333333333',
  film: '55555555-5555-4555-8555-555555555555',
  order: '44444444-4444-4444-8444-444444444444',
  mediaFront: '66666666-6666-4666-8666-666666666666',
  mediaOther: '77777777-7777-4777-8777-777777777777',
  memoryFront: '88888888-8888-4888-8888-888888888888',
  memberChild: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  memberParent: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;

export const SHARE_TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

export const US_ADDRESS = {
  name: 'Ada Lovelace',
  line1: '1 Analytical Engine Way',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62704',
  countryCode: 'US',
};

// ── A world with one ready card, its film, people and photos ─────────────

export const PHOTO_KEYS = {
  frontOriginal: 'u1/photos/front-original.jpg',
  frontPreview: 'u1/photos/front-preview.jpg',
  otherOriginal: 'u1/photos/other-original.jpg',
  childPortrait: 'u1/portraits/child.png',
  parentPortrait: 'u1/portraits/parent.png',
} as const;

export const KEY_DIMS: Record<string, { width: number; height: number }> = {
  [PHOTO_KEYS.frontOriginal]: { width: 4000, height: 3000 },
  [PHOTO_KEYS.otherOriginal]: { width: 3000, height: 4000 },
  [PHOTO_KEYS.childPortrait]: { width: 1024, height: 1024 },
  [PHOTO_KEYS.parentPortrait]: { width: 1024, height: 1024 },
};

/** `imageSize` stand-in: the fake R2 answers a ranged read with `dim:<w>x<h>`. */
export function fakeImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const match = /^dim:(\d+)x(\d+)$/.exec(new TextDecoder().decode(bytes));
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

export function fakePresign(record?: { keys: string[]; ttl: number[] }) {
  return (keys: string[], expiresIn?: number): Promise<Record<string, string>> => {
    record?.keys.push(...keys);
    record?.ttl.push(expiresIn ?? 3600);
    return Promise.resolve(Object.fromEntries(keys.map((k) => [k, `https://r2.test/${k}?sig=test`])));
  };
}

export interface RenderCall {
  headers: Headers;
  body: Record<string, unknown>;
}

export interface WorldFetch {
  fetch: typeof fetch;
  gelato: ReturnType<typeof makeGelatoFake>;
  stripe: ReturnType<typeof makeStripeFake>;
  renderCalls: RenderCall[];
  /** Objects the fake render service "uploaded" (key -> bytes), for the R2 HEAD check. */
  objects: Map<string, number>;
  headObject: (key: string) => Promise<{ contentLength: number | null } | null>;
  /** Replace the render service's answer (default: 200 with one card.pdf for `one_pdf`, front.pdf + back.pdf for `two_files`). */
  setRender: (handler: (call: RenderCall) => Response) => void;
}

export function defaultRenderResponse(call: RenderCall): Response {
  const prefix = String(call.body.outputPrefix);
  const files = call.body.fileLayout === 'one_pdf'
    ? [{ side: 'both', key: `${prefix}card.pdf`, sha256: 'c'.repeat(64), bytes: 2000 }]
    : [
      { side: 'front', key: `${prefix}front.pdf`, sha256: 'a'.repeat(64), bytes: 1000 },
      { side: 'back', key: `${prefix}back.pdf`, sha256: 'b'.repeat(64), bytes: 1000 },
    ];
  return new Response(JSON.stringify({ ok: true, mode: call.body.mode, files, checks: { pages: 2 } }), { status: 200 });
}

/** The render service (`https://render.test/render-card`): records calls, "uploads" the files it reports, answers by `setRender`. */
export function makeRenderFake() {
  const renderCalls: RenderCall[] = [];
  const objects = new Map<string, number>();
  let renderHandler: (call: RenderCall) => Response = defaultRenderResponse;
  const fetchRender = async (init?: RequestInit): Promise<Response> => {
    const call = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    renderCalls.push(call);
    const response = renderHandler(call);
    if (response.status === 200) {
      const parsed = await response.clone().json().catch(() => null) as { files?: { key: string; bytes: number }[] } | null;
      for (const file of parsed?.files ?? []) objects.set(file.key, file.bytes);
    }
    return response;
  };
  return {
    renderCalls,
    objects,
    fetchRender,
    headObject: (key: string): Promise<{ contentLength: number | null } | null> => Promise.resolve(objects.has(key) ? { contentLength: objects.get(key) ?? null } : null),
    setRender: (handler: (call: RenderCall) => Response) => { renderHandler = handler; },
  };
}

export function makeWorldFetch(): WorldFetch {
  const gelato = makeGelatoFake();
  const stripe = makeStripeFake();
  const render = makeRenderFake();
  const fakeFetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'order.gelatoapis.com') return gelato.fetch(input, init);
    if (url.hostname === 'api.stripe.com') return stripe.fetch(input, init);
    if (url.hostname === 'render.test') return render.fetchRender(init);
    if (url.hostname === 'r2.test') {
      const key = decodeURIComponent(url.pathname.slice(1));
      const dims = KEY_DIMS[key];
      return dims ? new Response(new TextEncoder().encode(`dim:${dims.width}x${dims.height}`), { status: 206 }) : new Response('missing', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    fetch: fakeFetch, gelato, stripe, renderCalls: render.renderCalls, objects: render.objects,
    headObject: render.headObject,
    setRender: render.setRender,
  };
}

type SeedRow = Record<string, unknown>;

export function cardWorldSeed(overrides: {
  order?: SeedRow | null;
  card?: SeedRow;
  film?: SeedRow | null;
  token?: SeedRow | null;
  family?: SeedRow;
  /** `holiday_card_settings` (the kill switch + the canary hold list); defaults to ordering on, nobody held. */
  settings?: SeedRow;
} = {}): Record<string, SeedRow[]> {
  const film = overrides.film === null ? [] : [{
    id: IDS.film, status: 'ready', blocked: false, video_key: 'films/example.mp4', poster_key: 'films/example.jpg', ready_at: '2026-10-02T10:00:00Z', ...(overrides.film ?? {}),
  }];
  const token = overrides.token === null ? [] : [{ token: SHARE_TOKEN, film_id: IDS.film, revoked_at: null, ...(overrides.token ?? {}) }];
  return {
    holiday_card_settings: [{
      id: true, mode: 'canary', canary_family_ids: [IDS.family], orders_enabled: true, hold_confirm_family_ids: [], ...(overrides.settings ?? {}),
    }],
    families: [{ id: IDS.family, name: 'The Example Family', deleted_at: null, ...(overrides.family ?? {}) }],
    holiday_cards: [{
      id: IDS.card,
      family_id: IDS.family,
      status: 'ready',
      deleted_at: null,
      year: 2026,
      language: 'en',
      locale: 'en-US',
      film_id: overrides.film === null ? null : IDS.film,
      share_token: overrides.film === null ? null : SHARE_TOKEN,
      greeting: 'holidays',
      front_candidates: [{ mediaId: IDS.mediaFront, rank: 1 }],
      letters: [
        { tone: 'classic', text: 'Dear family,\n\nThis year Robin learned to ride a bike.' },
        { tone: 'warm', text: 'Hello everyone,\n\nWhat a year it was.' },
      ],
      qr_caption: 'Watch our year',
      signature: 'With love, the Example family',
      edits: {},
      edits_version: 0,
      checkout_order_id: null,
      checkout_claimed_at: null,
      last_failure_code: null,
      generation_attempts: 1,
      created_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-01T10:00:00.000Z',
      ...(overrides.card ?? {}),
    }],
    year_films: film,
    film_share_tokens: token,
    family_members: [
      { id: IDS.memberChild, family_id: IDS.family, name: 'Robin Example', date_of_birth: '2023-05-05', relationship: 'child', illustrated_profile_key: PHOTO_KEYS.childPortrait, illustrated_profile_status: 'ready' },
      { id: IDS.memberParent, family_id: IDS.family, name: 'Sam Example', date_of_birth: '1990-03-03', relationship: 'parent', illustrated_profile_key: PHOTO_KEYS.parentPortrait, illustrated_profile_status: 'ready' },
    ],
    family_member_portrait_versions: [],
    memory_media: [
      { id: IDS.mediaFront, memory_id: IDS.memoryFront, object_key: PHOTO_KEYS.frontOriginal, preview_object_key: PHOTO_KEYS.frontPreview, content_type: 'image/jpeg' },
      { id: IDS.mediaOther, memory_id: '99999999-0000-4000-8000-000000000000', object_key: PHOTO_KEYS.otherOriginal, preview_object_key: null, content_type: 'image/jpeg' },
    ],
    memories: [
      { id: IDS.memoryFront, family_id: IDS.family, memory_date: '2026-08-12' },
      { id: '99999999-0000-4000-8000-000000000000', family_id: '12121212-1212-4212-8212-121212121212', memory_date: '2026-08-13' },
    ],
    holiday_card_orders: overrides.order === null ? [] : [{
      id: IDS.order,
      card_id: IDS.card,
      family_id: IDS.family,
      requested_by: IDS.user,
      status: 'draft',
      updated_at: '2026-10-06T08:00:00.000Z',
      created_at: '2026-10-06T08:00:00.000Z',
      ...(overrides.order ?? {}),
    }],
  };
}

/** A quoted 2-pack US order (the state `create_checkout` starts from). */
export const QUOTED_ORDER: Record<string, unknown> = {
  status: 'quoted',
  region: 'us_ca',
  format: '5R',
  product_uid: 'pack_of_cards_qt_10_pcs_pf_5r_upt_350-gsm-130lb-coated-silk_cl_4-4_ct_glossy-protection_prt_1-0_sft_none_set_none_hor_ept_standard',
  file_layout: 'one_pdf',
  packs: 2,
  currency: 'USD',
  price_cents: 4980,
  gelato_cost_cents: 1871,
  shipping_address: US_ADDRESS,
};


/** A minimal valid frozen snapshot (what `create_checkout` stores in `card_snapshot`) for pipeline tests that start from a paid row. */
export const FROZEN_SNAPSHOT = {
  card: {
    version: 1,
    slug: 'hc-test',
    year: 2026,
    language: 'en',
    locale: 'en-US',
    greeting: 'holidays',
    familyName: 'The Example Family',
    signature: 'With love, the Example family',
    qrCaption: null,
    qr: { enabled: false, token: '', url: '' },
    format: '5R',
    letters: [{ tone: 'classic', text: 'Dear family,\n\nThis year Robin learned to ride a bike.' }],
    photo: { mediaId: IDS.mediaFront, file: 'assets/photo.jpg', width: 4000, height: 3000 },
    illustrations: [],
    frontOptions: [],
    portraits: [],
  },
  edits: {},
  assets: [{ file: 'assets/photo.jpg', key: PHOTO_KEYS.frontOriginal }],
  qrUrl: null,
  front: { mediaId: IDS.mediaFront, originalKey: PHOTO_KEYS.frontOriginal, previewKey: PHOTO_KEYS.frontPreview, width: 4000, height: 3000 },
};

export const FROZEN_HASH = 'f'.repeat(64);

/** Order columns of a PAY-FIRST order at the moment it is paid: snapshot frozen, nothing rendered, no draft. */
export const PAY_FIRST_COLUMNS: Record<string, unknown> = {
  region: 'us_ca',
  product_uid: QUOTED_ORDER.product_uid,
  currency: 'USD',
  format: '5R',
  file_layout: 'one_pdf',
  packs: 2,
  card_snapshot: FROZEN_SNAPSHOT,
  snapshot_hash: FROZEN_HASH,
  gelato_order_id: null,
  gelato_status: null,
  print_files: { snapshotHash: FROZEN_HASH, sessionExpiresAt: '2026-10-06T12:35:00.000Z' },
};
