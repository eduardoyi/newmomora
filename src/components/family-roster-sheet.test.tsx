import { act, render } from '@testing-library/react-native';
import { Keyboard, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  FamilyRosterSheet,
  getRosterBottomPadding,
  getRosterKeyboardAvoidingBehavior,
} from './family-roster-sheet';
import { spacing } from '@/constants/theme';
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
  afterEach(() => {
    jest.restoreAllMocks();
  });

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
    expect(getByTestId('roster-member-enzo-id').props.accessibilityState.disabled).toBe(false);
    expect(getByText('1 tagged')).toBeTruthy();
    expect(getByTestId('roster-keyboard-avoiding-view')).toBeTruthy();
  });

  it('uses stable flex sizing and only enables Android height avoidance while typing', () => {
    const { getByTestId } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <FamilyRosterSheet
          members={[createMember('enzo-id', 'Enzo')]}
          onClose={jest.fn()}
          onToggleMember={jest.fn()}
          selectedMemberIds={[]}
          visible
        />
      </SafeAreaProvider>,
    );
    const listStyle = StyleSheet.flatten(getByTestId('roster-member-list').props.style);

    expect(getRosterKeyboardAvoidingBehavior('ios', false)).toBe('padding');
    expect(getRosterKeyboardAvoidingBehavior('android', true)).toBe('height');
    expect(getRosterKeyboardAvoidingBehavior('android', false)).toBeUndefined();
    expect(listStyle.flexShrink).toBe(1);
    expect(listStyle.maxHeight).toBeUndefined();
  });

  it('removes the safe-area gap while typing and restores it after keyboard close', () => {
    const keyboardListeners: Record<string, () => void> = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
      keyboardListeners[event] = listener as () => void;
      return { remove: jest.fn() } as never;
    });
    const { getByTestId } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <FamilyRosterSheet
          members={[createMember('enzo-id', 'Enzo')]}
          onClose={jest.fn()}
          onToggleMember={jest.fn()}
          selectedMemberIds={[]}
          visible
        />
      </SafeAreaProvider>,
    );

    expect(getRosterBottomPadding(34, false)).toBe(34);
    expect(StyleSheet.flatten(getByTestId('roster-sheet').props.style).paddingBottom).toBe(34);

    act(() => keyboardListeners.keyboardDidShow());
    expect(StyleSheet.flatten(getByTestId('roster-sheet').props.style).paddingBottom).toBe(
      spacing.md,
    );

    act(() => keyboardListeners.keyboardDidHide());
    expect(StyleSheet.flatten(getByTestId('roster-sheet').props.style).paddingBottom).toBe(34);
  });

  it('disables unselected rows when an illustrated-memory cap is reached', () => {
    const members = [createMember('enzo-id', 'Enzo'), createMember('mara-id', 'Mara')];

    const { getByTestId, getByText } = render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <FamilyRosterSheet
          maxSelected={1}
          members={members}
          onClose={jest.fn()}
          onToggleMember={jest.fn()}
          selectedMemberIds={['mara-id']}
          visible
        />
      </SafeAreaProvider>,
    );

    expect(getByTestId('roster-member-enzo-id').props.accessibilityState.disabled).toBe(true);
    expect(getByText('1 of 1')).toBeTruthy();
  });
});
