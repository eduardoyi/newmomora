import { act, fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Keyboard } from 'react-native';

import { MemoryTagPicker } from '@/components/memory-tag-picker';
import { resolveFamilyMemberCreationRequest } from '@/lib/family-member-creation-requests';
import type { FamilyMember } from '@/services/family-members';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

const mockRosterProps: { current: { onAddMember?: (name: string) => void } | null } = {
  current: null,
};
jest.mock('@/components/family-roster-sheet', () => ({
  FamilyRosterSheet: (props: { onAddMember?: (name: string) => void }) => {
    mockRosterProps.current = props;
    return null;
  },
}));

const mockedPush = router.push as jest.Mock;

function lastPushedParams(): { name?: string; requestId?: string } {
  const href = mockedPush.mock.calls.at(-1)?.[0] as {
    pathname: string;
    params: { name?: string; requestId?: string };
  };
  expect(href.pathname).toBe('/(app)/add-family-member');
  return href.params;
}

function createMember(
  id: string,
  name: string,
  overrides: Partial<FamilyMember> = {},
): FamilyMember {
  return {
    additional_info: null,
    created_at: '2026-07-14T00:00:00.000Z',
    date_of_birth: null,
    family_id: 'family-1',
    gender: null,
    id,
    illustrated_profile_key: null,
    illustrated_profile_status: 'ready',
    is_user_profile: false,
    name,
    nicknames: [],
    profile_picture_key: null,
    updated_at: '2026-07-14T00:00:00.000Z',
    user_id: 'user-1',
    ...overrides,
  };
}

const members = [
  createMember('member-1', 'Emma'),
  createMember('member-2', 'Avery'),
];

