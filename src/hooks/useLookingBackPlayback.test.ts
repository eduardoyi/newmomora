import { act, renderHook } from '@testing-library/react-native';

import { lookingBackFramesFingerprint, lookingBackPlaybackReducer, type LookingBackPlaybackState, useLookingBackPlayback } from './useLookingBackPlayback';

const frames = [{ durationMs: 1000 }, { durationMs: 500 }] as any;
const initial: LookingBackPlaybackState = { phase: 'playing', frameIndex: 0, frameFraction: 0, pauseReasons: [], isMuted: true };

describe('Looking Back playback reducer', () => {
  it('preserves the exact fraction over a pause and resumes only its own reason', () => {
    const ticking = lookingBackPlaybackReducer(initial, { type: 'SYNC_FRACTION', fraction: 0.4 });
    const paused = lookingBackPlaybackReducer(ticking, { type: 'PAUSE', reason: 'detail' });
    const doublyPaused = lookingBackPlaybackReducer(paused, { type: 'PAUSE', reason: 'buffering' });
    expect(lookingBackPlaybackReducer(doublyPaused, { type: 'RESUME', reason: 'buffering' }).pauseReasons).toEqual(['detail']);
    expect(lookingBackPlaybackReducer(paused, { type: 'RESUME', reason: 'detail' }).pauseReasons).toEqual([]);
  });

  it('advances consecutive frames and completes without replaying the title card', () => {
    const next = lookingBackPlaybackReducer(initial, { type: 'ADVANCE', frames });
    expect(next).toMatchObject({ frameIndex: 1, frameFraction: 0, phase: 'playing' });
    const completed = lookingBackPlaybackReducer(next, { type: 'ADVANCE', frames });
    expect(completed.phase).toBe('complete');
    expect(lookingBackPlaybackReducer(completed, { type: 'REPLAY' })).toMatchObject({ phase: 'playing', frameIndex: 0, frameFraction: 0 });
  });

  it('starts the first real frame without retaining an old touch pause', () => {
    const intro: LookingBackPlaybackState = { ...initial, phase: 'intro', pauseReasons: ['manual', 'screen-reader'] };
    expect(lookingBackPlaybackReducer(intro, { type: 'INTRO_COMPLETE' })).toMatchObject({
      phase: 'playing',
      frameIndex: 0,
      pauseReasons: ['screen-reader'],
    });
  });

  it('lets a right tap on the final frame open completion immediately', () => {
    const finalFrame = { ...initial, frameIndex: frames.length - 1, frameFraction: 0.6 };
    expect(lookingBackPlaybackReducer(finalFrame, { type: 'SKIP', direction: 1, frames }))
      .toMatchObject({ phase: 'complete', frameIndex: frames.length - 1, frameFraction: 1 });
  });

  it('clamps a checkpoint after a deleted frame and retains every pause reason', () => {
    const restored = lookingBackPlaybackReducer(initial, {
      type: 'RESTORE',
      frames,
      checkpoint: {
        familyId: 'family', dailySetId: 'set', packageId: 'package', frameIndex: 9,
        frameFraction: 2, phase: 'playing', isMuted: false, pauseReasons: ['background', 'buffering'],
      },
    });
    expect(restored).toMatchObject({ frameIndex: 1, frameFraction: 1, isMuted: false, pauseReasons: ['background', 'buffering'] });
  });

  it('reconciles deletions by stable frame identity rather than an old numeric index', () => {
    const identified = [{ id: 'a', durationMs: 1 }, { id: 'b', durationMs: 1 }, { id: 'c', durationMs: 1 }] as any;
    const viewingB = { ...initial, frameIndex: 1, frameFraction: 0.45 };
    // An earlier deletion makes B index zero. It must stay B, not jump to C.
    expect(lookingBackPlaybackReducer(viewingB, { type: 'RECONCILE_FRAMES', frames: identified.slice(1), previousFrameId: 'b' }))
      .toMatchObject({ frameIndex: 0, frameFraction: 0.45 });
    // A current deletion advances to the replacement at the same position.
    expect(lookingBackPlaybackReducer(viewingB, { type: 'RECONCILE_FRAMES', frames: [identified[0], identified[2]], previousFrameId: 'b' }))
      .toMatchObject({ frameIndex: 1, frameFraction: 0 });
    // A last-frame deletion selects the new last frame deterministically.
    expect(lookingBackPlaybackReducer({ ...initial, frameIndex: 2 }, { type: 'RECONCILE_FRAMES', frames: identified.slice(0, 2), previousFrameId: 'c' }))
      .toMatchObject({ frameIndex: 1, frameFraction: 0 });
  });

  it('keeps a mid-frame fraction when pause and checkpoint are called in the same lifecycle turn', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T12:00:00.000Z'));
    const hook = renderHook(() => useLookingBackPlayback({
      frames: [{ id: 'frame-1', durationMs: 1000 }] as any,
      checkpoint: {
        familyId: 'family', dailySetId: 'set', packageId: 'package', frameIndex: 0,
        frameFraction: 0, phase: 'playing', isMuted: true, pauseReasons: [],
      },
    }));
    act(() => { jest.advanceTimersByTime(400); });
    let saved: ReturnType<typeof hook.result.current.checkpointFor> | undefined;
    act(() => {
      hook.result.current.pause('background');
      saved = hook.result.current.checkpointFor({ familyId: 'family', dailySetId: 'set', packageId: 'package' });
    });

    expect(saved?.frameFraction).toBeCloseTo(0.4, 1);
    expect(saved?.frameFraction).toBeLessThan(1);
    expect(saved?.pauseReasons).toContain('background');
    jest.useRealTimers();
  });

  it('does not reconcile forever when a caller recreates an equivalent frame array', () => {
    const equivalentFrame = {
      id: 'frame-1', kind: 'text-short', durationMs: 1000,
      memory: { id: 'memory-1', content: 'A memory', updated_at: '2026-08-08T00:00:00.000Z' },
    } as any;
    const hook = renderHook(({ value }) => useLookingBackPlayback({ frames: value }), {
      initialProps: { value: [equivalentFrame] as any },
    });

    hook.rerender({ value: [{ ...equivalentFrame, memory: { ...equivalentFrame.memory } }] as any });
    expect(hook.result.current.currentFrame?.id).toBe('frame-1');
    expect(hook.result.current.state.phase).toBe('intro');
  });

  it('recognizes same-ID duration and written-content changes as a frame reconciliation', () => {
    const frame = {
      id: 'frame-1', kind: 'text-short', durationMs: 1000,
      memory: { id: 'memory-1', content: 'Before', updated_at: '2026-08-08T00:00:00.000Z' },
    } as any;
    const revised = {
      ...frame,
      durationMs: 1800,
      memory: { ...frame.memory, content: 'After', updated_at: '2026-08-08T00:01:00.000Z' },
    } as any;
    expect(lookingBackFramesFingerprint([frame])).not.toBe(lookingBackFramesFingerprint([revised]));
  });
});
