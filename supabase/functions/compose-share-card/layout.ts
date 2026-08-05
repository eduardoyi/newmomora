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
    return h('img', {
      src: member.dataUri,
      width: size,
      height: size,
      style: commonStyle,
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
  children.push(wordmarkNode(s(20)));

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

function imageBlockNode(data: ShareCardData, width: number): SatoriNode {
  const height = Math.round(width / (data.imageAspectRatio ?? 4 / 3));
  return h('img', {
    src: data.imageDataUri,
    width,
    height,
    style: { display: 'flex' },
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
      },
    },
    children,
  );
}

function buildQuoteCard(data: ShareCardData, width: number, s: (px: number) => number): SatoriNode {
  const children: SatoriNode[] = [
    // Decorative top accent, structurally mirroring memory-card.tsx's
    // `quoteAccent` strip. The in-app version tints this with the memory's
    // emotion color; the share card never loads `emotion` (dropped along
    // with the emotion chip, per the S3 "no emotion chip" decision), so a
    // fixed neutral tint is used instead of a per-memory color.
    h('div', {
      style: {
        display: 'flex',
        height: s(3),
        backgroundColor: SHARE_CARD_THEME.border,
        borderTopLeftRadius: s(SHARE_CARD_RADIUS_LG),
        borderTopRightRadius: s(SHARE_CARD_RADIUS_LG),
      },
    }),
    h(
      'div',
      {
        style: {
          display: 'flex',
          fontFamily: 'Newsreader-Italic',
          fontSize: s(22),
          lineHeight: 1.28,
          color: SHARE_CARD_THEME.ink,
          padding: `${s(18)}px ${s(18)}px ${s(4)}px ${s(18)}px`,
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
      },
    },
    children,
  );
}

/**
 * Builds the full card tree, composed entirely in LOGICAL (dp) units and
 * then scaled to a raster pixel size by `scale` -- BASE_SCALE for the
 * primary 1080px output, REDUCED_SCALE for the 720px reduced-pixel-count
 * output (see scale.ts). The card's own width is `s(LOGICAL_CARD_WIDTH)`,
 * NOT a raw raster width -- every other pixel value in this file (font
 * sizes, paddings, radii, avatar sizes) is a logical value too, so `s`
 * scales the whole card uniformly and proportions are preserved exactly:
 * this is what keeps the 720px render the IDENTICAL layout at 2/3 size,
 * not a reflow -- the S0-mandated mitigation
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
