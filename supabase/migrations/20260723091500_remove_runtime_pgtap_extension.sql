-- pgTAP is enabled temporarily by `supabase test db` and is not part of the
-- production application schema. Keep production clean if a remote test
-- runner is interrupted before its normal extension cleanup.
drop extension if exists pgtap;
