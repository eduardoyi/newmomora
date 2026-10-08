// The family's holiday card as a shelf object (docs/plans/keepsakes-redesign.md
// C1): the card-with-envelope object, pressable. A tap opens the card in the
// shop (signed in); the status badge and caption live in the shelf layout.
//
// With the real card (`front`, from `keepsakes_overview.card_front`) the object
// shows what the family designed: a PORTRAIT card is 104 wide (outer 132 x 161,
// inside the 166-high object zone), a LANDSCAPE card is 150 wide (outer 179 x
// 122) and stands on the same baseline. Without it (the overview failed, an old
// server, or a mismatched card) it falls back to the generic portrait preview.
import { Pressable, StyleSheet } from 'react-native';

import { HolidayCardObject, holidayCardFrontObjectSize, holidayCardObjectSize } from '@/components/keepsakes/holiday-card-object';
import { openShopUrl } from '@/services/web-handoff';
import { defaultGreetingText } from '@/utils/holiday-card-front';
import { holidayCardWebUrl, type HolidayCardLanguage } from '@/services/holiday-cards';
import type { KeepsakesCardFront } from '@/services/keepsakes';

export const SHELF_CARD_PORTRAIT_WIDTH = 104;
export const SHELF_CARD_LANDSCAPE_WIDTH = 150;

/** The card's width on the shelf for the real card's orientation (portrait without one). */
export function shelfHolidayCardWidth(front: Pick<KeepsakesCardFront, 'orientation'> | null): number {
  return front?.orientation === 'landscape' ? SHELF_CARD_LANDSCAPE_WIDTH : SHELF_CARD_PORTRAIT_WIDTH;
}

/** The object's outer box on the shelf (also the shelf item's width). */
export function shelfHolidayCardSize(front: Pick<KeepsakesCardFront, 'orientation'> | null): {
  width: number;
  height: number;
} {
  return front
    ? holidayCardFrontObjectSize(front, shelfHolidayCardWidth(front))
    : holidayCardObjectSize(shelfHolidayCardWidth(null));
}

export interface ShelfHolidayCardProps {
  cardId: string;
  year: number;
  /** The real card's front, when the overview has it for THIS card. */
  front: KeepsakesCardFront | null;
  /** Fallback preview picture (`overview.preview_key`). */
  imageKey: string | null;
  /** Fallback preview greeting language (the card summary's). */
  language: HolidayCardLanguage;
  /** Override the default shop handoff (tests). */
  onPress?: () => void;
}

export function ShelfHolidayCard({ cardId, year, front, imageKey, language, onPress }: ShelfHolidayCardProps) {
  const size = shelfHolidayCardSize(front);
  return (
    <Pressable
      accessibilityLabel={`Holiday card ${year}`}
      accessibilityRole="button"
      onPress={onPress ?? (() => void openShopUrl(holidayCardWebUrl(cardId)))}
      style={({ pressed }) => [{ width: size.width, height: size.height }, pressed && styles.pressed]}
      testID={`keepsakes-card-${cardId}`}
    >
      <HolidayCardObject
        front={front}
        greeting={defaultGreetingText(language, 'holidays')}
        imageKey={imageKey}
        subline={String(year)}
        testID={`keepsakes-card-${cardId}-object`}
        width={shelfHolidayCardWidth(front)}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
});
