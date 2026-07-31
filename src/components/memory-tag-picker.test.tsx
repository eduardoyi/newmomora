import { fireEvent, render } from '@testing-library/react-native';
import { Keyboard } from 'react-native';

import { MemoryTagPicker } from '@/components/memory-tag-picker';
import type { FamilyMember } from '@/services/family-members';

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

jest.mock('@/components/family-roster-sheet', () => ({
  FamilyRosterSheet: () => null,
}));

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
});
