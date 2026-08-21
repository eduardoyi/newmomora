import { spacing } from '@/constants/theme';

// Shared pull-down-to-dismiss thresholds and safe-area padding for the
// app's in-house `Modal`-based bottom sheets (MemoryCommentsDrawer,
// FamilyActivitySheet). Deliberately dependency-free (no hooks, no
// supabase-touching imports) -- pulling this out of memory-comments-drawer.tsx
// lets a second sheet reuse the exact same thresholds without dragging in
// that file's full hook chain (use-auth -> lib/supabase -> AsyncStorage),
// which breaks under Jest for any screen test that doesn't already mock
// that chain end to end.

export const BOTTOM_SHEET_DISMISS_DISTANCE = 120;
export const BOTTOM_SHEET_DISMISS_VELOCITY = 900;

export function shouldDismissBottomSheet(translationY: number, velocityY: number) {
  'worklet';
  return (
    translationY >= BOTTOM_SHEET_DISMISS_DISTANCE || velocityY >= BOTTOM_SHEET_DISMISS_VELOCITY
  );
}

export function getBottomSheetBottomPadding(bottomInset: number, isKeyboardVisible: boolean) {
  return isKeyboardVisible ? 0 : Math.max(bottomInset, spacing.md);
}
