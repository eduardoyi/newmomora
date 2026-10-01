/**
 * Orchestrates one outline curation pass: eligibility -> features ->
 * candidates -> backbone segmentation -> the shared outline prompt/parse ->
 * single-placement + dissolve -> the final reading order. Ports the
 * relevant pieces of supabase/scripts/eval-memory-book-outline.ts's
 * `main()` (see eligibility.ts/candidates.ts/backbone.ts/reading-order.ts
 * for the individual ported functions this composes, and each of those
 * files' header comments for the documented V5a simplifications).
 */
import {
  buildOutlineRequestBody,
  buildOutlineSystemPrompt,
  buildOutlineUserPrompt,
  FIRSTS_MIN_MILESTONES,
  parseOutlineResponse,
  verifyQuoteTitles,
  type Candidate,
  type MemoryFeature,
  type OpenAiUsage,
  type OutlineIntegrityViolation,
  type OutlineSkeletonSummaryInput,
  type ParsedOutlineResponse,
} from '../../../supabase/functions/_shared/memory-book-outline.ts';
import {
  buildMemoryFeature,
  buildTaggedMemberFeatures,
  computeMemoryEligibility,
  isPrintable,
  type MemoryFeatureWithStatus,
} from './eligibility';
import {
  emotionCandidatesToUnified,
  peoplePairCandidatesToUnified,
  selectEmotionCandidates,
  selectPeoplePairCandidates,
  selectTopicCandidatesWithSparseFallback,
  topicCandidatesToUnified,
  TOPIC_PAGE_TITLES,
} from './candidates';
import {
  buildBackboneSegments,
  buildQuarterBlockSegments,
  buildSpecialSegmentTitlesByMonth,
  computeAgeYearBirthdayMonths,
  flagSpecialBackboneSegments,
  suppressSurvivingBirthdaySpecialTitles,
} from './backbone';
import { chapterIndexOfMonth, computeBirthdayMonthsFromDob, resolveChapters, type AgeYearChapter } from './chapters';
import { gateFirstsMilestones, selectMultiYearFirsts } from './firsts';
import {
  admitThemedSpreads,
  capThemedSpreadsPerChapter,
  chapterIndexOfGap,
  computeMedianDate,
  computeThemedSpreadBudget,
  findAnchorSegmentIndex,
  isTimeAnchoredCandidate,
  paceThemedSpreads,
  reassignDissolvedSpreadMembers,
} from './pacing';
import { samplePortraitsForMultiYear } from './portraits';
import {
  buildReadingOrder,
  dissolveSmallThemedSpreads,
  dissolveThinBirthdaySpreads,
  resolveSinglePlacement,
  type PlacementCandidate,
  type ReadingOrderSection,
  type ReadingOrderThemedSpreadInput,
} from './reading-order';
import { subtractOneDay } from '../../../supabase/functions/_shared/memory-book-manifest.ts';
import { callOpenAiChat, DEFAULT_OUTLINE_MODEL } from './openai';
import type { Env, GenerationContextResponse } from './types';

export interface OutlineCounts {
  inWindow: number;
  eligible: number;
  taggedToChild: number;
  untaggedInWindow: number;
  excluded: number;
}

export interface OutlineResult {
  elements: ReadingOrderSection[];
  parsed: ParsedOutlineResponse;
  violations: OutlineIntegrityViolation[];
  features: Map<string, MemoryFeature>;
  usage: OpenAiUsage | null;
  counts: OutlineCounts;
}

const MIN_SPREAD_SIZE = 3;

/**
 * Home chapter of a themed spread (chapter mode): the chapter holding the
 * most members; a tie goes to the chapter of the lower-median member (by
 * date, then id), or -- if that chapter is not among the tied ones -- the
 * tied chapter closest to it (lower index on a further tie).
 */
