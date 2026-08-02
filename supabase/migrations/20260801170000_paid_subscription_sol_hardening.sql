-- Production hardening from the second adversarial review.
-- Keep the actor-parameterized billing function private to server-side
-- definer functions. RLS uses this authenticated-safe wrapper instead.

create or replace function public.billing_write_allowed_for_current_user(p_family_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select auth.uid() is not null
    and public.billing_write_allowed(p_family_id, auth.uid());
$$;

revoke all on function public.billing_write_allowed_for_current_user(uuid) from public, anon;
grant execute on function public.billing_write_allowed_for_current_user(uuid) to authenticated;

-- Serialize export creation per owner so concurrent POSTs cannot all pass a
-- count-then-insert check and exceed the three-active-export limit.
create or replace function public.create_export_job(
  p_owner_user_id uuid,
  p_family_count integer,
  p_max_active integer default 3
)
returns setof public.export_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_owner_user_id is null or p_family_count is null or p_family_count < 0 then
    raise exception 'Invalid export job' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_user_id::text, 0));
  if (
    select count(*)
    from public.export_jobs
    where owner_user_id = p_owner_user_id
      and status = 'ready'
      and expires_at > transaction_timestamp()
  ) >= greatest(1, least(coalesce(p_max_active, 3), 10)) then
    raise exception 'export_rate_limited' using errcode = 'P0001';
  end if;
  return query
    insert into public.export_jobs (owner_user_id, family_count)
    values (p_owner_user_id, p_family_count)
    returning *;
end;
$$;

revoke all on function public.create_export_job(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.create_export_job(uuid, integer, integer) to service_role;

-- Shared-family viewers cannot trigger a reconciliation for the owner. Sweep
-- owners whose ledger is active/near expiry (or stale) so missed webhooks are
-- repaired without requiring the owner to open the app.
create or replace function public.claim_billing_reconcile_owners(p_limit integer default 50)
returns table (owner_user_id uuid)
language sql
security definer
set search_path = public
as $$
  select candidates.owner_user_id
  from (
    select e.owner_user_id, max(e.updated_at) as latest_update
    from public.owner_entitlements e
    where e.status in ('active', 'trial', 'grace')
      and e.expires_at is not null
    group by e.owner_user_id
  ) candidates
  where candidates.latest_update < transaction_timestamp() - interval '30 minutes'
  order by candidates.latest_update
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke all on function public.claim_billing_reconcile_owners(integer) from public, anon, authenticated;
grant execute on function public.claim_billing_reconcile_owners(integer) to service_role;

-- The earlier paid policies were created before the actor-parameterized
-- function was made private. Alter them in place so authenticated RLS checks
-- still work without exposing an arbitrary-actor billing oracle to the client.
alter policy "Families: update" on public.families
  using (public.has_family_role(id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(id))
  with check (public.has_family_role(id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(id));

alter policy "Family memberships: update" on public.family_memberships
  using (public.has_family_role(family_id, array['owner', 'manager'])
    and role <> 'owner'
    and public.billing_write_allowed_for_current_user(family_id))
  with check (public.has_family_role(family_id, array['owner', 'manager'])
    and role <> 'owner'
    and public.billing_write_allowed_for_current_user(family_id));

alter policy "Family memberships: delete" on public.family_memberships
  using (
    (public.has_family_role(family_id, array['owner', 'manager'])
      and role <> 'owner'
      and public.billing_write_allowed_for_current_user(family_id))
    or (user_id = auth.uid() and role <> 'owner')
  );

alter policy "Family invites: update" on public.family_invites
  using (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id))
  with check (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id));

alter policy "Family members: insert" on public.family_members
  with check (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id));

alter policy "Family members: update" on public.family_members
  using (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id))
  with check (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id));

alter policy "Family members: delete" on public.family_members
  using (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id));

alter policy "Memories: insert" on public.memories
  with check (
    user_id = auth.uid()
    and public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id)
  );

