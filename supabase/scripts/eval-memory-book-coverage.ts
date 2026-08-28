/**
 * eval-memory-book-coverage.ts — READ-ONLY diff of an outline run's selected
 * memories against the full archive for its period (owner question,
 * 2026-08-28: "did any illustrated memories actually get left out of the
 * book?"). No writes of any kind; RLS-scoped auth like every eval script.
 *
 * For every memory in the outline's own window belonging to the child's
 * family, classifies it (photo / video / text — a text memory is the
 * "illustrated" population, since every text memory gets an illustration)
 * and buckets it:
 *   - selected: appears in the outline's elements
 *   - cli-excluded: in the optional --exclusions-file (one id per line —
 *     the editorial --exclude-memory-id list the outline run was given)
 *   - not-tagged: in window but not tagged to the child (never eligible)
 *   - dropped: eligible but not selected by the outline (the answer set)
 *
 * PII rule: prints ids, dates, and counts ONLY — never memory content.
 *
 * Usage:
 *   npm run eval:memory-book-coverage -- \
 *     --outline-run supabase/scripts/eval-output/memory-book-outline/<run> \
 *     [--exclusions-file path/to/ids.txt]
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Args (house rule: reject unknown args loudly) ──────────────────────────

interface Options {
  outlineRunDir: string;
  exclusionsFile: string | null;
}

function parseArgs(args: string[]): Options {
  let outlineRunDir: string | null = null;
  let exclusionsFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--outline-run') {
      outlineRunDir = args[++i] ?? null;
    } else if (arg === '--exclusions-file') {
      exclusionsFile = args[++i] ?? null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!outlineRunDir) throw new Error('--outline-run <dir> is required');
  return { outlineRunDir, exclusionsFile };
}

// ── Auth (same pattern as eval-memory-book-outline.ts) ─────────────────────

async function createAuthedClient() {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';

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

type AuthedClient = Awaited<ReturnType<typeof createAuthedClient>>;

// ── Pagination (1000-row PostgREST cap — same fetchAllRows pattern) ────────

async function fetchAllRows<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const pageSize = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────

interface OutlineJson {
  child: { id: string; name: string };
  window: { start: string; endExclusive: string; label: string };
  elements: Array<{ memoryIds: string[] }>;
  counts: Record<string, number>;
}

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
}

async function main() {
  const options = parseArgs(Deno.args);
  const outline: OutlineJson = JSON.parse(
    await Deno.readTextFile(`${options.outlineRunDir}/outline.json`),
  );
  const selectedIds = new Set(outline.elements.flatMap((e) => e.memoryIds));
  const cliExcluded = new Set<string>();
  if (options.exclusionsFile) {
    const text = await Deno.readTextFile(options.exclusionsFile);
    for (const line of text.split('\n')) {
      const id = line.trim();
      if (id) cliExcluded.add(id);
    }
  }

  const supabase = await createAuthedClient();

  // The outline records only the child's id — resolve the family through the
  // child's own family_members row (RLS-visible to the eval user).
  const { data: memberRow, error: memberError } = await supabase
    .from('family_members')
    .select('id, family_id')
    .eq('id', outline.child.id)
    .single();
  if (memberError || !memberRow) throw new Error(memberError?.message ?? 'child family_members row not found');

  const memories = await fetchAllRows<MemoryRow>(
    (from, to) =>
      supabase
        .from('memories')
        .select('id, family_id, content, memory_date, memory_type')
        .eq('family_id', memberRow.family_id)
        .gte('memory_date', outline.window.start)
        .lt('memory_date', outline.window.endExclusive)
        .order('memory_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'memories',
  );

  const memoryIds = memories.map((m) => m.id);
  const mediaByMemory = new Map<string, string[]>();
  for (const ids of chunk(memoryIds, 200)) {
    const rows = await fetchAllRows<{ memory_id: string; content_type: string }>(
      (from, to) =>
        supabase
          .from('memory_media')
          .select('memory_id, content_type')
          .in('memory_id', ids)
          .order('memory_id', { ascending: true })
          .range(from, to),
      'memory_media',
    );
    for (const row of rows) {
      const list = mediaByMemory.get(row.memory_id) ?? [];
      list.push(row.content_type);
      mediaByMemory.set(row.memory_id, list);
    }
  }
  const taggedToChild = new Set<string>();
  for (const ids of chunk(memoryIds, 200)) {
    const rows = await fetchAllRows<{ memory_id: string; family_member_id: string }>(
      (from, to) =>
        supabase
          .from('memory_family_members')
          .select('memory_id, family_member_id')
          .in('memory_id', ids)
          .eq('family_member_id', outline.child.id)
          .order('memory_id', { ascending: true })
          .range(from, to),
      'memory_family_members',
    );
    for (const row of rows) taggedToChild.add(row.memory_id);
  }

  const classify = (m: MemoryRow): 'photo' | 'video' | 'text' | 'audio' | 'empty' => {
    const media = mediaByMemory.get(m.id) ?? [];
    if (media.some((ct) => ct.startsWith('video'))) return 'video';
    if (media.some((ct) => ct.startsWith('audio')) || m.memory_type.includes('audio')) return 'audio';
    if (media.length > 0) return 'photo';
    if (m.content && m.content.trim().length > 0) return 'text';
    return 'empty';
  };

  type Bucket = 'selected' | 'cli-excluded' | 'not-tagged' | 'dropped';
  const bucketOf = (m: MemoryRow): Bucket => {
    if (selectedIds.has(m.id)) return 'selected';
    if (cliExcluded.has(m.id)) return 'cli-excluded';
    if (!taggedToChild.has(m.id)) return 'not-tagged';
    return 'dropped';
  };

  const matrix = new Map<string, number>();
  const droppedByKind = new Map<string, Array<{ id: string; date: string }>>();
  for (const m of memories) {
    const kind = classify(m);
    const bucket = bucketOf(m);
    const key = `${bucket}/${kind}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    if (bucket === 'dropped') {
      const list = droppedByKind.get(kind) ?? [];
      list.push({ id: m.id, date: m.memory_date });
      droppedByKind.set(kind, list);
    }
  }

  console.log(`window: ${outline.window.start} .. ${outline.window.endExclusive} (${outline.window.label})`);
  console.log(`archive memories in window: ${memories.length}`);
  console.log(`outline-selected: ${selectedIds.size} | outline counts: ${JSON.stringify(outline.counts)}`);
  console.log('\nbucket/kind matrix:');
  for (const key of [...matrix.keys()].sort()) console.log(`  ${key}: ${matrix.get(key)}`);
  console.log('\ndropped (eligible but not selected by the outline), ids+dates only:');
  for (const [kind, list] of [...droppedByKind.entries()].sort()) {
    console.log(`  ${kind} (${list.length}):`);
    for (const item of list) console.log(`    ${item.id}  ${item.date}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  Deno.exit(1);
});
