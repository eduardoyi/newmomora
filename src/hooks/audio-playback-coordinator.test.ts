// useIsActiveAudioClip is a useSyncExternalStore hook -- exercise it through
// React's test renderer rather than reimplementing the subscribe/getSnapshot
// wiring by hand. createElement (not JSX) keeps this file plain .ts.
import { act, render } from '@testing-library/react-native';
import { createElement } from 'react';
import { Text } from 'react-native';

import {
  beginAudioPlayback,
  endAudioPlayback,
  pauseAllAudioPlayback,
  prepareAudioPlaybackMode,
  resetAudioPlaybackCoordinatorForTests,
  useIsActiveAudioClip,
} from './audio-playback-coordinator';

const mockSetAudioModeAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-audio', () => ({
  setAudioModeAsync: (...args: unknown[]) => mockSetAudioModeAsync(...args),
}));

function Probe({ id, onRender }: { id: string; onRender: (isActive: boolean) => void }) {
  const isActive = useIsActiveAudioClip(id);
  onRender(isActive);
  return createElement(Text, null, isActive ? 'active' : 'inactive');
}

beforeEach(() => {
  resetAudioPlaybackCoordinatorForTests();
  mockSetAudioModeAsync.mockClear();
});

describe('single-active enforcement', () => {
  it('pauses the previously active clip when a different one begins', () => {
    const pauseA = jest.fn();
    const pauseB = jest.fn();

    beginAudioPlayback('a', pauseA);
    beginAudioPlayback('b', pauseB);

    expect(pauseA).toHaveBeenCalledTimes(1);
    expect(pauseB).not.toHaveBeenCalled();
  });

  it('does not re-pause the same clip beginning again', () => {
    const pauseA = jest.fn();

    beginAudioPlayback('a', pauseA);
    beginAudioPlayback('a', pauseA);

    expect(pauseA).not.toHaveBeenCalled();
  });

  it('reflects the active clip through useIsActiveAudioClip, and flips on hand-off', () => {
    const rendersA: boolean[] = [];
    const rendersB: boolean[] = [];

    render(createElement(Probe, { id: 'a', onRender: (v: boolean) => rendersA.push(v) }));
    render(createElement(Probe, { id: 'b', onRender: (v: boolean) => rendersB.push(v) }));

    expect(rendersA.at(-1)).toBe(false);
    expect(rendersB.at(-1)).toBe(false);

    act(() => {
      beginAudioPlayback('a', jest.fn());
    });
    expect(rendersA.at(-1)).toBe(true);

    act(() => {
      beginAudioPlayback('b', jest.fn());
    });
    // Both components re-render on every store change; "a" must flip back
    // to inactive the instant "b" claims the slot.
    expect(rendersB.at(-1)).toBe(true);
    expect(rendersA.at(-1)).toBe(false);
  });

  it('endAudioPlayback releases the slot only for its own id, without re-pausing', () => {
    const pauseA = jest.fn();
    beginAudioPlayback('a', pauseA);

    endAudioPlayback('some-other-id');
    expect(pauseA).not.toHaveBeenCalled();

    endAudioPlayback('a');
    // Releasing should not itself call the pause callback again -- the
    // caller already stopped (or is stopping) on its own.
    expect(pauseA).not.toHaveBeenCalled();

    // A fresh begin for a new id should not need to pause anything, since
    // the slot was already released.
    const pauseC = jest.fn();
    beginAudioPlayback('c', pauseC);
    expect(pauseC).not.toHaveBeenCalled();
  });
});

describe('pauseAllAudioPlayback', () => {
  it('pauses the active clip and clears the active slot', () => {
    const pauseA = jest.fn();
    beginAudioPlayback('a', pauseA);

    pauseAllAudioPlayback();

    expect(pauseA).toHaveBeenCalledTimes(1);

    const rendersA: boolean[] = [];
    render(createElement(Probe, { id: 'a', onRender: (v: boolean) => rendersA.push(v) }));
    expect(rendersA.at(-1)).toBe(false);
  });

  it('is a no-op when nothing is playing', () => {
    expect(() => pauseAllAudioPlayback()).not.toThrow();
  });

  it('a clip begun after pauseAll is not immediately re-paused', () => {
    const pauseA = jest.fn();
    beginAudioPlayback('a', pauseA);
    pauseAllAudioPlayback();

    const pauseB = jest.fn();
    beginAudioPlayback('b', pauseB);
    expect(pauseB).not.toHaveBeenCalled();
  });
});

describe('prepareAudioPlaybackMode', () => {
  it('configures the audio session for playback with recording disabled', async () => {
    await prepareAudioPlaybackMode();

    expect(mockSetAudioModeAsync).toHaveBeenCalledWith({
      allowsRecording: false,
      playsInSilentMode: true,
    });
  });
});