function pickHomeChapter(members: Array<{ memoryId: string; date: string; chapter: number }>): number {
  const counts = new Map<number, number>();
  for (const m of members) counts.set(m.chapter, (counts.get(m.chapter) ?? 0) + 1);
  const best = Math.max(...counts.values());
  const tied = [...counts.entries()].filter(([, n]) => n === best).map(([chapter]) => chapter).sort((a, b) => a - b);
  if (tied.length === 1) return tied[0];
  const sorted = [...members].sort((a, b) => a.date.localeCompare(b.date) || a.memoryId.localeCompare(b.memoryId));
  const medianChapter = sorted[Math.floor((sorted.length - 1) / 2)].chapter;
  return [...tied].sort((a, b) => Math.abs(a - medianChapter) - Math.abs(b - medianChapter) || a - b)[0];
}

export async function runOutlineStage(env: Env, context: GenerationContextResponse): Promise<OutlineResult> {
  const violations: OutlineIntegrityViolation[] = [];
  const childId = context.child?.id ?? null;

  // ── eligibility + features ──────────────────────────────────────────────
  const mediaByMemory = new Map<string, typeof context.media>();
  for (const row of context.media) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }
  const tagsByMemory = new Map<string, string[]>();
  for (const row of context.tags) {
    const list = tagsByMemory.get(row.memory_id) ?? [];
    list.push(row.family_member_id);
    tagsByMemory.set(row.memory_id, list);
  }
  const milestonesByMemory = new Map<string, typeof context.milestones>();
  for (const row of context.milestones) {
    const list = milestonesByMemory.get(row.memory_id) ?? [];
    list.push(row);
    milestonesByMemory.set(row.memory_id, list);
  }
  const familyMembersById = new Map(context.familyMembers.map((m) => [m.id, m]));

  const isEverything = context.book.scopeKind === 'everything';
  const features = new Map<string, MemoryFeatureWithStatus>();
  const excludedMemoryIds: Array<{ memoryId: string; elementId: string; reason: string }> = [];
  let taggedToChildCount = 0;
  let untaggedInWindowCount = 0;

  for (const memory of context.memories) {
    const taggedMemberIds = tagsByMemory.get(memory.id) ?? [];
    const eligibility = childId ? computeMemoryEligibility(taggedMemberIds, childId) : { eligible: true, taggedToChild: false, untaggedInWindow: taggedMemberIds.length === 0 };
    if (!eligibility.eligible) {
      excludedMemoryIds.push({ memoryId: memory.id, elementId: 'eligibility', reason: 'tagged_to_other_member_only' });
      continue;
    }
    if (eligibility.taggedToChild) taggedToChildCount += 1;
    if (eligibility.untaggedInWindow) untaggedInWindowCount += 1;
    const taggedMembers = buildTaggedMemberFeatures(taggedMemberIds, familyMembersById, memory.memory_date);
    const feature = buildMemoryFeature(
      memory,
      mediaByMemory.get(memory.id) ?? [],
      taggedMemberIds,
      childId ?? '',
      milestonesByMemory.get(memory.id) ?? [],
      context.engagementCounts[memory.id] ?? 0,
      taggedMembers,
    );
    features.set(memory.id, feature);
  }

  // ── backbone (from every eligible+printable memory) ─────────────────────
  const backboneInput = [...features.values()]
    .filter((f) => isPrintable(f))
    .map((f) => ({ id: f.id, date: f.date, printable: true }));
  // Everything (multi-year): one chapter per age-year (only when >= 2 are
  // non-empty -- "chapter mode") and quarter-block backbone segments that
  // never cross a chapter. Every other scope keeps today's call exactly.
  const childDateOfBirth = context.child?.dateOfBirth ?? null;
  const chapters: AgeYearChapter[] = isEverything
    ? resolveChapters(childDateOfBirth, backboneInput.map((m) => m.date.slice(0, 7)))
    : [];
  // Everything: fixed calendar-aligned 3-month blocks (per chapter in chapter
  // mode), clipped to the window -- phase 2b fix A. Other scopes unchanged.
  const backboneSegments = isEverything
    ? buildQuarterBlockSegments(backboneInput, {
      chapters: chapters.length > 0 ? chapters : undefined,
      firstMonth: context.book.windowStart.slice(0, 7),
      lastMonth: subtractOneDay(context.book.windowEndExclusive).slice(0, 7),
    })
    : buildBackboneSegments(backboneInput);
  const defaultBackboneByMemory = new Map<string, string>();
  for (const segment of backboneSegments) {
    for (const id of segment.memoryIds) defaultBackboneByMemory.set(id, `backbone:${segment.id}`);
  }

  // ── special (birth/birthday) segment flags ───────────────────────────────
  const birthMonth = context.child?.dateOfBirth ? context.child.dateOfBirth.slice(0, 7) : null;
  const isAgeYear = context.book.scopeKind === 'age_year';
  let ageYear = 0;
  if (isAgeYear && context.child?.dateOfBirth) {
    ageYear = Number(context.book.windowEndExclusive.slice(0, 4)) - Number(context.child.dateOfBirth.slice(0, 4));
  }
  const birthdayMonthToAge = isAgeYear
    ? computeAgeYearBirthdayMonths(true, ageYear, context.book.windowStart, context.book.windowEndExclusive)
    : isEverything
    // Deterministic from the DOB (never from whether a birthday-milestone
    // memory happens to exist), like the age-year path.
    ? computeBirthdayMonthsFromDob(childDateOfBirth, context.book.windowStart, context.book.windowEndExclusive)
    : (() => {
      const map = new Map<string, number>();
      for (const f of features.values()) {
        if (f.birthdayAgeTurned !== null) map.set(f.date.slice(0, 7), f.birthdayAgeTurned);
      }
      return map;
    })();
  const originalSpecialFlags = flagSpecialBackboneSegments(backboneSegments, birthMonth, birthdayMonthToAge);

  // ── candidate generation ─────────────────────────────────────────────────
  const topicMemberships = [...features.values()].map((f) => ({ memoryId: f.id, topics: f.topics }));
  const themedCandidates = selectTopicCandidatesWithSparseFallback(topicMemberships, TOPIC_PAGE_TITLES);

  const coTagMemberships: Array<{ memoryId: string; coTaggedMemberIds: string[] }> = [];
  if (childId) {
    for (const [memoryId] of features) {
      const taggedIds = tagsByMemory.get(memoryId) ?? [];
      if (!taggedIds.includes(childId)) continue;
      coTagMemberships.push({ memoryId, coTaggedMemberIds: taggedIds.filter((id) => id !== childId) });
    }
  }
  const memberNamesById = new Map(context.familyMembers.map((m) => [m.id, m.name]));
  const peoplePairCandidates = selectPeoplePairCandidates(coTagMemberships, memberNamesById);

  const memoryEmotions = [...features.values()].map((f) => ({ memoryId: f.id, emotion: f.emotion }));
  const emotionCandidates = selectEmotionCandidates(memoryEmotions);

  const candidates: Candidate[] = [
    ...topicCandidatesToUnified(themedCandidates),
    ...peoplePairCandidatesToUnified(peoplePairCandidates),
    ...emotionCandidatesToUnified(emotionCandidates),
  ];

  // ── Firsts (non-birthday milestones) ─────────────────────────────────────
  // Phase 2e owner rule (ALL scopes): a memory is a "first" only with explicit
  // evidence -- a parent-`confirmed` milestone row, or first-time language in
  // the memory's own text. Everything else stays in its backbone section.
  // Everything: then capped to the most meaningful few, chronological (D5);
  // year books keep every qualifying milestone memory.
  const memoryTextById = new Map(context.memories.map((m) => [m.id, m.content]));
  const gatedFirstsFeatures: MemoryFeatureWithStatus[] = [];
  for (const f of features.values()) {
    const gated = gateFirstsMilestones(f.milestones, memoryTextById.get(f.id));
    if (gated.length > 0) gatedFirstsFeatures.push({ ...f, milestones: gated });
  }
  const firstsMemoryIds = isEverything
    ? selectMultiYearFirsts(gatedFirstsFeatures)
    : gatedFirstsFeatures.map((f) => f.id);
  const firstsMemoryIdSet = new Set(firstsMemoryIds);
  // `memoryId::milestoneId` of every milestone row that may be listed as a first.
  const firstsMilestoneKeys = gatedFirstsFeatures
    .filter((f) => firstsMemoryIdSet.has(f.id))
    .flatMap((f) => f.milestones.map((m) => `${f.id}::${m.milestoneId}`));
  const firstsCount = firstsMemoryIds.length;
  const firstsPresent = firstsCount >= FIRSTS_MIN_MILESTONES;

  // ── birthday spreads (data-driven: any memory with a birthday milestone) ─
  // Everything emits NO birthday-N spreads (the renderer's fitter drops them,
  // so their members would never be laid out); those memories stay in their
  // backbone month, which is flagged deterministically above.
  const birthdayMemoryIdsByAge = new Map<number, string[]>();
  for (const f of isEverything ? [] : features.values()) {
    if (f.birthdayAgeTurned === null) continue;
    const list = birthdayMemoryIdsByAge.get(f.birthdayAgeTurned) ?? [];
    list.push(f.id);
    birthdayMemoryIdsByAge.set(f.birthdayAgeTurned, list);
  }

  // ── LLM call ──────────────────────────────────────────────────────────────
  const skeleton: OutlineSkeletonSummaryInput = {
    childName: context.child?.name ?? context.familyName,
    scopeLabel: context.book.scopeLabel,
    windowStart: context.book.windowStart,
    windowLastDay: subtractOneDay(context.book.windowEndExclusive),
    backboneSegments,
    firstsCount,
    birthdaySpreads: [...birthdayMemoryIdsByAge.entries()].map(([ageTurned, ids]) => ({ ageTurned, memoryCount: ids.length })),
    throughTheYearsCount: isEverything
      ? samplePortraitsForMultiYear(
        context.portraitVersions
          .filter((v) => v.reference_date && v.illustrated_profile_key)
          .map((v) => ({ date: v.reference_date as string })),
      ).length
      : context.portraitVersions.length,
    specialSegments: originalSpecialFlags,
    configuredLanguage: context.configuredLanguage,
    languageEvidenceCaptions: context.languageEvidenceCaptions,
    firstsMemoryIds,
    firstsMilestoneKeys,
    ...(isEverything ? { multiYear: true } : {}),
    ...(chapters.length > 0 ? { chapters } : {}),
  };

  const systemPrompt = buildOutlineSystemPrompt({ multiYear: isEverything });
  const userPrompt = buildOutlineUserPrompt(skeleton, candidates, features);
  const requestBody = buildOutlineRequestBody(systemPrompt, userPrompt, DEFAULT_OUTLINE_MODEL);
  const { content, usage } = await callOpenAiChat(env, requestBody);

  const validCandidateIds = new Set(candidates.map((c) => c.id));
  const validSegmentIds = new Set(backboneSegments.map((s) => s.id));
  const validMemoryIds = new Set(features.keys());
  const candidateMembersById = new Map(candidates.map((c) => [c.id, new Set(c.memoryIds)]));
  const candidateDefaultTitleById = new Map(candidates.map((c) => [c.id, c.defaultTitle]));
  const segmentMembersById = new Map(backboneSegments.map((s) => [s.id, new Set(s.memoryIds)]));
  const wideOrientationMemoryIds = new Set(
    [...features.values()].filter((f) => f.photoOrientation?.orientation === 'wide').map((f) => f.id),
  );
  const validMilestoneKeys = new Set(firstsMilestoneKeys);

  let parsedRaw: unknown = {};
  try {
    parsedRaw = JSON.parse(content);
  } catch {
    violations.push({ kind: 'unparseable_outline_json', detail: 'model response was not valid JSON' });
  }

  const { response: parsed, violations: parseViolations } = parseOutlineResponse(
    parsedRaw,
    validCandidateIds,
    validSegmentIds,
    validMemoryIds,
    candidateMembersById,
    candidateDefaultTitleById,
    segmentMembersById,
    wideOrientationMemoryIds,
    validMilestoneKeys,
    context.configuredLanguage,
  );
  violations.push(...parseViolations);

  const contentByMemoryId = new Map(context.memories.map((m) => [m.id, m.content]));
  violations.push(...verifyQuoteTitles(parsed.spreads, contentByMemoryId));

  // ── single placement ──────────────────────────────────────────────────────
  const placementCandidates: PlacementCandidate[] = [];
  for (const memoryId of features.keys()) {
    const backboneId = defaultBackboneByMemory.get(memoryId);
    if (backboneId) placementCandidates.push({ memoryId, spreadId: backboneId });
  }
  if (firstsPresent) {
    for (const memoryId of firstsMemoryIds) placementCandidates.push({ memoryId, spreadId: 'firsts' });
  }
  for (const [ageTurned, ids] of birthdayMemoryIdsByAge) {
    for (const memoryId of ids) placementCandidates.push({ memoryId, spreadId: `birthday-${ageTurned}` });
  }
  const themedSpreadIds = new Set<string>();
  for (const spread of parsed.spreads) {
    themedSpreadIds.add(spread.candidateId);
    for (const memoryId of spread.memoryIds) placementCandidates.push({ memoryId, spreadId: spread.candidateId });
  }

  const { placementByMemory: singlePlacement, reassignments } = resolveSinglePlacement(placementCandidates);

  const themedDissolve = dissolveSmallThemedSpreads(singlePlacement, themedSpreadIds, defaultBackboneByMemory, MIN_SPREAD_SIZE);
  const birthdaySpreadIds = new Set([...birthdayMemoryIdsByAge.keys()].map((age) => `birthday-${age}`));
  const birthdayDissolve = dissolveThinBirthdaySpreads(
    themedDissolve.placementByMemory,
    birthdaySpreadIds,
    defaultBackboneByMemory,
    MIN_SPREAD_SIZE,
  );

  let finalPlacement = birthdayDissolve.placementByMemory;

  // ── Everything: pace, admit (budget + spill) and chapter-cap themed spreads ─
  // Anchor each surviving spread by its members' median month, spread them
  // across the backbone, admit within the page budget (floor(min(eligible,
  // pageBudget)/15)), then cap per chapter. Dissolved members go back to their
  // default backbone segment. The placed gap replaces the AI's own
  // insert_after_segment_index.
  const placedGapBySpreadId = new Map<string, number>();
  const budgetDissolved: Array<{ id: string; reason: string }> = [];
  const chapterDissolved: Array<{ id: string; detail: string }> = [];
  if (isEverything) {
    const survivingSpreads = new Map<string, string[]>();
    for (const spread of parsed.spreads) {
      if (themedDissolve.dissolvedSpreadIds.includes(spread.candidateId)) continue;
      if (survivingSpreads.has(spread.candidateId)) continue;
      const members = [...finalPlacement.entries()]
        .filter(([, spreadId]) => spreadId === spread.candidateId)
        .map(([memoryId]) => memoryId)
        .sort();
      if (members.length > 0) survivingSpreads.set(spread.candidateId, members);
    }

    const segmentChapterIndices = backboneSegments.map((s) => s.chapterIndex ?? 0);
    const lastValidIndex = backboneSegments.length - 1;
    const chapterMode = chapters.length > 0;

    // Chapter mode (phase 2b fix 3): membership is chapter-blind, so pull each
    // spread back into one HOME chapter before placing it. Members outside it
    // return to their own default backbone segment; a spread left with fewer
    // than MIN_SPREAD_SIZE members dissolves entirely.
    const homeChapterBySpreadId = new Map<string, number>();
    if (chapterMode) {
      const memberChapter = (memoryId: string) => chapterIndexOfMonth(chapters, features.get(memoryId)!.date.slice(0, 7));
      const releasedMembers = new Map<string, string[]>();
      for (const [id, members] of [...survivingSpreads.entries()]) {
        const home = pickHomeChapter(members.map((memoryId) => ({ memoryId, date: features.get(memoryId)!.date, chapter: memberChapter(memoryId) })));
        const inHome = members.filter((memoryId) => memberChapter(memoryId) === home);
        const outOfHome = members.filter((memoryId) => memberChapter(memoryId) !== home);
        if (inHome.length < MIN_SPREAD_SIZE) {
          releasedMembers.set(id, members);
          survivingSpreads.delete(id);
          chapterDissolved.push({ id, detail: `${id}: dissolved` });
          continue;
        }
        homeChapterBySpreadId.set(id, home);
        if (outOfHome.length > 0) {
          releasedMembers.set(id, outOfHome);
          survivingSpreads.set(id, inHome);
          chapterDissolved.push({ id, detail: `${id}: ${outOfHome.length} moved` });
        }
      }
      finalPlacement = reassignDissolvedSpreadMembers(finalPlacement, releasedMembers, defaultBackboneByMemory);
    }

    const chapterGapRange = (chapterIndex: number) => {
      const indices = segmentChapterIndices.flatMap((c, i) => (c === chapterIndex ? [i] : []));
      return indices.length > 0 ? { min: indices[0], max: indices[indices.length - 1] } : { min: 0, max: -1 };
    };
    const pacingCandidates = [...survivingSpreads.entries()].map(([id, members]) => {
      const medianMonth = computeMedianDate(members.map((memoryId) => features.get(memoryId)!.date)).slice(0, 7);
      return { id, idealGapIndex: findAnchorSegmentIndex(medianMonth, backboneSegments), anchored: isTimeAnchoredCandidate(id) };
    });
    // paceThemedSpreads is a year-book heuristic that drags spreads to the
    // first uncovered gap -- far from their members in a multi-year book -- so
    // chapter mode skips it and clamps each spread into its home chapter.
    const pacedGapById = chapterMode ? new Map<string, number>() : paceThemedSpreads(backboneSegments.length, pacingCandidates);
    const admission = admitThemedSpreads(
      pacingCandidates.map((c) => ({
        id: c.id,
        memberCount: survivingSpreads.get(c.id)!.length,
        anchorGap: pacedGapById.get(c.id) ?? c.idealGapIndex,
        ...(chapterMode ? { gapRange: chapterGapRange(homeChapterBySpreadId.get(c.id)!) } : {}),
      })),
      lastValidIndex,
      computeThemedSpreadBudget(features.size, context.book.pageBudget),
    );

    const dissolvedMembers = new Map<string, string[]>();
    for (const id of admission.dissolvedIds) {
      dissolvedMembers.set(id, survivingSpreads.get(id) ?? []);
      budgetDissolved.push({ id, reason: 'budget_or_spill' });
    }
    let keptPlacements = [...admission.placedGapById.entries()];
    if (chapters.length > 0) {
      const capped = capThemedSpreadsPerChapter(
        keptPlacements.map(([id, gap]) => ({
          id,
          memberCount: survivingSpreads.get(id)!.length,
          chapterIndex: chapterIndexOfGap(gap, segmentChapterIndices),
        })),
      );
      for (const id of capped.dissolvedIds) {
        dissolvedMembers.set(id, survivingSpreads.get(id) ?? []);
        budgetDissolved.push({ id, reason: 'chapter_cap' });
      }
      const keptIds = new Set(capped.keptIds);
      keptPlacements = keptPlacements.filter(([id]) => keptIds.has(id));
    }
    for (const [id, gap] of keptPlacements) placedGapBySpreadId.set(id, gap);
    finalPlacement = reassignDissolvedSpreadMembers(finalPlacement, dissolvedMembers, defaultBackboneByMemory);
  }

  // ── rebuild final section membership from the resolved placement ────────
  const finalBySpread = new Map<string, string[]>();
  for (const [memoryId, spreadId] of finalPlacement) {
    const list = finalBySpread.get(spreadId) ?? [];
    list.push(memoryId);
    finalBySpread.set(spreadId, list);
  }

  const finalBackboneSegments = backboneSegments.map((segment) => ({
    ...segment,
    memoryIds: (finalBySpread.get(`backbone:${segment.id}`) ?? []).sort(
      (a, b) => (features.get(a)?.date ?? '').localeCompare(features.get(b)?.date ?? ''),
    ),
  }));

  const survivingBirthdayAges = new Set(
    [...birthdayMemoryIdsByAge.keys()].filter((age) => (finalBySpread.get(`birthday-${age}`) ?? []).length > 0),
  );
  const finalSpecialFlags = flagSpecialBackboneSegments(finalBackboneSegments, birthMonth, birthdayMonthToAge);
  const applicableSpecialFlags = suppressSurvivingBirthdaySpecialTitles(finalSpecialFlags, survivingBirthdayAges);
  const specialTitleByMonth = buildSpecialSegmentTitlesByMonth(originalSpecialFlags, parsed.segmentTitles);
  const specialSegmentTitles: Record<string, string> = {};
  for (const flag of applicableSpecialFlags) {
    const title = specialTitleByMonth.get(flag.month);
    if (title) specialSegmentTitles[flag.segmentId] = title;
  }

  const backboneRationale: Record<string, string> = {};
  for (const highlight of parsed.backboneHighlights) {
    for (const [memoryId, reason] of Object.entries(highlight.rationale)) backboneRationale[memoryId] = reason;
  }

  const themedSpreads: ReadingOrderThemedSpreadInput[] = [];
  for (const spread of parsed.spreads) {
    if (themedDissolve.dissolvedSpreadIds.includes(spread.candidateId)) continue;
    if (isEverything && !placedGapBySpreadId.has(spread.candidateId)) continue;
    const memoryIds = finalBySpread.get(spread.candidateId) ?? [];
    if (memoryIds.length === 0) continue;
    themedSpreads.push({
      candidateId: spread.candidateId,
      candidateKind: spread.candidateKind,
      title: spread.title,
      titleMode: spread.titleMode,
      titleSourceMemoryId: spread.titleSourceMemoryId,
      memoryIds,
      insertAfterFinalSegmentIndex: isEverything
        ? placedGapBySpreadId.get(spread.candidateId)!
        : Math.min(Math.max(spread.insertAfterSegmentIndex, -1), finalBackboneSegments.length - 1),
      rationale: spread.rationale,
      kicker: spread.kicker,
    });
  }

  const elements = buildReadingOrder({
    childName: skeleton.childName,
    finalBackboneSegments,
    firsts: firstsPresent
      ? { present: true, title: parsed.firstsTitle, memoryIds: finalBySpread.get('firsts') ?? [], warmNames: parsed.firstsWarmNames }
      : null,
    birthdaySpreads: [...birthdayMemoryIdsByAge.keys()]
      .map((ageTurned) => ({ ageTurned, memoryIds: finalBySpread.get(`birthday-${ageTurned}`) ?? [] }))
      .filter((s) => s.memoryIds.length > 0),
    themedSpreads,
    backboneRationale,
    specialSegmentTitles,
    highlightedMemoryIds: new Set(parsed.backboneHighlights.flatMap((h) => h.memoryIds)),
    ...(isEverything ? { multiYear: true } : {}),
    ...(chapters.length > 0 ? { chapters } : {}),
  });

  violations.push(
    ...reassignments.map((r) => ({ kind: 'single_placement_reassignment', detail: `${r.memoryId}: kept in ${r.keptIn}` })),
    ...themedDissolve.dissolvedSpreadIds.map((id) => ({ kind: 'themed_spread_dissolved', detail: id })),
    ...chapterDissolved.map((d) => ({ kind: 'themed_spread_out_of_chapter', detail: d.detail })),
    ...budgetDissolved.map((d) => ({ kind: 'themed_spread_dissolved_budget', detail: `${d.id}: ${d.reason}` })),
    ...birthdayDissolve.dissolvedAges.map((age) => ({ kind: 'birthday_spread_dissolved', detail: String(age) })),
    ...excludedMemoryIds.map((e) => ({ kind: 'memory_excluded', detail: `${e.memoryId}: ${e.reason}` })),
  );

  const counts: OutlineCounts = {
    inWindow: context.memories.length,
    eligible: features.size,
    taggedToChild: taggedToChildCount,
    untaggedInWindow: untaggedInWindowCount,
    excluded: excludedMemoryIds.length,
  };

  return { elements, parsed, violations, features, usage, counts };
}
