import type { FrontOption } from '../../card/types';
import type { FrontPhotoProvider, PickerItem } from '../../card/preview/photoProvider';
import type { PickerPoolPage } from './cardTypes';

/**
 * The shop's `FrontPhotoProvider`: the family's photo pool (`holiday-cards`
 * `picker_pool`, newest first) with thumbnails signed through the shared
 * `get-media-url` coalescer. Pure of any network import — both calls are
 * injected — so it unit-tests in plain node.
 */

export interface PickerProviderDeps {
  fetchPool: (cursor: string | null) => Promise<PickerPoolPage>;
  /** Signed URLs for storage keys (the coalescer); a key it could not sign is simply absent. */
  getUrls: (keys: string[]) => Promise<Map<string, string>>;
}

/** Long edge, px, of a picked photo until the server has measured the real one (sizes only drive layout hints, never printing). */
export const PLACEHOLDER_LONG_EDGE_PX = 4000;

/** Width/height for a pool item: from its stored aspect ratio, else a 1:1 placeholder. */
export function sizeFromAspect(aspectRatio: number | null): { width: number; height: number } {
  if (aspectRatio === null || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { width: PLACEHOLDER_LONG_EDGE_PX, height: PLACEHOLDER_LONG_EDGE_PX };
  }
  const long = PLACEHOLDER_LONG_EDGE_PX;
  return aspectRatio >= 1
    ? { width: long, height: Math.round(long / aspectRatio) }
    : { width: Math.round(long * aspectRatio), height: long };
}

export function createPickerProvider(deps: PickerProviderDeps): FrontPhotoProvider {
  return {
    async list(cursor) {
      const page = await deps.fetchPool(cursor);
      const urls = page.items.length > 0 ? await deps.getUrls(page.items.map((i) => i.previewKey)) : new Map<string, string>();
      const items: PickerItem[] = page.items.map((row) => ({
        id: row.mediaId,
        kind: 'photo',
        thumbUrl: urls.get(row.previewKey) ?? '',
        ...sizeFromAspect(row.aspectRatio),
        date: row.date || undefined,
      }));
      return { items, nextCursor: page.nextCursor };
    },
  };
}

// ── A photo picked in this session, before the server has it in `frontOptions` ──

/** The `cardData` file name a locally picked photo is registered under (never a real server file). */
export const LOCAL_FILE_PREFIX = 'local:';

export interface LocalFront {
  option: FrontOption;
  /** Where to draw it from (the picker's preview URL). */
  url: string;
}

export function localFrontFromPick(item: PickerItem): LocalFront {
  return {
    url: item.thumbUrl,
    option: { id: item.id, kind: 'photo', file: `${LOCAL_FILE_PREFIX}${item.id}`, width: item.width, height: item.height, date: item.date },
  };
}

/** The editor's `frontOptions`: the server's, plus picks the server does not list yet (it replaces them once it does). */
export function mergeFrontOptions(serverOptions: FrontOption[], locals: LocalFront[]): FrontOption[] {
  const known = new Set(serverOptions.map((o) => o.id));
  return [...serverOptions, ...locals.filter((l) => !known.has(l.option.id)).map((l) => l.option)];
}

/** Locals the server has caught up with (drop them) and locals still pending. */
export function pruneLocalFronts(locals: LocalFront[], serverOptions: FrontOption[]): LocalFront[] {
  const known = new Set(serverOptions.map((o) => o.id));
  return locals.filter((l) => !known.has(l.option.id));
}

export function removeLocalFront(locals: LocalFront[], mediaId: string): LocalFront[] {
  return locals.filter((l) => l.option.id !== mediaId);
}

/** `file` → URL for `cardInputFromData`: local picks first, then the server's signed assets. */
export function buildAssetUrl(assets: Record<string, string>, locals: LocalFront[], fallback: string): (file: string) => string {
  const localUrls = new Map(locals.map((l) => [l.option.file, l.url]));
  return (file) => localUrls.get(file) ?? assets[file] ?? fallback;
}

/**
 * The `frontImage` a pick saves: null ("the card's own photo") when the default photo is picked, except when the saved front
 * vanished (`needsRepick`), where the pick is always an explicit id so it can never silently become "the default".
 */
export function frontIdForPick(pickedId: string, defaultId: string, needsRepick: boolean): string | null {
  return pickedId === defaultId && !needsRepick ? null : pickedId;
}
