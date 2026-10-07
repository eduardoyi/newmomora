// The "Free to make" block on the Keepsakes product pages
// (docs/plans/keepsakes-redesign.md D3/D4). No prices anywhere in the app --
// prices live in the shop -- so this says what is included and when payment
// happens, and nothing else.
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';

export type FreeToMakeProduct = 'card' | 'book';

export const FREE_TO_MAKE_TITLE = 'Free to make';
export const FREE_TO_MAKE_BODY: Record<FreeToMakeProduct, string> = {
  card: 'Making your card is included with Momora Plus. Look it over, change anything, and only pay if you decide to print.',
  book: 'Making the book is included with Momora Plus. Look through it, change anything, and only pay if you decide to print.',
};

export function FreeToMake({ product }: { product: FreeToMakeProduct }) {
  return (
    <View style={styles.card} testID={`free-to-make-${product}`}>
      <Text style={styles.title}>{FREE_TO_MAKE_TITLE}</Text>
      <Text style={styles.body}>{FREE_TO_MAKE_BODY[product]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
    padding: 16,
  },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 20, lineHeight: 26 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 20 },
});
