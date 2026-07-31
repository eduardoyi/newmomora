/**
 * Local curation tool: list and download real memory content for bundling as
 * onboarding assets (illustrations, media, and family member portraits).
 *
 * Examples:
 *   npm run export:onboarding -- --email you@example.com --list
 *   npm run export:onboarding -- --email you@example.com --list --type text_illustration --limit 20
 *   npm run export:onboarding -- --email you@example.com --list --tagged "Mia,Leo"
 *   npm run export:onboarding -- --email you@example.com --download --memory-id <uuid> --memory-id <uuid>
 *   npm run export:onboarding -- --email you@example.com --member-portrait "Mia"
 *
 * Requires R2/Supabase vars in supabase/.env.local. DB/R2 access is not
 * available in every environment this script runs in -- it must typecheck
 * even when it cannot be executed.
 *
 * This is a local curation tool: printing memory content in --list is
 * intended and fine. Never download original video bytes -- only the
 * generated poster/preview image is ever fetched for video media rows.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getObjectBytes } from '../functions/_shared/r2.ts';

type SupabaseClient = Awaited<ReturnType<typeof createAuthedClient>>;

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_date: string;
  emotion: string | null;
  memory_type: string;
  illustration_status: string;
  illustration_key: string | null;
}

interface MediaRow {
  memory_id: string;
  content_type: string;
  duration_ms: number | null;
  aspect_ratio: number | null;
  object_key: string;
  preview_object_key: string | null;
  position: number;
}

interface CliOptions {
  email?: string;
  list: boolean;
  download: boolean;
  memoryIds: string[];
  types: string[];
  taggedNames?: string[];
  limit: number;
  memberPortrait?: string;
  outputDir: URL;
}

const defaultOutputDir = new URL('./eval-output/onboarding-export/', import.meta.url);

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    download: false,
    memoryIds: [],
    types: [],
    limit: 200,
    outputDir: defaultOutputDir,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--email':
        options.email = next;
        index += 1;
        break;
      case '--list':
        options.list = true;
        break;
      case '--download':
        options.download = true;
        break;
      case '--memory-id':
        options.memoryIds.push(next);
        index += 1;
        break;
      case '--type':
        options.types.push(next);
        index += 1;
        break;
      case '--tagged':
        options.taggedNames = next
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        index += 1;
        break;
      case '--limit':
        options.limit = Number(next) || 200;
        index += 1;
        break;
      case '--member-portrait':
        options.memberPortrait = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

async function createAuthedClient(userEmail: string) {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new Error('Missing Supabase env vars in supabase/.env.local');
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: userEmail,
  });

  if (linkError || !linkData.properties?.hashed_token) {
    throw new Error(linkError?.message ?? 'Failed to generate auth link');
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: sessionData, error: sessionError } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });

  if (sessionError || !sessionData.session?.access_token) {
    throw new Error(sessionError?.message ?? 'Failed to create session');
  }

  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function extractExtension(objectKey: string): string {
  const match = objectKey.match(/\.([a-zA-Z0-9]+)$/);
  return match ? `.${match[1].toLowerCase()}` : '.webp';
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'member';
}

/** Resolves memory ids tagged with ALL of the given family member names. */
async function resolveMemoryIdsTaggedWithAll(
  supabase: SupabaseClient,
  names: string[],
): Promise<string[]> {
  const { data: members, error } = await supabase
    .from('family_members')
    .select('id, name')
    .in('name', names);

  if (error) {
    throw new Error(`Failed to resolve tagged family members: ${error.message}`);
  }

  const foundNames = new Set((members ?? []).map((member: { name: string }) => member.name));
  const missing = names.filter((name) => !foundNames.has(name));

  if (missing.length > 0) {
    console.error(`  ⚠ no family member found for: ${missing.join(', ')}`);
  }

  const memberIds = (members ?? []).map((member: { id: string }) => member.id);

  // Can't satisfy "tagged with ALL" if any requested name doesn't resolve.
  if (memberIds.length < names.length) {
    return [];
  }

  const { data: tagRows, error: tagError } = await supabase
    .from('memory_family_members')
    .select('memory_id, family_member_id')
    .in('family_member_id', memberIds);

  if (tagError) {
    throw new Error(`Failed to resolve tagged memories: ${tagError.message}`);
  }

  const memoryToMembers = new Map<string, Set<string>>();
  for (const row of (tagRows ?? []) as Array<{ memory_id: string; family_member_id: string }>) {
    const set = memoryToMembers.get(row.memory_id) ?? new Set<string>();
    set.add(row.family_member_id);
    memoryToMembers.set(row.memory_id, set);
  }

  return [...memoryToMembers.entries()]
    .filter(([, set]) => memberIds.every((id: string) => set.has(id)))
    .map(([memoryId]) => memoryId);
}

