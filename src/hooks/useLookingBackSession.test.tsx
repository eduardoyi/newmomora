import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { LookingBackSessionProvider, useLookingBackSession } from '@/hooks/useLookingBackSession';
import { useLookingBackPlayback } from '@/hooks/useLookingBackPlayback';

function wrapper({ children }: { children: ReactNode }) {
  return <LookingBackSessionProvider>{children}</LookingBackSessionProvider>;
}

const packageSnapshot = {
  id: 'package-1', familyId: 'family-1', dailySetId: 'set-1', memories: [
    { id: 'memory-1', taggedMembers: [] },
    { id: 'memory-2', taggedMembers: [] },
  ],
} as never;

describe('Looking Back session snapshot', () => {
  it('tombstones only deleted/unsafe rows without replacing frozen package metadata', () => {
    const hook = renderHook(() => useLookingBackSession(), { wrapper });
    act(() => hook.result.current.savePackageSnapshot(packageSnapshot));
    act(() => hook.result.current.reconcilePackageMemories('package-1', ['memory-2']));

    expect(hook.result.current.packageSnapshot?.dailySetId).toBe('set-1');
    expect(hook.result.current.packageSnapshot?.value.memories.map((memory) => memory.id)).toEqual(['memory-2']);
  });

  it('clears both checkpoint and frozen content on an access-loss close', () => {
    const hook = renderHook(() => useLookingBackSession(), { wrapper });
    act(() => hook.result.current.savePackageSnapshot(packageSnapshot));
    act(() => hook.result.current.saveCheckpoint({
      familyId: 'family-1', dailySetId: 'set-1', packageId: 'package-1', frameIndex: 0,
      frameFraction: 0.5, phase: 'playing', isMuted: true, pauseReasons: [],
    }));
    act(() => hook.result.current.clearCheckpoint('package-1'));

    expect(hook.result.current.checkpoint).toBeNull();
    expect(hook.result.current.packageSnapshot).toBeNull();
  });

  it('keeps the same surviving frame through a detail-style tombstone reconciliation', () => {
    const frames = [
      { id: 'frame-a', durationMs: 1000 }, { id: 'frame-b', durationMs: 1000 }, { id: 'frame-c', durationMs: 1000 },
    ] as never;
    const hook = renderHook(({ activeFrames }) => {
      const session = useLookingBackSession();
      const playback = useLookingBackPlayback({ frames: activeFrames });
      return { session, playback };
    }, { initialProps: { activeFrames: frames }, wrapper });
    act(() => hook.result.current.session.savePackageSnapshot(packageSnapshot));
    act(() => {
      hook.result.current.playback.dispatch({ type: 'INTRO_COMPLETE' });
      hook.result.current.playback.dispatch({ type: 'SKIP', direction: 1, frames });
    });
    expect(hook.result.current.playback.currentFrame?.id).toBe('frame-b');

    // Detail reports/deletes frame A; the session preserves the package but
    // tombstones that row before the viewer is re-focused.
    act(() => hook.result.current.session.reconcilePackageMemories('package-1', ['memory-2']));
    hook.rerender({ activeFrames: frames.slice(1) as never });
    expect(hook.result.current.session.packageSnapshot?.value.memories.map((memory) => memory.id)).toEqual(['memory-2']);
    expect(hook.result.current.playback.currentFrame?.id).toBe('frame-b');
  });
});
