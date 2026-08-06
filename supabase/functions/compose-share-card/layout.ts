// ─────────────────────────────────────────────────────────────────────────
// KEEP IN SYNC with src/components/memory-card.tsx (SpreadCard/QuoteCard,
// CardFooter, AvatarCluster) and src/components/wordmark.tsx.
//
// This builds the satori JSX tree for the memory share card -- a simplified,
// server-side reproduction of the in-app card (plan:
// docs/plans/offline-awareness-and-share-cards.md, Workstream S, step S3).
// Differences from the in-app card are DELIBERATE, not drift:
//   - No engagement icons (like/comment), no attribution.
//   - No emotion chip -- the "Momora." wordmark sits in that slot instead.
//   - Full, untruncated caption (the in-app card truncates to ~140 chars via
//     formatMemoryExcerpt; the share card never truncates -- see S3 spec).
//   - Tagged-member portraits have no name chips (avatars only).
// Everything else (colors, radii, spacing, font choices, footer layout,
// avatar-cluster overlap) is intentionally pixel-matched where satori's CSS
// subset allows it. If you change memory-card.tsx's visual design, check
// whether this file needs the same change, and vice versa.
//
// Deno Edge Functions cannot import from src/, so theme tokens are
// duplicated in SHARE_CARD_THEME below -- keep those values equal to
// src/constants/theme.ts's `colors`/`radius`/`spacing` exports by hand.
//
// Every pixel value below (font sizes, paddings, radii, avatar sizes) is a
// LOGICAL (RN dp) value, copied verbatim from memory-card.tsx/theme.ts --
// NOT a raster pixel value. buildShareCardTree's `scale` argument (see its
// doc comment) is what converts these to the final raster size; see
// scale.ts's header comment for why composing directly at a raster width
// was the bug.
// ─────────────────────────────────────────────────────────────────────────

import { LOGICAL_CARD_WIDTH } from './scale.ts';

export interface SatoriNode {
  type: string;
  props: Record<string, unknown> & { children?: SatoriNode | SatoriNode[] | string };
}

/** Minimal JSX-less node builder, matching the pattern proven in
 * supabase/functions/compose-share-card-spike/index.ts. */
export function h(
  type: string,
  props: Record<string, unknown> = {},
  children?: SatoriNode | SatoriNode[] | string,
): SatoriNode {
  return { type, props: { ...props, children } };
}

// Mirrors src/constants/theme.ts `colors`. Keep values identical.
export const SHARE_CARD_THEME = {
  bg: '#FAFAFD',
  white: '#FFFFFF',
  surface: '#F4F3F8',
  border: '#EBE7F2',
  ink: '#2C2418',
  ink2: '#6B5E4F',
  ink3: '#9A8B79',
  primary: '#D63E78',
} as const;

// Mirrors src/constants/theme.ts `radius`/`spacing` (px, pre-scale).
export const SHARE_CARD_RADIUS_LG = 16;
export const SHARE_CARD_SPACING_MD = 16;

// ── Emotion colors ───────────────────────────────────────────────────────
// KEEP IN SYNC with src/constants/theme.ts `emotionColors` (Deno Edge
// Functions cannot import from src/) -- that's the source of truth; if you
// add/change an emotion there, mirror it here too. If theme.ts adds an
// emotion this map doesn't know about yet, `shareCardEmotionColors` falls
// back to null (the quote card's existing neutral tint), same as the
// client's own `getEmotionColors` unknown-emotion behavior.
//
// BUG FIX (device report -- text-only/quote share cards render with a GRAY
// accent strip regardless of the memory's mood): this function used to
// never select `emotion` at all -- a documented v1 simplification ("the
// share card never loads `emotion`, dropped along with the emotion chip")
// that the user has now overruled specifically for the quote card's accent
// strip + quote-glyph tint (the emotion CHIP itself stays dropped; the
// wordmark keeps that slot, per S3). `emotion` is fetched for this
// coloring only -- per AGENTS.md logging discipline, it is never logged
// (it flows straight from a DB select into a color-table lookup, never into
// a console.* call anywhere in this package).
export const SHARE_CARD_EMOTION_COLORS: Record<string, { c: string; soft: string; ink: string }> = {
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
};

