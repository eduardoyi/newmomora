import { parseManifest, parseOutline } from '../../model/loader';
import type { BookManifest, BookOutline } from '../../model/types';
import { COVER_SLOT_KEY, isFurnitureKey, type MemoryBookEditsShape } from '../../model/edits';
import type { MemoryBookOrderListRow, MemoryBookOrderRow, MemoryBookOrderStatus, MemoryBookRow } from '../types';
import type { PickerPoolItem, PickerPoolPage, SaveEditInput, SaveEditResult } from '../edits/editsApi';
import type { ShippingAddressInput } from '../order/types';

/**
 * DEV-ONLY fixture mode (owner-approved follow-up round: "diagnose live" —
 * reproduce the reported picker/popover bugs, and verify the furniture-
 * namespace + always-on-editing work, without a running Supabase backend or
 * a logged-in session). Loads one book's `manifest.json`/`book.outline.json`
 * straight from `book-data/<slug>/` (served by the dev server's own
 * `publicDir` — see `vite.web.config.ts`'s header comment) and stands in for
 * every network call the real editing flow makes (`useEditableBook`'s
 * Supabase reads, `editsApi.ts`'s `memory-book-edits` invocations,
 * `coalescer.ts`'s `get-media-url` invocations) with an equivalent local,
 * in-memory implementation.
 *
 * SAFETY: every export here is gated behind `import.meta.env.DEV` (a
 * compile-time constant Vite replaces per-build — `false` for
 * `vite build --config vite.web.config.ts`), so the `if (false) { ... }`
 * branches this module's callers wrap around every use of it are dead code
 * a production build's minifier eliminates, taking this module's import
 * with them. `scripts/check-web-bundle.mjs` asserts that held for the REAL
 * built output, not just this file's intent (same "don't trust the config
 * alone" posture that script's own header comment documents for
 * `publicDir`) — see its `FIXTURE_MARKERS` check.
 */

const FIXTURE_QUERY_PARAM = 'fixture';

// ---------------------------------------------------------------------------
// Book label cache -- see `registerFixtureBookLabel`'s call site in
// `loadFixtureBook` below for why this exists (item 2's orders list needs a
// title the orders store itself never sees).
// ---------------------------------------------------------------------------
const fixtureBookLabelCache = new Map<string, string>();

function registerFixtureBookLabel(slug: string, label: string): void {
  fixtureBookLabelCache.set(slug, label);
}

/** Falls back to the bare slug if the owning book hasn't loaded in THIS
 * session yet (e.g. `OrdersListScreen` visited directly without opening the
 * book first) -- a readable-enough placeholder for dev-only fixture mode,
 * never shown in production. */
function fixtureBookLabel(slug: string): string {
  return fixtureBookLabelCache.get(slug) ?? slug;
}

/** The active `?fixture=<slug>` slug, DEV-only — always `null` in a
 * production build (both because the query param won't be set on a real
 * deploy, and because `import.meta.env.DEV` itself is statically `false`
 * there). */
export function getFixtureSlug(): string | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  const slug = new URLSearchParams(window.location.search).get(FIXTURE_QUERY_PARAM);
  return slug && slug.length > 0 ? slug : null;
}

