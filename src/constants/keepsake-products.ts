// The Keepsakes storefront registry (docs/plans/keepsakes-redesign.md C6):
// the products the "Make something" row offers, in order. A future product is
// one entry here plus its page under `app/(app)/keepsakes/` and its object in
// `make-something-row.tsx`. Prices never appear in the app -- they live in the
// shop, so changing them needs no app update.
import type { Href } from 'expo-router';

import { keepsakeProductRoute, type KeepsakeProduct } from '@/lib/routes';

export type KeepsakeProductId = KeepsakeProduct;

export interface KeepsakeProductContext {
  /** Owner or manager. */
  canEdit: boolean;
  /** `holiday_card_summary.enabled`: the server's season / billing switch. */
  holidayCardEnabled: boolean;
}

export interface KeepsakeProductDefinition {
  id: KeepsakeProductId;
  title: string;
  subtitle: string;
  /** The storefront card's width. */
  cardWidth: number;
  isAvailable: (context: KeepsakeProductContext) => boolean;
  route: () => Href;
}

export const KEEPSAKE_PRODUCTS: readonly KeepsakeProductDefinition[] = [
  {
    id: 'holiday-card',
    title: 'Holiday card',
    subtitle: 'Your card could look like this, with a letter from your year.',
    cardWidth: 236,
    // In season only (the existing server switch). It leads the row.
    isAvailable: (context) => context.canEdit && context.holidayCardEnabled,
    route: () => keepsakeProductRoute('holiday-card'),
  },
  {
    id: 'memory-book',
    title: 'Memory Book',
    subtitle: 'A year of one child, printed and bound.',
    cardWidth: 168,
    isAvailable: (context) => context.canEdit,
    route: () => keepsakeProductRoute('memory-book'),
  },
];

export function availableKeepsakeProducts(context: KeepsakeProductContext): KeepsakeProductDefinition[] {
  return KEEPSAKE_PRODUCTS.filter((product) => product.isAvailable(context));
}
