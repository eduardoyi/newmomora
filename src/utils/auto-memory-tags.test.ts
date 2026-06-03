import {
  applyAutoMemoryTags,
  memberIdArraysEqual,
  toggleMemoryTag,
} from '@/utils/auto-memory-tags';

const members = [
  { id: 'enzo-id', name: 'Enzo' },
  { id: 'mara-id', name: 'Mara', nicknames: ['Marita'] },
  { id: 'leo-id', name: 'Leo' },
  { id: 'mia-id', name: 'Mia' },
  { id: 'ava-id', name: 'Ava' },
];

describe('auto-memory-tags', () => {
  it('auto-adds mentioned members', () => {
    const next = applyAutoMemoryTags({
      content: 'Marita refused oatmeal',
      members,
      selectedMemberIds: [],
      suppressedMemberIds: [],
    });

    expect(next).toEqual(['mara-id']);
  });

  it('does not re-add suppressed members', () => {
    const next = applyAutoMemoryTags({
      content: 'Marita refused oatmeal',
      members,
      selectedMemberIds: [],
      suppressedMemberIds: ['mara-id'],
    });

    expect(next).toEqual([]);
  });

  it('does not remove tags when mentions disappear', () => {
    const next = applyAutoMemoryTags({
      content: 'plain breakfast',
      members,
      selectedMemberIds: ['mara-id'],
      suppressedMemberIds: [],
    });

    expect(next).toEqual(['mara-id']);
  });

  it('caps at MAX_MEMORY_TAGS', () => {
    const next = applyAutoMemoryTags({
      content: 'Enzo Mara Leo Mia Ava',
      members,
      selectedMemberIds: [],
      suppressedMemberIds: [],
    });

    expect(next).toHaveLength(4);
    expect(next).toEqual(['enzo-id', 'mara-id', 'leo-id', 'mia-id']);
  });

  it('returns same reference when unchanged', () => {
    const selected = ['mara-id'];
    const next = applyAutoMemoryTags({
      content: 'quiet morning',
      members,
      selectedMemberIds: selected,
      suppressedMemberIds: [],
    });

    expect(next).toBe(selected);
  });

  it('toggle off removes selection and suppresses', () => {
    const result = toggleMemoryTag({
      memberId: 'mara-id',
      selectedMemberIds: ['mara-id', 'enzo-id'],
      suppressedMemberIds: [],
      selecting: false,
    });

    expect(result.selectedMemberIds).toEqual(['enzo-id']);
    expect(result.suppressedMemberIds).toEqual(['mara-id']);
  });

  it('toggle off when unselected still suppresses', () => {
    const result = toggleMemoryTag({
      memberId: 'mara-id',
      selectedMemberIds: [],
      suppressedMemberIds: [],
      selecting: false,
    });

    expect(result.selectedMemberIds).toEqual([]);
    expect(result.suppressedMemberIds).toEqual(['mara-id']);
  });

  it('toggle on clears suppression and adds when under cap', () => {
    const result = toggleMemoryTag({
      memberId: 'mara-id',
      selectedMemberIds: ['enzo-id'],
      suppressedMemberIds: ['mara-id'],
      selecting: true,
    });

    expect(result.selectedMemberIds).toEqual(['enzo-id', 'mara-id']);
    expect(result.suppressedMemberIds).toEqual([]);
  });

  it('toggle on at cap is a no-op', () => {
    const selected = ['enzo-id', 'mara-id', 'leo-id', 'mia-id'];
    const result = toggleMemoryTag({
      memberId: 'ava-id',
      selectedMemberIds: selected,
      suppressedMemberIds: [],
      selecting: true,
    });

    expect(result.selectedMemberIds).toBe(selected);
    expect(result.suppressedMemberIds).toEqual([]);
  });

  it('memberIdArraysEqual compares order', () => {
    expect(memberIdArraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(memberIdArraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});
