import { createVideoPlayer } from 'expo-video';
import type { EventSubscription } from 'expo-modules-core';

const VIDEO_METADATA_TIMEOUT_MS = 10_000;

export function getSharedVideoDurationMs(uri: string): Promise<number | null> {
  return new Promise((resolve) => {
    const player = createVideoPlayer({ uri });
    let hasFinished = false;
    let timeout: ReturnType<typeof setTimeout>;
    let sourceLoadSubscription: EventSubscription;
    let statusSubscription: EventSubscription;

    const finish = (durationMs: number | null) => {
      if (hasFinished) {
        return;
      }
      hasFinished = true;
      clearTimeout(timeout);
      sourceLoadSubscription.remove();
      statusSubscription.remove();
      player.release();
      resolve(durationMs);
    };

    sourceLoadSubscription = player.addListener('sourceLoad', ({ duration }) => {
      finish(duration > 0 ? Math.round(duration * 1000) : null);
    });
    statusSubscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') {
        finish(null);
      }
    });
    timeout = setTimeout(() => finish(null), VIDEO_METADATA_TIMEOUT_MS);
  });
}
