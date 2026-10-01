import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MemberActionSheet, type MemberActionSheetProps } from '@/components/member-action-sheet';

function renderSheet(props: MemberActionSheetProps) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <MemberActionSheet {...props} />
    </SafeAreaProvider>,
  );
}

describe('MemberActionSheet', () => {
  it('offers "Make manager" for a viewer and calls onPromote', () => {
    const onPromote = jest.fn();
    const onDemote = jest.fn();
    const { getByTestId, getByText, queryByTestId } = renderSheet({
      memberName: 'Ana',
      memberRole: 'viewer',
      onClose: jest.fn(),
      onDemote,
      onPromote,
      onRemove: jest.fn(),
      visible: true,
    });

    expect(getByText('Ana')).toBeTruthy();
    expect(getByText('Viewer')).toBeTruthy();
    expect(
      getByText('Managers can add memories, edit anything, and invite family. Viewers can browse, like, and comment.'),
    ).toBeTruthy();
    expect(getByTestId('member-action-promote')).toBeTruthy();
    expect(queryByTestId('member-action-demote')).toBeNull();

    fireEvent.press(getByTestId('member-action-promote'));
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onDemote).not.toHaveBeenCalled();
  });

  it('offers "Make viewer" for a manager and calls onDemote', () => {
    const onPromote = jest.fn();
    const onDemote = jest.fn();
    const { getByTestId, queryByTestId } = renderSheet({
      memberName: 'Dana',
      memberRole: 'manager',
      onClose: jest.fn(),
      onDemote,
      onPromote,
      onRemove: jest.fn(),
      visible: true,
    });

    expect(getByTestId('member-action-demote')).toBeTruthy();
    expect(queryByTestId('member-action-promote')).toBeNull();

    fireEvent.press(getByTestId('member-action-demote'));
    expect(onDemote).toHaveBeenCalledTimes(1);
    expect(onPromote).not.toHaveBeenCalled();
  });

  it('calls onRemove when "Remove from family" is pressed', () => {
    const onRemove = jest.fn();
    const { getByTestId } = renderSheet({
      memberName: 'Ana',
      memberRole: 'viewer',
      onClose: jest.fn(),
      onDemote: jest.fn(),
      onPromote: jest.fn(),
      onRemove,
      visible: true,
    });

    fireEvent.press(getByTestId('member-action-remove'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('calls onClose from the Cancel row', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderSheet({
      memberName: 'Ana',
      memberRole: 'viewer',
      onClose,
      onDemote: jest.fn(),
      onPromote: jest.fn(),
      onRemove: jest.fn(),
      visible: true,
    });

    fireEvent.press(getByTestId('member-action-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('link actions', () => {
    const base: MemberActionSheetProps = {
      memberName: 'Ana',
      memberRole: 'viewer',
      onClose: jest.fn(),
      onDemote: jest.fn(),
      onPromote: jest.fn(),
      onRemove: jest.fn(),
      visible: true,
    };

    it('shows no link actions by default', () => {
      const { queryByTestId } = renderSheet(base);

      expect(queryByTestId('member-action-link')).toBeNull();
      expect(queryByTestId('member-action-change-person')).toBeNull();
      expect(queryByTestId('member-action-unlink-person')).toBeNull();
    });

    it('offers "Link to a person…" for an unlinked account', () => {
      const onLinkPerson = jest.fn();
      const { getByTestId, getByText, queryByTestId } = renderSheet({ ...base, onLinkPerson });

      expect(getByText('Link to a person…')).toBeTruthy();
      expect(queryByTestId('member-action-change-person')).toBeNull();
      fireEvent.press(getByTestId('member-action-link'));
      expect(onLinkPerson).toHaveBeenCalledTimes(1);
    });

    it('offers "Change person…" and "Unlink person" for a linked account and names the person', () => {
      const onChangePerson = jest.fn();
      const onUnlinkPerson = jest.fn();
      const { getByTestId, getByText, queryByTestId } = renderSheet({
        ...base,
        linkedPersonName: 'Grandma Ana',
        onChangePerson,
        onUnlinkPerson,
      });

      expect(getByText('This is Grandma Ana')).toBeTruthy();
      expect(queryByTestId('member-action-link')).toBeNull();
      fireEvent.press(getByTestId('member-action-change-person'));
      fireEvent.press(getByTestId('member-action-unlink-person'));
      expect(onChangePerson).toHaveBeenCalledTimes(1);
      expect(onUnlinkPerson).toHaveBeenCalledTimes(1);
    });

    it('shows link actions without role/remove actions when management is off', () => {
      const { getByTestId, queryByTestId } = renderSheet({
        ...base,
        onLinkPerson: jest.fn(),
        showManagementActions: false,
      });

      expect(getByTestId('member-action-link')).toBeTruthy();
      expect(queryByTestId('member-action-promote')).toBeNull();
      expect(queryByTestId('member-action-remove')).toBeNull();
    });

    it('keeps role and remove actions alongside link actions when management is on', () => {
      const { getByTestId } = renderSheet({ ...base, onLinkPerson: jest.fn() });

      expect(getByTestId('member-action-link')).toBeTruthy();
      expect(getByTestId('member-action-promote')).toBeTruthy();
      expect(getByTestId('member-action-remove')).toBeTruthy();
    });
  });
});
