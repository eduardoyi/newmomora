import { fireEvent, render } from '@testing-library/react-native';

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

describe('FullScreenMediaViewer integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVideoPlayer.playing = true;
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'user/memory/photo.jpg': 'https://example.com/photo.jpg',
        'user/memory/video.mp4': 'https://example.com/video.mp4',
      },
    } as ReturnType<typeof useMediaUrls>);
  });

  it('resolves private media, starts at the tapped item, pages, and closes', () => {
    const onClose = jest.fn();
    const { getByTestId, getByText } = render(
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

    fireEvent(getByTestId('full-screen-media-scroll'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: 0, y: 0 } },
    });
    expect(getByText('1 / 2')).toBeTruthy();

    fireEvent.press(getByTestId('full-screen-media-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a direct illustration URI without a page counter', () => {
    const { getByTestId, queryByTestId } = render(
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
});
