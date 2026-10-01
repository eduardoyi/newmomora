begin;

-- RLS policies express row ownership; these assertions protect the separate
-- PostgreSQL ACL layer. A fresh current Supabase bootstrap grants neither
-- layer implicitly, so both are required for normal authenticated clients.
select plan(27);

select ok(has_table_privilege('authenticated', 'public.user_profiles', 'SELECT, UPDATE'), 'authenticated can read and update its RLS-scoped profile');
select ok(has_table_privilege('authenticated', 'public.families', 'SELECT, UPDATE, DELETE'), 'authenticated has the family operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.family_memberships', 'SELECT, UPDATE, DELETE'), 'authenticated has membership roster operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.family_invites', 'SELECT') and has_column_privilege('authenticated', 'public.family_invites', 'status', 'UPDATE'), 'authenticated can list invites and revoke them (update status only; the invitee columns are not client-writable)');
select ok(has_table_privilege('authenticated', 'public.family_members', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated has family-member CRUD backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.memories', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated has memory CRUD backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.memory_family_members', 'SELECT, INSERT, DELETE'), 'authenticated has memory-tag operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.memory_media', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated has media-asset operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.memory_likes', 'SELECT, INSERT, DELETE'), 'authenticated has like operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.memory_comments', 'SELECT, INSERT, DELETE'), 'authenticated has comment operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.family_member_portrait_versions', 'SELECT'), 'authenticated can read RLS-scoped portrait versions');

select ok(not has_table_privilege('anon', 'public.memories', 'SELECT, INSERT, UPDATE, DELETE'), 'anon has no direct memory-table access');
select ok(not has_table_privilege('anon', 'public.family_members', 'SELECT, INSERT, UPDATE, DELETE'), 'anon has no direct family-member-table access');

select ok(not has_table_privilege('authenticated', 'public.ai_usage_events', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated cannot access raw AI usage ledger');
select ok(not has_table_privilege('authenticated', 'public.ai_image_generation_requests', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated cannot access image admission requests');
select ok(not has_table_privilege('authenticated', 'public.ai_onboarding_voice_requests', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated cannot access onboarding voice reservations');
select ok(not has_table_privilege('authenticated', 'public.memory_illustration_jobs', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated cannot access private illustration workflow jobs');
select ok(not has_table_privilege('authenticated', 'public.portrait_generation_jobs', 'SELECT, INSERT, UPDATE, DELETE'), 'authenticated cannot access private portrait workflow jobs');

-- Family relationships: suggestions are read-only for clients (owner/manager
-- RLS), and the "this is me" link columns are written only by definer RPCs.
select ok(has_table_privilege('authenticated', 'public.family_member_suggestions', 'SELECT'), 'authenticated can read RLS-scoped relationship suggestions');
select ok(not has_table_privilege('authenticated', 'public.family_member_suggestions', 'INSERT, UPDATE, DELETE, TRUNCATE'), 'authenticated cannot write relationship suggestions directly');
select ok(not has_table_privilege('anon', 'public.family_member_suggestions', 'SELECT, INSERT, UPDATE, DELETE'), 'anon has no direct relationship-suggestion access');
select ok(has_column_privilege('authenticated', 'public.year_films', 'status', 'SELECT'), 'authenticated can read safe year film columns');
select ok(not has_column_privilege('authenticated', 'public.year_films', 'film_script', 'SELECT'), 'authenticated cannot read year film scripts');
select ok(not has_table_privilege('authenticated', 'public.year_films', 'INSERT, UPDATE, DELETE, TRUNCATE'), 'authenticated cannot write year films');
select ok(not has_table_privilege('anon', 'public.year_films', 'SELECT, INSERT, UPDATE, DELETE'), 'anon has no year film access');
select ok(not has_table_privilege('authenticated', 'public.year_film_settings', 'SELECT, INSERT, UPDATE, DELETE'), 'the rollout flag is service-role only');
select ok(not has_column_privilege('authenticated', 'public.family_memberships', 'family_member_id', 'UPDATE'), 'authenticated cannot write the "this is me" link column directly');

select * from finish();
rollback;
