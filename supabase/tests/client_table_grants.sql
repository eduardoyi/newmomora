begin;

-- RLS policies express row ownership; these assertions protect the separate
-- PostgreSQL ACL layer. A fresh current Supabase bootstrap grants neither
-- layer implicitly, so both are required for normal authenticated clients.
select plan(18);

select ok(has_table_privilege('authenticated', 'public.user_profiles', 'SELECT, UPDATE'), 'authenticated can read and update its RLS-scoped profile');
select ok(has_table_privilege('authenticated', 'public.families', 'SELECT, UPDATE, DELETE'), 'authenticated has the family operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.family_memberships', 'SELECT, UPDATE, DELETE'), 'authenticated has membership roster operations backed by RLS policies');
select ok(has_table_privilege('authenticated', 'public.family_invites', 'SELECT, UPDATE'), 'authenticated has invite list and revoke operations backed by RLS policies');
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

select * from finish();
rollback;