describe('MemoryTagPicker', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    mockedPush.mockClear();
  });

  it('allows unlimited selection when no illustration cap is supplied', () => {
    const screen = render(
      <MemoryTagPicker
        members={members}
        onToggleMember={jest.fn()}
        selectedMemberIds={['member-1']}
      />,
    );

    expect(screen.getByTestId('memory-tag-member-2').props.accessibilityState.disabled).toBe(
      false,
    );
    expect(screen.getByTestId('memory-tag-count').props.children.join('')).toContain('1');
  });

  it('disables additional members at the illustrated-memory cap', () => {
    const screen = render(
      <MemoryTagPicker
        maxSelected={1}
        members={members}
        onToggleMember={jest.fn()}
        selectedMemberIds={['member-1']}
      />,
    );

    expect(screen.getByTestId('memory-tag-member-2').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(screen.getByTestId('memory-tag-count').props.children.join('')).toContain('1/1');
  });

  it('shows a light visual hint for an incomplete (name-only) member', () => {
    const screen = render(
      <MemoryTagPicker
        members={members}
        onToggleMember={jest.fn()}
        selectedMemberIds={[]}
      />,
    );

    // Default fixture members have no DOB/photo -- incomplete by design.
    expect(screen.getByTestId('memory-tag-member-1-incomplete-hint')).toBeTruthy();
  });

  it('shows no hint once a member has both a DOB and a photo', () => {
    const completeMembers = [
      createMember('member-1', 'Emma', {
        date_of_birth: '2022-01-01',
        profile_picture_key: 'user-1/family/member-1/photo.jpg',
      }),
      members[1],
    ];
    const screen = render(
      <MemoryTagPicker
        members={completeMembers}
        onToggleMember={jest.fn()}
        selectedMemberIds={[]}
      />,
    );

    expect(screen.queryByTestId('memory-tag-member-1-incomplete-hint')).toBeNull();
  });

  it('keeps an incomplete member fully selectable -- never disables or blocks tagging', () => {
    const onToggleMember = jest.fn();
    const screen = render(
      <MemoryTagPicker
        members={members}
        onToggleMember={onToggleMember}
        selectedMemberIds={[]}
      />,
    );

    const chip = screen.getByTestId('memory-tag-member-1');
    expect(chip.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(chip);
    expect(onToggleMember).toHaveBeenCalledWith('member-1');
  });

  it('dismisses the editor keyboard before opening the full family roster', () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const screen = render(
      <MemoryTagPicker
        members={[
          ...members,
          createMember('member-3', 'Jordan'),
          createMember('member-4', 'Taylor'),
        ]}
        onToggleMember={jest.fn()}
        selectedMemberIds={[]}
      />,
    );

    fireEvent.press(screen.getByTestId('memory-tag-more'));

    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  describe('adding someone new', () => {
    it('opens the add-person form and tags the created member when it comes back', () => {
      const onToggleMember = jest.fn();
      const screen = render(
        <MemoryTagPicker
          members={members}
          onToggleMember={onToggleMember}
          selectedMemberIds={[]}
        />,
      );

      fireEvent.press(screen.getByTestId('memory-tag-add'));
      const { name, requestId } = lastPushedParams();
      expect(name).toBeUndefined();
      expect(requestId).toEqual(expect.any(String));

      act(() => resolveFamilyMemberCreationRequest(requestId, 'member-new'));
      expect(onToggleMember).toHaveBeenCalledWith('member-new');
    });

    it('pins the created member to the front of the row once it loads', () => {
      const screen = render(
        <MemoryTagPicker
          members={members}
          onToggleMember={jest.fn()}
          selectedMemberIds={[]}
        />,
      );

      fireEvent.press(screen.getByTestId('memory-tag-add'));
      act(() => resolveFamilyMemberCreationRequest(lastPushedParams().requestId, 'member-new'));
      screen.rerender(
        <MemoryTagPicker
          members={[...members, createMember('member-new', 'Grandma Rose')]}
          onToggleMember={jest.fn()}
          selectedMemberIds={['member-new']}
        />,
      );

      // Fallback (unmeasured) layout shows the first three members inline.
      const chipIds = screen
        .getAllByTestId(/^memory-tag-member-/)
        .map((node) => node.props.testID as string)
        .filter((id) => !id.endsWith('-incomplete-hint'));
      expect(chipIds[0]).toBe('memory-tag-member-new');
    });

    it('does not tag the created member when the illustration cap is full', () => {
      const onToggleMember = jest.fn();
      const screen = render(
        <MemoryTagPicker
          maxSelected={1}
          members={members}
          onToggleMember={onToggleMember}
          selectedMemberIds={['member-1']}
        />,
      );

      fireEvent.press(screen.getByTestId('memory-tag-add'));
      act(() => resolveFamilyMemberCreationRequest(lastPushedParams().requestId, 'member-new'));
      expect(onToggleMember).not.toHaveBeenCalled();
    });

    it('ignores a creation that finishes after the picker unmounted', () => {
      const onToggleMember = jest.fn();
      const screen = render(
        <MemoryTagPicker
          members={members}
          onToggleMember={onToggleMember}
          selectedMemberIds={[]}
        />,
      );

      fireEvent.press(screen.getByTestId('memory-tag-add'));
      const { requestId } = lastPushedParams();
      screen.unmount();
      resolveFamilyMemberCreationRequest(requestId, 'member-new');
      expect(onToggleMember).not.toHaveBeenCalled();
    });

    it('shows a labelled add chip when the family is empty', () => {
      const screen = render(
        <MemoryTagPicker members={[]} onToggleMember={jest.fn()} selectedMemberIds={[]} />,
      );

      expect(screen.getByText('Add someone')).toBeTruthy();
    });

    it('drops the inline add chip once members overflow into the roster sheet', () => {
      // Unmeasured fallback shows three chips inline, so four members overflow.
      const screen = render(
        <MemoryTagPicker
          members={[
            ...members,
            createMember('member-3', 'Jordan'),
            createMember('member-4', 'Taylor'),
          ]}
          onToggleMember={jest.fn()}
          selectedMemberIds={[]}
        />,
      );

      expect(screen.getByTestId('memory-tag-more')).toBeTruthy();
      expect(screen.queryByTestId('memory-tag-add')).toBeNull();
      expect(mockRosterProps.current?.onAddMember).toEqual(expect.any(Function));
    });

    it('waits for the roster sheet to close before opening the form with the searched name', () => {
      jest.useFakeTimers();
      render(
        <MemoryTagPicker members={members} onToggleMember={jest.fn()} selectedMemberIds={[]} />,
      );

      act(() => mockRosterProps.current?.onAddMember?.('Grandma Rose'));
      expect(mockedPush).not.toHaveBeenCalled();

      act(() => {
        jest.runAllTimers();
      });
      expect(lastPushedParams().name).toBe('Grandma Rose');
    });
  });
});