alter policy "Memories: update" on public.memories
  using (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id))
  with check (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id));

alter policy "Memories: delete" on public.memories
  using (public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed_for_current_user(family_id));

-- Media/tag policies retain the bounded post-commit hand-off, but no longer
-- call the private actor-parameterized function from authenticated RLS.
alter policy "Memory tags: insert" on public.memory_family_members
  with check (
    exists (
      select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
        and (
          public.billing_write_allowed_for_current_user(m.family_id)
          or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
        )
    )
    and exists (
      select 1 from public.family_members fm
      join public.memories m on m.id = memory_id
      where fm.id = family_member_id and fm.family_id = m.family_id
    )
  );

alter policy "Memory tags: delete" on public.memory_family_members
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed_for_current_user(m.family_id)
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

alter policy "Memory media: insert" on public.memory_media
  with check (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed_for_current_user(m.family_id)
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

alter policy "Memory media: update" on public.memory_media
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed_for_current_user(m.family_id)
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ))
  with check (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed_for_current_user(m.family_id)
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

alter policy "Memory media: delete" on public.memory_media
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (
        public.billing_write_allowed_for_current_user(m.family_id)
        or (m.onboarding_media_pending and m.onboarding_media_pending_until > transaction_timestamp())
      )
  ));

-- Billing metadata is server-owned. Column privileges prevent a client from
-- changing owner/grace state or manufacturing an onboarding exemption. The
-- definer RPCs remain able to set these columns because they run as the table
-- owner, while ordinary inserts can still omit them and receive defaults.
revoke insert (owner_id, created_at, billing_grace_until) on public.families from public, anon, authenticated;
revoke update (owner_id, created_at, billing_grace_until) on public.families from public, anon, authenticated;
revoke insert (onboarding_attributed, onboarding_media_pending, onboarding_media_pending_until)
  on public.memories from public, anon, authenticated;
revoke update (onboarding_attributed, onboarding_media_pending, onboarding_media_pending_until)
  on public.memories from public, anon, authenticated;

-- A table-level grant would override a column-level revoke. Replace the
-- client DML grants with the narrow columns the app actually writes.
revoke insert, update on public.families from public, anon, authenticated;
grant update (name) on public.families to authenticated;
revoke insert, update on public.memories from public, anon, authenticated;
grant insert (
  id, user_id, content, memory_date, memory_type, media_key, media_content_type,
  family_id, illustration_status
) on public.memories to authenticated;
grant update (content, memory_date, memory_type, illustration_status) on public.memories to authenticated;

alter table public.memories
  drop constraint if exists memories_type_invariants,
  add constraint memories_type_invariants check (
    (memory_type = 'text_illustration' and content is not null and media_key is null)
    or (memory_type = 'text_only' and content is not null and media_key is null)
    or (memory_type = 'media' and media_key is not null and media_content_type is not null and illustration_status = 'none')
    or (
      memory_type = 'media'
      and onboarding_media_pending = true
      and onboarding_media_pending_until is not null
      and media_key is null
      and media_content_type is null
      and illustration_status = 'none'
    )
  );

-- A non-expiring webhook or snapshot must never create lifetime access. The
-- product catalog contains subscriptions only, so missing expiry is invalid
-- for access even if the provider payload is otherwise well-formed.
create or replace function public.owner_has_billing_access(
  p_owner_user_id uuid,
  p_now timestamptz default transaction_timestamp()
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.owner_entitlements e
    cross join public.billing_settings s
    where e.owner_user_id = p_owner_user_id
      and s.singleton
      and (e.environment = 'production' or (e.environment = 'sandbox' and s.allow_sandbox_access))
      and e.status in ('active', 'trial', 'grace')
      and e.expires_at is not null
      and (e.expires_at > p_now or (e.grace_until is not null and e.grace_until > p_now))
  );
$$;