async function loadMemories(supabase: SupabaseClient, options: CliOptions): Promise<MemoryRow[]> {
  let query = supabase
    .from('memories')
    .select('id, family_id, content, memory_date, emotion, memory_type, illustration_status, illustration_key')
    .order('memory_date', { ascending: false });

  if (options.types.length > 0) {
    query = query.in('memory_type', options.types);
  }

  if (options.taggedNames && options.taggedNames.length > 0) {
    const matchingIds = await resolveMemoryIdsTaggedWithAll(supabase, options.taggedNames);

    if (matchingIds.length === 0) {
      return [];
    }

    query = query.in('id', matchingIds);
  }

  const { data, error } = await query.limit(options.limit);

  if (error) {
    throw new Error(`Failed to load memories: ${error.message}`);
  }

  return (data ?? []) as MemoryRow[];
}

async function loadMemoriesByIds(supabase: SupabaseClient, ids: string[]): Promise<MemoryRow[]> {
  const { data, error } = await supabase
    .from('memories')
    .select('id, family_id, content, memory_date, emotion, memory_type, illustration_status, illustration_key')
    .in('id', ids);

  if (error) {
    throw new Error(`Failed to load memories: ${error.message}`);
  }

  return (data ?? []) as MemoryRow[];
}

async function loadTagsForMemories(
  supabase: SupabaseClient,
  memoryIds: string[],
): Promise<Map<string, string[]>> {
  if (memoryIds.length === 0) {
    return new Map();
  }

  const { data: tagRows, error } = await supabase
    .from('memory_family_members')
    .select('memory_id, family_member_id')
    .in('memory_id', memoryIds);

  if (error) {
    throw new Error(`Failed to load memory tags: ${error.message}`);
  }

  const rows = (tagRows ?? []) as Array<{ memory_id: string; family_member_id: string }>;
  const memberIds = [...new Set(rows.map((row) => row.family_member_id))];

  if (memberIds.length === 0) {
    return new Map();
  }

  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, name')
    .in('id', memberIds);

  if (membersError) {
    throw new Error(`Failed to load family member names: ${membersError.message}`);
  }

  const nameById = new Map(
    ((members ?? []) as Array<{ id: string; name: string }>).map((member) => [member.id, member.name]),
  );

  const tagsByMemory = new Map<string, string[]>();
  for (const row of rows) {
    const name = nameById.get(row.family_member_id);
    if (!name) continue;
    const list = tagsByMemory.get(row.memory_id) ?? [];
    list.push(name);
    tagsByMemory.set(row.memory_id, list);
  }

  return tagsByMemory;
}