/** Returns null for a null/unrecognized emotion -- callers fall back to the
 * card's fixed neutral tint, matching getEmotionColors' contract. */
export function shareCardEmotionColors(
  emotion: string | null | undefined,
): { c: string; soft: string; ink: string } | null {
  if (!emotion || !(emotion in SHARE_CARD_EMOTION_COLORS)) {
    return null;
  }
  return SHARE_CARD_EMOTION_COLORS[emotion];
}

// Mirrors MAX_TIMELINE_MEMBER_AVATARS in src/components/memory-card.tsx.
export const MAX_VISIBLE_MEMBERS = 6;

export type ShareCardVariant = 'spread' | 'quote';

export interface ShareCardMemberPortrait {
  name: string;
  /** Data URI for the member's current portrait/photo, or null to fall back
   * to an initial-letter circle (mirrors FamilyMemberAvatar's fallback). */
  dataUri: string | null;
}

export interface ShareCardData {
  variant: ShareCardVariant;
  /** Pre-formatted display date, e.g. "Aug 5, 2026" (see formatDateLabel below). */
  dateLabel: string;
  /** Full, untruncated memory content. Empty string when there is none. */
  caption: string;
  /** null for text-only cards. */
  imageDataUri: string | null;
  /** width / height of the image block. Required when imageDataUri is set. */
  imageAspectRatio: number | null;
  /** Already capped to MAX_VISIBLE_MEMBERS by the caller. */
  members: ShareCardMemberPortrait[];
  /** Count of additional tagged members beyond the visible cap. */
  memberOverflowCount: number;
  /** Memory's emotion label, or null. Only used by the quote (text-only)
   * variant's accent strip + quote-glyph tint (shareCardEmotionColors
   * above) -- the spread variant's emotion CHIP stays dropped per S3 (the
   * wordmark keeps that slot); this is NOT logged anywhere (AGENTS.md
   * logging discipline). */
  emotion: string | null;
}

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Mirrors src/utils/memories.ts formatDisplayDate's "Mon D, YYYY" style
 * (that function uses `toLocaleDateString` with month:'short'; duplicated
 * here as a fixed table so output doesn't depend on the Edge Function
 * isolate's ICU locale data). Parses as local midnight, matching the
 * client's `${dateValue}T00:00:00` convention so a YYYY-MM-DD memory_date
 * never shifts a day across timezones. */
export function formatShareCardDateLabel(memoryDateIso: string): string {
  const parsed = new Date(`${memoryDateIso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return memoryDateIso;
  }
  const month = MONTH_LABELS[parsed.getMonth()].slice(0, 3);
  return `${month} ${parsed.getDate()}, ${parsed.getFullYear()}`;
}

// Batched design tweak (Eduardo, 2026-08-05, docs/plans/share-card-store-through.md
// W2): the wordmark reads as too prominent sitting in the footer's emotion-chip
// slot -- 20% smaller (0.8x the previous logical size of 20, i.e. 16) and
// softened to opacity 0.8 makes it subtler, closer to a signature than a
// label. This is a LAYOUT change: see index.ts's DESIGN_VERSION (bumped to 2
// specifically for this tweak) -- stored cards regenerate lazily on next
// share instead of ever showing the old wordmark from a live cache entry.
export const SHARE_CARD_WORDMARK_FONT_SIZE = 16;
export const SHARE_CARD_WORDMARK_OPACITY = 0.8;

function wordmarkNode(size: number): SatoriNode {
  // Replicates src/components/wordmark.tsx: Newsreader medium, tight
  // negative letter-spacing, trailing period in the primary color.
  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'row',
        fontFamily: 'Newsreader-Medium',
        fontSize: size,
        color: SHARE_CARD_THEME.ink,
        letterSpacing: size * -0.025,
        opacity: SHARE_CARD_WORDMARK_OPACITY,
      },
    },
    [
      h('span', {}, 'Momora'),
      h('span', { style: { color: SHARE_CARD_THEME.primary } }, '.'),
    ],
  );
}

function memberAvatarNode(member: ShareCardMemberPortrait, size: number, marginLeft: number): SatoriNode {
  const commonStyle = {
    display: 'flex',
    width: size,
    height: size,
    borderRadius: size,
    marginLeft,
    border: `1.5px solid ${SHARE_CARD_THEME.white}`,
  };

  if (member.dataUri) {
    // Belt-and-braces (same objectFit: 'cover' fix as imageBlockNode above)
    // -- portrait avatars are square boxes and portraitBytesToDataUri
    // (index.ts) already downscales to a small edge without changing
    // aspect ratio, so a squished portrait is unlikely in practice, but a
    // non-square LEGACY portrait source would otherwise stretch into this
    // circle exactly like the hero-image bug did.
    return h('img', {
      src: member.dataUri,
      width: size,
      height: size,
      style: { ...commonStyle, objectFit: 'cover' },
    });
  }

  // Fallback: initial-letter circle, mirroring FamilyMemberAvatar's
  // no-image state (simplified to a neutral tint -- the client's per-name
  // color hash isn't worth reproducing for this small, name-less avatar).
  return h(
    'div',
    {
      style: {
        ...commonStyle,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: SHARE_CARD_THEME.surface,
      },
    },
    h(
      'span',
      { style: { fontFamily: 'Jakarta-Bold', fontSize: size * 0.42, color: SHARE_CARD_THEME.ink3 } },
      member.name.charAt(0).toUpperCase() || '?',
    ),
  );
}

function avatarClusterNode(
  members: ShareCardMemberPortrait[],
  overflowCount: number,
  s: (px: number) => number,
): SatoriNode {
  const size = s(22);
  const children: SatoriNode[] = members.map((member, index) =>
    memberAvatarNode(member, size, index === 0 ? 0 : s(-7))
  );

  if (overflowCount > 0) {
    children.push(
      h(
        'div',
        {
          style: {
            display: 'flex',
            width: size,
            height: size,
            borderRadius: size,
            marginLeft: s(-7),
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: SHARE_CARD_THEME.surface,
          },
        },
        h(
          'span',
          { style: { fontFamily: 'Jakarta-Bold', fontSize: s(8), color: SHARE_CARD_THEME.ink3 } },
          `+${overflowCount}`,
        ),
      ),
    );
  }

  return h('div', { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', marginLeft: s(2) } }, children);
}

/** Footer row: date | avatar cluster | (spacer) | wordmark -- the wordmark
 * occupies the slot CardFooter gives the emotion chip in the in-app card. */
function footerNode(data: ShareCardData, s: (px: number) => number): SatoriNode {
  const children: SatoriNode[] = [
    h(
      'div',
      {
        style: {
          display: 'flex',
          fontFamily: 'Jakarta-Bold',
          fontSize: s(10),
          letterSpacing: s(10) * 0.14,
          color: SHARE_CARD_THEME.ink3,
        },
      },
      data.dateLabel.toUpperCase(),
    ),
  ];

  if (data.members.length > 0) {
    children.push(avatarClusterNode(data.members, data.memberOverflowCount, s));
  }

  children.push(h('div', { style: { display: 'flex', flexGrow: 1 } }));
  children.push(wordmarkNode(s(SHARE_CARD_WORDMARK_FONT_SIZE)));

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(8),
        paddingLeft: s(SHARE_CARD_SPACING_MD),
        paddingRight: s(SHARE_CARD_SPACING_MD),
        paddingTop: s(9),
        paddingBottom: s(13),
      },
    },
    children,
  );
}

// Mirrors src/components/memory-card.tsx `styles.caption.fontSize` (spread
// card body copy). Exported so proportion-regression tests can assert the
// emitted tree's font-size/card-width ratio against this exact value
// instead of a re-typed magic number that could silently drift.
export const SHARE_CARD_BODY_FONT_SIZE = 14.5;

function captionNode(caption: string, fontFamily: string, s: (px: number) => number): SatoriNode | null {
  if (!caption.trim()) {
    return null;
  }

  return h(
    'div',
    {
      style: {
        display: 'flex',
        fontFamily,
        fontSize: s(SHARE_CARD_BODY_FONT_SIZE),
        lineHeight: 1.52,
        color: SHARE_CARD_THEME.ink,
        paddingLeft: s(SHARE_CARD_SPACING_MD),
        paddingRight: s(SHARE_CARD_SPACING_MD),
        paddingTop: s(13),
        paddingBottom: s(2),
        whiteSpace: 'pre-wrap',
      },
    },
    caption,
  );
}

/**
 * BUG FIX (device report -- a tall photo renders visibly SQUISHED
 * (stretched short/wide) on the share card, while the SAME photo in-app
 * shows cropped-to-fit, undistorted): `clampMediaAspectRatio`
 * (index.ts) is correct and stays -- it bounds the image BLOCK's aspect
 * ratio into [3/4, 16/9] as part of the pixel-budget mitigation (an
 * unclamped extreme ratio inflates the card's height). The bug was never
 * the clamp itself -- it's that satori's `<img>` defaults to STRETCHING
 * its source non-uniformly to exactly fill the given width/height, so a
 * source image whose TRUE aspect ratio differs from the (clamped) block's
 * aspect ratio got squashed into it. The in-app card
 * (MediaVisual/MemoryMediaCarousel) always renders with RN's `resizeMode:
 * 'cover'` -- crop-to-fill, preserving the source's own aspect ratio --
 * never a stretch. `objectFit: 'cover'` (satori supports the CSS
 * `object-fit` property on `<img>`) reproduces that exact semantic:
 * verified empirically (this package's implementation report) that it
 * scales the embedded image UNIFORMLY to cover the box then clips the
 * overflow, not a non-uniform width/height stretch.
 */
function imageBlockNode(data: ShareCardData, width: number): SatoriNode {
  const height = Math.round(width / (data.imageAspectRatio ?? 4 / 3));
  return h('img', {
    src: data.imageDataUri,
    width,
    height,
    style: { display: 'flex', objectFit: 'cover' },
  });
}

function buildSpreadCard(data: ShareCardData, width: number, s: (px: number) => number): SatoriNode {
  const children: SatoriNode[] = [];

  if (data.imageDataUri) {
    children.push(imageBlockNode(data, width));
  }

  const caption = captionNode(data.caption, 'Jakarta-Regular', s);
  if (caption) {
    children.push(caption);
  }

  children.push(footerNode(data, s));

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width,
        backgroundColor: SHARE_CARD_THEME.white,
        border: `1px solid ${SHARE_CARD_THEME.border}`,
        borderRadius: s(SHARE_CARD_RADIUS_LG),
        // BUG FIX (device report -- photo bleeds past the card's top
        // rounded corners): satori does not clip a child to its parent's
        // borderRadius unless the parent also sets overflow: hidden -- the
        // full-bleed photo (imageBlockNode, first child, flush against the
        // top edge) was drawn as a plain rectangle straight over the
        // card's rounded top corners. This is the fix, verified visually
        // via local compose (see this package's implementation report).
        overflow: 'hidden',
      },
    },
    children,
  );
}

/** Decorative opening-quotation-mark glyph, top-left above the caption --
 * replicates app/(app)/memory/[id]/index.tsx's `MemoryDetailEditorial`
 * (`styles.editorialQuote`: Newsreader regular, fontSize 56 / lineHeight 56
 * / height 34 clipped / opacity 0.18 / marginBottom -6, tinted with the
 * memory's emotion `ink` color, falling back to ink3), converted to this
 * file's logical units via `s`.
 *
 * BUG FIX (device report -- the glyph's curled descender overlapped the
 * ascender of the caption's first line, e.g. touching the top of a capital
 * "H"/"W"): satori's flexbox `div` clips/positions a fixed-height text box
 * differently than React Native's `Text`, so a direct port of the RN
 * height/marginBottom values sat measurably closer to the caption below it
 * here than in the app. Verified visually (this package's implementation
 * report, quote-glyph-repro renders): `height` trimmed 34->30 (clips a
 * touch more of the glyph's own tail) and `marginBottom` flipped from -6
 * (pulling the caption UP, i.e. closer/overlapping) to +2 (real clearance)
 * -- across a one-word caption, a single short line, and a two-line
 * caption, both cap-height ("H") and round-top ("W") first letters now
 * clear the glyph with visible whitespace.
 *
 * FOLLOW-UP (user feedback, docs/plans/share-card-store-through.md's
 * four-part fix, 2026-08-05): +2 read as still touching on a real device --
 * bumped another +6 to +8 total for clearer separation from the caption.
 * This is a LAYOUT change: see index.ts's `DESIGN_VERSION` (bumped
 * specifically for this tweak) -- stored cards regenerate lazily on next
 * share instead of ever showing the tighter old spacing from a live cache
 * entry. Verified visually via a local compose (this package's
 * implementation report) against a short, one-line, and two-line caption. */
function quoteGlyphNode(color: string, s: (px: number) => number): SatoriNode {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        fontFamily: 'Newsreader-Regular',
        fontSize: s(56),
        lineHeight: 1,
        height: s(30),
        color,
        opacity: 0.18,
        paddingLeft: s(18),
        paddingTop: s(18),
        marginBottom: s(8),
      },
    },
    '“',
  );
}

function buildQuoteCard(data: ShareCardData, width: number, s: (px: number) => number): SatoriNode {
  // BUG FIX (device report -- quote card's accent strip + (missing)
  // quote-glyph render gray/absent regardless of the memory's mood): this
  // used to be a fixed neutral tint because the function never selected
  // `emotion` at all (a documented v1 simplification the user has now
  // overruled for the quote card specifically -- see shareCardEmotionColors'
  // header comment). `emo` is null for a null/unrecognized emotion, and
  // every color use below falls back to the original fixed neutral tint in
  // that case, so an untagged memory looks exactly as it did before this
  // fix.
  const emo = shareCardEmotionColors(data.emotion);

  const children: SatoriNode[] = [
    // Decorative top accent, structurally mirroring memory-card.tsx's
    // `quoteAccent` strip (which tints with `emo.soft`).
    h('div', {
      style: {
        display: 'flex',
        height: s(3),
        backgroundColor: emo?.soft ?? SHARE_CARD_THEME.border,
        borderTopLeftRadius: s(SHARE_CARD_RADIUS_LG),
        borderTopRightRadius: s(SHARE_CARD_RADIUS_LG),
      },
    }),
    quoteGlyphNode(emo?.ink ?? SHARE_CARD_THEME.ink3, s),
    h(
      'div',
      {
        style: {
          display: 'flex',
          fontFamily: 'Newsreader-Italic',
          fontSize: s(22),
          lineHeight: 1.28,
          color: SHARE_CARD_THEME.ink,
          padding: `0px ${s(18)}px ${s(4)}px ${s(18)}px`,
          whiteSpace: 'pre-wrap',
        },
      },
      data.caption,
    ),
    footerNode(data, s),
  ];

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width,
        backgroundColor: SHARE_CARD_THEME.white,
        border: `1px solid ${SHARE_CARD_THEME.border}`,
        borderRadius: s(SHARE_CARD_RADIUS_LG),
        // Same corner-clip fix as buildSpreadCard above -- the accent strip
        // is flush against the top edge and needs the parent's
        // overflow:hidden to be cropped by the card's rounded corners.
        overflow: 'hidden',
      },
    },
    children,
  );
}

/**
 * Builds the full card tree, composed entirely in LOGICAL (dp) units and
 * then scaled to a raster pixel size by `scale` -- BASE_SCALE for the
 * primary 1080px output, or scale.ts's `resolveShareCardOutputScale`'s
 * CONTINUOUS budget-fit scale (tail fix, docs/plans/
 * share-card-store-through.md's four-part production fix -- replaced the
 * original fixed REDUCED_SCALE/720px second tier) for a caption long
 * enough to need scaling down. The card's own width is
 * `s(LOGICAL_CARD_WIDTH)`, NOT a raw raster width -- every other pixel
 * value in this file (font sizes, paddings, radii, avatar sizes) is a
 * logical value too, so `s` scales the whole card uniformly and
 * proportions are preserved exactly: this is what keeps ANY scaled-down
 * render the IDENTICAL layout at a smaller size, not a reflow -- the
 * original S0-mandated mitigation
 * (docs/plans/offline-awareness-and-share-cards.md S0/S3): full caption
 * always, never truncated to fit a pixel budget.
 */
export function buildShareCardTree(data: ShareCardData, scale: number): SatoriNode {
  const s = (px: number) => Math.round(px * scale);
  const width = s(LOGICAL_CARD_WIDTH);

  return data.variant === 'quote'
    ? buildQuoteCard(data, width, s)
    : buildSpreadCard(data, width, s);
}
