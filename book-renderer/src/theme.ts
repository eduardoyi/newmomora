/**
 * Momora design tokens for the book renderer.
 *
 * Copied (not imported — book-renderer is an isolated package with its own
 * deps, per docs/plans/memory-book.md Stage C) from the app's design system
 * at src/constants/theme.ts. Keep the palette + font names in sync by hand
 * whenever that file's `colors`/`fonts` change.
 *
 * Book pages deliberately use lavender sparingly (accents only) — the app's
 * `primary` pink is a UI color, not book copy. See the borderStrong/surface2
 * lavender-leaning tokens below for the book's accent usage.
 */

export const colors = {
  bg: '#FAFAFD',
  surface: '#F4F3F8',
  surface2: '#F2EFF8',
  border: '#EBE7F2',
  borderStrong: '#CFC8E0',
  white: '#FFFFFF',

  ink: '#2C2418',
  // Print-polish round (owner decision 2026-09-14, item B): the physical
  // sample book showed small text set in these mid-grays (captions,
  // eyebrows, page numbers, dates) screening into visible halftone grain —
  // darkened both a notch while keeping the warm brown hue (same hue
  // family, just more depth/contrast against the paper-white page). Global
  // book-design tokens — preview and print stay byte-identical (single-
  // renderer rule); the mobile app's own theme is untouched.
  ink2: '#55483C',
  ink3: '#7A6B58',

  primary: '#D63E78',
  primaryDark: '#B22A60',
  primarySoft: '#FBD3E2',
  primaryTint: '#FDEAF1',

  /** Footer-index numerals / photo-tile numeral labels (Momora Book Layout System 1b). */
  numeral: '#C3B8A8',
  /** The single pink accent dot in the "Momora." wordmark. */
  wordmarkDot: '#EC7FA1',
  /** Warm-ink scan-mark color — never pure black (78% luminance delta on white). */
  scanInk: '#4A3F35',
} as const;

// The book's lavender accent family. `theme.ts` has no dedicated "lavender"
// token today (borderStrong/surface2 are the closest lavender-leaning
// values) — these are hand-picked to sit in the same family for cover /
// section-opener accents, not lifted verbatim from an existing token.
export const lavender = {
  pale: '#F2EFF8', // == colors.surface2
  soft: '#E4DEF2',
  mid: '#CFC8E0', // == colors.borderStrong
  deep: '#8E7FB8',
  ink: '#4A3F6B',
} as const;

export const fonts = {
  // Narrative body copy, spread titles (descriptive mode), covers.
  display: "'Newsreader', Georgia, 'Times New Roman', serif",
  displayItalic: "'Newsreader', Georgia, serif",
  // Quote-mode spread titles + attribution lines (Stage B title modes).
  script: "'Caveat', cursive",
  // UI chrome (preview app) and small book microcopy (QR captions, date labels).
  sans: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;
