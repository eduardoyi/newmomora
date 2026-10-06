import {
  applyAutoMemoryTags,
  memberIdArraysEqual,
  toggleMemoryTag,
} from '@/utils/auto-memory-tags';

const members = [
  { id: 'tomas-id', name: 'Tomás' },
  { id: 'lucia-id', name: 'Lucía', nicknames: ['Lucita'] },
  { id: 'leo-id', name: 'Leo' },
  { id: 'mia-id', name: 'Mia' },
  { id: 'ava-id', name: 'Ava' },
];

describe('auto-memory-tags', () => {
  it('auto-adds mentioned members', () => {
    const next = applyAutoMemoryTags({
      content: 'Lucita refused oatmeal',
      members,
      selectedMemberIds: [],
      suppressedMemberIds: [],
    });

    expect(next).toEqual(['lucia-id']);
  });

  it('does not re-add suppressed members', () => {
    const next = applyAutoMemoryTags({
      content: 'Lucita refused oatmeal',
      members,
      selectedMemberIds: [],
      suppressedMemberIds: ['lucia-id'],
    });

    expect(next).toEqual([]);
  });

  it('does not remove tags when mentions disappear', () => {
    const next = applyAutoMemoryTags({
      content: 'plain breakfast',
      members,
      selectedMemberIds: ['lucia-id'],
      suppressedMemberIds: [],
    });

    expect(next).toEqual(['lucia-id']);
  });

  it('auto-adds every mentioned member', () => {
    const next = applyAutoMemoryTags({
      content: 'Tomás Lucía Leo Mia Ava',
      members,
      selectedMemberIds: [],
      suppressedMemberIds: [],
    });

    expect(next).toEqual(['tomas-id', 'lucia-id', 'leo-id', 'mia-id', 'ava-id']);
  });

  it('returns same reference when unchanged', () => {
    const selected = ['lucia-id'];
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
      memberId: 'lucia-id',
      selectedMemberIds: ['lucia-id', 'tomas-id'],
      suppressedMemberIds: [],
      selecting: false,
    });

    expect(result.selectedMemberIds).toEqual(['tomas-id']);
    expect(result.suppressedMemberIds).toEqual(['lucia-id']);
  });

  it('toggle off when unselected still suppresses', () => {
    const result = toggleMemoryTag({
      memberId: 'lucia-id',
      selectedMemberIds: [],
      suppressedMemberIds: [],
      selecting: false,
    });

    expect(result.selectedMemberIds).toEqual([]);
    expect(result.suppressedMemberIds).toEqual(['lucia-id']);
  });

  it('toggle on clears suppression and adds the member', () => {
    const result = toggleMemoryTag({
      memberId: 'lucia-id',
      selectedMemberIds: ['tomas-id'],
      suppressedMemberIds: ['lucia-id'],
      selecting: true,
    });

    expect(result.selectedMemberIds).toEqual(['tomas-id', 'lucia-id']);
    expect(result.suppressedMemberIds).toEqual([]);
  });

  it('toggle on has no global tag cap', () => {
    const selected = ['tomas-id', 'lucia-id', 'leo-id', 'mia-id'];
    const result = toggleMemoryTag({
      memberId: 'ava-id',
      selectedMemberIds: selected,
      suppressedMemberIds: [],
      selecting: true,
    });

    expect(result.selectedMemberIds).toEqual([...selected, 'ava-id']);
    expect(result.suppressedMemberIds).toEqual([]);
  });

  it('memberIdArraysEqual compares order', () => {
    expect(memberIdArraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(memberIdArraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});
