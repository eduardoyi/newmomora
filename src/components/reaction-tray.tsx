import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius } from '@/constants/theme';
import { QUICK_REACTIONS } from '@/services/engagement';

/** Window-relative rect of the button the tray is anchored to (measureInWindow). */
export interface ReactionTrayAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReactionTrayProps {
  visible: boolean;
  anchor: ReactionTrayAnchor | null;
  /** The caller's current reaction; highlighted. Picking it again removes it. */
  currentEmoji: string | null;
  /** Called with the picked emoji (the caller decides same-emoji = remove). */
  onSelect: (emoji: string) => void;
  onOpenPicker: () => void;
  onClose: () => void;
}

const EMOJI_BUTTON = 44;
const TRAY_PADDING = 6;
const TRAY_GAP = 2;
const EDGE_MARGIN = 8;
const ANCHOR_GAP = 8;
// 6 quick emoji + the "+" button.
const TRAY_WIDTH = (QUICK_REACTIONS.length + 1) * EMOJI_BUTTON + QUICK_REACTIONS.length * TRAY_GAP + TRAY_PADDING * 2;
const TRAY_HEIGHT = EMOJI_BUTTON + TRAY_PADDING * 2;

export function computeReactionTrayPosition(
  anchor: ReactionTrayAnchor,
  window: { width: number; height: number },
  insets: { top: number; bottom: number; left: number; right: number },
): { left: number; top: number } {
  const minLeft = insets.left + EDGE_MARGIN;
  const maxLeft = Math.max(minLeft, window.width - insets.right - EDGE_MARGIN - TRAY_WIDTH);
  const left = Math.min(Math.max(anchor.x, minLeft), maxLeft);

  const minTop = insets.top + EDGE_MARGIN;
  const maxTop = Math.max(minTop, window.height - insets.bottom - EDGE_MARGIN - TRAY_HEIGHT);
  const above = anchor.y - TRAY_HEIGHT - ANCHOR_GAP;
  const below = anchor.y + anchor.height + ANCHOR_GAP;
  const top = above >= minTop ? above : below;
  return { left, top: Math.min(Math.max(top, minTop), maxTop) };
}

// Insets are only read once the tray is actually showing, so a closed tray
// (one per timeline card) never requires a SafeAreaProvider.
export function ReactionTray(props: ReactionTrayProps) {
  if (!props.visible || !props.anchor) return null;
  return <ReactionTrayContent {...props} anchor={props.anchor} />;
}

function ReactionTrayContent({
  anchor,
  currentEmoji,
  onSelect,
  onOpenPicker,
  onClose,
}: ReactionTrayProps & { anchor: ReactionTrayAnchor }) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();

  const position = computeReactionTrayPosition(anchor, window, insets);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <Pressable
        accessibilityLabel="Close reactions"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
        testID="reaction-tray-backdrop"
      />
      <View
        accessibilityViewIsModal
        pointerEvents="box-none"
        style={[styles.tray, position]}
        testID="reaction-tray"
      >
        {QUICK_REACTIONS.map((emoji) => {
          const selected = emoji === currentEmoji;
          return (
            <Pressable
              accessibilityLabel={selected ? `Remove reaction ${emoji}` : `React ${emoji}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={emoji}
              onPress={() => onSelect(emoji)}
              style={({ pressed }) => [
                styles.emojiButton,
                selected && styles.emojiButtonSelected,
                pressed && styles.pressed,
              ]}
              testID={`reaction-tray-${emoji}`}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityLabel="More reactions"
          accessibilityRole="button"
          onPress={onOpenPicker}
          style={({ pressed }) => [styles.emojiButton, styles.moreButton, pressed && styles.pressed]}
          testID="reaction-tray-more"
        >
          <Text style={styles.plus}>+</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44,36,24,0.12)',
  },
  tray: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    elevation: 8,
    flexDirection: 'row',
    gap: TRAY_GAP,
    height: TRAY_HEIGHT,
    padding: TRAY_PADDING,
    position: 'absolute',
    shadowColor: '#2C2418',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    width: TRAY_WIDTH,
  },
  emojiButton: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: EMOJI_BUTTON,
    justifyContent: 'center',
    width: EMOJI_BUTTON,
  },
  emojiButtonSelected: {
    backgroundColor: colors.primaryTint,
  },
  moreButton: {
    backgroundColor: colors.surface,
  },
  emoji: {
    fontSize: 26,
  },
  plus: {
    color: colors.ink2,
    fontSize: 26,
    lineHeight: 30,
  },
  pressed: {
    opacity: 0.65,
  },
});
