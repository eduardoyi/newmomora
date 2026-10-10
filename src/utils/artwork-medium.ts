// Artwork medium vocabulary, app side (docs/plans/artwork-scanning.md 1.4).
// Mirrors supabase/functions/_shared/artwork-medium.ts -- the list is
// sync-tested by that module's Deno test. Kept free of `@/` imports so the
// Deno test can import this file directly. The server (not this module)
// normalizes whatever the model returns; the value stored in
// `memories.artwork_medium` is already lowercase and displayed as-is.

export const ARTWORK_MEDIUMS = [
  'crayon',
  'marker',
  'colored pencil',
  'pencil',
  'watercolor',
  'paint',
  'chalk',
  'pastel',
  'collage',
  'mixed media',
] as const;

export type ArtworkMedium = (typeof ARTWORK_MEDIUMS)[number];

export function isArtworkMedium(value: unknown): value is ArtworkMedium {
  return typeof value === 'string' && (ARTWORK_MEDIUMS as readonly string[]).includes(value);
}

/** Chip label for a stored medium; null when absent/blank (caller shows the "Artwork" fallback). */
export function formatArtworkMedium(medium: string | null | undefined): string | null {
  const trimmed = medium?.trim();
  return trimmed ? trimmed : null;
}