async function loadMediaForMemories(
  supabase: SupabaseClient,
  memoryIds: string[],
): Promise<Map<string, MediaRow[]>> {
  if (memoryIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from('memory_media')
    .select('memory_id, content_type, duration_ms, aspect_ratio, object_key, preview_object_key, position')
    .in('memory_id', memoryIds)
    .order('position', { ascending: true });

  if (error) {
    throw new Error(`Failed to load memory media: ${error.message}`);
  }

  const byMemory = new Map<string, MediaRow[]>();
  for (const row of (data ?? []) as MediaRow[]) {
    const list = byMemory.get(row.memory_id) ?? [];
    list.push(row);
    byMemory.set(row.memory_id, list);
  }

  return byMemory;
}

function formatMediaSummary(media: MediaRow[]): string {
  if (media.length === 0) {
    return 'none';
  }

  return media
    .map((item) =>
      `${item.content_type} dur=${item.duration_ms ?? 'n/a'}ms ar=${item.aspect_ratio ?? 'n/a'} preview=${
        item.preview_object_key ? 'yes' : 'no'
      }`
    )
    .join('; ');
}

function printMemoryBlock(memory: MemoryRow, tags: string[], media: MediaRow[]): void {
  console.log(`\n[${memory.id}]`);
  console.log(`  type: ${memory.memory_type}`);
  console.log(`  date: ${memory.memory_date}`);
  console.log(`  emotion: ${memory.emotion ?? '(none)'}`);
  console.log(`  tags: ${tags.length > 0 ? tags.join(', ') : '(none)'}`);
  console.log(
    `  illustration: status=${memory.illustration_status} key=${memory.illustration_key ? 'present' : 'none'}`,
  );
  console.log(`  media: ${formatMediaSummary(media)}`);
  console.log('  content:');
  console.log(memory.content ?? '(empty)');
}

async function runList(supabase: SupabaseClient, options: CliOptions): Promise<void> {
  const memories = await loadMemories(supabase, options);

  if (memories.length === 0) {
    console.log('No matching memories found.');
    return;
  }

  const memoryIds = memories.map((memory) => memory.id);
  const [tagsByMemory, mediaByMemory] = await Promise.all([
    loadTagsForMemories(supabase, memoryIds),
    loadMediaForMemories(supabase, memoryIds),
  ]);

  console.log(`${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} found`);

  for (const memory of memories) {
    printMemoryBlock(memory, tagsByMemory.get(memory.id) ?? [], mediaByMemory.get(memory.id) ?? []);
  }
}

interface MediaManifestEntry {
  position: number;
  contentType: string;
  durationMs: number | null;
  aspectRatio: number | null;
  downloadedFile: string | null;
}

async function downloadMemory(
  memory: MemoryRow,
  tags: string[],
  media: MediaRow[],
  outputDir: URL,
): Promise<void> {
  console.log(`\n→ [${memory.id}]`);
  const memoryDir = new URL(`${memory.id}/`, outputDir);
  await Deno.mkdir(memoryDir, { recursive: true });

  if (memory.illustration_key) {
    try {
      const bytes = await getObjectBytes(memory.illustration_key);
      const filename = `illustration${extractExtension(memory.illustration_key)}`;
      await Deno.writeFile(new URL(filename, memoryDir), bytes);
      console.log(`  ✓ illustration → ${filename}`);
    } catch (error) {
      console.error(`  ✗ illustration download failed`, error instanceof Error ? error.message : 'unknown');
    }
  }

  const mediaManifest: MediaManifestEntry[] = [];

  for (const item of media) {
    const base: Omit<MediaManifestEntry, 'downloadedFile'> = {
      position: item.position,
      contentType: item.content_type,
      durationMs: item.duration_ms,
      aspectRatio: item.aspect_ratio,
    };

    if (item.content_type.startsWith('video/')) {
      // Hard rule: never download original video bytes -- only the poster.
      if (!item.preview_object_key) {
        console.error(`  ✗ media[${item.position}] video has no preview_object_key, skipping`);
        mediaManifest.push({ ...base, downloadedFile: null });
        continue;
      }

      try {
        const bytes = await getObjectBytes(item.preview_object_key);
        const filename = `poster-${item.position}${extractExtension(item.preview_object_key)}`;
        await Deno.writeFile(new URL(filename, memoryDir), bytes);
        console.log(`  ✓ media[${item.position}] poster → ${filename}`);
        mediaManifest.push({ ...base, downloadedFile: filename });
      } catch (error) {
        console.error(
          `  ✗ media[${item.position}] poster download failed`,
          error instanceof Error ? error.message : 'unknown',
        );
        mediaManifest.push({ ...base, downloadedFile: null });
      }

      continue;
    }

    try {
      const bytes = await getObjectBytes(item.object_key);
      const filename = `media-${item.position}${extractExtension(item.object_key)}`;
      await Deno.writeFile(new URL(filename, memoryDir), bytes);
      console.log(`  ✓ media[${item.position}] → ${filename}`);
      mediaManifest.push({ ...base, downloadedFile: filename });
    } catch (error) {
      console.error(
        `  ✗ media[${item.position}] download failed`,
        error instanceof Error ? error.message : 'unknown',
      );
      mediaManifest.push({ ...base, downloadedFile: null });
    }
  }

  const manifest = {
    id: memory.id,
    memoryType: memory.memory_type,
    memoryDate: memory.memory_date,
    emotion: memory.emotion,
    content: memory.content,
    taggedNames: tags,
    media: mediaManifest,
  };

  await Deno.writeFile(
    new URL('manifest.json', memoryDir),
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  );

  console.log(`  ✓ manifest.json saved → ${memoryDir.pathname}`);
}

async function runDownload(supabase: SupabaseClient, memoryIds: string[], outputDir: URL): Promise<void> {
  const memories = await loadMemoriesByIds(supabase, memoryIds);

  if (memories.length === 0) {
    console.error('No matching memories found.');
    Deno.exit(1);
  }

  const foundIds = new Set(memories.map((memory) => memory.id));
  for (const id of memoryIds) {
    if (!foundIds.has(id)) {
      console.error(`  ⚠ memory not found or not accessible: ${id}`);
    }
  }

  const resolvedIds = [...foundIds];
  const [tagsByMemory, mediaByMemory] = await Promise.all([
    loadTagsForMemories(supabase, resolvedIds),
    loadMediaForMemories(supabase, resolvedIds),
  ]);

  for (const memory of memories) {
    await downloadMemory(memory, tagsByMemory.get(memory.id) ?? [], mediaByMemory.get(memory.id) ?? [], outputDir);
  }

  console.log(`\nDone. Output under ${outputDir.pathname}`);
}

async function runMemberPortrait(supabase: SupabaseClient, name: string, outputDir: URL): Promise<void> {
  const { data: members, error } = await supabase
    .from('family_members')
    .select('id, name, illustrated_profile_key, illustrated_profile_status')
    .eq('name', name);

  if (error) {
    console.error(`Failed to load family member: ${error.message}`);
    Deno.exit(1);
  }

  if (!members || members.length === 0) {
    console.error(`No family member found with name "${name}"`);
    Deno.exit(1);
  }

  if (members.length > 1) {
    console.error(`  ⚠ multiple family members named "${name}" found; using the first match`);
  }

  const member = members[0] as {
    id: string;
    name: string;
    illustrated_profile_key: string | null;
    illustrated_profile_status: string;
  };

  if (member.illustrated_profile_status !== 'ready' || !member.illustrated_profile_key) {
    console.error(`"${name}" portrait is not ready (status: ${member.illustrated_profile_status})`);
    Deno.exit(1);
  }

  const bytes = await getObjectBytes(member.illustrated_profile_key);
  const portraitsDir = new URL('portraits/', outputDir);
  await Deno.mkdir(portraitsDir, { recursive: true });
  const filename = `${slugify(name)}${extractExtension(member.illustrated_profile_key)}`;
  const destination = new URL(filename, portraitsDir);
  await Deno.writeFile(destination, bytes);
  console.log(`✓ saved → ${destination.pathname}`);
}

const options = parseArgs(Deno.args);

if (!options.email) {
  console.error('Provide --email <email>');
  Deno.exit(1);
}

const modeCount = [options.list, options.download, Boolean(options.memberPortrait)]
  .filter(Boolean).length;

if (modeCount === 0) {
  console.error('Provide --list, --download, or --member-portrait "<name>"');
  Deno.exit(1);
}

if (modeCount > 1) {
  console.error('Provide exactly one of --list, --download, or --member-portrait');
  Deno.exit(1);
}

const supabase = await createAuthedClient(options.email);

if (options.list) {
  await runList(supabase, options);
} else if (options.download) {
  if (options.memoryIds.length === 0) {
    console.error('Provide --memory-id <uuid> (repeatable) with --download');
    Deno.exit(1);
  }

  await Deno.mkdir(options.outputDir, { recursive: true });
  await runDownload(supabase, options.memoryIds, options.outputDir);
} else if (options.memberPortrait) {
  await Deno.mkdir(options.outputDir, { recursive: true });
  await runMemberPortrait(supabase, options.memberPortrait, options.outputDir);
}
