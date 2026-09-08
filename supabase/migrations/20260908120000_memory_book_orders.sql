-- Memory Book 5c: order + fulfillment schema (plans/memory-book-5c-checkout-
-- fulfillment.md Design Decision 4). One row per purchase attempt of a
-- Memory Book: a frozen snapshot of what was paid for, the quote/payment/
-- fulfillment identifiers a service-role order workflow accumulates as it
-- runs, and a state machine that tracks the order from draft all the way to
-- delivered. This migration ships the schema + RLS contract only -- the
-- `memory-book-orders`/`stripe-webhook` Edge Functions and the Cloudflare
-- order workflow that actually own every transition are a separate change
-- (see docs/features/memory-book-orders.md).
--
-- Trust boundary (round-2/round-3 plan hardening, Design Decision 4):
-- - An order row carries the buyer's home address AND payment identifiers
--   (Stripe session/payment-intent ids). Unlike every other Memory Book
--   table, that is NOT family-wide content -- a family-membership SELECT
--   policy would show every relative the buyer's street address and Stripe
--   ids just because they can see the book. SELECT is therefore scoped to
--   `requested_by = auth.uid()` (the purchaser only) rather than
--   `is_family_member(family_id)`. A family-visible status-only projection
--   can be added later if wanted (round-3 note); this migration does not
--   attempt it.
-- - A client must never be able to seed a draft with a favorable price/page
--   count/shipping quote that `create_checkout` would then trust as-is
--   (round-2 review). The insert policy therefore null-locks every
--   server-computed field -- price, quote (page count + shipping quote),
--   Stripe ids, Prodigi id, state, CAS identity/clocks, and both frozen
--   snapshots -- mirroring `memory_books`' own insert with-check
--   (20260901100000) line for line: a client may only claim the bare
--   just-drafted shape (`book_id`, `family_id`, `requested_by`, and the
--   `status = 'draft'` default with everything else null). Even the
--   shipping address is written this way -- it reaches the row only via the
--   service-role `quote` operation, not a direct client write, so there is
--   exactly one write path for every quote-time field instead of two.
-- - No client UPDATE or DELETE policy exists at all, same "job is
--   service-only" shape as `memory_books`/`memory_book_edits`: every state
--   transition (quoted, paid, rendering, submitted, in_production, shipped,
--   delivered, failed, cancelled), every identifier, and both snapshots are
--   written only by service-role Edge Functions / the order workflow bridge.

