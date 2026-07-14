import { act, renderHook } from '@testing-library/react-native';

import { useAutoMemoryTags } from '@/hooks/useAutoMemoryTags';

const members = [
  { id: 'mara-id', name: 'Mara', nicknames: ['Marita'] },
  { id: 'enzo-id', name: 'Enzo' },
];

describe('useAutoMemoryTags integration', () => {
  it('auto-adds tags when enabled and content mentions a nickname', () => {
    const { result } = renderHook(() => useAutoMemoryTags({ members, enabled: true }));

    act(() => {
      result.current.applyForContent('Marita refused oatmeal');
    });

    expect(result.current.selectedMemberIds).toEqual(['mara-id']);
  });

  it('reports the full selection when auto-tagging crosses the illustration limit', () => {
    const manyMembers = Array.from({ length: 7 }, (_, index) => ({
      id: `member-${index}`,
      name: `Person ${index}`,
    }));
    const onSelectedMemberIdsChange = jest.fn();
    const { result } = renderHook(() => useAutoMemoryTags({
      members: manyMembers,
      enabled: true,
      onSelectedMemberIdsChange,
    }));

    act(() => {
      result.current.applyForContent(manyMembers.map((member) => member.name).join(' and '));
    });

    expect(result.current.selectedMemberIds).toEqual(
      manyMembers.map((member) => member.id),
    );
    expect(onSelectedMemberIdsChange).toHaveBeenLastCalledWith(
      manyMembers.map((member) => member.id),
    );
  });

  it('does not auto-add when disabled', () => {
    const { result } = renderHook(() => useAutoMemoryTags({ members, enabled: false }));

    act(() => {
      result.current.applyForContent('Marita refused oatmeal');
    });

    expect(result.current.selectedMemberIds).toEqual([]);
  });

  it('respects manual untag suppression while typing', () => {
    const { result } = renderHook(() => useAutoMemoryTags({ members, enabled: true }));

    act(() => {
      result.current.applyForContent('Marita refused oatmeal');
    });

    act(() => {
      result.current.toggleMember('mara-id');
    });

    act(() => {
      result.current.applyForContent('Marita still refused oatmeal');
    });

    expect(result.current.selectedMemberIds).toEqual([]);
    expect(result.current.suppressedMemberIds).toEqual(['mara-id']);
  });

  it('applyVoiceResult resets suppression and sets voice mentions', () => {
    const { result } = renderHook(() => useAutoMemoryTags({ members, enabled: true }));

    act(() => {
      result.current.applyForContent('Marita refused oatmeal');
      result.current.toggleMember('mara-id');
    });

    act(() => {
      result.current.applyVoiceResult({
        cleanedText: 'Enzo spilled oatmeal',
        mentionedMemberIds: ['enzo-id'],
      });
    });

    expect(result.current.selectedMemberIds).toEqual(['enzo-id']);
    expect(result.current.suppressedMemberIds).toEqual([]);
  });

  it('applyVoiceResult keeps every unique mentioned member', () => {
    const { result } = renderHook(() => useAutoMemoryTags({ members, enabled: true }));
    const mentionedMemberIds = Array.from({ length: 8 }, (_, index) => `member-${index}`);

    act(() => {
      result.current.applyVoiceResult({
        cleanedText: 'The whole family gathered together',
        mentionedMemberIds: [...mentionedMemberIds, mentionedMemberIds[0]],
      });
    });

    expect(result.current.selectedMemberIds).toEqual(mentionedMemberIds);
  });

  it('auto-adds after enabled flips on for edit-style flow', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useAutoMemoryTags({ members, enabled }),
      { initialProps: { enabled: false } },
    );

    act(() => {
      result.current.applyForContent('Marita refused oatmeal');
    });

    expect(result.current.selectedMemberIds).toEqual([]);

    rerender({ enabled: true });

    act(() => {
      result.current.applyForContent('Marita refused oatmeal');
    });

    expect(result.current.selectedMemberIds).toEqual(['mara-id']);
  });

  it('initializeTags loads saved tags without auto-inference', () => {
    const { result } = renderHook(() => useAutoMemoryTags({ members, enabled: false }));

    act(() => {
      result.current.initializeTags(['enzo-id']);
    });

    expect(result.current.selectedMemberIds).toEqual(['enzo-id']);
  });
});
