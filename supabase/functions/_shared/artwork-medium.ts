// Artwork medium vocabulary (docs/plans/artwork-scanning.md 1.4): the closed
// set of materials `analyze-memory` may attach to a memory flagged
// `media_variant = 'artwork'`. Stored lowercase in `memories.artwork_medium`
// and displayed as-is. The database deliberately has NO check constraint on
// the value (a vocabulary drift must never fail the analysis CAS write that
// also carries emotion/topics/milestones), so this module is the only
// enforcement: `normalizeArtworkMedium` maps anything the model returns onto
// the list or null. The app keeps the same list in src/utils/artwork-medium.ts
// (sync-tested in artwork-medium.test.ts).

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

const ARTWORK_MEDIUM_SET: ReadonlySet<string> = new Set(ARTWORK_MEDIUMS);

// Spelling variants and near-synonyms the model reliably produces. Keys are
// already cleaned (lowercase, single spaces, no punctuation, singular).
const ARTWORK_MEDIUM_SYNONYMS: Readonly<Record<string, ArtworkMedium>> = {
  'wax crayon': 'crayon',
  'felt tip': 'marker',
  'felt tip pen': 'marker',
  'felt tipped pen': 'marker',
  'felt pen': 'marker',
  'sketch pen': 'marker',
  'marker pen': 'marker',
  sharpie: 'marker',
  'colouring pencil': 'colored pencil',
  'coloring pencil': 'colored pencil',
  'coloured pencil': 'colored pencil',
  'color pencil': 'colored pencil',
  'colour pencil': 'colored pencil',
  'pencil crayon': 'colored pencil',
  graphite: 'pencil',
  'graphite pencil': 'pencil',
  'lead pencil': 'pencil',
  'water color': 'watercolor',
  watercolour: 'watercolor',
  'water colour': 'watercolor',
  painting: 'paint',
  acrylic: 'paint',
  'acrylic paint': 'paint',
  tempera: 'paint',
  'tempera paint': 'paint',
  'poster paint': 'paint',
  'finger paint': 'paint',
  'finger painting': 'paint',
  gouache: 'paint',
  'oil paint': 'paint',
  'sidewalk chalk': 'chalk',
  'colored chalk': 'chalk',
  'oil pastel': 'pastel',
  'soft pastel': 'pastel',
  'pastel crayon': 'pastel',
  'paper collage': 'collage',
  'cut paper': 'collage',
  mixed: 'mixed media',
  'mixed medium': 'mixed media',
  'mix media': 'mixed media',
  'multi media': 'mixed media',
  multimedia: 'mixed media',
  'mixed material': 'mixed media',
};

function cleanMediumText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupMedium(cleaned: string): ArtworkMedium | null {
  if (ARTWORK_MEDIUM_SET.has(cleaned)) return cleaned as ArtworkMedium;
  return ARTWORK_MEDIUM_SYNONYMS[cleaned] ?? null;
}

/**
 * Tolerant parse of the model's `medium` value: case, whitespace, hyphens,
 * trailing punctuation, plurals (`crayons`), and a small synonym map
 * (`water color`, `colouring pencil`, `felt tip` -> marker, `oil pastel` ->
 * pastel). Anything else (including non-strings) is null, never a guess.
 */
export function normalizeArtworkMedium(raw: unknown): ArtworkMedium | null {
  if (typeof raw !== 'string') return null;
  const cleaned = cleanMediumText(raw);
  if (!cleaned) return null;

  const direct = lookupMedium(cleaned);
  if (direct) return direct;

  if (cleaned.length > 3 && cleaned.endsWith('s') && !cleaned.endsWith('ss')) {
    return lookupMedium(cleaned.slice(0, -1));
  }
  return null;
}
