// Year Film context → builder inputs (docs/plans/year-film-p1.md Step 2).
// One mapping from database rows to the builders' FilmMemorySource /
// FilmPerson shapes, used by the production Worker (rows come from
// workflow-year-film-bridge) and the eval scripts (rows come from the
// RLS-scoped client) — so a passing eval means the production mapping
// passed too.
//
// Pure: no I/O, no Deno APIs.
import type { PortraitVersionCandidate } from './portrait-versions.ts';
import {
  birthdayFilmScope,
  birthdayPool,
  chapterChildren,
  evaluateBirthdayFilm,
  evaluateFamilyFilm,
  evaluateHolidayFilm,
  evaluateMonthlyFilm,
  familyPool,
  type FilmMediaInput,
  type FilmMilestoneInput,
  type FilmScope,
  holidayPool,
  isFilmChild,
} from './year-film-eligibility.ts';
import type { QuoteSubject } from './year-film-quotes.ts';
import {
  type BirthdayInput,
  type FamilyYearInput,
  type FilmAssetRef,
  type FilmMemorySource,
  type FilmPerson,
  type HolidayInput,
  type MonthlyInput,
  shareSensitiveIds,
  type VerifiedQuote,
} from './year-film-script.ts';

// ── Rows ───────────────────────────────────────────────────────────────────

export interface FamilyRow {
  id: string;
  name: string;
  gallery_caption_language: string | null;
}

export interface MemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
  relationship: string | null;
  created_at: string;
  /** Optional: the holiday letter's voice and naming (eval + later production). */
  user_id?: string | null;
  nicknames?: string[] | null;
  gender?: string | null;
}

export interface MemoryRow {
  id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[] | null;
  /** Optional: open-vocabulary labels (holiday letter details). */
  labels?: string[] | null;
  illustration_status: string;
  illustration_key: string | null;
  media_key: string | null;
  media_content_type: string | null;
  onboarding_media_pending: boolean;
  /** Production only: filters memories added after the film's first curate. */
  created_at?: string;
  /** The author (memories.user_id); production only. */
  user_id?: string | null;
}

export interface MediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  duration_ms: number | null;
  aspect_ratio: number | null;
  position: number;
}

export interface TagRow {
  memory_id: string;
  family_member_id: string;
}

export interface MilestoneRow {
  memory_id: string;
  family_member_id: string | null;
  milestone_id: string;
  status: string;
  out_of_band: boolean;
}

export interface ReportRow {
  target_id: string;
  target_type: string;
}

export interface FamilyRows {
  family: FamilyRow;
  members: MemberRow[];
  memories: MemoryRow[];
  media: MediaRow[];
  tags: TagRow[];
  milestones: MilestoneRow[];
  portraits: (PortraitVersionCandidate & { family_member_id: string })[];
  /** Eval: the viewer's own open reports. Production: every open/reviewing
   * report in the family (films are family-wide, plan Decision 11). */
  reports: ReportRow[];
  /** Accounts blocked by an owner/manager: their memories are left out of
   * every film (owner decision 2026-09-29). Viewer blocks stay personal. */
  blockedAuthorIds?: string[];
}

export interface FamilyFilmData {
  familyId: string;
  familyName: string;
  language: string | null;
  members: FilmPerson[];
  memories: FilmMemorySource[];
  milestones: FilmMilestoneInput[];
}

export interface MapOptions {
  /** Memories created after this instant are left out (re-renders never pull
   * in backdated memories, plan Decision 7). */
  poolCutoffAt?: string | null;
  /** The family's edit: memories removed from the film. */
  excludeMemoryIds?: readonly string[];
}

function mediaKind(contentType: string): FilmMediaInput['kind'] | null {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return null;
}

function group<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}

