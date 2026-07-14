import { render } from '@testing-library/react-native';

import { MemoryTagPicker } from '@/components/memory-tag-picker';
import type { FamilyMember } from '@/services/family-members';

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

jest.mock('@/components/family-roster-sheet', () => ({
  FamilyRosterSheet: () => null,
}));

function createMember(id: string, name: string): FamilyMember {
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
  };
}

const members = [
  createMember('member-1', 'Emma'),
  createMember('member-2', 'Avery'),
];

describe('MemoryTagPicker', () => {
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
});
