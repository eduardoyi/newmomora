-- Memory Book order tracking (5c order-status UX round, item 3): carrier
-- tracking surfaced once an order ships. Three columns, all null until the
-- post-submission sweep (`sweep-memory-book-orders`) extracts them from
-- Prodigi's `GET /v4.0/Orders/{id}` shipments array on the `submitted /
-- in_production -> shipped` transition -- defensively parsed (absent
-- fields stay null, never fabricated; `_shared/prodigi.ts#
-- getProdigiOrderStatus` already returns `{ carrier, trackingUrl,
-- trackingNumber }` per shipment, so the sweep only needs to persist what
-- it already parses).
--
-- Service-role written only -- same "job is service-only" contract as every
-- other post-draft field on this table (see 20260908120000's header note):
-- the bare-draft insert with-check is extended below to null-lock these
-- three columns alongside its existing list, so a client insert can never
-- seed a fake tracking number/URL/carrier into a still-`draft` row.

alter table public.memory_book_orders
  add column tracking_number text,
  add column tracking_url text,
  add column carrier text;

comment on column public.memory_book_orders.tracking_number is
  'Carrier tracking number, set by the sweep''s Prodigi shipments parse on the shipped transition. Null until shipped, and stays null even then if Prodigi reports no tracking number for this shipment -- never fabricated.';
comment on column public.memory_book_orders.tracking_url is
  'Carrier tracking URL, set alongside tracking_number when Prodigi reports one. May remain null even once tracking_number is set (Prodigi/carrier did not supply a URL).';
comment on column public.memory_book_orders.carrier is
  'Carrier name (e.g. "DPD"), set alongside tracking_number when Prodigi reports one.';

-- Extend the bare-draft insert with-check (20260908120000) to null-lock
-- these three new service-role-only columns too -- identical reasoning to
-- every other field already in that list: a client insert may only ever
-- claim the exact just-drafted shape, never pre-seed a later-stage field.
alter policy "Memory book orders: insert" on public.memory_book_orders
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
    and tracking_number is null
    and tracking_url is null
    and carrier is null
  );
