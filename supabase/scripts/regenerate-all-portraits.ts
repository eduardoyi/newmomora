/**
 * Regenerate portraits for all family members (testing utility).
 * Usage: deno run --allow-all --env-file=supabase/.env.local supabase/scripts/regenerate-all-portraits.ts
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const userEmail = Deno.args[0] ?? 'eduardoyi@gmail.com';

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in supabase/.env.local');
  Deno.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email: userEmail,
});

if (linkError || !linkData.properties?.hashed_token) {
  console.error('Failed to generate auth link', linkError?.message ?? 'no token');
  Deno.exit(1);
}

const anonKey =
  Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');

if (!anonKey) {
  console.error('Missing anon key');
  Deno.exit(1);
}

const client = createClient(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: sessionData, error: sessionError } = await client.auth.verifyOtp({
  type: 'magiclink',
  token_hash: linkData.properties.hashed_token,
});

if (sessionError || !sessionData.session?.access_token) {
  console.error('Failed to create user session', sessionError?.message ?? 'no session');
  Deno.exit(1);
}

const authed = createClient(supabaseUrl, anonKey, {
  global: {
    headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
  },
  auth: { autoRefreshToken: false, persistSession: false },
});

const userId = sessionData.user?.id;
console.log(`Authenticated as ${userEmail} (${userId})`);

const { data: members, error: membersError } = await authed
  .from('family_members')
  .select('id, name, profile_picture_key, illustrated_profile_status')
  .order('created_at', { ascending: true });

if (membersError || !members) {
  console.error('Failed to load family members', membersError?.message);
  Deno.exit(1);
}

const eligible = members.filter((member) => member.profile_picture_key);

console.log(`Regenerating ${eligible.length} portrait(s)...`);

for (const member of eligible) {
  console.log(`→ ${member.name} (${member.id})...`);
  const started = Date.now();

  const { data, error } = await authed.functions.invoke('generate-portrait-illustration', {
    body: { familyMemberId: member.id },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (error) {
    console.error(`  ✗ failed (${elapsed}s):`, error.message);
    continue;
  }

  console.log(`  ✓ ready (${elapsed}s)`, data);
}

console.log('Done.');
