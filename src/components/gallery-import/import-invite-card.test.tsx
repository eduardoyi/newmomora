import { fireEvent, render } from '@testing-library/react-native';

import { ImportInviteCard } from '@/components/gallery-import/import-invite-card';

describe('ImportInviteCard', () => {
  it('fires onStart from the dedicated CTA', () => {
    const onStart = jest.fn();
    const onDismiss = jest.fn();
    const { getByTestId } = render(<ImportInviteCard onDismiss={onDismiss} onStart={onStart} />);

    fireEvent.press(getByTestId('timeline-gallery-import-start'));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('fires onDismiss from the X button', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(<ImportInviteCard onDismiss={onDismiss} onStart={jest.fn()} />);

    fireEvent.press(getByTestId('timeline-gallery-import-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps the approved "photos only for now" clarification and never says import/upload/scan/library in visible copy', () => {
    const { getByText, queryByText } = render(<ImportInviteCard onDismiss={jest.fn()} onStart={jest.fn()} />);

    expect(getByText('Momora suggests photos only for now.')).toBeTruthy();
    expect(getByText('Look through my photos')).toBeTruthy();

    // Scoped to visible text nodes only -- testIDs like
    // "timeline-gallery-import-start" legitimately contain "import" and are
    // not user-facing copy.
    expect(queryByText(/import|upload|scan|library/i)).toBeNull();
  });
});
