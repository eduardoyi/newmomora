// Local-only Maestro fixture. It deliberately never writes ai_usage_settings.
const url = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('EXPO_PUBLIC_SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const familyId = Deno.env.get('USAGE_LIMIT_E2E_FAMILY_ID');
const actorUserId = Deno.env.get('USAGE_LIMIT_E2E_USER_ID');
const targetId = Deno.env.get('USAGE_LIMIT_E2E_TARGET_ID');
const cleanup = Deno.args.includes('--cleanup');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (url !== 'http://127.0.0.1:54321' || !key || !familyId || !actorUserId || !targetId || !uuid.test(familyId) || !uuid.test(actorUserId) || !uuid.test(targetId)) {
  throw new Error('Usage-limit E2E fixture requires exact local Supabase URL plus FAMILY_ID, USER_ID, and TARGET_ID.');
}
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const fixtureId = '00000000-0000-4000-8000-000000000099';
const membership = await fetch(`${url}/rest/v1/family_memberships?select=family_id&family_id=eq.${familyId}&user_id=eq.${actorUserId}&limit=1`, { headers });
if (!membership.ok || (await membership.json()).length !== 1) throw new Error('Fixture user does not belong to the supplied family.');
const settingsResponse = await fetch(`${url}/rest/v1/ai_usage_settings?select=enforcement_enabled,enforcement_activated_at,quota_policy_epoch&singleton=eq.true`, { headers });
const settings = await settingsResponse.json();
const setting = settings[0];
if (!settingsResponse.ok || setting?.enforcement_enabled !== true || !setting.enforcement_activated_at || new Date(setting.enforcement_activated_at) > new Date()) throw new Error('Local enforcement must already be active; fixture will not change settings.');
const targetResponse = await fetch(`${url}/rest/v1/memories?select=id&family_id=eq.${familyId}&id=eq.${targetId}&limit=1`, { headers });
if (!targetResponse.ok || (await targetResponse.json()).length !== 1) throw new Error('Fixture target must be an existing memory in the supplied family.');
if (cleanup) {
  const response = await fetch(`${url}/rest/v1/ai_usage_limit_notices?id=eq.${fixtureId}`, { method: 'DELETE', headers });
  if (!response.ok) throw new Error('Fixture cleanup failed.');
} else {
  const response = await fetch(`${url}/rest/v1/ai_usage_limit_notices`, { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: fixtureId, family_id: familyId, actor_user_id: actorUserId, target_kind: 'memory', target_id: targetId, scope: 'daily', retry_after: new Date(Date.now() + 60 * 60_000).toISOString(), quota_policy_epoch: setting.quota_policy_epoch }) });
  if (!response.ok) throw new Error('Fixture seed failed.');
}