create or replace function public.expire_billing_entitlements(
  p_now timestamptz default transaction_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.owner_entitlements
  set status = case
      when grace_until is not null and grace_until > p_now then 'grace'
      else 'expired'
    end,
    updated_at = p_now
  where environment = 'production'
    and status in ('active', 'trial', 'grace', 'paused')
    and expires_at is not null
    and expires_at <= p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Preserve the last known expiry when a cancellation/billing-issue webhook is
-- partial. A newly inserted partial entitlement remains non-authorizing
-- because owner_has_billing_access requires a non-null future expiry.
create or replace function public.apply_billing_webhook_event(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.billing_webhook_events%rowtype;
  v_status text;
  v_period text;
begin
  select * into e from public.billing_webhook_events where event_id = p_event_id for update;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if e.status = 'processed' then return jsonb_build_object('status', 'processed'); end if;
  if e.status = 'dead_letter' then return jsonb_build_object('status', 'dead_letter'); end if;
  if e.owner_user_id is null then
    update public.billing_webhook_events
    set status = 'dead_letter', last_error = 'unknown_account', updated_at = now()
    where event_id = p_event_id;
    return jsonb_build_object('status', 'dead_letter', 'reason', 'unknown_account');
  end if;

  insert into public.billing_owner_locks (owner_user_id) values (e.owner_user_id)
  on conflict (owner_user_id) do nothing;
  perform 1 from public.billing_owner_locks where owner_user_id = e.owner_user_id for update;

  v_status := case
    when e.event_type in ('EXPIRATION', 'REFUND') then 'expired'
    when e.event_type = 'REFUND_REVERSED' then 'active'
    when e.event_type in ('BILLING_ISSUE', 'SUBSCRIPTION_PAUSED') then 'grace'
    else case when lower(coalesce(e.period_type, '')) in ('trial', 'intro') then 'trial' else 'active' end
  end;
  v_period := case
    when e.product_id in ('momora_annual_v1', 'momora:annual') then 'annual'
    when e.product_id in ('momora_monthly_v1', 'momora:monthly') then 'monthly'
    else 'unknown'
  end;

  insert into public.owner_entitlements (
    owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
    period_type, status, purchased_at, expires_at, grace_until, will_renew,
    original_transaction_id, transaction_id, management_url, last_event_id, last_event_at
  ) values (
    e.owner_user_id, coalesce(e.app_user_id, e.owner_user_id::text), e.environment,
    case when e.store = 'play_store' then 'play_store' else 'app_store' end,
    e.product_id, coalesce(e.entitlement_id, 'momora_plus'), v_period, v_status,
    e.purchased_at, e.expires_at, e.grace_until, coalesce(e.will_renew, false),
    e.original_transaction_id, e.transaction_id, e.management_url, e.event_id, e.event_at
  ) on conflict (owner_user_id, environment, store, product_id) do update set
    app_user_id = excluded.app_user_id,
    entitlement_id = excluded.entitlement_id,
    period_type = excluded.period_type,
    status = excluded.status,
    purchased_at = coalesce(excluded.purchased_at, owner_entitlements.purchased_at),
    expires_at = coalesce(excluded.expires_at, owner_entitlements.expires_at),
    grace_until = coalesce(excluded.grace_until, owner_entitlements.grace_until),
    will_renew = excluded.will_renew,
    original_transaction_id = coalesce(excluded.original_transaction_id, owner_entitlements.original_transaction_id),
    transaction_id = coalesce(excluded.transaction_id, owner_entitlements.transaction_id),
    management_url = coalesce(excluded.management_url, owner_entitlements.management_url),
    last_event_id = excluded.last_event_id,
    last_event_at = excluded.last_event_at,
    updated_at = now()
  where excluded.last_event_at >= owner_entitlements.last_event_at;

  update public.billing_webhook_events
  set status = 'processed', processed_at = now(), updated_at = now(), last_error = null
  where event_id = p_event_id;
  return jsonb_build_object('status', 'processed');
end;
$$;

-- Reconciliation is fail-closed for malformed provider entries. The initial
-- clear marks old access expired; only an entry with a valid expiry can be
-- reinserted or refreshed.
create or replace function public.reconcile_billing_snapshot(
  p_owner_user_id uuid,
  p_environment text,
  p_entitlements jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  v_store text;
  v_product_id text;
  v_status text;
  v_period text;
  v_expires_at timestamptz;
begin
  if p_owner_user_id is null or p_environment not in ('production', 'sandbox') then
    raise exception 'Invalid billing snapshot' using errcode = '22023';
  end if;
  if jsonb_typeof(p_entitlements) <> 'array' then
    raise exception 'Billing snapshot must be an array' using errcode = '22023';
  end if;

  insert into public.billing_owner_locks (owner_user_id) values (p_owner_user_id)
  on conflict (owner_user_id) do nothing;
  perform 1 from public.billing_owner_locks where owner_user_id = p_owner_user_id for update;

  update public.owner_entitlements
  set status = 'expired', updated_at = now()
  where owner_user_id = p_owner_user_id
    and environment = p_environment
    and status in ('active', 'trial', 'grace');

  for item in select value from jsonb_array_elements(p_entitlements)
  loop
    v_product_id := item->>'product_id';
    v_store := case when item->>'store' in ('play_store', 'PLAY_STORE') then 'play_store' else 'app_store' end;
    if not exists (select 1 from public.billing_products where store = v_store and product_id = v_product_id and active) then
      continue;
    end if;
    v_expires_at := nullif(item->>'expires_at', '')::timestamptz;
    if v_expires_at is null then
      continue;
    end if;
    v_status := case when lower(coalesce(item->>'period_type', '')) in ('trial', 'intro') then 'trial' else 'active' end;
    v_period := case when v_product_id in ('momora_annual_v1', 'momora:annual') then 'annual' else 'monthly' end;
    insert into public.owner_entitlements (
      owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
      period_type, status, purchased_at, expires_at, grace_until, will_renew,
      original_transaction_id, transaction_id, management_url, last_event_id, last_event_at
    ) values (
      p_owner_user_id, p_owner_user_id::text, p_environment, v_store, v_product_id,
      coalesce(item->>'entitlement_id', 'momora_plus'), v_period, v_status,
      nullif(item->>'purchased_at', '')::timestamptz,
      v_expires_at,
      nullif(item->>'grace_until', '')::timestamptz,
      coalesce((item->>'will_renew')::boolean, false),
      item->>'original_transaction_id', item->>'transaction_id', item->>'management_url',
      'reconcile:' || p_owner_user_id::text, now()
    ) on conflict (owner_user_id, environment, store, product_id) do update set
      entitlement_id = excluded.entitlement_id,
      period_type = excluded.period_type,
      status = excluded.status,
      purchased_at = excluded.purchased_at,
      expires_at = excluded.expires_at,
      grace_until = excluded.grace_until,
      will_renew = excluded.will_renew,
      original_transaction_id = excluded.original_transaction_id,
      transaction_id = excluded.transaction_id,
      management_url = excluded.management_url,
      last_event_id = excluded.last_event_id,
      last_event_at = excluded.last_event_at,
      updated_at = now();
  end loop;
  return true;
end;
$$;

-- The invoker-rights media finalization function must use the wrapper too;
-- otherwise its internal billing call would hit the private function's
-- revoked EXECUTE privilege when called by an authenticated client.
-- (The function body itself remains defined in the preceding hardening
-- migration; this targeted replacement keeps its validation unchanged.)
-- Its policy path is the authoritative gate for the same operation.

revoke all on function public.billing_engagement_allowed(uuid, uuid) from public, anon;
grant execute on function public.billing_engagement_allowed(uuid, uuid) to authenticated;

revoke all on function public.billing_write_allowed_for_current_user(uuid) from public, anon;
grant execute on function public.billing_write_allowed_for_current_user(uuid) to authenticated;