export function fixtureAssetUrl(slug: string, file: string): string {
  // `book-data/<slug>/` is this dev server's own `publicDir` root, and
  // manifest `file` values already carry their own `assets/` prefix (see
  // `model/loader.ts`'s `staticAssetUrl` doc comment) — identical
  // resolution to the local preview app's default asset URL provider.
  return `/${slug}/${file}`;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fixture: failed to fetch ${path} (${res.status})`);
  return res.json();
}

export interface FixtureBook {
  book: MemoryBookRow;
  outline: BookOutline;
  manifest: BookManifest;
}

/** Loads + parses one fixture book's outline/manifest through the SAME
 * validated parsers the real load path uses (`model/loader.ts`) — never a
 * separate ad hoc shape, so a malformed local export fails the same way it
 * would for a real book. */
export async function loadFixtureBook(slug: string): Promise<FixtureBook> {
  const [manifestRaw, outlineRaw] = await Promise.all([
    fetchJson(`/${slug}/manifest.json`),
    fetchJson(`/${slug}/book.outline.json`),
  ]);
  const manifest = parseManifest(manifestRaw);
  const outline = parseOutline(outlineRaw);
  const now = new Date().toISOString();
  const book: MemoryBookRow = {
    id: slug,
    family_id: 'fixture-family',
    child_id: manifest.child.id,
    status: 'ready',
    scope_label: manifest.scope.label,
    failure_reason: null,
    created_at: now,
    updated_at: now,
    book_document: { outline: outlineRaw, manifest: manifestRaw },
    child: { name: manifest.child.name },
  };
  // memory-book-5c order-status UX round, item 2: `OrdersListScreen`'s
  // fixture stand-in needs a book TITLE per order, which the orders store
  // itself has no way to derive (it only ever sees a bare `bookId`). Cache
  // it here, keyed by slug, the same "registered once the manifest is
  // available" shape `registerFixturePool` already uses below -- same
  // `child.name — scope.label` label `BookListScreen.tsx`/
  // `BookViewScreen.tsx` build for their own headers, so a fixture order's
  // list-row title matches the book's real on-screen name exactly.
  registerFixtureBookLabel(slug, manifest.child.name ? `${manifest.child.name} — ${manifest.scope.label}` : manifest.scope.label);
  return { book, outline, manifest };
}

// ---------------------------------------------------------------------------
// Edits store — one per fixture slug. Backed by `sessionStorage` (owner-
// approved follow-up round, item 1: "toast Remove flow incl. reload
// persistence" needs a real reload to mean something) rather than a bare
// module-level `Map`: a `Map` alone is wiped by ANY full page reload (a new
// JS realm starts from scratch), which made "does the orphan actually stay
// gone after a reload" impossible to verify against fixture mode at all —
// every reload looked "fixed" whether or not the delete really worked.
// `sessionStorage` survives a same-tab reload but still clears itself when
// the tab/window closes, so this is still throwaway, dev-only data with no
// real persistence layer behind it — just enough to make a reload a
// meaningful test within one diagnosis session.
// ---------------------------------------------------------------------------

const EDITS_STORAGE_PREFIX = 'momora-fixture-edits:';
const editsCache = new Map<string, MemoryBookEditsShape>();

function currentEdits(slug: string): MemoryBookEditsShape {
  const cached = editsCache.get(slug);
  if (cached) return cached;
  if (typeof window === 'undefined' || !window.sessionStorage) return {};
  try {
    const raw = window.sessionStorage.getItem(EDITS_STORAGE_PREFIX + slug);
    const parsed = raw ? (JSON.parse(raw) as MemoryBookEditsShape) : {};
    editsCache.set(slug, parsed);
    return parsed;
  } catch {
    return {};
  }
}

function persistEdits(slug: string, edits: MemoryBookEditsShape): void {
  editsCache.set(slug, edits);
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(EDITS_STORAGE_PREFIX + slug, JSON.stringify(edits));
  } catch {
    // Best-effort only — dev diagnosis tooling, never a real data path.
  }
}

/** Read-only accessor for `useEditableBook.ts`'s fixture `load()` branch —
 * so re-loading a fixture book (a remount, or a real reload within the same
 * tab/session) picks up whatever this book's edits already are, exactly like
 * the real path re-fetching `memory_book_edits` would, instead of always
 * starting over from an empty `{}`. */
export function fixtureCurrentEdits(slug: string): MemoryBookEditsShape {
  return currentEdits(slug);
}

const TEXT_TARGET_PATTERN =
  /^(dedication|closing|backCover|sectionTitle:[^\x00-\x1f]{1,128}|eyebrow:[^\x00-\x1f]{1,128}|caption:[0-9a-f-]{36})$/i;
const TEXT_VALUE_MAX_LENGTH = 1000;

function isValidTextTarget(target: string): boolean {
  if (target.startsWith('furniture:')) return isFurnitureKey(target.slice('furniture:'.length));
  return TEXT_TARGET_PATTERN.test(target);
}

/** Fixture stand-in for `editsApi.ts`'s `saveEdit` — mirrors
 * `supabase/functions/memory-book-edits/index.ts`'s `handleSaveEdit`
 * validation just closely enough to catch a genuinely malformed edit during
 * local diagnosis, WITHOUT re-implementing its server-only trust-boundary
 * work (media-row family-ownership resolution, ranged-GET dimension
 * measurement) — `mediaId` here is trusted directly against the fixture's
 * own synthetic picker pool (`fixturePickerPool` below), which is the only
 * source of `mediaId`s a fixture-mode caller could ever pass. */
export async function fixtureSaveEdit(slug: string, edit: SaveEditInput): Promise<SaveEditResult> {
  const current = currentEdits(slug);
  const next: MemoryBookEditsShape = {
    text: { ...current.text },
    images: { ...current.images },
    focalPoints: { ...current.focalPoints },
  };

  switch (edit.kind) {
    case 'text': {
      if (!isValidTextTarget(edit.target)) return { edits: current, error: 'Invalid text edit target' };
      if (edit.value.length > TEXT_VALUE_MAX_LENGTH) return { edits: current, error: 'Invalid text edit value' };
      next.text![edit.target] = { target: edit.target, value: edit.value };
      break;
    }
    case 'imageReplace':
    case 'coverPhoto': {
      const pool = poolForSlug(slug);
      const item = pool.find((i) => i.mediaId === edit.mediaId);
      if (!item) return { edits: current, error: 'Media not found' };
      const slotKeyValue = edit.kind === 'coverPhoto' ? COVER_SLOT_KEY : edit.slot;
      next.images![slotKeyValue] = {
        slot: slotKeyValue,
        mediaId: item.mediaId,
        file: item.previewKey,
        originalFile: item.previewKey,
        aspectRatio: item.aspectRatio ?? 1,
      };
      break;
    }
    case 'focalPoint': {
      if (edit.x < 0 || edit.x > 1 || edit.y < 0 || edit.y > 1) return { edits: current, error: 'Invalid focal point' };
      next.focalPoints![edit.slot] = { slot: edit.slot, x: edit.x, y: edit.y };
      break;
    }
    case 'delete': {
      // Mirrors the Edge Function's `delete` kind (owner-approved follow-up
      // round, item 3a "Reset to original") — removing a key that was never
      // set is a no-op, same idempotent posture as the real server.
      const category = next[edit.category];
      if (category) delete category[edit.key];
      break;
    }
    default:
      return { edits: current, error: 'Unknown edit kind' };
  }

  persistEdits(slug, next);
  return { edits: next, error: null };
}

// ---------------------------------------------------------------------------
// Picker pool — every photo asset across the fixture manifest's memories,
// paginated with a deliberately SMALL page size so exhausting it (to verify
// "hide Load more when nextCursor is null") doesn't need hundreds of clicks.
// ---------------------------------------------------------------------------

const FIXTURE_PICKER_PAGE_SIZE = 12;
const poolCache = new Map<string, PickerPoolItem[]>();

function poolForSlug(slug: string): PickerPoolItem[] {
  return poolCache.get(slug) ?? [];
}

function buildPool(manifest: BookManifest): PickerPoolItem[] {
  const items: PickerPoolItem[] = [];
  const entries = Object.entries(manifest.memories).sort(([, a], [, b]) => a.date.localeCompare(b.date));
  for (const [memoryId, memory] of entries) {
    memory.assets.forEach((asset, i) => {
      if (asset.kind !== 'photo') return;
      items.push({
        memoryId,
        mediaId: `${memoryId}::${i}`,
        previewKey: asset.file,
        date: memory.date,
        aspectRatio: asset.aspectRatio,
        alreadyInBook: false,
      });
    });
  }
  return items;
}

/** Registers this fixture's picker pool — called once from `loadFixtureBook`'s
 * caller (`useEditableBook.ts`) after the manifest is available, so
 * `fixturePickerPool`/`fixtureSaveEdit` (both slug-keyed, no manifest of
 * their own) can resolve `mediaId`s against it. */
export function registerFixturePool(slug: string, manifest: BookManifest): void {
  if (poolCache.has(slug)) return;
  poolCache.set(slug, buildPool(manifest));
}

/** Fixture stand-in for `editsApi.ts`'s `fetchPickerPool` — offset-paginated
 * over the registered pool, same `nextCursor: null` exhaustion contract the
 * real Edge Function uses (see `handlePickerPool`'s own doc comment). An
 * item already chosen via a saved `imageReplace`/`coverPhoto` edit in THIS
 * fixture session is flagged `alreadyInBook`, mirroring
 * `collectImageEditMediaIds`.
 *
 * Item 1 (owner-approved editing-UX round): `filters` mirrors the real
 * function's optional `dateStart`/`dateEnd`/`memberId` -- date filtering
 * works here (`item.date` is a bare `YYYY-MM-DD`, so a plain string
 * comparison is correct). The person filter is a DELIBERATE no-op: the
 * fixture pool (`buildPool` above) carries no member tags to filter
 * against — real tagging lives in `memory_family_members`, which this
 * dev-only, backend-free fixture never models — so a `memberId` here
 * returns the unfiltered pool rather than fabricating tag data. */
export async function fixtureFetchPickerPool(
  slug: string,
  cursor: string | null,
  filters: { dateStart?: string; dateEnd?: string; memberId?: string } = {},
): Promise<PickerPoolPage> {
  const pool = poolForSlug(slug).filter((item) => {
    if (filters.dateStart && item.date < filters.dateStart) return false;
    if (filters.dateEnd && item.date > filters.dateEnd) return false;
    return true;
  });
  const offset = cursor ? Number(cursor) : 0;
  if (cursor && (!Number.isInteger(offset) || offset < 0)) {
    return { items: [], nextCursor: null, error: 'Invalid cursor' };
  }
  const claimedMediaIds = new Set(Object.values(currentEdits(slug).images ?? {}).map((r) => r.mediaId));
  const page = pool.slice(offset, offset + FIXTURE_PICKER_PAGE_SIZE).map((item) => ({
    ...item,
    alreadyInBook: claimedMediaIds.has(item.mediaId),
  }));
  const nextOffset = offset + FIXTURE_PICKER_PAGE_SIZE;
  const nextCursor = nextOffset < pool.length ? String(nextOffset) : null;
  return { items: page, nextCursor, error: null };
}

/** Fixture stand-in for `coalescer.ts`'s `getMediaUrls` — every key resolves
 * synchronously to this book's own static asset URL (no presigning, no
 * network round trip: `book-data/` is already being served locally). */
export function fixtureMediaUrls(slug: string, keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) out.set(key, fixtureAssetUrl(slug, key));
  return out;
}

// ---------------------------------------------------------------------------
// Orders store (memory-book-5c plan Step 6) — mocks every
// `memory-book-orders` op (`create_draft`/`quote`/`create_checkout`) AND the
// buyer-scoped `memory_book_orders` SELECT `useOrderStatus.ts` reads
// directly, so the whole "Order this book" → address → quote → pay →
// order-status flow is interactively verifiable without a running Supabase
// backend, Stripe, Prodigi, or the render worker — no real network call, no
// real money, ever. Same two-layer shape as the edits store above: an
// in-memory object is the ground truth every read/write goes through first
// (also what makes this testable under vitest's `environment: 'node'`, which
// has no `window`), best-effort mirrored into `sessionStorage` so a same-tab
// reload (or navigating away to `/order/<id>` and back) still shows a
// consistent order instead of resetting to nothing.
// ---------------------------------------------------------------------------

export interface FixtureOrder {
  id: string;
  bookId: string;
  status: MemoryBookOrderStatus;
  priceCents: number | null;
  shippingCostCents: number | null;
  currency: string;
  quotedPageCount: number | null;
  shippingAddress: ShippingAddressInput | null;
  prodigiOrderId: string | null;
  failureReason: string | null;
  refundedAt: string | null;
  /** memory-book-5c order-status UX round, item 3 -- mirrors the real
   * `tracking_number`/`tracking_url`/`carrier` columns. */
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  createdAt: string;
  updatedAt: string;
}

const ORDERS_STORAGE_KEY = 'momora-fixture-orders';
// Placeholder figures only — the real price is config-driven and TBD
// (plan §"Resolved owner decisions": "Still pending: the PRICE itself"); the
// shipping figure mirrors prodigi-order-spec.md §6's own indicative Spain
// shipping cost ($16.22) purely as a plausible-looking anchor, not a real
// Prodigi quote.
const FIXTURE_PRICE_CENTS = 4900;
const FIXTURE_SHIPPING_CENTS = 1622;
const FIXTURE_PAGE_COUNT = 64;

let ordersMemoryStore: Record<string, FixtureOrder> | null = null;

/** The in-memory ground truth, lazily hydrated from `sessionStorage` (once)
 * on first access. Every fixture order function reads/writes THIS object
 * directly (never a fresh copy), then `persistOrdersStore()` best-effort
 * mirrors it out — same shape `currentEdits`/`persistEdits` use above. */
function ordersStore(): Record<string, FixtureOrder> {
  if (ordersMemoryStore) return ordersMemoryStore;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const raw = window.sessionStorage.getItem(ORDERS_STORAGE_KEY);
      ordersMemoryStore = raw ? (JSON.parse(raw) as Record<string, FixtureOrder>) : {};
      return ordersMemoryStore;
    } catch {
      // Fall through to a fresh in-memory store below.
    }
  }
  ordersMemoryStore = {};
  return ordersMemoryStore;
}

function persistOrdersStore(): void {
  if (!ordersMemoryStore || typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(ordersMemoryStore));
  } catch {
    // Best-effort only — dev diagnosis tooling, never a real data path.
  }
}

let fixtureOrderCounter = 0;

/** Fixture stand-in for `memory-book-orders`' `create_draft` op. */
export function fixtureCreateOrderDraft(bookId: string): { orderId: string } {
  const store = ordersStore();
  fixtureOrderCounter += 1;
  const id = `fixture-order-${bookId}-${Date.now()}-${fixtureOrderCounter}`;
  const now = new Date().toISOString();
  store[id] = {
    id,
    bookId,
    status: 'draft',
    priceCents: null,
    shippingCostCents: null,
    currency: 'usd',
    quotedPageCount: null,
    shippingAddress: null,
    prodigiOrderId: null,
    failureReason: null,
    refundedAt: null,
    trackingNumber: null,
    trackingUrl: null,
    carrier: null,
    createdAt: now,
    updatedAt: now,
  };
  persistOrdersStore();
  return { orderId: id };
}

export interface FixtureQuoteResult {
  orderId: string;
  status: 'quoted';
  priceCents: number;
  shippingCostCents: number;
  totalCents: number;
  currency: string;
  pageCount: number;
}

/** Fixture stand-in for the `quote` op — skips the real worker `/fit` +
 * Prodigi `/quotes` calls and returns a fixed, plausible-looking bundle. */
export function fixtureQuoteOrder(orderId: string, address: ShippingAddressInput): FixtureQuoteResult | { error: string } {
  const store = ordersStore();
  const order = store[orderId];
  if (!order) return { error: 'Order not found' };
  if (order.status !== 'draft') return { error: 'Order has already been quoted' };
  order.status = 'quoted';
  order.priceCents = FIXTURE_PRICE_CENTS;
  order.shippingCostCents = FIXTURE_SHIPPING_CENTS;
  order.quotedPageCount = FIXTURE_PAGE_COUNT;
  order.shippingAddress = address;
  order.updatedAt = new Date().toISOString();
  store[orderId] = order;
  persistOrdersStore();
  return {
    orderId,
    status: 'quoted',
    priceCents: order.priceCents,
    shippingCostCents: order.shippingCostCents,
    totalCents: order.priceCents + order.shippingCostCents,
    currency: order.currency,
    pageCount: order.quotedPageCount,
  };
}

/** Fixture stand-in for `create_checkout` — no `checkoutUrl` (there is no
 * Stripe session in fixture mode): real money can never move here, so "pay"
 * jumps straight to a paid order, matching the task brief exactly ("pay"
 * (mock jumps straight to a paid order)). The caller (`ordersApi.ts`) reads
 * `checkoutUrl === null` as the signal to navigate client-side to
 * `/order/<id>` instead of redirecting to Stripe. */
export function fixtureCreateCheckout(orderId: string): { orderId: string } | { error: string } {
  const store = ordersStore();
  const order = store[orderId];
  if (!order) return { error: 'Order not found' };
  if (order.status !== 'quoted') return { error: 'Order has not been quoted' };
  order.status = 'paid';
  order.updatedAt = new Date().toISOString();
  store[orderId] = order;
  persistOrdersStore();
  return { orderId };
}

/** Fixture stand-in for the buyer-scoped `memory_book_orders` SELECT
 * `useOrderStatus.ts` reads directly in the real flow. */
export function fixtureGetOrder(orderId: string): FixtureOrder | null {
  return ordersStore()[orderId] ?? null;
}

export function fixtureOrderRow(order: FixtureOrder): MemoryBookOrderRow {
  return {
    id: order.id,
    book_id: order.bookId,
    status: order.status,
    price_cents: order.priceCents,
    shipping_cost_cents: order.shippingCostCents,
    currency: order.currency,
    quoted_page_count: order.quotedPageCount,
    prodigi_order_id: order.prodigiOrderId,
    failure_reason: order.failureReason,
    refunded_at: order.refundedAt,
    shipping_address: order.shippingAddress,
    tracking_number: order.trackingNumber,
    tracking_url: order.trackingUrl,
    carrier: order.carrier,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}

const FIXTURE_ORDER_JUMP_STATES: MemoryBookOrderStatus[] = [
  'draft',
  'quoted',
  'paid',
  'rendering',
  'submitted',
  'in_production',
  'shipped',
  'delivered',
  'failed',
  'cancelled',
];

/** Mock tracking data (memory-book-5c order-status UX round, item 3) --
 * Prodigi's shape via `_shared/prodigi.ts`'s shipments parse, NOT a real
 * Prodigi response, same "placeholder figures only" posture as
 * `FIXTURE_PRICE_CENTS` above. Lets the interactive walkthrough exercise
 * the stepper's carrier line and `OrderStatusScreen`'s tracking CTA
 * without a real sweep/Prodigi call. */
const FIXTURE_TRACKING_NUMBER = 'FIXTURE1234567890';
const FIXTURE_TRACKING_URL = 'https://example.com/track/FIXTURE1234567890';
const FIXTURE_CARRIER = 'DPD';

/** Dev-only "state switcher" (task brief: "mock a state switcher or
 * sequential progression") — `OrderStatusScreen`'s fixture-only control
 * panel uses this to jump an order directly to ANY status, so every one of
 * `orderStatusCopy.ts`'s ten states can be exercised interactively without a
 * render worker, Prodigi, or a cron sweep to drive real progression. Setting
 * `submitted` (or later) fills in a fake `prodigiOrderId`, `failed` fills in
 * a fake `failureReason`, and `shipped`/`delivered` fill in the fake
 * tracking triple above -- mirroring what the real workflow/sweep would
 * have already set by the time a buyer could see that status. */
export function fixtureSetOrderStatus(orderId: string, status: MemoryBookOrderStatus): FixtureOrder | null {
  const store = ordersStore();
  const order = store[orderId];
  if (!order) return null;
  order.status = status;
  order.updatedAt = new Date().toISOString();
  const hasProdigiOrderFrom: MemoryBookOrderStatus[] = ['submitted', 'in_production', 'shipped', 'delivered'];
  order.prodigiOrderId = hasProdigiOrderFrom.includes(status) ? 'fixture-prodigi-order-id' : null;
  order.failureReason = status === 'failed' ? 'Fixture-simulated failure — the render worker returned an error.' : null;
  const hasTrackingFrom: MemoryBookOrderStatus[] = ['shipped', 'delivered'];
  order.trackingNumber = hasTrackingFrom.includes(status) ? FIXTURE_TRACKING_NUMBER : null;
  order.trackingUrl = hasTrackingFrom.includes(status) ? FIXTURE_TRACKING_URL : null;
  order.carrier = hasTrackingFrom.includes(status) ? FIXTURE_CARRIER : null;
  store[orderId] = order;
  persistOrdersStore();
  return order;
}

export function fixtureToggleOrderRefunded(orderId: string): FixtureOrder | null {
  const store = ordersStore();
  const order = store[orderId];
  if (!order) return null;
  order.refundedAt = order.refundedAt ? null : new Date().toISOString();
  order.updatedAt = new Date().toISOString();
  store[orderId] = order;
  persistOrdersStore();
  return order;
}

export function fixtureOrderJumpStates(): MemoryBookOrderStatus[] {
  return FIXTURE_ORDER_JUMP_STATES;
}

/** Fixture stand-in for `useOrders.ts`'s real `memory_book_orders` SELECT +
 * `memory_books` join (memory-book-5c order-status UX round, item 2) --
 * newest first, same ordering and same bare-`draft` exclusion the real
 * query uses (see `useOrders.ts` on why draft shells never surface).
 * `book_title` comes from
 * `fixtureBookLabel`, not the order itself (see that function's own doc
 * comment on why a fixture order carries no title of its own). */
export function fixtureListOrders(): MemoryBookOrderListRow[] {
  const orders = Object.values(ordersStore());
  return orders
    .filter((order) => order.status !== 'draft')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((order) => ({
      id: order.id,
      book_id: order.bookId,
      status: order.status,
      price_cents: order.priceCents,
      shipping_cost_cents: order.shippingCostCents,
      currency: order.currency,
      refunded_at: order.refundedAt,
      created_at: order.createdAt,
      book_title: fixtureBookLabel(order.bookId),
    }));
}

/** Fixture stand-in for `useHasPastOrders.ts`'s real `limit(1)` existence
 * check -- and, matching it, bare `draft` shells don't count (see
 * `fixtureListOrders` above: a buyer with only stray drafts would get a
 * "Your orders" link into an empty-looking list). */
export function fixtureHasOrders(): boolean {
  return Object.values(ordersStore()).some((order) => order.status !== 'draft');
}
