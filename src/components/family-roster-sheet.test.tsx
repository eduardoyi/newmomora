import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FamilyRosterSheet } from './family-roster-sheet';
import type { FamilyMember } from '@/services/family-members';

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

function createMember(
  id: string,
  name: string,
  overrides: Partial<FamilyMember> = {},
): FamilyMember {
  return {
    additional_info: null,
    created_at: '2026-05-29T00:00:00.000Z',
    date_of_birth: null,
    gender: null,
    id,
    illustrated_profile_key: null,
    illustrated_profile_status: 'ready',
    is_user_profile: false,
    name,
    nicknames: null,
    profile_picture_key: null,
    updated_at: '2026-05-29T00:00:00.000Z',
    user_id: 'user-1',
    ...overrides,
  };
}

describe('FamilyRosterSheet', () => {
  it('renders every family member and preserves selected state', () => {
    const members = [
      createMember('enzo-id', 'Enzo', { additional_info: 'Son' }),
      createMember('mara-id', 'Mara'),
      createMember('adriana-id', 'Adriana'),
      createMember('leo-id', 'Leo'),
    ];

    const { getByTestId, getByText, queryByText } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <FamilyRosterSheet
          members={members}
          onClose={jest.fn()}
          onToggleMember={jest.fn()}
          selectedMemberIds={['mara-id']}
          visible
        />
      </SafeAreaProvider>,
    );

    expect(getByText('Enzo')).toBeTruthy();
    expect(getByText('Mara')).toBeTruthy();
    expect(getByText('Adriana')).toBeTruthy();
    expect(getByText('Leo')).toBeTruthy();
    expect(queryByText('Son')).toBeNull();
    expect(getByTestId('roster-member-mara-id').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('roster-keyboard-avoiding-view')).toBeTruthy();
  });
});
