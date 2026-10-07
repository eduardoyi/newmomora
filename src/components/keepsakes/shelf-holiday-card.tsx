// The family's holiday card as a shelf object (docs/plans/keepsakes-redesign.md
// C1): the shared card-with-envelope object at ~104 wide, pressable. A tap
// opens the card in the shop (signed in); the status badge and caption live
// in the shelf layout.
import { Pressable, StyleSheet } from 'react-native';

import {
  HolidayCardObject,
  holidayCardFamilyLine,
  holidayCardObjectSize,
} from '@/components/keepsakes/holiday-card-object';
import { openShopUrl } from '@/services/web-handoff';
import { holidayCardWebUrl } from '@/services/holiday-cards';

export const SHELF_CARD_WIDTH = 104;

export interface ShelfHolidayCardProps {
  cardId: string;
  year: number;
  /** The family's own children, for the tiny line on the card front. */
  names: string[];
  /** `overview.preview_key`; null renders the warm wash. */
  imageKey: string | null;
  /** Override the default shop handoff (tests). */
  onPress?: () => void;
}

export function ShelfHolidayCard({ cardId, year, names, imageKey, onPress }: ShelfHolidayCardProps) {
  const size = holidayCardObjectSize(SHELF_CARD_WIDTH);
  return (
    <Pressable
      accessibilityLabel={`Holiday card ${year}`}
      accessibilityRole="button"
      onPress={onPress ?? (() => void openShopUrl(holidayCardWebUrl(cardId)))}
      style={({ pressed }) => [{ width: size.width, height: size.height }, pressed && styles.pressed]}
      testID={`keepsakes-card-${cardId}`}
    >
      <HolidayCardObject
        familyLine={holidayCardFamilyLine(names, year)}
        imageKey={imageKey}
        width={SHELF_CARD_WIDTH}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
});
