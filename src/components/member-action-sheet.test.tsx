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
});
