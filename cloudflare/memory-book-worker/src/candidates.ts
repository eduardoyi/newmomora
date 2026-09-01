/**
 * Spread-candidate generation (topic / people-pair / emotion), ported from
 * supabase/scripts/eval-memory-book-outline.ts (selectThemedCandidates,
 * selectTopicCandidatesWithSparseFallback, selectPeoplePairCandidates,
 * selectEmotionCandidates, and the *ToUnified mappers) -- same thresholds,
 * same tie-break rules. See eligibility.ts's header comment for why this is
 * a faithful duplicate rather than a `_shared/` extraction.
 */
import { TOPICS } from '../../../supabase/functions/_shared/memory-topics.ts';
import type { Candidate } from '../../../supabase/functions/_shared/memory-book-outline.ts';

export const TOPIC_PAGE_TITLES = new Map(TOPICS.map((t) => [t.id, t.pageTitle]));

export interface ThemedCandidate {
  topicId: string;
  pageTitle: string;
  memoryIds: string[];
}

const DEFAULT_TOPIC_MIN_COUNT = 4;
const SPARSE_TOPIC_TRIGGER_COUNT = 3;
const SPARSE_TOPIC_MIN_COUNT = 3;

export function selectThemedCandidates(
  topicMemberships: Array<{ memoryId: string; topics: string[] }>,
  topicPageTitles: Map<string, string>,
  minCount = DEFAULT_TOPIC_MIN_COUNT,
): ThemedCandidate[] {
  const byTopic = new Map<string, string[]>();
  for (const { memoryId, topics } of topicMemberships) {
    for (const topicId of topics) {
      const list = byTopic.get(topicId) ?? [];
      list.push(memoryId);
      byTopic.set(topicId, list);
    }
  }
  const candidates: ThemedCandidate[] = [];
  for (const [topicId, memoryIds] of byTopic) {
    if (memoryIds.length >= minCount) {
      candidates.push({ topicId, pageTitle: topicPageTitles.get(topicId) ?? topicId, memoryIds });
    }
  }
  return candidates.sort((a, b) => b.memoryIds.length - a.memoryIds.length || a.topicId.localeCompare(b.topicId));
}

/** Drops the topic-candidate threshold from 4 to 3 when the primary pass
 * yields fewer than 3 topic candidates -- a sparse-archive fallback so a
 * thin window still gets some themed variety. */
export function selectTopicCandidatesWithSparseFallback(
  topicMemberships: Array<{ memoryId: string; topics: string[] }>,
  topicPageTitles: Map<string, string>,
  primaryMinCount = DEFAULT_TOPIC_MIN_COUNT,
  sparseTriggerCount = SPARSE_TOPIC_TRIGGER_COUNT,
  sparseMinCount = SPARSE_TOPIC_MIN_COUNT,
): ThemedCandidate[] {
  const primary = selectThemedCandidates(topicMemberships, topicPageTitles, primaryMinCount);
  if (primary.length < sparseTriggerCount) {
    return selectThemedCandidates(topicMemberships, topicPageTitles, sparseMinCount);
  }
  return primary;
}

export interface PeoplePairCandidate {
  memberId: string;
  memberName: string;
  memoryIds: string[];
}

const PEOPLE_PAIR_MIN_COUNT = 4;
const PEOPLE_PAIR_CAP = 3;

export function selectPeoplePairCandidates(
  coTagMemberships: Array<{ memoryId: string; coTaggedMemberIds: string[] }>,
  memberNamesById: Map<string, string>,
  minCount = PEOPLE_PAIR_MIN_COUNT,
  cap = PEOPLE_PAIR_CAP,
): PeoplePairCandidate[] {
  const byMember = new Map<string, string[]>();
  for (const { memoryId, coTaggedMemberIds } of coTagMemberships) {
    for (const memberId of coTaggedMemberIds) {
      const list = byMember.get(memberId) ?? [];
      list.push(memoryId);
      byMember.set(memberId, list);
    }
  }
  const candidates: PeoplePairCandidate[] = [];
  for (const [memberId, memoryIds] of byMember) {
    if (memoryIds.length >= minCount) {
      candidates.push({ memberId, memberName: memberNamesById.get(memberId) ?? memberId, memoryIds });
    }
  }
  return candidates
    .sort((a, b) => b.memoryIds.length - a.memoryIds.length || a.memberId.localeCompare(b.memberId))
    .slice(0, cap);
}

export interface EmotionCandidate {
  emotion: 'funny' | 'tender';
  memoryIds: string[];
}

const EMOTION_SPREAD_TARGETS: ReadonlyArray<'funny' | 'tender'> = ['funny', 'tender'];
const EMOTION_SPREAD_MIN_COUNT = 4;

export function selectEmotionCandidates(
  memoryEmotions: Array<{ memoryId: string; emotion: string | null }>,
  targets = EMOTION_SPREAD_TARGETS,
  minCount = EMOTION_SPREAD_MIN_COUNT,
): EmotionCandidate[] {
  const byEmotion = new Map<'funny' | 'tender', string[]>();
  for (const { memoryId, emotion } of memoryEmotions) {
    if (!emotion) continue;
    const normalized = emotion === 'mischief' ? 'funny' : emotion;
    if (!targets.includes(normalized as 'funny' | 'tender')) continue;
    const key = normalized as 'funny' | 'tender';
    const list = byEmotion.get(key) ?? [];
    list.push(memoryId);
    byEmotion.set(key, list);
  }
  const candidates: EmotionCandidate[] = [];
  for (const [emotion, memoryIds] of byEmotion) {
    if (memoryIds.length >= minCount) candidates.push({ emotion, memoryIds });
  }
  return candidates.sort((a, b) => b.memoryIds.length - a.memoryIds.length || a.emotion.localeCompare(b.emotion));
}

export function topicCandidatesToUnified(candidates: ThemedCandidate[]): Candidate[] {
  return candidates.map((c) => ({
    id: `topic:${c.topicId}`,
    kind: 'topic',
    defaultTitle: c.pageTitle,
    memoryIds: c.memoryIds,
  }));
}

export function peoplePairCandidatesToUnified(candidates: PeoplePairCandidate[]): Candidate[] {
  return candidates.map((c) => ({
    id: `people:${c.memberId}`,
    kind: 'people-pair',
    defaultTitle: `With ${c.memberName}`,
    memoryIds: c.memoryIds,
  }));
}

const EMOTION_DEFAULT_TITLES: Record<'funny' | 'tender', string> = {
  funny: 'The funny ones',
  tender: 'The tender ones',
};

export function emotionCandidatesToUnified(candidates: EmotionCandidate[]): Candidate[] {
  return candidates.map((c) => ({
    id: `emotion:${c.emotion}`,
    kind: 'emotion',
    defaultTitle: EMOTION_DEFAULT_TITLES[c.emotion],
    memoryIds: c.memoryIds,
  }));
}
