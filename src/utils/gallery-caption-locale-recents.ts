// Small "recently used" list for the caption-language picker
// (src/components/gallery-import/gallery-import-caption-settings.tsx). Mirrors
// the design handoff's GILocalePicker: switching away from a language files
// it under "Recently used" so it is one tap away next time, without keeping a
// full history. Device-local only -- there is nothing sensitive here, so a
// best-effort AsyncStorage round-trip (same pattern as
// src/utils/pending-invite-code.ts) is enough; a storage hiccup just means an
// empty "Recently used" section, never a crash.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const GALLERY_CAPTION_LOCALE_RECENTS_STORAGE_KEY = 'momora.galleryCaptionLocaleRecents';
export const GALLERY_CAPTION_LOCALE_RECENTS_MAX = 3;

export async function getRecentGalleryCaptionLocales(): Promise<string[]> {
  try {
    const stored = await AsyncStorage.getItem(GALLERY_CAPTION_LOCALE_RECENTS_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Records `previousTag` (the language being switched away from) as a recent
 * choice and returns the updated list. Call this before adopting `nextTag`.
 * A no-op switch (picking the language that is already active) is filtered
 * out rather than added to its own recents list.
 */
export async function recordGalleryCaptionLocaleRecent(
  previousTag: string,
  nextTag: string,
): Promise<string[]> {
  const current = await getRecentGalleryCaptionLocales();
  if (previousTag === nextTag) return current;
  const next = [previousTag, ...current.filter((tag) => tag !== previousTag && tag !== nextTag)]
    .slice(0, GALLERY_CAPTION_LOCALE_RECENTS_MAX);
  try {
    await AsyncStorage.setItem(GALLERY_CAPTION_LOCALE_RECENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort: losing the recents list is a minor convenience regression,
    // never blocking.
  }
  return next;
}
