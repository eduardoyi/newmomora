/**
 * Regenerate memory illustrations through the deployed generate-illustration
 * Edge Function (forceRegenerate) — same path as the app's regenerate button.
 *
 * Defaults to hard-emotion memories (worry, weary, sad) with ready
 * illustrations, so entries illustrated before the emotion-aware prompt
 * rework get expressions matching their mood.
 *
 * Examples:
 *   npm run regenerate:illustrations -- --dry-run
 *   npm run regenerate:illustrations
 *   npm run regenerate:illustrations -- --emotions worry --limit 2
 *   npm run regenerate:illustrations -- --memory-id <uuid>
 *
 * Requires Supabase vars in supabase/.env.local. Aborts after the first
 * regeneration if the stored prompt lacks the new "Emotional tone:" section
 * (deployed function still running pre-rework code).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

interface CliOptions {
  emotions: string[];
  memoryIds: string[];
  limit?: number;
  dryRun: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    emotions: ['worry', 'weary', 'sad'],
    memoryIds: [],
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--emotions':
        options.emotions = next.split(',').map((emotion) => emotion.trim()).filter(Boolean);
        index += 1;
        break;
      case '--memory-id':
        options.memoryIds.push(next);
        index += 1;
        break;
      case '--limit':
        options.limit = Number(next) || undefined;
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        break;
    }
  }

  return options;
}

const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';

if (!supabaseUrl || !serviceRoleKey || !anonKey) {
  console.error('Missing Supabase env vars in supabase/.env.local');
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

console.log(`Authenticated as ${userEmail} (${sessionData.user?.id})`);

const options = parseArgs(Deno.args);

let query = authed
  .from('memories')
  .select('id, content, emotion, memory_date, illustration_status')
  .eq('memory_type', 'text_illustration')
  .eq('illustration_status', 'ready')
  .order('memory_date', { ascending: false });

query = options.memoryIds.length > 0
  ? query.in('id', options.memoryIds)
  : query.in('emotion', options.emotions);

if (options.limit) {
  query = query.limit(options.limit);
}

const { data: memories, error: memoriesError } = await query;

if (memoriesError || !memories) {
  console.error('Failed to load memories', memoriesError?.message);
  Deno.exit(1);
}

if (memories.length === 0) {
  console.log('No matching memories with ready illustrations.');
  Deno.exit(0);
}

console.log(`${options.dryRun ? '[dry-run] Would regenerate' : 'Regenerating'} ${memories.length} illustration(s):`);
for (const memory of memories) {
  console.log(`  - ${memory.memory_date} [${memory.emotion}] ${memory.content?.slice(0, 60) ?? ''}`);
}

if (options.dryRun) {
  Deno.exit(0);
}

let verifiedNewPipeline = false;
let succeeded = 0;
let failed = 0;

for (const memory of memories) {
  console.log(`→ ${memory.id} [${memory.emotion}]...`);
  const started = Date.now();

  const { error } = await authed.functions.invoke('generate-illustration', {
    body: { memoryId: memory.id, forceRegenerate: true },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (error) {
    failed += 1;
    console.error(`  ✗ failed (${elapsed}s):`, error.message);
    continue;
  }

  succeeded += 1;
  console.log(`  ✓ ready (${elapsed}s)`);

  if (!verifiedNewPipeline) {
    const { data: refreshed } = await authed
      .from('memories')
      .select('illustration_prompt')
      .eq('id', memory.id)
      .maybeSingle();

    if (!refreshed?.illustration_prompt?.includes('Emotional tone:')) {
      console.error(
        'Stored prompt lacks the "Emotional tone:" section — the deployed generate-illustration function is still running pre-rework code.',
      );
      console.error('Deploy first: supabase functions deploy generate-illustration --use-api');
      Deno.exit(1);
    }

    verifiedNewPipeline = true;
    console.log('  ✓ verified deployed function uses the emotion-aware prompt');
  }
}

console.log(`Done. ${succeeded} regenerated, ${failed} failed.`);
