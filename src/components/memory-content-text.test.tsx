import { fireEvent, render } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

import { isOpenableUrl, MemoryContentText, openLink, revealUrl } from './memory-content-text';

describe('MemoryContentText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  it('renders plain text content with no links unchanged', () => {
    const screen = render(
      <MemoryContentText content="Just a regular memory" linkPreviews={{}} testID="content" />,
    );

    expect(screen.getByText('Just a regular memory')).toBeTruthy();
  });

  it('renders a link segment as (label) with parentheses in the tappable span', () => {
    const linkPreviews = {
      'https://example.com': { title: 'Example Site', fetchedAt: '2026-07-01T00:00:00Z' },
    };
    const screen = render(
      <MemoryContentText
        content="Check out https://example.com today"
        linkPreviews={linkPreviews}
        testID="content"
      />,
    );

    expect(screen.getByText('(Example Site)')).toBeTruthy();
  });

  it('falls back to the domain label when no title has been fetched yet', () => {
    const screen = render(
      <MemoryContentText content="See https://www.example.com/page" linkPreviews={{}} testID="content" />,
    );

    expect(screen.getByText('(example.com)')).toBeTruthy();
  });

  it('renders only the first five unique destinations as links', () => {
    const screen = render(
      <MemoryContentText
        content="https://a.com https://b.com https://c.com https://d.com https://e.com https://f.com https://a.com"
        linkPreviews={{}}
        testID="content"
      />,
    );

    expect(screen.getByText('https://f.com ')).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(screen.getAllByText('(a.com)')).toHaveLength(2);
  });

  it('calls Linking.openURL with the raw URL on press', () => {
    const screen = render(
      <MemoryContentText content="Visit https://example.com" linkPreviews={{}} testID="content" />,
    );

    fireEvent.press(screen.getByTestId('content-link-1'));

    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com');
  });

  it('long-press reveals the full URL via an Alert with Open/Cancel actions', () => {
    const screen = render(
      <MemoryContentText
        content="Visit https://example.com"
        linkPreviews={{ 'https://example.com': { title: 'Cute Title', fetchedAt: '2026-07-01T00:00:00Z' } }}
        testID="content"
      />,
    );

    fireEvent(screen.getByTestId('content-link-1'), 'longPress');

    expect(Alert.alert).toHaveBeenCalledWith(
      'Link destination',
      'https://example.com',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Open' }),
      ]),
    );
  });

  it('opening from the reveal alert calls Linking.openURL', () => {
    revealUrl('https://example.com');

    const buttons = (Alert.alert as jest.Mock).mock.calls[0]?.[2] as
      | { text: string; onPress?: () => void }[]
      | undefined;
    buttons?.find((button) => button.text === 'Open')?.onPress?.();

    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com');
  });

  describe('isOpenableUrl', () => {
    it('accepts http(s) URLs', () => {
      expect(isOpenableUrl('https://example.com')).toBe(true);
      expect(isOpenableUrl('http://example.com')).toBe(true);
    });

    it('rejects non-http(s) schemes', () => {
      expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
      expect(isOpenableUrl('data:text/html,hi')).toBe(false);
      expect(isOpenableUrl('not a url')).toBe(false);
    });
  });

  describe('openLink', () => {
    it('does not call Linking.openURL for a non-http(s) URL', async () => {
      await openLink('javascript:alert(1)');

      expect(Linking.openURL).not.toHaveBeenCalled();
      expect(Alert.alert).toHaveBeenCalledWith('Could not open link');
    });

    it('shows an alert (never fails silently) when Linking.openURL rejects', async () => {
      (Linking.openURL as jest.Mock).mockRejectedValueOnce(new Error('no handler'));

      await openLink('https://example.com');

      expect(Alert.alert).toHaveBeenCalledWith('Could not open link');
    });
  });
});
