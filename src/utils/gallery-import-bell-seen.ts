// Device-local "has the user already seen this batch of ready suggestions in
// the activity bell/sheet" marker (docs/plans/gallery-import-continuous.md
// I4a step 2). Distinct from gallery-import-invite-dismissal.ts's one-shot
// dismissal: this is keyed to a specific (runId, readyCount) pair so the dot
// comes back the moment a NEW suggestion arrives on the same run, not just
// once per run. Mirrors that file's defensive try/catch-to-safe-default
// AsyncStorage style -- a storage hiccup must never crash the Timeline; it
// only means the dot may show again unnecessarily, which is safe.
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_PREFIX = 'gallery-import-bell-seen';

interface GalleryImportBellSeenRecord {
  runId: string;
  readyCount: number;
}

function storageKey(userId: string, familyId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${familyId}`;
}

/** True once `markGalleryImportBellSeen` has recorded this exact
 * (runId, readyCount) pair for this user+family. A later increase in
 * readyCount for the same run (or a different run entirely) reads as unseen
 * again -- the bell dot is "is there something new to look at", not "has
 * this run ever been opened". */
export async function hasSeenGalleryImportBell(
  userId: string,
  familyId: string,
  runId: string,
  readyCount: number,
): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId, familyId));
    if (!raw) return false;
    const record = JSON.parse(raw) as Partial<GalleryImportBellSeenRecord>;
    return record.runId === runId && record.readyCount === readyCount;
  } catch {
    return false;
  }
}

export async function markGalleryImportBellSeen(
  userId: string,
  familyId: string,
  runId: string,
  readyCount: number,
): Promise<void> {
  try {
    const record: GalleryImportBellSeenRecord = { runId, readyCount };
    await AsyncStorage.setItem(storageKey(userId, familyId), JSON.stringify(record));
  } catch {
    // Best effort -- a storage hiccup just means the dot may reappear.
  }
}
