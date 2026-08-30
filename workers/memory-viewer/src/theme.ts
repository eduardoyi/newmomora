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
  // Keep these aligned with src/constants/theme.ts. The viewer uses the
  // white surface for its framed card and `surface` for contained media.
  surface: '#F4F3F8',
  white: '#FFFFFF',
  border: '#EBE7F2',
  borderStrong: '#CFC8E0',

  ink: '#2C2418',
  ink2: '#6B5E4F',
  ink3: '#9A8B79',

  primary: '#D63E78',
  primarySoft: '#FBD3E2',
  primaryTint: '#FDEAF1',
} as const;

// Soft detail-screen tints copied from src/constants/theme.ts. The QR viewer
// is a separate Worker deploy unit, so it cannot import the app's tokens.
// Keep this list in sync when a supported emotion changes there.
export const emotionColors = {
  joy: { c: '#F5A623', soft: '#FFE7B0', ink: '#8a5b13' },
  funny: { c: '#F07E3A', soft: '#FCDCC0', ink: '#8a4416' },
  calm: { c: '#6BB58A', soft: '#D6EDDE', ink: '#3f6a4c' },
  wonder: { c: '#4F8FCC', soft: '#CFE1F4', ink: '#3a5b7a' },
  tender: { c: '#EC7FA1', soft: '#FBD6E1', ink: '#9c4f68' },
  mischief: { c: '#9863B8', soft: '#E5D2F1', ink: '#5c4374' },
  pride: { c: '#E0654E', soft: '#F8D6CC', ink: '#893524' },
  bittersweet: { c: '#C77FA0', soft: '#EFD7E1', ink: '#743f59' },
  worry: { c: '#5C7A9B', soft: '#D7E0EA', ink: '#354a63' },
  weary: { c: '#8F8A86', soft: '#E6E1DD', ink: '#524d49' },
  sad: { c: '#6A6CA6', soft: '#DCDCEF', ink: '#3f4066' },
} as const;

export type ViewerEmotion = keyof typeof emotionColors;

export function getEmotionColors(emotion: string | null | undefined) {
  if (!emotion) return null;
  const normalized = emotion.trim().toLowerCase();
  if (!(normalized in emotionColors)) return null;
  return emotionColors[normalized as ViewerEmotion];
}

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
  lg: 16,
  xl: 24,
  pill: 999,
} as const;
