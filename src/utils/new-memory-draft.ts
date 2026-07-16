// Draft autosave for the new-memory composer (app/(app)/new-memory.tsx) --
// keeps a parent's in-progress entry from being lost if they get
// interrupted mid-entry. Scoped per user + family (see
// `getNewMemoryDraftStorageKey`) so switching the active family, or signing
// into a different account on the same device, never restores another
// context's draft.
//
// Deliberately NOT persisted: media attachments. Attached photos/videos are
// local picker-cache URIs (`file://...`) that the OS is free to evict or
// rewrite between app launches -- a restored draft pointing at a stale URI
// would either fail to render or silently resurrect the wrong file. Only
// plain, cheaply-serializable form state is stored: content text, tagged
// member ids, the memory date, and the AI-illustration toggle.
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface NewMemoryDraft {
  content: string;
  taggedMemberIds: string[];
  memoryDate: string;
  illustrationEnabled: boolean;
}

export function getNewMemoryDraftStorageKey(userId: string, familyId: string): string {
  return `momora.newMemoryDraft.${userId}.${familyId}`;
}

function isValidDraft(value: unknown): value is NewMemoryDraft {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const draft = value as Record<string, unknown>;
  return (
    typeof draft.content === 'string' &&
    Array.isArray(draft.taggedMemberIds) &&
    draft.taggedMemberIds.every((id) => typeof id === 'string') &&
    typeof draft.memoryDate === 'string' &&
    typeof draft.illustrationEnabled === 'boolean'
  );
}

/** A draft with nothing worth protecting -- callers should clear rather than store this. */
export function isEmptyDraft(draft: NewMemoryDraft): boolean {
  return draft.content.trim().length === 0 && draft.taggedMemberIds.length === 0;
}

export async function loadNewMemoryDraft(
  userId: string,
  familyId: string,
): Promise<NewMemoryDraft | null> {
  if (!userId || !familyId) {
    return null;
  }

  try {
    const stored = await AsyncStorage.getItem(getNewMemoryDraftStorageKey(userId, familyId));
    if (!stored) {
      return null;
    }
    const parsed: unknown = JSON.parse(stored);
    return isValidDraft(parsed) ? parsed : null;
  } catch {
    // Storage hiccups or corrupted JSON degrade to "no draft" -- never
    // block the composer from opening.
    return null;
  }
}

export async function saveNewMemoryDraft(
  userId: string,
  familyId: string,
  draft: NewMemoryDraft,
): Promise<void> {
  if (!userId || !familyId) {
    return;
  }

  try {
    await AsyncStorage.setItem(getNewMemoryDraftStorageKey(userId, familyId), JSON.stringify(draft));
  } catch {
    // Best-effort: losing the draft is annoying but never blocking.
  }
}

export async function clearNewMemoryDraft(userId: string, familyId: string): Promise<void> {
  if (!userId || !familyId) {
    return;
  }

  try {
    await AsyncStorage.removeItem(getNewMemoryDraftStorageKey(userId, familyId));
  } catch {
    // Best-effort; a stale draft is overwritten or re-cleared next time.
  }
}
