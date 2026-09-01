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
import { buildMemoryFeature, buildTaggedMemberFeatures, computeMemoryEligibility, isPrintable } from './eligibility';
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
  buildSpecialSegmentTitlesByMonth,
  computeAgeYearBirthdayMonths,
  flagSpecialBackboneSegments,
  suppressSurvivingBirthdaySpecialTitles,
} from './backbone';
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

  const features = new Map<string, MemoryFeature>();
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
  const backboneSegments = buildBackboneSegments(backboneInput);
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
  const firstsMemoryIds = [...features.values()]
    .filter((f) => f.milestones.length > 0)
    .map((f) => f.id);
  const firstsCount = firstsMemoryIds.length;
  const firstsPresent = firstsCount >= FIRSTS_MIN_MILESTONES;

  // ── birthday spreads (data-driven: any memory with a birthday milestone) ─
  const birthdayMemoryIdsByAge = new Map<number, string[]>();
  for (const f of features.values()) {
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
    throughTheYearsCount: context.portraitVersions.length,
    specialSegments: originalSpecialFlags,
    configuredLanguage: context.configuredLanguage,
    languageEvidenceCaptions: context.languageEvidenceCaptions,
  };

  const systemPrompt = buildOutlineSystemPrompt();
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
  const validMilestoneKeys = new Set(
    [...features.values()].flatMap((f) => f.milestones.map((m) => `${f.id}::${m.milestoneId}`)),
  );

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

  const finalPlacement = birthdayDissolve.placementByMemory;

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
    const memoryIds = finalBySpread.get(spread.candidateId) ?? [];
    if (memoryIds.length === 0) continue;
    themedSpreads.push({
      candidateId: spread.candidateId,
      candidateKind: spread.candidateKind,
      title: spread.title,
      titleMode: spread.titleMode,
      titleSourceMemoryId: spread.titleSourceMemoryId,
      memoryIds,
      insertAfterFinalSegmentIndex: Math.min(Math.max(spread.insertAfterSegmentIndex, -1), finalBackboneSegments.length - 1),
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
  });

  violations.push(
    ...reassignments.map((r) => ({ kind: 'single_placement_reassignment', detail: `${r.memoryId}: kept in ${r.keptIn}` })),
    ...themedDissolve.dissolvedSpreadIds.map((id) => ({ kind: 'themed_spread_dissolved', detail: id })),
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