export function mapFamilyRows(rows: FamilyRows, options: MapOptions = {}): FamilyFilmData {
  const excluded = new Set(options.excludeMemoryIds ?? []);
  const blockedAuthors = new Set(rows.blockedAuthorIds ?? []);
  const cutoff = options.poolCutoffAt ?? null;
  const saved = rows.memories.filter((m) =>
    !m.onboarding_media_pending &&
    !excluded.has(m.id) &&
    !(m.user_id && blockedAuthors.has(m.user_id)) &&
    (cutoff === null || !m.created_at || m.created_at <= cutoff)
  );
  const savedIds = new Set(saved.map((m) => m.id));

  const reportedMemories = new Set(rows.reports.filter((r) => r.target_type === 'memory').map((r) => r.target_id));
  const reportedIllustrations = new Set(
    rows.reports.filter((r) => r.target_type === 'memory_illustration').map((r) => r.target_id),
  );
  const mediaByMemory = group(rows.media.filter((m) => savedIds.has(m.memory_id)), (m) => m.memory_id);
  const tagsByMemory = group(rows.tags, (t) => t.memory_id);
  const portraitsByMember = group(rows.portraits, (p) => p.family_member_id);

  const memories: FilmMemorySource[] = saved.map((row) => {
    const media = [...(mediaByMemory.get(row.id) ?? [])].sort((a, b) => a.position - b.position);
    let assets: FilmAssetRef[] = media.flatMap((m) => {
      const kind = mediaKind(m.content_type);
      return kind
        ? [{ id: m.id, kind, key: m.object_key, previewKey: m.preview_object_key, durationMs: m.duration_ms, aspectRatio: m.aspect_ratio }]
        : [];
    });
    // Legacy single-asset memories predate memory_media rows.
    if (assets.length === 0 && row.media_key && row.media_content_type) {
      const kind = mediaKind(row.media_content_type);
      if (kind) assets = [{ kind, key: row.media_key, previewKey: null, durationMs: null, aspectRatio: null }];
    }
    const illustrationReady = row.illustration_status === 'ready' && !!row.illustration_key &&
      !reportedIllustrations.has(row.id);
    return {
      id: row.id,
      date: row.memory_date,
      type: row.memory_type,
      text: row.content,
      emotion: row.emotion,
      topics: row.topics ?? [],
      taggedMemberIds: (tagsByMemory.get(row.id) ?? []).map((t) => t.family_member_id),
      illustrationReady,
      illustrationKey: illustrationReady ? row.illustration_key : null,
      media: assets.map((a) => ({ kind: a.kind, durationMs: a.durationMs, hasPreview: !!a.previewKey || a.kind === 'image' })),
      assets,
      reported: reportedMemories.has(row.id),
      ...(row.labels ? { labels: row.labels } : {}),
      ...(row.user_id ? { authorId: row.user_id } : {}),
    };
  });

  return {
    familyId: rows.family.id,
    familyName: rows.family.name,
    language: rows.family.gallery_caption_language,
    members: rows.members.map((m) => ({
      id: m.id,
      name: m.name,
      dateOfBirth: m.date_of_birth,
      relationship: m.relationship,
      createdAt: m.created_at,
      portraits: portraitsByMember.get(m.id) ?? [],
      ...(m.user_id ? { userId: m.user_id } : {}),
      ...(m.nicknames?.length ? { nicknames: m.nicknames } : {}),
      ...(m.gender ? { gender: m.gender } : {}),
    })),
    memories,
    milestones: rows.milestones
      .filter((row) => savedIds.has(row.memory_id))
      .map((row) => ({
        memoryId: row.memory_id,
        familyMemberId: row.family_member_id,
        milestoneId: row.milestone_id,
        status: row.status,
        outOfBand: row.out_of_band,
      })),
  };
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

// ── Text hash (twin of public.year_film_text_hash) ─────────────────────────

/** sha256 hex of content ␟ transcript ␟ description — must match the SQL
 * function the invalidation trigger and publish check use. */
export async function yearFilmTextHash(content: string | null, transcript: string | null, description: string | null): Promise<string> {
  const text = `${content ?? ''}\u001f${transcript ?? ''}\u001f${description ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Film plan ─────────────────────────────────────────────────────────────

export interface FilmRowForPlan {
  kind: 'birthday' | 'family_month' | 'family_year' | 'family_holiday';
  familyMemberId: string | null;
  ageYear: number | null;
  scopeStart: string;
  scopeEndExclusive: string;
}

interface PlanBase {
  scope: FilmScope;
  /** The family's own children (isFilmChild at the film's end). */
  children: FilmPerson[];
  /** Whom the quote pick and claim checks are about. */
  subjects: FilmPerson[];
  pool: FilmMemorySource[];
  /** The pool minus share-sensitive memories (plan §3): quote candidates. */
  quotable: FilmMemorySource[];
  quoteSubjects: QuoteSubject[];
}

export type FilmPlan =
  | (PlanBase & { kind: 'birthday'; input: Omit<BirthdayInput, 'quotes' | 'language' | 'checks'> })
  | (PlanBase & { kind: 'family_month'; input: Omit<MonthlyInput, 'quotes' | 'language' | 'checks'> })
  | (PlanBase & { kind: 'family_year'; input: Omit<FamilyYearInput, 'quotes' | 'language' | 'checks'> })
  | (PlanBase & { kind: 'family_holiday'; input: Omit<HolidayInput, 'quotes' | 'language' | 'checks'> });

export type PlanResult = { ok: true; plan: FilmPlan } | { ok: false; reason: string };

/**
 * Who the film is about and its pool, and whether it clears the floors
 * (year-film-eligibility's evaluate*, the single source of truth). A film
 * that doesn't qualify ends `skipped` before any paid call.
 */
export function planFilm(data: FamilyFilmData, film: FilmRowForPlan): PlanResult {
  const scope: FilmScope = { start: film.scopeStart, endExclusive: film.scopeEndExclusive };
  // Own children as of the film's last day (the under-13 ceiling applies there).
  const lastDay = scope.endExclusive;
  const children = data.members.filter((m) =>
    isFilmChild({ id: m.id, dateOfBirth: m.dateOfBirth, relationship: m.relationship }, lastDay)
  );
  const ownChildIds = children.map((c) => c.id);
  const sensitive = shareSensitiveIds(data.memories, data.milestones);
  const quotableOf = (pool: FilmMemorySource[]) => pool.filter((m) => !sensitive.has(m.id));
  const subjectsOf = (people: FilmPerson[]) => people.map((p) => ({ id: p.id, name: firstName(p.name) }));

  if (film.kind === 'birthday') {
    const child = data.members.find((m) => m.id === film.familyMemberId);
    if (!child?.dateOfBirth || film.ageYear === null) return { ok: false, reason: 'CHILD_MISSING' };
    if (!isFilmChild({ id: child.id, dateOfBirth: child.dateOfBirth, relationship: child.relationship }, birthdayFilmScope(child.dateOfBirth, film.ageYear).start)) {
      return { ok: false, reason: 'NOT_OWN_CHILD' };
    }
    const evaluation = evaluateBirthdayFilm({
      memories: data.memories,
      childId: child.id,
      scope: { start: scope.start, endExclusive: scope.endExclusive },
      untagged: 'exclude',
      milestones: data.milestones,
      portraits: child.portraits,
    });
    if (!evaluation.eligible) return { ok: false, reason: 'BELOW_FLOORS' };
    const pool = birthdayPool(data.memories, child.id, scope, 'exclude');
    return {
      ok: true,
      plan: {
        kind: 'birthday',
        scope,
        children: children.some((c) => c.id === child.id) ? children : [...children, child],
        subjects: [child],
        pool,
        quotable: quotableOf(pool),
        quoteSubjects: subjectsOf([child]),
        input: {
          child,
          ageYear: film.ageYear,
          scope,
          memories: data.memories,
          members: data.members,
          ownChildIds: [...new Set([...ownChildIds, child.id])],
          milestones: data.milestones,
        },
      },
    };
  }

  if (children.length === 0) return { ok: false, reason: 'NO_OWN_CHILDREN' };
  const kids = chapterChildren(children.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth })), scope)
    .map((k) => children.find((c) => c.id === k.id)!);
  const pool = familyPool(data.memories, scope);

  if (film.kind === 'family_holiday') {
    // A card film is watched publicly: the floors count only the share-safe
    // pool (no sensitive memories, no worried/sad/weary), and the quote pick
    // reads the same pool. No quarter rule (docs/plans/holiday-cards.md).
    const holiday = holidayPool(data.memories, scope, sensitive);
    const evaluation = evaluateHolidayFilm({ memories: data.memories, children, scope, excludeIds: sensitive });
    if (!evaluation.eligible) return { ok: false, reason: 'BELOW_FLOORS' };
    return {
      ok: true,
      plan: {
        kind: 'family_holiday',
        scope,
        children,
        subjects: kids,
        pool: holiday,
        quotable: holiday,
        quoteSubjects: subjectsOf(kids),
        input: {
          year: Number(scope.start.slice(0, 4)),
          scope,
          familyName: data.familyName,
          memories: data.memories,
          children,
          members: data.members,
          milestones: data.milestones,
        },
      },
    };
  }

  if (film.kind === 'family_month') {
    const yearMonth = scope.start.slice(0, 7);
    const evaluation = evaluateMonthlyFilm({ memories: data.memories, children, yearMonth });
    if (!evaluation.eligible) return { ok: false, reason: 'BELOW_FLOORS' };
    return {
      ok: true,
      plan: {
        kind: 'family_month',
        scope,
        children,
        subjects: kids,
        pool,
        quotable: quotableOf(pool),
        quoteSubjects: subjectsOf(kids),
        input: { yearMonth, memories: data.memories, children, milestones: data.milestones },
      },
    };
  }

  const evaluation = evaluateFamilyFilm({ memories: data.memories, children, scope });
  if (!evaluation.eligible) return { ok: false, reason: 'BELOW_FLOORS' };
  return {
    ok: true,
    plan: {
      kind: 'family_year',
      scope,
      children,
      subjects: kids,
      pool,
      quotable: quotableOf(pool),
      quoteSubjects: subjectsOf(kids),
      input: {
        year: Number(scope.start.slice(0, 4)),
        scope,
        memories: data.memories,
        children,
        members: data.members,
        milestones: data.milestones,
      },
    },
  };
}

// ── Sticky quotes (plan Decision 6) ───────────────────────────────────────

export interface QuoteCandidate extends VerifiedQuote {
  textHash: string;
}

/**
 * The quotes a re-render may use: the first curate's candidates that still
 * point at a memory in the film's data with unchanged text; the family's
 * chosen quote (edit) moves first. Order is otherwise preserved.
 */
export function stickyQuotes(
  candidates: readonly QuoteCandidate[],
  currentHashes: ReadonlyMap<string, string>,
  chosen: { memoryId: string; textHash: string } | null,
): VerifiedQuote[] {
  const valid = candidates.filter((c) => currentHashes.get(c.memoryId) === c.textHash);
  const index = chosen ? valid.findIndex((c) => c.memoryId === chosen.memoryId && c.textHash === chosen.textHash) : -1;
  const ordered = index > 0 ? [valid[index], ...valid.slice(0, index), ...valid.slice(index + 1)] : valid;
  return ordered.map(({ memoryId, quote, speakerId }) => ({ memoryId, quote, speakerId }));
}

// ── What a script shows (stamped at curate for invalidation) ──────────────

export interface ScriptReferences {
  memoryIds: string[];
  assetKeys: string[];
  memberIds: string[];
  portraitVersionIds: string[];
  /** Memories whose text appears on screen (quotes, chapter lines, sound
   * captions): an edit to them blocks the film. */
  textMemoryIds: string[];
}

/**
 * Everything a script can put on screen, for the invalidation triggers and
 * the publish re-verification (docs/plans/year-film-p1.md §4–§5). Portrait
 * frames resolve to version ids through their keys.
 */
export function scriptReferences(
  script: { scenes: FilmScriptLike['scenes']; subjects?: { id: string }[]; references?: { id: string }[] },
  portraits: readonly { id: string; illustrated_profile_key: string | null; profile_picture_key: string | null }[],
): ScriptReferences {
  const memoryIds = new Set<string>();
  const assetKeys = new Set<string>();
  const memberIds = new Set<string>();
  const textMemoryIds = new Set<string>();
  const portraitKeys = new Set<string>();
  const addFrame = (f: FrameLike | null | undefined) => {
    if (!f) return;
    if (f.memoryId) memoryIds.add(f.memoryId);
    for (const k of [f.key, f.previewKey, f.pairKey]) if (k) assetKeys.add(k);
    if (f.kind === 'portrait') {
      portraitKeys.add(f.key);
      if (f.pairKey) portraitKeys.add(f.pairKey);
    }
  };
  for (const s of script.subjects ?? []) memberIds.add(s.id);
  for (const s of script.references ?? []) memberIds.add(s.id);
  for (const scene of script.scenes as SceneLike[]) {
    switch (scene.type) {
      case 'cold_open':
        addFrame(scene.from);
        addFrame(scene.to);
        break;
      case 'title':
        scene.cards.forEach(addFrame);
        break;
      case 'end_card':
        scene.grid.forEach(addFrame);
        break;
      case 'counters':
        (scene.backdrop ?? []).forEach(addFrame);
        break;
      case 'burst':
      case 'close':
        scene.frames.forEach(addFrame);
        break;
      case 'sound':
        addFrame(scene.frame);
        scene.alternates.forEach(addFrame);
        if (scene.frame.memoryId) textMemoryIds.add(scene.frame.memoryId);
        break;
      case 'line':
        addFrame(scene.frame);
        memoryIds.add(scene.memoryId);
        textMemoryIds.add(scene.memoryId);
        break;
      case 'starring':
        for (const p of scene.people) {
          memberIds.add(p.memberId);
          addFrame(p.portrait);
          p.moments.forEach(addFrame);
        }
        for (const t of scene.together ?? []) {
          memberIds.add(t.memberId);
          addFrame(t.portrait);
        }
        break;
      case 'firsts':
        for (const item of scene.items) {
          memoryIds.add(item.memoryId);
          addFrame(item.frame);
        }
        break;
      case 'chapter':
        memberIds.add(scene.childId);
        addFrame(scene.portrait);
        scene.frames.forEach(addFrame);
        if (scene.line) {
          memoryIds.add(scene.line.memoryId);
          textMemoryIds.add(scene.line.memoryId);
        }
        break;
      case 'award':
        memberIds.add(scene.childId);
        addFrame(scene.frame);
        break;
    }
  }
  const portraitVersionIds = portraits
    .filter((p) => (p.illustrated_profile_key && portraitKeys.has(p.illustrated_profile_key)) ||
      (p.profile_picture_key && portraitKeys.has(p.profile_picture_key)))
    .map((p) => p.id);
  return {
    memoryIds: [...memoryIds].sort(),
    assetKeys: [...assetKeys].sort(),
    memberIds: [...memberIds].sort(),
    portraitVersionIds: [...new Set(portraitVersionIds)].sort(),
    textMemoryIds: [...textMemoryIds].sort(),
  };
}

type FrameLike = { memoryId: string | null; key: string; previewKey: string | null; pairKey?: string | null; kind: string };
type SceneLike = import('./year-film-script.ts').FilmScene;
type FilmScriptLike = import('./year-film-script.ts').FilmScript;
