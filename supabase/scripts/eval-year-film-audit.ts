/**
 * Year Film F0 data audit -- read-only eval answering the F0 pass questions
 * from docs/plans/year-film.md §10: are the thresholds right, how many
 * scenes does a typical film get, which scenes almost never qualify?
 *
 * For every family the eval user can see (RLS-scoped), it evaluates:
 *   1. Every child's age-years (completed + the one in progress) as birthday
 *      films, under both untagged-memory policies.
 *   2. The year-end family film for last year and this year so far.
 *   3. Monthly family recaps for every month with memories (plan §4.3).
 *   4. Threshold sensitivity for year-scale films.
 * All scene logic lives in `_shared/year-film-eligibility.ts` (the
 * production module); this script only loads rows and renders the report.
 *
 * READ-ONLY: every data read goes through the RLS-scoped client (the
 * service-role client only bootstraps the session), exactly like
 * eval-memory-book-audit.ts.
 *
 * PII rule: memory `content` is fetched (quote detection needs it) but is
 * NEVER printed, logged, or written -- only ids, dates, counts, topic ids and
 * family-member first names (needed to read the report) appear. Output goes
 * to the gitignored supabase/scripts/eval-output/year-film-audit/. stdout is
 * counts-only.
 *
 * Examples:
 *   npm run eval:year-film-audit -- --children Enzo,Mara
 *   npm run eval:year-film-audit -- --children Enzo,Mara --today 2026-12-11
 *
 * `--children` lists the family's own children by first name (plan §4.2:
 * nieces/cousins with profiles don't get films or chapters). Without it,
 * every child <13 is included and the report says so.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { PortraitVersionCandidate } from '../functions/_shared/portrait-versions.ts';
import { getTopicById } from '../functions/_shared/memory-topics.ts';
import {
  ageYearScopes,
  BIRTHDAY_MIN_POOL,
  BIRTHDAY_MIN_VISUALS,
  type BirthdayEvaluation,
  evaluateBirthdayFilm,
  evaluateFamilyFilm,
  evaluateMonthlyFilm,
  FAMILY_MIN_POOL,
  FAMILY_MIN_VISUALS,
  type FamilyEvaluation,
  type FilmMediaInput,
  type FilmMemberInput,
  type FilmMemoryInput,
  type FilmMilestoneInput,
  type FilmScope,
  isFilmChild,
  MONTHLY_MIN_POOL,
  MONTHLY_MIN_VISUALS,
  type MonthlyEvaluation,
  type UntaggedPolicy,
  YEAR_MIN_QUARTERS,
} from '../functions/_shared/year-film-eligibility.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { today: string; children: string[] | null } {
  let today = new Date().toISOString().slice(0, 10);
  let children: string[] | null = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--today' && /^\d{4}-\d{2}-\d{2}$/.test(args[i + 1] ?? '')) {
      today = args[i + 1];
      i += 1;
    } else if (args[i] === '--children' && args[i + 1]) {
      children = args[i + 1].split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
      i += 1;
    }
  }
  return { today, children };
}

// ── Row shapes (hand-typed -- matches src/types/database.ts) ───────────────

interface FamilyRow {
  id: string;
  name: string;
}

interface MemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
  relationship: string | null;
}

interface MemoryRow {
  id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[] | null;
  illustration_status: string;
  illustration_key: string | null;
  media_key: string | null;
  media_content_type: string | null;
  onboarding_media_pending: boolean;
}

interface MediaRow {
  id: string;
  memory_id: string;
  content_type: string;
  duration_ms: number | null;
  preview_object_key: string | null;
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
}

interface ReportRow {
  target_id: string;
  target_type: string;
}

// ── Auth (same pattern as eval-memory-book-audit.ts) ─────────────────────

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

// ── Loading ──────────────────────────────────────────────────────────────

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

interface FamilyData {
  family: FamilyRow;
  members: MemberRow[];
  memories: FilmMemoryInput[];
  milestones: FilmMilestoneInput[];
  portraitsByMember: Map<string, PortraitVersionCandidate[]>;
}

function mediaKind(contentType: string): FilmMediaInput['kind'] | null {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return null;
}

async function loadFamilyData(supabase: AuthedClient, family: FamilyRow): Promise<FamilyData> {
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth, relationship')
    .eq('family_id', family.id);
  if (membersError) throw new Error(`Failed to load family_members: ${membersError.message}`);

  const memoryRows = await fetchAllRows<MemoryRow>(
    (from, to) =>
      supabase
        .from('memories')
        .select(
          'id, content, memory_date, memory_type, emotion, topics, illustration_status, illustration_key, media_key, media_content_type, onboarding_media_pending',
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
      .select('id, memory_id, content_type, duration_ms, preview_object_key')
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
      .select('memory_id, family_member_id, milestone_id, status')
      .in('memory_id', chunkIds)
      .order('id', { ascending: true })
      .range(from, to)
  );

  const { data: reports, error: reportsError } = await supabase.rpc('get_my_open_content_reports', {
    p_family_id: family.id,
  });
  if (reportsError) throw new Error(`Failed to load content reports: ${reportsError.message}`);
  const reportRows = (reports ?? []) as ReportRow[];
  const reportedMemories = new Set(reportRows.filter((r) => r.target_type === 'memory').map((r) => r.target_id));
  const reportedIllustrations = new Set(
    reportRows.filter((r) => r.target_type === 'memory_illustration').map((r) => r.target_id),
  );

  const memberIds = (members ?? []).map((m) => m.id);
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

  const mediaByMemory = new Map<string, MediaRow[]>();
  for (const row of media) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }
  const tagsByMemory = new Map<string, string[]>();
  for (const row of tags) {
    const list = tagsByMemory.get(row.memory_id) ?? [];
    list.push(row.family_member_id);
    tagsByMemory.set(row.memory_id, list);
  }
  const portraitsByMember = new Map<string, PortraitVersionCandidate[]>();
  for (const row of portraitRows) {
    const list = portraitsByMember.get(row.family_member_id) ?? [];
    list.push(row);
    portraitsByMember.set(row.family_member_id, list);
  }

  const memories: FilmMemoryInput[] = saved.map((row) => {
    const rows = mediaByMemory.get(row.id) ?? [];
    let filmMedia: FilmMediaInput[] = rows.flatMap((m) => {
      const kind = mediaKind(m.content_type);
      return kind ? [{ kind, durationMs: m.duration_ms, hasPreview: !!m.preview_object_key || kind === 'image' }] : [];
    });
    // Legacy single-asset memories predate memory_media rows.
    if (filmMedia.length === 0 && row.media_key && row.media_content_type) {
      const kind = mediaKind(row.media_content_type);
      // Legacy videos have no known poster; count them as not previewable.
      if (kind) filmMedia = [{ kind, durationMs: null, hasPreview: kind === 'image' }];
    }
    return {
      id: row.id,
      date: row.memory_date,
      type: row.memory_type,
      text: row.content,
      emotion: row.emotion,
      topics: row.topics ?? [],
      taggedMemberIds: tagsByMemory.get(row.id) ?? [],
      illustrationReady: row.illustration_status === 'ready' && !!row.illustration_key &&
        !reportedIllustrations.has(row.id),
      media: filmMedia,
      reported: reportedMemories.has(row.id),
    };
  });

  return {
    family,
    members: (members ?? []) as MemberRow[],
    memories,
    milestones: milestoneRows.map((row) => ({
      memoryId: row.memory_id,
      familyMemberId: row.family_member_id,
      milestoneId: row.milestone_id,
      status: row.status,
    })),
    portraitsByMember,
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────

interface BirthdayRow {
  familyName: string;
  childName: string;
  ageYear: number;
  scope: FilmScope;
  complete: boolean;
  byPolicy: Record<UntaggedPolicy, BirthdayEvaluation>;
}

interface FamilyFilmRow {
  familyName: string;
  label: string;
  scope: FilmScope;
  nameById: Record<string, string>;
  evaluation: FamilyEvaluation;
}

interface MonthlyRow {
  familyName: string;
  yearMonth: string;
  nameById: Record<string, string>;
  evaluation: MonthlyEvaluation;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function evaluateFamily(
  data: FamilyData,
  today: string,
  allowlist: string[] | null,
): { birthdays: BirthdayRow[]; familyFilms: FamilyFilmRow[]; monthly: MonthlyRow[] } {
  const children = data.members.filter(
    (m) =>
      isFilmChild({ id: m.id, dateOfBirth: m.date_of_birth, relationship: m.relationship }, today) &&
      (allowlist === null || allowlist.includes(firstName(m.name).toLowerCase())),
  );
  const birthdays: BirthdayRow[] = [];
  const nameById = Object.fromEntries(children.map((c) => [c.id, firstName(c.name)]));
  const filmChildren: FilmMemberInput[] = children.map((c) => ({ id: c.id, dateOfBirth: c.date_of_birth }));

  for (const child of children) {
    const member: FilmMemberInput = { id: child.id, dateOfBirth: child.date_of_birth };
    for (const scope of ageYearScopes(member.dateOfBirth!, today)) {
      const evalFor = (untagged: UntaggedPolicy) =>
        evaluateBirthdayFilm({
          memories: data.memories,
          childId: child.id,
          scope,
          untagged,
          milestones: data.milestones,
          portraits: data.portraitsByMember.get(child.id) ?? [],
        });
      birthdays.push({
        familyName: data.family.name,
        childName: firstName(child.name),
        ageYear: scope.ageYear,
        scope,
        complete: scope.complete,
        byPolicy: { exclude: evalFor('exclude'), include: evalFor('include') },
      });
    }
  }

  const year = Number(today.slice(0, 4));
  const familyFilms: FamilyFilmRow[] = [];
  // Plan §4.2: scope Jan 1 → Dec 11. This year's is capped at today.
  for (const [label, filmYear] of [[`${year - 1}`, year - 1], [`${year} so far`, year]] as const) {
    const cutoffExclusive = `${filmYear}-12-12`;
    const tomorrowish = today >= cutoffExclusive ? cutoffExclusive : nextDayString(today);
    const scope = { start: `${filmYear}-01-01`, endExclusive: filmYear < year ? cutoffExclusive : tomorrowish };
    familyFilms.push({
      familyName: data.family.name,
      label,
      scope,
      nameById,
      evaluation: evaluateFamilyFilm({ memories: data.memories, children: filmChildren, scope }),
    });
  }

  // Monthly recaps: every completed month from the first memory to last month.
  const monthly: MonthlyRow[] = [];
  const dates = data.memories.map((m) => m.date).sort();
  if (dates.length > 0) {
    const currentMonth = today.slice(0, 7);
    for (let ym = dates[0].slice(0, 7); ym < currentMonth; ym = nextMonth(ym)) {
      monthly.push({
        familyName: data.family.name,
        yearMonth: ym,
        nameById,
        evaluation: evaluateMonthlyFilm({ memories: data.memories, children: filmChildren, yearMonth: ym }),
      });
    }
  }

  return { birthdays, familyFilms, monthly };
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function themeTitles(themes: { id: string }[]): string {
  return themes.map((t) => getTopicById(t.id)?.pageTitle ?? t.id).join(' / ');
}

/** today + 1 as YYYY-MM-DD via UTC noon (no local-time day slip). */
function nextDayString(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Report ───────────────────────────────────────────────────────────────

function sceneList(e: BirthdayEvaluation): string[] {
  const s = e.scenes;
  const out: string[] = [];
  if (s.coldOpen !== 'none') out.push(s.coldOpen === 'match_cut' ? 'open(match)' : 'open(1-portrait)');
  if (s.counters) out.push('counters');
  if (s.sound.include) out.push('sound');
  if (s.line.quotedSpeechMemories > 0) out.push('line');
  if (s.starring.include) out.push('starring');
  if (s.world.include) out.push('world');
  if (s.firsts.include) out.push('firsts');
  if (s.montage.frames > 0) out.push('montage');
  if (s.close !== 'none') out.push(`close(${s.close})`);
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function renderMarkdown(
  runId: string,
  today: string,
  allowlist: string[] | null,
  birthdays: BirthdayRow[],
  familyFilms: FamilyFilmRow[],
  monthly: MonthlyRow[],
): string {
  const lines: string[] = [];
  const policy: UntaggedPolicy = 'exclude';
  const completed = birthdays.filter((b) => b.complete);
  const eligible = completed.filter((b) => b.byPolicy[policy].eligible);

  lines.push(`# Year Film F0 data audit`, '');
  lines.push(`Run \`${runId}\` · evaluated as of **${today}** · plan: docs/plans/year-film.md §10 (F0)`, '');
  lines.push(
    `Thresholds: birthday ≥${BIRTHDAY_MIN_POOL} memories & ≥${BIRTHDAY_MIN_VISUALS} visuals; ` +
      `family year ≥${FAMILY_MIN_POOL} & ≥${FAMILY_MIN_VISUALS}; both need ≥${YEAR_MIN_QUARTERS}/4 quarters. ` +
      `Monthly recap ≥${MONTHLY_MIN_POOL} & ≥${MONTHLY_MIN_VISUALS}. Visuals = illustrations + video clips + photos. ` +
      `Pool policy: **tagged-only**.`,
    '',
    allowlist
      ? `Children: **${allowlist.join(', ')}** (allowlist).`
      : `Children: every child <13 in the family (no --children allowlist given).`,
    '',
  );

  // Verdict
  lines.push(`## Verdict summary`, '');
  lines.push(`- Completed age-years: **${completed.length}**, eligible for a birthday film: **${eligible.length}**.`);
  const sceneTotals = new Map<string, number>();
  for (const b of eligible) {
    for (const scene of sceneList(b.byPolicy[policy])) {
      const key = scene.replace(/\(.*\)/, '');
      sceneTotals.set(key, (sceneTotals.get(key) ?? 0) + 1);
    }
  }
  if (eligible.length > 0) {
    lines.push(
      `- Median scenes per eligible film: **${median(eligible.map((b) => sceneList(b.byPolicy[policy]).length))}**; ` +
        `median estimated length: **${median(eligible.map((b) => b.byPolicy[policy].lengthSeconds))}s** (target 30–45s).`,
    );
    const order = ['open', 'counters', 'sound', 'line', 'starring', 'world', 'firsts', 'montage', 'close'];
    lines.push(
      `- Scene hit-rate across eligible films: ` +
        order.map((k) => `${k} ${pct(sceneTotals.get(k) ?? 0, eligible.length)}`).join(' · '),
    );
  }
  const monthlyEligible = monthly.filter((m) => m.evaluation.eligible);
  lines.push(
    `- Monthly recaps: **${monthlyEligible.length} of ${monthly.length}** completed months qualify` +
      (monthly.length
        ? `; median memories/month ${median(monthly.map((m) => m.evaluation.counts.moments))}, ` +
          `median video clips in eligible months ${median(monthlyEligible.map((m) => m.evaluation.videoClips))}.`
        : '.'),
  );
  const untaggedLift = completed.filter((b) => !b.byPolicy.exclude.eligible && b.byPolicy.include.eligible);
  lines.push(
    `- Years that only become eligible when untagged memories count: **${untaggedLift.length}**` +
      (untaggedLift.length ? ` (${untaggedLift.map((b) => `${b.childName} Y${b.ageYear}`).join(', ')})` : '') + '.',
  );
  for (const f of familyFilms) {
    const e = f.evaluation;
    lines.push(
      `- Family film ${f.familyName} ${f.label}: ${e.eligible ? '**eligible**' : 'not eligible'} ` +
        `(${e.counts.moments} memories, ${e.visuals} visuals, sibling gap ${e.siblingGapRatio ?? '—'}×).`,
    );
  }
  lines.push('');

  // Birthday tables
  lines.push(`## Birthday films`, '');
  const byChild = new Map<string, BirthdayRow[]>();
  for (const b of birthdays) {
    const key = `${b.familyName} · ${b.childName}`;
    byChild.set(key, [...(byChild.get(key) ?? []), b]);
  }
  for (const [key, rows] of byChild) {
    lines.push(`### ${key}`, '');
    lines.push(
      '| Year | Scope | Pool (tagged / +untagged) | Visuals ill/video/photo | Eligible | Sounds ≥2s (longest) · video fallbacks | Quoted speech / text pool | Starring | World topics | Firsts | Portraits | Montage frames (quarters) | Est. length | Scenes |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const b of rows) {
      const e = b.byPolicy.exclude;
      const s = e.scenes;
      const k = s.montage.byKind;
      lines.push(
        `| Y${b.ageYear}${b.complete ? '' : ' *(in progress)*'} | ${b.scope.start} → ${b.scope.endExclusive} | ` +
          `${e.counts.moments} / ${b.byPolicy.include.counts.moments} | ${k.illustration}/${k.video}/${k.photo} | ` +
          `${e.eligible ? '✅' : '—'} | ${s.sound.candidates}${s.sound.longestMs ? ` (${(s.sound.longestMs / 1000).toFixed(1)}s)` : ''} · ${s.sound.videoFallbacks} | ` +
          `${s.line.quotedSpeechMemories} / ${s.line.quotePoolMemories} | ${s.starring.people} | ` +
          `${s.world.qualifyingTopics}${s.world.topTopics.length ? ` (${s.world.topTopics.map((t) => `${t.id}×${t.memories}`).join(', ')})` : ''} | ` +
          `${s.firsts.total} | ${s.coldOpen} | ${s.montage.frames} (${s.montage.quartersCovered}/4) | ${e.lengthSeconds}s | ${sceneList(e).join(', ')} |`,
      );
    }
    lines.push('');
  }

  // Family films
  lines.push(`## Year-end family films`, '');
  lines.push('| Family | Film | Scope | Memories | Visuals (video clips) | Quarters | Eligible | Shared moments | Chapters (memories / visuals / sound / quoted) | Sibling gap |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const f of familyFilms) {
    const e = f.evaluation;
    const chapters = e.chapters
      .map((c) =>
        `${f.nameById[c.childId]}: ${c.memories}/${c.visuals}/${c.hasSound ? '🔊' : '·'}/${c.quotedSpeech ? '❝' : '·'}${c.portraitOnly ? ' (portrait-only)' : ''}`
      )
      .join('; ');
    lines.push(
      `| ${f.familyName} | ${f.label} | ${f.scope.start} → ${f.scope.endExclusive} | ${e.counts.moments} | ${e.visuals} (${e.videoClips}) | ` +
        `${e.quartersCovered}/4 | ${e.eligible ? '✅' : '—'} | ${e.sharedMoments} | ${chapters} | ${e.siblingGapRatio ?? '—'}× |`,
    );
  }
  lines.push('');

  // Monthly
  lines.push(`## Monthly family recaps`, '');
  lines.push('| Month | Memories | Visuals ill/video/photo | Eligible | Themes (topic page titles) | Chapters (memories / visuals / award candidates) | Sibling gap |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of [...monthly].reverse()) {
    const e = row.evaluation;
    const chapters = e.chapters
      .map((c) => `${row.nameById[c.childId]}: ${c.memories}/${c.visuals}/${c.awardCandidates}`)
      .join('; ');
    lines.push(
      `| ${row.yearMonth} | ${e.counts.moments} | ${e.counts.drawings}/${e.videoClips}/${e.counts.photos} | ${e.eligible ? '✅' : '—'} | ` +
        `${themeTitles(e.themes) || '—'} | ${chapters} | ${e.siblingGapRatio ?? '—'}× |`,
    );
  }
  lines.push('');

  // Sensitivity
  lines.push(`## Threshold sensitivity — birthday films (completed age-years, tagged-only, ≥${YEAR_MIN_QUARTERS} quarters)`, '');
  const poolSteps = [10, 20, 40, 60, 80, 100, 150];
  const visualSteps = [6, 20, 40, 60, 100];
  lines.push(`| Min pool \\ min visuals | ${visualSteps.join(' | ')} |`);
  lines.push(`|---|${visualSteps.map(() => '---').join('|')}|`);
  for (const p of poolSteps) {
    const cells = visualSteps.map((v) =>
      completed.filter((b) =>
        b.byPolicy.exclude.counts.moments >= p && b.byPolicy.exclude.visuals >= v &&
        b.byPolicy.exclude.scenes.montage.quartersCovered >= YEAR_MIN_QUARTERS
      ).length
    );
    lines.push(`| ${p} | ${cells.join(' | ')} |`);
  }
  lines.push('', `Cell = eligible completed age-years out of ${completed.length}.`, '');

  lines.push(
    `## Notes`,
    '',
    `- "Quoted speech" counts only text with explicit quotation marks — a floor. Unmarked quotes are F1's LLM pick's job; "text pool" is what it will search.`,
    `- Blocked-account filtering is not applied here (own-family audit); production must apply it.`,
    `- Length estimate uses nominal scene durations; the real timing comes from the music beat map in F3.`,
    '',
  );
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

const { today, children: allowlist } = parseArgs(Deno.args);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const supabase = await createAuthedClient();

const { data: families, error: familiesError } = await supabase
  .from('families')
  .select('id, name')
  .is('deleted_at', null);
if (familiesError) throw new Error(`Failed to load families: ${familiesError.message}`);

const allBirthdays: BirthdayRow[] = [];
const allFamilyFilms: FamilyFilmRow[] = [];
const allMonthly: MonthlyRow[] = [];
for (const family of (families ?? []) as FamilyRow[]) {
  const data = await loadFamilyData(supabase, family);
  const { birthdays, familyFilms, monthly } = evaluateFamily(data, today, allowlist);
  allBirthdays.push(...birthdays);
  allFamilyFilms.push(...familyFilms);
  allMonthly.push(...monthly);
  console.log(
    `family ${family.id}: ${data.memories.length} memories, ${birthdays.length} age-years, ` +
      `${birthdays.filter((b) => b.complete && b.byPolicy.exclude.eligible).length} eligible birthday films, ` +
      `${monthly.filter((m) => m.evaluation.eligible).length}/${monthly.length} eligible months`,
  );
}

const outputDir = new URL('./eval-output/year-film-audit/', import.meta.url);
await Deno.mkdir(outputDir, { recursive: true });
const mdPath = new URL(`${runId}-report.md`, outputDir);
const jsonPath = new URL(`${runId}-report.json`, outputDir);

await Deno.writeTextFile(mdPath, renderMarkdown(runId, today, allowlist, allBirthdays, allFamilyFilms, allMonthly));
await Deno.writeTextFile(
  jsonPath,
  JSON.stringify(
    {
      runId,
      today,
      allowlist,
      thresholds: {
        BIRTHDAY_MIN_POOL,
        BIRTHDAY_MIN_VISUALS,
        FAMILY_MIN_POOL,
        FAMILY_MIN_VISUALS,
        YEAR_MIN_QUARTERS,
        MONTHLY_MIN_POOL,
        MONTHLY_MIN_VISUALS,
      },
      birthdays: allBirthdays,
      familyFilms: allFamilyFilms,
      monthly: allMonthly,
    },
    null,
    2,
  ),
);

console.log(`\nDone.\n  Markdown: ${mdPath.pathname}\n  JSON:     ${jsonPath.pathname}`);
