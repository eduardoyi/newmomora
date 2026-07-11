import { fireEvent, render } from '@testing-library/react-native';

import { MemoryMediaCarousel } from '@/components/memory-media-carousel';
import { useMediaUrls } from '@/hooks/useMediaUrls';

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrls: jest.fn(),
}));

jest.mock('expo-video', () => ({
  useVideoPlayer: jest.fn(() => ({
    pause: jest.fn(),
    play: jest.fn(),
  })),
  VideoView: 'VideoView',
}));

const mockedUseMediaUrls = useMediaUrls as jest.MockedFunction<typeof useMediaUrls>;

const assets = [
  {
    id: 'asset-1',
    memory_id: 'memory-1',
    object_key: 'user/memory/media/photo-1.jpg',
    content_type: 'image/jpeg',
    position: 0,
    created_at: '2026-06-05T00:00:00.000Z',
  },
  {
    id: 'asset-2',
    memory_id: 'memory-1',
    object_key: 'user/memory/media/photo-2.jpg',
    content_type: 'image/jpeg',
    position: 1,
    created_at: '2026-06-05T00:00:00.000Z',
  },
];

describe('MemoryMediaCarousel', () => {
  beforeEach(() => {
    mockedUseMediaUrls.mockReturnValue({
      data: {
        'user/memory/media/photo-1.jpg': 'https://example.com/photo-1.jpg',
        'user/memory/media/photo-2.jpg': 'https://example.com/photo-2.jpg',
      },
    } as ReturnType<typeof useMediaUrls>);
  });

  it('calls onPress for a stationary tap', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={assets} onPress={onPress} />,
    );

    const scrollView = getByTestId('memory-media-carousel-scroll');
    fireEvent(scrollView, 'touchStart', { nativeEvent: { pageX: 20, pageY: 30 } });
    fireEvent(scrollView, 'touchEnd', { nativeEvent: { pageX: 22, pageY: 31 } });

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress for a horizontal drag', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <MemoryMediaCarousel assets={assets} onPress={onPress} />,
    );

    const scrollView = getByTestId('memory-media-carousel-scroll');
    fireEvent(scrollView, 'touchStart', { nativeEvent: { pageX: 20, pageY: 30 } });
    fireEvent(scrollView, 'touchMove', { nativeEvent: { pageX: 70, pageY: 32 } });
    fireEvent(scrollView, 'touchEnd', { nativeEvent: { pageX: 110, pageY: 32 } });

    expect(onPress).not.toHaveBeenCalled();
  });
});
