// The "Make something" storefront (docs/plans/keepsakes-redesign.md C5): a
// horizontal row of neutral product cards, each opening its own native product
// page. Owners and managers only. The holiday card leads, wider, only in
// season; the Memory Book is always there. The objects use the family's own
// pictures from the overview. No prices anywhere.
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HolidayCardObject, holidayCardFamilyLine } from '@/components/keepsakes/holiday-card-object';
import { BookCoverTile } from '@/components/memory-books/book-cover-tile';
import { colors, fonts, radius } from '@/constants/theme';
import {
  availableKeepsakeProducts,
  type KeepsakeProductDefinition,
  type KeepsakeProductId,
} from '@/constants/keepsake-products';
import type { KeepsakesOverview } from '@/services/keepsakes';

const TILE_HEIGHT = 178;
const CARD_OBJECT_WIDTH = 104;
const BOOK_OBJECT_WIDTH = 118;

export interface MakeSomethingRowProps {
  /** Owner or manager; the row renders nothing otherwise. */
  canEdit: boolean;
  /** `holiday_card_summary.enabled` (the server's season switch). */
  holidayCardEnabled: boolean;
  overview: KeepsakesOverview | null;
  /** Names of the family's own children, for the card's tiny family line. */
  childNames: string[];
  /** The first own child (the book object's name and picture); null when none. */
  firstChild: { id: string; name: string } | null;
  /** The calendar year printed on the card object. */
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
  childNames,
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
                familyLine={holidayCardFamilyLine(childNames, year)}
                imageKey={overview?.preview_key ?? null}
                width={CARD_OBJECT_WIDTH}
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
