# Owner complimentary access runbook

Momora's paid access is owner-wide: the owner of a family is the billing
principal, and invited household members inherit that owner's access.

`public.owner_complimentary_access` is the operator-owned exception list for
people who should use Momora Plus without an App Store or Google Play
subscription. It is deliberately separate from `owner_entitlements`; never
create a fake RevenueCat entitlement for a free user.

## Grant permanent access

Run this in the production Supabase SQL editor or another authenticated
operator connection. Use the exact account email and confirm the result before
moving on.

```sql
do $$
declare
  v_user_id uuid;
  v_email text;
begin
  select id, email
  into strict v_user_id, v_email
  from auth.users
  where lower(email) = lower('person@example.com');

  insert into public.owner_complimentary_access (owner_user_id, expires_at, note)
  values (v_user_id, null, 'Grandfathered access')
  on conflict (owner_user_id) do update
  set expires_at = null,
      note = excluded.note;

  raise notice 'Granted permanent complimentary access to % (%)', v_email, v_user_id;
exception
  when no_data_found then
    raise exception 'No Auth user matches the requested email';
  when too_many_rows then
    raise exception 'More than one Auth user matches the requested email';
end $$;
```

The account does not need to own a family yet. When it later creates one, the
grant applies automatically because it is keyed to the owner account.

The Auth account must already exist. The guarded block raises instead of
silently inserting zero rows when the email is mistyped; still run the
verification query below and confirm the exact email before moving on.

## Grant temporary access

Use an explicit UTC expiry when the free period should end automatically:

```sql
do $$
declare
  v_user_id uuid;
  v_email text;
begin
  select id, email
  into strict v_user_id, v_email
  from auth.users
  where lower(email) = lower('person@example.com');

  insert into public.owner_complimentary_access (owner_user_id, expires_at, note)
  values (v_user_id, '2026-12-31 23:59:59+00', 'Beta access through 2026-12-31')
  on conflict (owner_user_id) do update
  set expires_at = excluded.expires_at,
      note = excluded.note;

  raise notice 'Granted temporary complimentary access to % (%)', v_email, v_user_id;
exception
  when no_data_found then
    raise exception 'No Auth user matches the requested email';
  when too_many_rows then
    raise exception 'More than one Auth user matches the requested email';
end $$;
```

## Verify the grant and the owner email

```sql
select
  u.email,
  c.owner_user_id,
  c.expires_at,
  c.note,
  c.created_at
from public.owner_complimentary_access c
join auth.users u on u.id = c.owner_user_id
order by lower(u.email);
```

An active row with `expires_at is null`, or an expiry in the future, grants
access. The app reports it as `access_reason = 'complimentary'` and does not
show the purchase paywall. Paid store entitlement history remains separate.

## Revoke access

Revocation is explicit and immediate. It does not cancel a real store
subscription the person may also have.

```sql
delete from public.owner_complimentary_access
where owner_user_id = (
  select id
  from auth.users
  where lower(email) = lower('person@example.com')
);
```

After granting or revoking access, have the user reopen Settings or switch
families so the app refreshes the server billing status. The server remains the
authorization boundary; cached mobile status never authorizes a write.

## Safety rules

- Run these statements only from the Supabase SQL editor or a protected
  operator/admin connection. The mobile client has no table access.
- Prefer permanent grants only for genuine grandfathered accounts; use an
  expiry for trials, beta access, or favors with a defined end date.
- Verify the email before executing an `insert` or `delete`.
- Do not change `billing_settings.enforcement_mode` to grant one person access.
- Do not insert rows into `owner_entitlements` for free users.
- A grant follows the owner across every family they own. It does not grant
  access to families where they are only an invited member.
