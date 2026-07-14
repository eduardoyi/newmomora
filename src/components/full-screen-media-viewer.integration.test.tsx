import { fireEvent, render, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FullScreenMediaViewer } from '@/components/full-screen-media-viewer';
import { useMediaUrls } from '@/hooks/useMediaUrls';

const mockVideoPlayer = {
  addListener: jest.fn(() => ({ remove: jest.fn() })),
  removeListener: jest.fn(),
  pause: jest.fn(),
  play: jest.fn(),
  playing: true,
};

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrls: jest.fn(),
}));

jest.mock('expo-video', () => ({
  useVideoPlayer: jest.fn((_source, setup) => {
    setup?.(mockVideoPlayer);
    return mockVideoPlayer;
  }),
  VideoView: 'VideoView',
}));

const mockedUseMediaUrls = useMediaUrls as jest.MockedFunction<typeof useMediaUrls>;
const mockRefetchMediaUrls = jest.fn();
const safeAreaMetrics = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

function renderWithSafeArea(view: ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      {view}
    </SafeAreaProvider>,
  );
}

describe('FullScreenMediaViewer integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVideoPlayer.playing = true;
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'user/memory/photo.jpg': 'https://example.com/photo.jpg',
        'user/memory/video.mp4': 'https://example.com/video.mp4',
      },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);
  });

  it('resolves private media, starts at the tapped item, pages, and closes', () => {
    const onClose = jest.fn();
    const { getByTestId, getByText } = renderWithSafeArea(
      <FullScreenMediaViewer
        initialIndex={1}
        items={[
          {
            id: 'photo',
            contentType: 'image/jpeg',
            objectKey: 'user/memory/photo.jpg',
          },
          {
            id: 'video',
            contentType: 'video/mp4',
            objectKey: 'user/memory/video.mp4',
          },
        ]}
        onClose={onClose}
      />,
    );

    expect(mockedUseMediaUrls).toHaveBeenCalledWith(
      ['user/memory/photo.jpg', 'user/memory/video.mp4'],
      undefined,
    );
    expect(getByText('2 / 2')).toBeTruthy();
    expect(getByTestId('full-screen-media-video')).toBeTruthy();
    expect(mockVideoPlayer.bufferOptions).toEqual({
      preferredForwardBufferDuration: 8,
      maxBufferBytes: 16 * 1024 * 1024,
    });
    expect(
      within(getByTestId('full-screen-media-safe-area-provider'))
        .getByTestId('full-screen-media-close'),
    ).toBeTruthy();

    fireEvent(getByTestId('full-screen-media-scroll'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 0, y: 0 } },
    });
    expect(getByText('1 / 2')).toBeTruthy();

    fireEvent.press(getByTestId('full-screen-media-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a direct illustration URI without a page counter', () => {
    const { getByTestId, queryByTestId } = renderWithSafeArea(
      <FullScreenMediaViewer
        items={[{
          id: 'illustration',
          contentType: 'image/webp',
          uri: 'https://example.com/illustration.webp',
        }]}
        onClose={jest.fn()}
      />,
    );

    expect(getByTestId('full-screen-media-image-illustration')).toBeTruthy();
    expect(queryByTestId('full-screen-media-counter')).toBeNull();
  });

  it('uses an object-key cache identity and refreshes a failed signed image URL', () => {
    const { getByTestId } = renderWithSafeArea(
      <FullScreenMediaViewer
        cacheVersion="version-1"
        items={[{
          id: 'photo',
          contentType: 'image/jpeg',
          objectKey: 'user/memory/photo.jpg',
        }]}
        onClose={jest.fn()}
      />,
    );

    const image = getByTestId('full-screen-media-image-photo');
    expect(image.props.source).toEqual([{
      uri: 'https://example.com/photo.jpg',
      cacheKey: 'user/memory/photo.jpg:version-1',
    }]);
    fireEvent(image, 'error', { nativeEvent: { error: 'expired' } });
    expect(mockRefetchMediaUrls).toHaveBeenCalledTimes(1);
  });
});
