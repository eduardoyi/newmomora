import { act, fireEvent, render, within } from '@testing-library/react-native';
import { createVideoPlayer } from 'expo-video';
import type { ReactElement } from 'react';
import { Dimensions } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FullScreenMediaViewer } from '@/components/full-screen-media-viewer';
import { useMediaUrls } from '@/hooks/useMediaUrls';

const mockVideoPlayer = {
  addListener: jest.fn(() => ({ remove: jest.fn() })),
  removeListener: jest.fn(),
  pause: jest.fn(),
  play: jest.fn(),
  release: jest.fn(),
  replaceAsync: jest.fn(() => Promise.resolve()),
  playing: true,
};

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrls: jest.fn(),
}));

jest.mock('expo-video', () => ({
  createVideoPlayer: jest.fn(() => mockVideoPlayer),
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

  it('swaps the active video source in place (no recreate) when a caption edit refreshes the signed URL, and releases only on unmount', () => {
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/video.mp4': 'https://example.com/video.mp4' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    const items = [{ id: 'video', contentType: 'video/mp4', objectKey: 'user/memory/video.mp4' }];
    const { getByTestId, rerender, unmount } = renderWithSafeArea(
      <FullScreenMediaViewer items={items} onClose={jest.fn()} />,
    );

    expect(getByTestId('full-screen-media-video')).toBeTruthy();
    expect(createVideoPlayer).toHaveBeenCalledTimes(1);

    // Editing a memory's caption bumps cacheVersion, which changes the
    // signed URL for the same object_key while this video stays mounted.
    mockedUseMediaUrls.mockReturnValue({
      data: { 'user/memory/video.mp4': 'https://example.com/video.mp4?refreshed=1' },
      refetch: mockRefetchMediaUrls,
    } as ReturnType<typeof useMediaUrls>);

    rerender(
      <SafeAreaProvider initialMetrics={safeAreaMetrics}>
        <FullScreenMediaViewer items={items} onClose={jest.fn()} />
      </SafeAreaProvider>,
    );

    expect(createVideoPlayer).toHaveBeenCalledTimes(1);
    expect(mockVideoPlayer.release).not.toHaveBeenCalled();
    expect(mockVideoPlayer.replaceAsync).toHaveBeenCalledWith({
      uri: 'https://example.com/video.mp4?refreshed=1',
      useCaching: true,
    });

    unmount();
    expect(mockVideoPlayer.release).toHaveBeenCalledTimes(1);
  });

  describe('pinch to zoom', () => {
    // A 390x844 page frame holding a square (1024x1024) asset: `contain` fits
    // it to the full width, leaving vertical letterboxing.
    const FRAME_WIDTH = 390;
    const FRAME_HEIGHT = 844;
    const PHOTO_ITEM = {
      id: 'photo',
      contentType: 'image/jpeg',
      objectKey: 'user/memory/photo.jpg',
    };
    const SECOND_PHOTO_ITEM = {
      id: 'photo-2',
      contentType: 'image/jpeg',
      objectKey: 'user/memory/photo-2.jpg',
    };

    function renderViewer(initialItems = [PHOTO_ITEM, SECOND_PHOTO_ITEM]) {
      const tree = (items = initialItems) => (
        <SafeAreaProvider initialMetrics={safeAreaMetrics}>
          <FullScreenMediaViewer items={items} onClose={jest.fn()} />
        </SafeAreaProvider>
      );
      const view = render(tree());

      // Layout and natural-size events don't fire on their own in Jest, and
      // both feed the pan clamp.
      fireEvent(view.getByTestId('full-screen-media-image-photo-frame'), 'layout', {
        nativeEvent: { layout: { height: FRAME_HEIGHT, width: FRAME_WIDTH, x: 0, y: 0 } },
      });
      fireEvent(view.getByTestId('full-screen-media-image-photo'), 'load', {
        nativeEvent: { source: { height: 1024, width: 1024 } },
      });

      return {
        ...view,
        // The mocked animated style resolves at render time. Zooming flips
        // React state (paging) and so re-renders on its own, but panning
        // changes nothing React can see -- force a render pass to read it.
        // A fresh element is required: re-rendering the identical one bails out.
        renderAgain: () => view.rerender(tree()),
        renderWithItems: (items: typeof initialItems) => view.rerender(tree(items)),
      };
    }

    // Gesture callbacks flip React state (paging on/off), which the animated
    // style is then read back from, so the whole gesture has to settle inside
    // act() before assertions. The async flush matters too: gesture-handler
    // pushes re-rendered gesture config (the pan's `enabled`) to the native
    // handler in a microtask, so a following gesture only sees it after this.
    async function fireZoomGesture(
      gestureTestId: string,
      events: Parameters<typeof fireGestureHandler>[1],
    ) {
      await act(async () => {
        fireGestureHandler(getByGestureTestId(gestureTestId), events);
      });
    }

    function transformOf(zoomLayer: { props: { style: unknown } }) {
      return (zoomLayer.props.style as { transform?: unknown }[])
        .flat()
        .find((style) => Boolean(style?.transform))?.transform;
    }

    beforeEach(() => {
      mockedUseMediaUrls.mockReturnValue({
        data: {
          'user/memory/photo.jpg': 'https://example.com/photo.jpg',
          'user/memory/photo-2.jpg': 'https://example.com/photo-2.jpg',
        },
        refetch: mockRefetchMediaUrls,
      } as ReturnType<typeof useMediaUrls>);
    });

    it('scales the image around the pinch focal point and takes paging offline while zoomed', async () => {
      const { getByTestId } = renderViewer();

      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(true);

      await fireZoomGesture('full-screen-media-image-photo-pinch', [
        { state: State.BEGAN, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.ACTIVE, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.ACTIVE, scale: 2, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.END, scale: 2, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
      ]);

      expect(transformOf(getByTestId('full-screen-media-image-photo-zoom-layer'))).toEqual([
        { translateX: 0 },
        { translateY: 0 },
        { scale: 2 },
      ]);
      // Zoomed: the pan gesture owns horizontal drags, so paging must not.
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(false);
    });

    it('hands paging back once the image is pinched out to fit again', async () => {
      const { getByTestId } = renderViewer();

      await fireZoomGesture('full-screen-media-image-photo-pinch', [
        { state: State.BEGAN, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.ACTIVE, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.ACTIVE, scale: 3, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.END, scale: 3, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
      ]);
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(false);

      await fireZoomGesture('full-screen-media-image-photo-pinch', [
        { state: State.BEGAN, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.ACTIVE, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        // Pinching further out than the fitted size clamps at 1x rather than
        // shrinking the image below the frame.
        { state: State.ACTIVE, scale: 0.2, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.END, scale: 0.2, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
      ]);

      expect(transformOf(getByTestId('full-screen-media-image-photo-zoom-layer'))).toEqual([
        { translateX: 0 },
        { translateY: 0 },
        { scale: 1 },
      ]);
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(true);
    });

    it('double tap zooms in anchored on the tapped point, and taps back out to fit', async () => {
      const { getByTestId } = renderViewer();

      await fireZoomGesture('full-screen-media-image-photo-double-tap', [
        { state: State.BEGAN, x: 100, y: 400 },
        { state: State.ACTIVE, x: 100, y: 400 },
        { state: State.END, x: 100, y: 400 },
      ]);

      // Tapping left of centre pushes the image right so the tapped point
      // stays under the finger. The square asset is letterboxed vertically at
      // 2x (390*2 < 844), so there is no vertical slack to take up.
      expect(transformOf(getByTestId('full-screen-media-image-photo-zoom-layer'))).toEqual([
        { translateX: 95 },
        { translateY: 0 },
        { scale: 2 },
      ]);
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(false);

      await fireZoomGesture('full-screen-media-image-photo-double-tap', [
        { state: State.BEGAN, x: 100, y: 400 },
        { state: State.ACTIVE, x: 100, y: 400 },
        { state: State.END, x: 100, y: 400 },
      ]);

      expect(transformOf(getByTestId('full-screen-media-image-photo-zoom-layer'))).toEqual([
        { translateX: 0 },
        { translateY: 0 },
        { scale: 1 },
      ]);
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(true);
    });

    it('clamps panning to the visible content box so the image cannot be dragged off its own edge', async () => {
      const { getByTestId, renderAgain } = renderViewer();

      await fireZoomGesture('full-screen-media-image-photo-pinch', [
        { state: State.BEGAN, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.ACTIVE, scale: 1, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.ACTIVE, scale: 2, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
        { state: State.END, scale: 2, focalX: FRAME_WIDTH / 2, focalY: FRAME_HEIGHT / 2 },
      ]);

      await fireZoomGesture('full-screen-media-image-photo-pan', [
        { state: State.BEGAN, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, translationX: 0, translationY: 0 },
        { state: State.ACTIVE, translationX: 1000, translationY: 1000 },
        { state: State.END, translationX: 1000, translationY: 1000 },
      ]);
      renderAgain();

      // Horizontal slack at 2x is (390*2 - 390)/2 = 195. The 1024x1024 asset
      // is only 390pt tall inside an 844pt frame, so vertical slack is 0 --
      // clamping against the frame instead of the content box would have let
      // this drag pull the image off its letterbox.
      expect(transformOf(getByTestId('full-screen-media-image-photo-zoom-layer'))).toEqual([
        { translateX: 195 },
        { translateY: 0 },
        { scale: 2 },
      ]);
    });

    it('hands paging back if the zoomed page disappears from under the viewer', async () => {
      const { getByTestId, renderWithItems } = renderViewer();

      await fireZoomGesture('full-screen-media-image-photo-double-tap', [
        { state: State.BEGAN, x: 100, y: 400 },
        { state: State.ACTIVE, x: 100, y: 400 },
        { state: State.END, x: 100, y: 400 },
      ]);
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(false);

      // A family member editing this memory's media refreshes `items` while the
      // viewer is open: the zoomed page unmounts with nothing left to pinch out.
      renderWithItems([SECOND_PHOTO_ITEM, { ...PHOTO_ITEM, id: 'photo-3' }]);

      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(true);
    });

    it('drops a page\'s zoom when the viewer moves to another item', async () => {
      const { getByTestId } = renderViewer();

      await fireZoomGesture('full-screen-media-image-photo-double-tap', [
        { state: State.BEGAN, x: 100, y: 400 },
        { state: State.ACTIVE, x: 100, y: 400 },
        { state: State.END, x: 100, y: 400 },
      ]);
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(false);

      fireEvent(getByTestId('full-screen-media-scroll'), 'momentumScrollEnd', {
        nativeEvent: { contentOffset: { x: Dimensions.get('window').width, y: 0 } },
      });

      expect(transformOf(getByTestId('full-screen-media-image-photo-zoom-layer'))).toEqual([
        { translateX: 0 },
        { translateY: 0 },
        { scale: 1 },
      ]);
      expect(getByTestId('full-screen-media-scroll').props.scrollEnabled).toBe(true);
    });
  });
});
