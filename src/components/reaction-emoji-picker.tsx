import EmojiPicker, { type EmojiType } from 'rn-emoji-keyboard';

import { colors } from '@/constants/theme';

interface ReactionEmojiPickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
}

// Thin, themed wrapper around rn-emoji-keyboard (pure JS, OTA-safe). Kept in
// its own file so the bar (rendered once per timeline card) only pays for the
// emoji dataset when someone actually opens the full picker.
export function ReactionEmojiPicker({ open, onClose, onPick }: ReactionEmojiPickerProps) {
  return (
    <EmojiPicker
      enableRecentlyUsed
      enableSearchBar
      onClose={onClose}
      onEmojiSelected={(picked: EmojiType) => onPick(picked.emoji)}
      open={open}
      theme={{
        backdrop: 'rgba(44,36,24,0.34)',
        knob: colors.borderStrong,
        container: colors.white,
        header: colors.ink2,
        skinTonesContainer: colors.surface,
        category: {
          icon: colors.ink3,
          iconActive: colors.primary,
          container: colors.surface,
          containerActive: colors.primaryTint,
        },
        search: {
          background: colors.surface,
          text: colors.ink,
          placeholder: colors.ink3,
          icon: colors.ink3,
        },
        emoji: { selected: colors.primaryTint },
      }}
    />
  );
}
