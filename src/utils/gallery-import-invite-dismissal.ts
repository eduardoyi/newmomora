// Device-local dismissal for the Timeline "start with what you have" invite
// card (gi-entry.jsx GIImportInvite's X button). Mirrors
// gallery-import-checkpoint.ts's defensive try/catch-to-safe-default
// AsyncStorage style: a storage hiccup must never crash the Timeline or
// re-show a card the user already closed more than once in a row.
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_PREFIX = 'gallery-import-invite-dismissed';

function storageKey(userId: string, familyId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${familyId}`;
}

export async function isGalleryImportInviteDismissed(userId: string, familyId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(storageKey(userId, familyId))) === '1';
  } catch {
    // Unreadable storage degrades to "not dismissed" -- the card can show
    // again, which is safe; silently hiding it forever would not be.
    return false;
  }
}

export async function dismissGalleryImportInvite(userId: string, familyId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(userId, familyId), '1');
  } catch {
    // Best effort -- a storage hiccup just means the card can reappear next launch.
  }
}
