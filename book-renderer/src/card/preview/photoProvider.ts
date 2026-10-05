import { frontOptionsOf } from '../fromData';
import type { CardData } from '../types';

/**
 * The picker's data source. The card editor never knows where candidates come
 * from: locally it is the card's own `frontOptions` (the C1 top picks + the
 * illustrated scenes, downloaded by `eval:holiday-card-assets`); in P2 the web
 * shop plugs in the family's photo pool (an Edge Function scoped to the family
 * and year, with date/person filters like the book's `picker_pool`) behind the
 * same two members.
 */
export interface PickerItem {
  /** The id stored in `edits.frontImage`. */
  id: string;
  kind: 'photo' | 'illustration';
  thumbUrl: string;
  width: number;
  height: number;
  /** Photos: YYYY-MM-DD. */
  date?: string;
  /** Illustrations: the scene id. */
  label?: string;
  /** 1 = the judge's top pick. */
  rank?: number;
}

export interface FrontPhotoProvider {
  /** One page of candidates; `nextCursor` null = no more. */
  list(cursor: string | null): Promise<{ items: PickerItem[]; nextCursor: string | null }>;
}

export function localPhotoProvider(data: CardData, assetUrl: (file: string) => string): FrontPhotoProvider {
  const items: PickerItem[] = frontOptionsOf(data).map((o) => ({
    id: o.id,
    kind: o.kind,
    thumbUrl: assetUrl(o.thumb ?? o.file),
    width: o.width,
    height: o.height,
    date: o.date,
    label: o.label,
    rank: o.rank,
  }));
  return { list: async () => ({ items, nextCursor: null }) };
}
