import { describe, expect, it } from 'vitest';
import {
  emotionCandidatesToUnified,
  peoplePairCandidatesToUnified,
  selectEmotionCandidates,
  selectPeoplePairCandidates,
  selectThemedCandidates,
  selectTopicCandidatesWithSparseFallback,
  topicCandidatesToUnified,
} from '../src/candidates';

describe('selectThemedCandidates', () => {
  it('only keeps topics reaching the minimum count, sorted by size desc', () => {
    const memberships = [
      { memoryId: 'a', topics: ['beach'] },
      { memoryId: 'b', topics: ['beach'] },
      { memoryId: 'c', topics: ['beach'] },
      { memoryId: 'd', topics: ['beach', 'park'] },
      { memoryId: 'e', topics: ['park'] },
    ];
    const titles = new Map([['beach', 'A day at the beach'], ['park', 'Park days']]);
    const result = selectThemedCandidates(memberships, titles);
    expect(result).toEqual([{ topicId: 'beach', pageTitle: 'A day at the beach', memoryIds: ['a', 'b', 'c', 'd'] }]);
  });

  it('sparse fallback drops the threshold to 3 when fewer than 3 topics clear 4', () => {
    const memberships = [
      { memoryId: 'a', topics: ['beach'] },
      { memoryId: 'b', topics: ['beach'] },
      { memoryId: 'c', topics: ['beach'] },
    ];
    const titles = new Map([['beach', 'A day at the beach']]);
    expect(selectTopicCandidatesWithSparseFallback(memberships, titles)).toHaveLength(1);
  });
});

describe('selectPeoplePairCandidates', () => {
  it('requires at least 4 co-tagged memories and caps at the top 3', () => {
    const memberships = [
      { memoryId: '1', coTaggedMemberIds: ['a'] },
      { memoryId: '2', coTaggedMemberIds: ['a'] },
      { memoryId: '3', coTaggedMemberIds: ['a'] },
      { memoryId: '4', coTaggedMemberIds: ['a', 'b'] },
      { memoryId: '5', coTaggedMemberIds: ['b'] },
      { memoryId: '6', coTaggedMemberIds: ['b'] },
      { memoryId: '7', coTaggedMemberIds: ['b'] },
    ];
    const names = new Map([['a', 'Nonna'], ['b', 'Papi']]);
    const result = selectPeoplePairCandidates(memberships, names);
    // Both reach 4 memories -- tie breaks on memberId ascending.
    expect(result.map((r) => r.memberId)).toEqual(['a', 'b']);
  });
});

describe('selectEmotionCandidates', () => {
  it('folds mischief into funny and ignores emotions outside the target set', () => {
    const emotions = [
      { memoryId: '1', emotion: 'mischief' },
      { memoryId: '2', emotion: 'funny' },
      { memoryId: '3', emotion: 'funny' },
      { memoryId: '4', emotion: 'funny' },
      { memoryId: '5', emotion: 'tender' },
      { memoryId: '6', emotion: null },
    ];
    const result = selectEmotionCandidates(emotions);
    expect(result).toEqual([{ emotion: 'funny', memoryIds: ['1', '2', '3', '4'] }]);
  });
});

describe('unified candidate mappers', () => {
  it('produce globally-unique, kind-prefixed ids', () => {
    expect(topicCandidatesToUnified([{ topicId: 'beach', pageTitle: 'Beach', memoryIds: ['a'] }])[0].id).toBe('topic:beach');
    expect(peoplePairCandidatesToUnified([{ memberId: 'x', memberName: 'Nonna', memoryIds: ['a'] }])[0].id).toBe('people:x');
    expect(emotionCandidatesToUnified([{ emotion: 'funny', memoryIds: ['a'] }])[0].id).toBe('emotion:funny');
  });
});