create table public.memory_book_orders (
  id uuid primary key default gen_random_uuid(),

  -- Deliberately NOT `on delete cascade`: an order is a purchase/print
  -- record that must outlive an accidental (or future, currently
  -- unbuilt) book deletion path -- deleting a book with orders against it
  -- should fail loudly, not silently orphan or destroy payment history.
  book_id uuid not null references public.memory_books (id) on delete restrict,
  family_id uuid not null references public.families (id) on delete cascade,
  -- Who started this order (the buyer). Nullable-on-delete like
  -- memory_books.requested_by -- a departed account must not cascade-delete
  -- an order/payment record.
  requested_by uuid references auth.users (id) on delete set null,

  -- Frozen at the service-role CAS `quoted -> paid` (Decision 6): later
  -- edits to the live book affect future orders only, never a paid one.
  -- Both null until paid; the order workflow REFUSES to freeze a snapshot
  -- whose book_document is missing manifest `originalFile` (Decision 1 --
  -- enforced in application code, not here).
  book_document_snapshot jsonb,
  edits_snapshot jsonb,

  -- Money. Owner decision 2026-09-08: USD only for now (matches Prodigi's
  -- own billing currency; no fx spread to manage) -- `currency` is stored
  -- rather than hardcoded in application code so a future multi-currency
  -- change is a constraint change, not a new column.
  price_cents integer,
  currency text not null default 'usd',

  -- Persisted by the `quote` op together with the price above: the render
  -- worker's `/fit` SUBMITTED-INTERIOR page count for this book's frozen
  -- inputs (render worker Decision 2's "THE page count" definition) --
  -- untrusted if client-supplied, so it is computed and stored server-side
  -- at quote time, then re-verified (not re-trusted) by the post-payment
  -- workflow's own `/fit` call, which alarms on divergence.
  quoted_page_count smallint,

  -- Shipping, all persisted together by the `quote` op (never by a direct
  -- client write -- see header note). `shipping_address` shape is owned by
  -- the Edge Function/web checkout form, not fixed here.
  shipping_address jsonb,
  shipping_method text,
  shipping_cost_cents integer,

  -- Stripe Checkout (one-time payment, separate from the RevenueCat-backed
  -- app subscriptions -- see docs/plans/PRICING_STRATEGY.md). Session id is
  -- unique so a replayed `create_checkout` call or a re-delivered webhook
  -- can't attach two sessions to one order.
  stripe_session_id text unique,
  stripe_payment_intent_id text,

  -- Fulfillment identity (Prodigi). Set once the order workflow submits.
  prodigi_order_id text,

  -- STATE machine (Decision 4, binding table spec):
  --   draft -> quoted -> paid -> rendering -> submitted -> in_production
  --         -> shipped -> delivered
  --                     \-> failed
  --         \-> cancelled (abandoned/expired checkout, pre-payment)
  -- App inserts `draft`; every later transition is service-role only (see
  -- RLS below). `cancelled` is reachable pre-payment too (the
  -- `checkout.session.expired` sweep ages an abandoned `quoted` order), so
  -- it is NOT required to carry a frozen snapshot the way every paid-or-
  -- later state is (see the constraint below).
  status text not null default 'draft'
    check (status in (
      'draft', 'quoted', 'paid', 'rendering', 'submitted',
      'in_production', 'shipped', 'delivered', 'failed', 'cancelled'
    )),
  -- Required once status = 'failed' (mirrors memory_books_failed_has_reason).
  failure_reason text,
  -- Set when a `charge.refunded` Stripe webhook fires (incl. a manual
  -- dashboard refund) -- makes an out-of-band refund visible system state
  -- without inventing a dedicated 'refunded' status that would collide with
  -- wherever the order otherwise sits (e.g. a refunded-but-already-shipped
  -- order stays 'shipped', just with refunded_at set).
  refunded_at timestamptz,

  -- CAS identity + recovery clocks for the (short-lived, ends at
  -- submission -- Decision 4) order workflow. Mirrors memory_books'
  -- workflow_instance_id/generation_attempt_id/generation_started_at/
  -- generation_completed_at shape: set only by the service-role
  -- dispatcher/bridge at CAS `paid -> rendering`, never by the client.
  -- workflow_instance_id is unique so a replayed dispatch is idempotent.
  workflow_instance_id text unique,
  workflow_attempt_id uuid,
  workflow_started_at timestamptz,
  workflow_completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint memory_book_orders_currency_usd check (currency = 'usd'),
  constraint memory_book_orders_price_nonnegative check (price_cents is null or price_cents >= 0),
  constraint memory_book_orders_shipping_cost_nonnegative check (shipping_cost_cents is null or shipping_cost_cents >= 0),
  constraint memory_book_orders_page_count_positive check (quoted_page_count is null or quoted_page_count > 0),
  -- Anything past 'draft' must already carry the quote bundle (price +
  -- page count) -- the with-check below additionally guarantees a client
  -- can never insert past 'draft' in the first place, so in practice this
  -- only ever fires against a service-role write that skipped the quote
  -- step by mistake.
  constraint memory_book_orders_quoted_has_price check (
    status = 'draft' or (price_cents is not null and quoted_page_count is not null)
  ),
  -- Every state from 'paid' onward must carry the frozen snapshot pair --
  -- 'draft'/'quoted' precede the freeze, and 'cancelled' can precede it too
  -- (an abandoned quote never reaches 'paid'); 'failed' is workflow-only
  -- and therefore always post-freeze in practice.
  constraint memory_book_orders_paid_has_snapshot check (
    status not in ('paid', 'rendering', 'submitted', 'in_production', 'shipped', 'delivered', 'failed')
    or (book_document_snapshot is not null and edits_snapshot is not null)
  ),
  constraint memory_book_orders_failed_has_reason check (
    status <> 'failed' or failure_reason is not null
  ),
  constraint memory_book_orders_book_document_snapshot_is_object check (
    book_document_snapshot is null or jsonb_typeof(book_document_snapshot) = 'object'
  ),
  constraint memory_book_orders_edits_snapshot_is_object check (
    edits_snapshot is null or jsonb_typeof(edits_snapshot) = 'object'
  ),
  constraint memory_book_orders_shipping_address_is_object check (
    shipping_address is null or jsonb_typeof(shipping_address) = 'object'
  )
);

comment on table public.memory_book_orders is
  'One row per Memory Book purchase attempt (plans/memory-book-5c-checkout-fulfillment.md Design Decision 4). App inserts a bare draft; a service-role quote op + Stripe webhook + order workflow own every later field and transition (see docs/features/memory-book-orders.md). SELECT is scoped to the buyer (requested_by = auth.uid()), NOT family-wide -- see header note.';
comment on column public.memory_book_orders.book_document_snapshot is
  'Frozen copy of memory_books.book_document at CAS quoted -> paid. Null until paid. Later live-book edits never affect an already-paid order.';
comment on column public.memory_book_orders.edits_snapshot is
  'Frozen copy of memory_book_edits.edits at CAS quoted -> paid. Null until paid.';
comment on column public.memory_book_orders.price_cents is
  'Our price for this order, persisted by the quote op. Null until quoted.';
comment on column public.memory_book_orders.quoted_page_count is
  'Render worker /fit SUBMITTED-INTERIOR page count at quote time, persisted by the quote op and re-verified (not re-trusted) post-payment.';
comment on column public.memory_book_orders.shipping_address is
  'Buyer-entered shipping address, persisted by the quote op (never a direct client write) -- PII, see the requested_by-scoped SELECT policy below.';
comment on column public.memory_book_orders.stripe_session_id is
  'Stripe Checkout Session id, set by create_checkout. Unique so a replayed call or re-delivered webhook cannot attach two sessions to one order.';
comment on column public.memory_book_orders.status is
  'Order state machine: draft -> quoted -> paid -> rendering -> submitted -> in_production -> shipped -> delivered / failed, plus cancelled (reachable pre-payment from quoted via the checkout.session.expired sweep).';
comment on column public.memory_book_orders.refunded_at is
  'Set by the charge.refunded Stripe webhook (incl. manual dashboard refunds). Independent of status -- a refunded order keeps whatever status it was already in.';
comment on column public.memory_book_orders.workflow_instance_id is
  'Cloudflare order-workflow instance id, set by the service-role dispatcher at CAS paid -> rendering. Unique so a replayed dispatch is idempotent (mirrors memory_books.workflow_instance_id).';
comment on column public.memory_book_orders.workflow_attempt_id is
  'Compare-and-set token for the current render/submit attempt (mirrors memory_books.generation_attempt_id).';
comment on column public.memory_book_orders.workflow_started_at is
  'Dedicated recovery clock: set at CAS paid -> rendering. Not created_at/updated_at -- an unrelated write must never extend or shorten the workflow''s lease.';
comment on column public.memory_book_orders.workflow_completed_at is
  'Dedicated recovery clock: set when the (short-lived, ends-at-submission) order workflow exits, success or failure.';

create index memory_book_orders_family_id_idx on public.memory_book_orders (family_id);
create index memory_book_orders_book_id_idx on public.memory_book_orders (book_id);
create index memory_book_orders_requested_by_idx on public.memory_book_orders (requested_by);
-- Sweep/dispatcher polling surface (mirrors memory_books_status_idx): the
-- states a reconciliation sweep or the post-submission tracking sweep needs
-- to repeatedly scan.
create index memory_book_orders_active_status_idx on public.memory_book_orders (status)
  where status in ('paid', 'rendering', 'submitted', 'in_production');

create trigger set_memory_book_orders_updated_at
  before update on public.memory_book_orders
  for each row execute function public.set_updated_at();

alter table public.memory_book_orders enable row level security;

-- Select: the BUYER only, not the family (header note) -- an order row
-- carries the buyer's home address and Stripe identifiers, which the rest
-- of the family (e.g. a grandparent viewer) must not see just because they
-- can see the book itself.
create policy "Memory book orders: select" on public.memory_book_orders for select
  using (requested_by = auth.uid());

-- Insert: owner/manager of the book's family, claiming themselves as buyer,
-- with book_id verified to actually belong to family_id (the "Memory tags:
-- insert" cross-family lesson applied here -- without it, a manager of two
-- families could point book_id at family B's book while family_id claims
-- family A). The with-check pins the row to the exact bare-draft shape:
-- every server-computed field (price/quote/page count/shipping quote,
-- Stripe ids, Prodigi id, non-draft state, CAS identity/clocks, both frozen
-- snapshots, failure/refund bookkeeping) must be null and status must be
-- 'draft' -- mirrors memory_books' insert with-check line for line.
create policy "Memory book orders: insert" on public.memory_book_orders for insert
  with check (
    requested_by = auth.uid()
    and public.has_family_role(family_id, array['owner', 'manager'])
    and exists (
      select 1 from public.memory_books mb
      where mb.id = book_id and mb.family_id = memory_book_orders.family_id
    )
    and status = 'draft'
    and book_document_snapshot is null
    and edits_snapshot is null
    and price_cents is null
    and quoted_page_count is null
    and shipping_address is null
    and shipping_method is null
    and shipping_cost_cents is null
    and stripe_session_id is null
    and stripe_payment_intent_id is null
    and prodigi_order_id is null
    and failure_reason is null
    and refunded_at is null
    and workflow_instance_id is null
    and workflow_attempt_id is null
    and workflow_started_at is null
    and workflow_completed_at is null
  );

-- Deliberately NO update or delete policy at all for authenticated -- same
-- "job is service-only" contract as memory_books/memory_book_edits. Every
-- state transition, identifier, and snapshot write happens through a
-- service-role Edge Function or the order-workflow bridge (a separate
-- change -- see docs/features/memory-book-orders.md). RLS with zero
-- matching policy denies the operation outright for every non-bypassing
-- role, and the missing table grant below blocks it a second, independent
-- way even if a future migration accidentally added a permissive policy.
revoke all on table public.memory_book_orders from anon;
revoke all on table public.memory_book_orders from authenticated;
grant select, insert on table public.memory_book_orders to authenticated;
