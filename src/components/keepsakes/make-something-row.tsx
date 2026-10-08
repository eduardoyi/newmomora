// The "Make something" storefront (docs/plans/keepsakes-redesign.md C5): a
// horizontal row of neutral product cards, each opening its own native product
// page. Owners and managers only. The holiday card leads, wider, only in
// season; the Memory Book is always there. The objects use the family's own
// pictures from the overview. Once a card exists the holiday tile shows the
// REAL card front (`cardFront`, landscape or portrait, sized to fit the tile);
// before that, the generic "could look like this" preview. No prices anywhere.
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HolidayCardObject } from '@/components/keepsakes/holiday-card-object';
import { BookCoverTile } from '@/components/memory-books/book-cover-tile';
import { colors, fonts, radius } from '@/constants/theme';
import {
  availableKeepsakeProducts,
  type KeepsakeProductDefinition,
  type KeepsakeProductId,
} from '@/constants/keepsake-products';
import type { HolidayCardLanguage } from '@/services/holiday-cards';
import type { KeepsakesCardFront, KeepsakesOverview } from '@/services/keepsakes';
import { defaultGreetingText, holidayCardWidthToFit } from '@/utils/holiday-card-front';

const TILE_HEIGHT = 178;
const CARD_OBJECT_WIDTH = 104;
// The real card is sized to fit the tile's picture area (236 wide card minus its
// 8px padding and 1px border, 178 high) with a few px for the 1.5 degree tilts.
const REAL_CARD_MAX_WIDTH = 208;
const REAL_CARD_MAX_HEIGHT = 166;
const BOOK_OBJECT_WIDTH = 118;

export interface MakeSomethingRowProps {
  /** Owner or manager; the row renders nothing otherwise. */
  canEdit: boolean;
  /** `holiday_card_summary.enabled` (the server's season switch). */
  holidayCardEnabled: boolean;
  overview: KeepsakesOverview | null;
  /**
   * The family's real card front for the card that exists THIS season (the
   * tab passes it only when the tile state is not "make" and the ids match);
   * null shows the generic preview.
   */
  cardFront: KeepsakesCardFront | null;
  /** The generic preview's greeting language (`holiday_card_summary.language`). */
  language: HolidayCardLanguage;
  /** The first own child (the book object's name and picture); null when none. */
  firstChild: { id: string; name: string } | null;
  /** The calendar year printed on the generic preview. */
  year: number;
  onOpenProduct: (product: KeepsakeProductId) => void;
}

function ProductCard({
  product,
  children,
  note,
  onPress,
}: {
  product: KeepsakeProductDefinition;
  children: ReactNode;
  note?: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${product.title}. ${product.subtitle}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, { width: product.cardWidth }, pressed && styles.pressed]}
      testID={`keepsakes-store-${product.id}`}
    >
      <View style={styles.tile}>{children}</View>
      <View style={styles.textBlock}>
        <Text style={styles.title}>{product.title}</Text>
        <Text style={styles.subtitle}>{product.subtitle}</Text>
        {note ? (
          <View style={styles.pill} testID={`keepsakes-store-${product.id}-note`}>
            <Text style={styles.pillText}>{note}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function MakeSomethingRow({
  canEdit,
  holidayCardEnabled,
  overview,
  cardFront,
  language,
  firstChild,
  year,
  onOpenProduct,
}: MakeSomethingRowProps) {
  const products = availableKeepsakeProducts({ canEdit, holidayCardEnabled });
  if (products.length === 0) return null;

  return (
    <View style={styles.section} testID="keepsakes-store">
      <Text accessibilityRole="header" style={styles.eyebrow}>
        Make something
      </Text>
      <ScrollView
        contentContainerStyle={styles.row}
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
      >
        {products.map((product) => (
          <ProductCard
            key={product.id}
            note={product.id === 'holiday-card' ? overview?.holiday_ship_by_note ?? null : null}
            onPress={() => onOpenProduct(product.id)}
            product={product}
          >
            {product.id === 'holiday-card' ? (
              <HolidayCardObject
                front={cardFront}
                greeting={defaultGreetingText(language, 'holidays')}
                imageKey={overview?.preview_key ?? null}
                subline={String(year)}
                testID="keepsakes-store-holiday-card-object"
                width={
                  cardFront
                    ? holidayCardWidthToFit(cardFront.orientation, REAL_CARD_MAX_WIDTH, REAL_CARD_MAX_HEIGHT)
                    : CARD_OBJECT_WIDTH
                }
              />
            ) : (
              <View style={{ width: BOOK_OBJECT_WIDTH }}>
                <BookCoverTile
                  childFirstName={firstChild?.name ?? 'Your child'}
                  coverAssetKey={firstChild ? overview?.book_preview_keys[firstChild.id] ?? null : null}
                  scopeLabel="Year One"
                  status="ready"
                  washId={`store-${firstChild?.id ?? 'book'}`}
                />
              </View>
            )}
          </ProductCard>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12, paddingTop: 30 },
  eyebrow: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 13,
    letterSpacing: 0.8,
    paddingHorizontal: 20,
    textTransform: 'uppercase',
  },
  row: { alignItems: 'flex-start', gap: 12, paddingHorizontal: 20 },
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingBottom: 12,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  pressed: { opacity: 0.88 },
  tile: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 11,
    height: TILE_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  textBlock: { gap: 3, paddingHorizontal: 4, paddingTop: 12 },
  title: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15 },
  subtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  pill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.sunSoft,
    borderRadius: radius.pill,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pillText: { color: colors.sunInk, fontFamily: fonts.sansBold, fontSize: 11.5, lineHeight: 15 },
});
