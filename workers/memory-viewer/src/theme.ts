/**
 * Momora design tokens for the QR memory-viewer page.
 *
 * Copied (not imported -- this worker is an isolated Cloudflare package
 * with its own deploy lifecycle, same rationale as
 * book-renderer/src/theme.ts's header comment) from the app's design
 * system at src/constants/theme.ts. Only the subset this worker's single
 * page actually uses. Keep in sync by hand whenever the source palette
 * changes.
 */

export const colors = {
  bg: '#FAFAFD',
  surface: '#FFFFFF',
  border: '#EBE7F2',
  borderStrong: '#CFC8E0',

  ink: '#2C2418',
  ink2: '#6B5E4F',
  ink3: '#9A8B79',

  primary: '#D63E78',
  primarySoft: '#FBD3E2',
  primaryTint: '#FDEAF1',
} as const;

// System-font stack chosen deliberately over the app's Newsreader/Jakarta
// webfonts -- see README "Design notes": this page is the very first thing
// a family member sees after scanning a printed QR code, often on cellular
// signal, and a webfont round-trip is a bad trade for a one-shot viewer.
export const fonts = {
  display: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const;

export const radius = {
  md: 12,
  lg: 20,
  pill: 999,
} as const;
