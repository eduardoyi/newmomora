import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LinkPersonSheet, type LinkPersonSheetProps } from '@/components/link-person-sheet';
import type { FamilyMember } from '@/services/family-members';

jest.mock('@/components/family-member-avatar', () => ({
  FamilyMemberAvatar: () => null,
}));

function person(id: string, name: string, overrides: Partial<FamilyMember> = {}): FamilyMember {
  return {
    id,
    name,
    relationship: 'aunt_uncle',
    date_of_birth: '1975-01-01',
    ...overrides,
  } as FamilyMember;
}

const members = [
  person('ana', 'Grandma Ana', { relationship: 'grandparent' }),
  person('bo', 'Uncle Bo'),
  person('cy', 'Cy'),
  person('kid', 'Kiddo', { relationship: 'child', date_of_birth: '2021-01-01' }),
  person('rex', 'Rex', { relationship: 'pet', date_of_birth: null }),
  person('baby', 'Baby', { relationship: null, date_of_birth: new Date().toISOString().slice(0, 10) }),
  person('hid', 'Hidden Hal'),
];

function renderSheet(props: LinkPersonSheetProps) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <LinkPersonSheet {...props} />
    </SafeAreaProvider>,
  );
}

const peopleProps = {
  mode: 'people' as const,
  title: 'Who is Dana?',
  visible: true,
  onClose: jest.fn(),
  onSelectPerson: jest.fn(),
  members,
  accountUserId: 'user-dana',
  isMemberHidden: (id: string) => id === 'hid',
  links: [],
};

describe('LinkPersonSheet -- people mode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists only eligible people: no kids, pets, unsorted under-13s, hidden profiles or people held by other accounts', () => {
    const { getByTestId, queryByTestId, getByText } = renderSheet({
      ...peopleProps,
      links: [{ userId: 'user-bo', familyMemberId: 'bo', notInList: false }],
    });

    expect(getByText('Who is Dana?')).toBeTruthy();
    expect(getByTestId('link-person-option-ana')).toBeTruthy();
    expect(getByTestId('link-person-option-cy')).toBeTruthy();
    expect(queryByTestId('link-person-option-bo')).toBeNull();
    expect(queryByTestId('link-person-option-kid')).toBeNull();
    expect(queryByTestId('link-person-option-rex')).toBeNull();
    expect(queryByTestId('link-person-option-baby')).toBeNull();
    expect(queryByTestId('link-person-option-hid')).toBeNull();
  });

  it('shows the account\'s current person as selected and still offers it', () => {
    const { getByTestId } = renderSheet({
      ...peopleProps,
      links: [
        { userId: 'user-dana', familyMemberId: 'ana', notInList: false },
        { userId: 'user-bo', familyMemberId: 'bo', notInList: false },
      ],
    });

    expect(getByTestId('link-person-option-ana').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('link-person-option-cy').props.accessibilityState.selected).toBe(false);
  });

  it('selects a person, but closes instead when the current person is tapped', () => {
    const onSelectPerson = jest.fn();
    const onClose = jest.fn();
    const { getByTestId } = renderSheet({
      ...peopleProps,
      onSelectPerson,
      onClose,
      links: [{ userId: 'user-dana', familyMemberId: 'ana', notInList: false }],
    });

    fireEvent.press(getByTestId('link-person-option-cy'));
    expect(onSelectPerson).toHaveBeenCalledWith('cy');

    fireEvent.press(getByTestId('link-person-option-ana'));
    expect(onSelectPerson).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when nobody is eligible', () => {
    const { getByTestId } = renderSheet({ ...peopleProps, members: [members[3]] });

    expect(getByTestId('link-person-empty')).toBeTruthy();
  });

  it('disables the rows while busy and closes from Cancel', () => {
    const onSelectPerson = jest.fn();
    const onClose = jest.fn();
    const { getByTestId } = renderSheet({ ...peopleProps, isBusy: true, onSelectPerson, onClose });

    fireEvent.press(getByTestId('link-person-option-cy'));
    expect(onSelectPerson).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('link-person-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('LinkPersonSheet -- accounts mode', () => {
  const accounts = [
    { userId: 'user-1', name: 'Rosa', role: 'owner' },
    { userId: 'user-3', name: 'Ana', role: 'viewer' },
  ];

  it('lists accounts by name and role and reports the chosen one', () => {
    const onSelectAccount = jest.fn();
    const { getByTestId, getByText } = renderSheet({
      mode: 'accounts',
      title: 'Which account is Grandma Ana?',
      visible: true,
      onClose: jest.fn(),
      accounts,
      onSelectAccount,
    });

    expect(getByText('Rosa')).toBeTruthy();
    expect(getByText('Owner')).toBeTruthy();
    expect(getByText('Viewer')).toBeTruthy();
    fireEvent.press(getByTestId('link-account-option-user-3'));
    expect(onSelectAccount).toHaveBeenCalledWith('user-3');
  });

  it('shows an empty state with no accounts', () => {
    const { getByTestId } = renderSheet({
      mode: 'accounts',
      title: 'Which account?',
      visible: true,
      onClose: jest.fn(),
      accounts: [],
      onSelectAccount: jest.fn(),
    });

    expect(getByTestId('link-person-empty')).toBeTruthy();
  });
});
