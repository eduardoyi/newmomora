// The Timeline's List / Calendar view choice (docs/plans/timeline-calendar-keepsakes.md
// B1). Per device, shared across families and accounts -- it's a reading
// preference, not data. Same defensive try/catch-to-default style as
// gallery-import-bell-seen.ts: a storage hiccup only means List.
import AsyncStorage from '@react-native-async-storage/async-storage';

export type TimelineView = 'list' | 'calendar';

const STORAGE_KEY = 'timeline.view';

export async function loadTimelineView(): Promise<TimelineView> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEY)) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

export async function saveTimelineView(view: TimelineView): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, view);
  } catch {
    // Best effort -- the next launch just opens in List.
  }
}
