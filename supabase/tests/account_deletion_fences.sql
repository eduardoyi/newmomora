begin;

select plan(8);

insert into auth.users (id, email)
values ('14000000-0000-4000-8000-000000000001', 'account-deletion-fence@example.test');

insert into public.families (id, name, owner_id)
values
  ('24000000-0000-4000-8000-000000000001', 'Scheduled family', '14000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000002', 'Unrelated historical deletion', '14000000-0000-4000-8000-000000000001');

update public.user_profiles
set deleted_at = now(),
    scheduled_hard_delete_at = now() + interval '15 days',
    account_deletion_token = '34000000-0000-4000-8000-000000000001'
where id = '14000000-0000-4000-8000-000000000001';
update public.families
set deleted_at = now(), account_deletion_token = '34000000-0000-4000-8000-000000000001'
where id = '24000000-0000-4000-8000-000000000001';
update public.families
set deleted_at = now() - interval '30 days', account_deletion_token = '34000000-0000-4000-8000-000000000002'
where id = '24000000-0000-4000-8000-000000000002';

select is(
  public.cancel_account_deletion('14000000-0000-4000-8000-000000000001'),
  true,
  'cancel succeeds during the future grace window'
);
select is(
  (select deleted_at is null and account_deletion_token is null
   from public.user_profiles where id = '14000000-0000-4000-8000-000000000001'),
  true,
  'cancel clears the profile operation token with the scheduled deletion'
);
select is(
  (select deleted_at is null and account_deletion_token is null
   from public.families where id = '24000000-0000-4000-8000-000000000001'),
  true,
  'cancel restores the exact family operation token'
);
select is(
  (select deleted_at is not null
    and account_deletion_token = '34000000-0000-4000-8000-000000000002'::uuid
   from public.families where id = '24000000-0000-4000-8000-000000000002'),
  true,
  'cancel does not restore an unrelated historical family deletion'
);

update public.user_profiles
set deleted_at = now(),
    scheduled_hard_delete_at = now() - interval '1 second',
    account_deletion_token = '34000000-0000-4000-8000-000000000003'
where id = '14000000-0000-4000-8000-000000000001';
select is(
  public.cancel_account_deletion('14000000-0000-4000-8000-000000000001'),
  false,
  'cancel is rejected once the scheduled hard-delete time has arrived'
);
select is(
  (select deleted_at is not null from public.user_profiles where id = '14000000-0000-4000-8000-000000000001'),
  true,
  'an expired deletion cannot be restored after cleanup may have begun'
);
select is(
  public.claim_account_hard_deletion(
    '14000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001'
  ),
  true,
  'hard-delete cron claims an expired account with an exact token'
);
select is(
  public.claim_account_hard_deletion(
    '14000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000002'
  ),
  false,
  'a fresh hard-delete claim cannot be stolen by a second cron run'
);

select * from finish();
rollback;
