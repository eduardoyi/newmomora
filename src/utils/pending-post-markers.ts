// Device-local markers for deferred media/audio posts that are still in
// flight (src/hooks/use-pending-memory-uploads.tsx). The queue itself is
// in-memory, so a post the OS kills mid-upload used to vanish without a
// trace -- no memory row and no `memory_save_failed` (observed 2026-10-22).
// A marker left over at the next app start means exactly that, and is
// reported as `memory_save_failed {code: 'interrupted'}`.
//
// Only ids and timestamps are stored -- never captions, file paths or other
// memory content. Same defensive try/catch style as onboarding-progress.ts:
// storage hiccups degrade to a no-op, never a thrown save.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PENDING_POST_MARKERS_STORAGE_KEY = 'momora.pendingPostMarkers';

export interface PendingPostMarker {
  memoryId: string;
  enqueuedAt: string;
}

let mutationChain: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(mutation, mutation);
  mutationChain = result.catch(() => undefined);
  return result;
}

async function readMarkers(): Promise<PendingPostMarker[]> {
  try {
    const stored = await AsyncStorage.getItem(PENDING_POST_MARKERS_STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (marker): marker is PendingPostMarker =>
            Boolean(marker) && typeof marker.memoryId === 'string' && typeof marker.enqueuedAt === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

async function writeMarkers(markers: PendingPostMarker[]): Promise<void> {
  try {
    if (markers.length === 0) {
      await AsyncStorage.removeItem(PENDING_POST_MARKERS_STORAGE_KEY);
    } else {
      await AsyncStorage.setItem(PENDING_POST_MARKERS_STORAGE_KEY, JSON.stringify(markers));
    }
  } catch {
    // Best-effort: a lost marker only means one interruption goes unreported.
  }
}

export function addPendingPostMarker(memoryId: string, now = new Date()): Promise<void> {
  return enqueueMutation(async () => {
    const markers = (await readMarkers()).filter((marker) => marker.memoryId !== memoryId);
    await writeMarkers([...markers, { memoryId, enqueuedAt: now.toISOString() }]);
  });
}

export function removePendingPostMarker(memoryId: string): Promise<void> {
  return enqueueMutation(async () => {
    const markers = await readMarkers();
    if (markers.some((marker) => marker.memoryId === memoryId)) {
      await writeMarkers(markers.filter((marker) => marker.memoryId !== memoryId));
    }
  });
}

/** Returns every leftover marker and clears them, so each is reported once. */
export function takePendingPostMarkers(): Promise<PendingPostMarker[]> {
  return enqueueMutation(async () => {
    const markers = await readMarkers();
    if (markers.length > 0) {
      await writeMarkers([]);
    }
    return markers;
  });
}
