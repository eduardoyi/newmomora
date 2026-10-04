/**
 * Year Film eval data loader -- shared by eval-year-film-audit.ts (F0) and
 * eval-year-film-script.ts (F1) (docs/plans/year-film.md §10). Not
 * production code: production loads the same rows through the
 * workflow-year-film-bridge (P1).
 *
 * READ-ONLY: every data read goes through the RLS-scoped client (the
 * service-role client only bootstraps the session), exactly like
 * eval-memory-book-audit.ts. Returns memory text because F1's quote pick and
 * storyboard need it; callers must never print it to stdout.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { PortraitVersionCandidate } from '../functions/_shared/portrait-versions.ts';
import type { FilmMemorySource, FilmPerson } from '../functions/_shared/year-film-script.ts';
import type { FilmMilestoneInput } from '../functions/_shared/year-film-eligibility.ts';
import { mapFamilyRows } from '../functions/_shared/year-film-context.ts';

// ── Row shapes (hand-typed -- matches src/types/database.ts) ───────────────

interface FamilyRow {
  id: string;
  name: string;
  gallery_caption_language: string | null;
  /** families.gallery_caption_instructions: the family's own caption guidance (≤500 chars). */
  gallery_caption_instructions?: string | null;
}

interface MemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
  relationship: string | null;
  created_at: string;
  user_id: string | null;
  nicknames: string[] | null;
  gender: string | null;
}

interface MemoryRow {
  id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[] | null;
  labels: string[] | null;
  user_id: string | null;
  illustration_status: string;
  illustration_key: string | null;
  media_key: string | null;
  media_content_type: string | null;
  onboarding_media_pending: boolean;
}

interface MediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  duration_ms: number | null;
  aspect_ratio: number | null;
  position: number;
}

interface TagRow {
  memory_id: string;
  family_member_id: string;
}

interface MilestoneRow {
  memory_id: string;
  family_member_id: string | null;
  milestone_id: string;
  status: string;
  out_of_band: boolean;
}

interface ReportRow {
  target_id: string;
  target_type: string;
}

// ── Auth ─────────────────────────────────────────────────────────────────

export async function createAuthedClient() {
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

export type AuthedClient = Awaited<ReturnType<typeof createAuthedClient>>;

// ── Paging ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
const CHUNK_SIZE = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Pages `.range()` until a short page; callers must pass a deterministic
 * `.order()` (see eval-memory-book-audit.ts's fetchAllRows). */
async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

async function loadByMemoryIds<T>(
  memoryIds: string[],
  label: string,
  page: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (const ids of chunk(memoryIds, CHUNK_SIZE)) {
    out.push(...(await fetchAllRows<T>((from, to) => page(ids, from, to), label)));
  }
  return out;
}

// ── Family data ──────────────────────────────────────────────────────────

export interface EvalFamilyData {
  familyId: string;
  familyName: string;
  language: string | null;
  /** The family's caption instructions (free text), or null. User content. */
  captionInstructions: string | null;
  members: FilmPerson[];
  memories: FilmMemorySource[];
  milestones: FilmMilestoneInput[];
}

export async function loadFamilies(supabase: AuthedClient): Promise<FamilyRow[]> {
  const { data, error } = await supabase
    .from('families')
    .select('id, name, gallery_caption_language, gallery_caption_instructions')
    .is('deleted_at', null);
  if (error) throw new Error(`Failed to load families: ${error.message}`);
  return (data ?? []) as FamilyRow[];
}

export async function loadFamilyData(supabase: AuthedClient, family: FamilyRow): Promise<EvalFamilyData> {
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth, relationship, created_at, user_id, nicknames, gender')
    .eq('family_id', family.id);
  if (membersError) throw new Error(`Failed to load family_members: ${membersError.message}`);
  const memberRows = (members ?? []) as MemberRow[];

  const memoryRows = await fetchAllRows<MemoryRow>(
    (from, to) =>
      supabase
        .from('memories')
        .select(
          'id, content, memory_date, memory_type, emotion, topics, labels, user_id, illustration_status, illustration_key, media_key, media_content_type, onboarding_media_pending',
        )
        .eq('family_id', family.id)
        .order('memory_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'memories',
  );
  const saved = memoryRows.filter((m) => !m.onboarding_media_pending);
  const ids = saved.map((m) => m.id);

  const media = await loadByMemoryIds<MediaRow>(ids, 'memory_media', (chunkIds, from, to) =>
    supabase
      .from('memory_media')
      .select('id, memory_id, object_key, preview_object_key, content_type, duration_ms, aspect_ratio, position')
      .in('memory_id', chunkIds)
      .order('id', { ascending: true })
      .range(from, to)
  );
  const tags = await loadByMemoryIds<TagRow>(ids, 'memory_family_members', (chunkIds, from, to) =>
    supabase
      .from('memory_family_members')
      .select('memory_id, family_member_id')
      .in('memory_id', chunkIds)
      .order('memory_id', { ascending: true })
      .order('family_member_id', { ascending: true })
      .range(from, to)
  );
  const milestoneRows = await loadByMemoryIds<MilestoneRow>(ids, 'memory_milestones', (chunkIds, from, to) =>
    supabase
      .from('memory_milestones')
      .select('memory_id, family_member_id, milestone_id, status, out_of_band')
      .in('memory_id', chunkIds)
      .order('id', { ascending: true })
      .range(from, to)
  );

  const { data: reports, error: reportsError } = await supabase.rpc('get_my_open_content_reports', {
    p_family_id: family.id,
  });
  if (reportsError) throw new Error(`Failed to load content reports: ${reportsError.message}`);
  const reportRows = (reports ?? []) as ReportRow[];

  const memberIds = memberRows.map((m) => m.id);
  const portraitRows = memberIds.length === 0 ? [] : await fetchAllRows<PortraitVersionCandidate>(
    (from, to) =>
      supabase
        .from('family_member_portrait_versions')
        .select(
          'id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, created_at',
        )
        .in('family_member_id', memberIds)
        .order('id', { ascending: true })
        .range(from, to),
    'family_member_portrait_versions',
  );

  const mapped = mapFamilyRows({
    family,
    members: memberRows,
    memories: saved,
    media,
    tags,
    milestones: milestoneRows,
    portraits: portraitRows as (PortraitVersionCandidate & { family_member_id: string })[],
    reports: reportRows,
  });
  return { ...mapped, captionInstructions: family.gallery_caption_instructions?.trim() || null };
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Resolves the `--children` allowlist (first names, case-insensitive). */
export function pickChildren(
  members: FilmPerson[],
  allowlist: string[] | null,
  isChild: (m: FilmPerson) => boolean,
): FilmPerson[] {
  return members.filter(
    (m) => isChild(m) && (allowlist === null || allowlist.includes(firstName(m.name).toLowerCase())),
  );
}
