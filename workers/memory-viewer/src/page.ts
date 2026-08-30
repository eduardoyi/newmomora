import { colors, fonts, getEmotionColors, radius } from './theme';
import type { ResolvedMedia } from './resolve';

const DEFAULT_DESCRIPTION = 'A moment preserved in a Momora book.';
const OPEN_GRAPH_DESCRIPTION_MAX_LENGTH = 180;

export interface ViewerPageOptions {
  /** Absolute canonical `/m/:token` URL, supplied by the Worker route. */
  canonicalUrl?: string | null;
  /** Absolute, token-protected `/poster/:token` URL for the share preview. */
  posterUrl?: string | null;
  /** MIME type served by `posterUrl` (JPEG for media previews and the branded fallback). */
  posterContentType?: string | null;
  /** The memory's normalized emotion label, if analysis has completed. */
  emotion?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `memories.memory_date` is a plain `date` column (e.g. "2026-08-29") --
 * parse it as UTC midnight so the displayed day never shifts a day
 * backwards for viewers west of UTC (a bare `new Date("2026-08-29")` is
 * parsed as UTC by spec, but `new Date("2026-08-29T00:00:00")` -- no
 * offset -- would be local time; we pin the "Z" explicitly to avoid ever
 * relying on that distinction being remembered correctly later). */
function formatMemoryDate(memoryDate: string | null): string | null {
  if (!memoryDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(memoryDate);
  if (!match) return null;

  const [, year, month, day] = match;
  const parsed = new Date(`${memoryDate}T00:00:00Z`);
  // JavaScript normalizes impossible dates (for example, February 30) rather
  // than rejecting them. Check each field after parsing so bogus source data
  // cannot produce a misleading social title or footer.
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function displayCaption(caption: string | null): string | null {
  if (!caption) return null;
  const trimmed = caption.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function openGraphDescription(caption: string | null): string {
  const normalized = displayCaption(caption)?.replace(/\s+/g, ' ') ?? '';
  if (!normalized) return DEFAULT_DESCRIPTION;

  const characters = Array.from(normalized);
  if (characters.length <= OPEN_GRAPH_DESCRIPTION_MAX_LENGTH) return normalized;
  return `${characters.slice(0, OPEN_GRAPH_DESCRIPTION_MAX_LENGTH - 1).join('').trimEnd()}…`;
}

function absoluteHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function socialImageContentType(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized === 'image/jpeg' || normalized === 'image/png' || normalized === 'image/webp'
    ? normalized
    : null;
}

function emotionLabel(emotion: string | null | undefined): string | null {
  const theme = getEmotionColors(emotion);
  return theme && emotion ? emotion.trim().toLowerCase() : null;
}

function viewerStyle(emotion: string | null | undefined): string {
  const emotionTheme = getEmotionColors(emotion);
  const gradientStart = emotionTheme?.soft ?? colors.surface;

  return `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    background: linear-gradient(180deg, ${gradientStart} 0%, ${colors.bg} 46%, ${colors.bg} 100%);
    color: ${colors.ink};
    font-family: ${fonts.sans};
    display: grid;
    /* The single row fills a normal viewport but expands for a long caption. */
    grid-template-rows: minmax(min-content, 1fr);
    padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom));
  }
  .wrap {
    width: 100%;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    /* Auto margins center only when there is spare height; otherwise they
       collapse to zero so a tall card starts below the safe-area padding. */
    margin: auto;
  }
  .card {
    width: 100%;
    background: ${colors.white};
    border: 1px solid ${colors.border};
    border-radius: ${radius.xl}px;
    overflow: hidden;
    box-shadow: 0 24px 48px rgba(40, 30, 20, 0.08);
  }
  .media-wrap { padding: 10px 10px 0; }
  .media {
    display: block;
    width: 100%;
    border-radius: ${radius.lg}px;
    background: ${colors.surface};
    overflow: hidden;
  }
  /* Preserve the existing constrained treatment for tall still images. */
  img.media { height: auto; max-height: min(68dvh, 680px); object-fit: contain; }
  /* A video has no fixed-height frame: full width + auto height lets its
     intrinsic aspect ratio fill the card without side letterboxing. */
  video.media { height: auto; }
  .meta { display: flex; flex-direction: column; gap: 14px; padding: 14px 20px 20px; }
  .meta-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .date {
    margin: 0;
    font-family: ${fonts.sans};
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: ${colors.ink3};
  }
  .caption {
    margin: 0;
    font-family: ${fonts.sans};
    font-size: 16px;
    line-height: 26px;
    color: ${colors.ink};
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .emotion {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px 3px 7px;
    border-radius: ${radius.pill}px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.021em;
  }
  .emotion-dot {
    width: 5px;
    height: 5px;
    border-radius: ${radius.pill}px;
  }
  .audio-shell {
    padding: 32px 20px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    background: ${colors.primaryTint};
    border-radius: ${radius.lg}px;
  }
  .audio-icon {
    width: 64px;
    height: 64px;
    border-radius: ${radius.pill}px;
    background: ${colors.primarySoft};
    color: ${colors.primary};
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
  }
  audio.audio-player { width: 100%; }
  .brand {
    margin: 4px 0 0;
    font-family: ${fonts.display};
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.55px;
    color: ${colors.ink3};
  }
  .brand-dot { color: ${colors.primary}; }
`;
}

const NOT_FOUND_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100dvh;
    background: ${colors.bg};
    color: ${colors.ink};
    font-family: ${fonts.sans};
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 20px;
    text-align: center;
  }
  .wrap { max-width: 360px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  h1 { margin: 0; font-family: ${fonts.display}; font-size: 22px; color: ${colors.ink}; }
  p { margin: 0; font-size: 15px; line-height: 1.5; color: ${colors.ink2}; }
  .brand {
    margin-top: 18px;
    font-family: ${fonts.display};
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.5px;
    color: ${colors.ink3};
  }
  .brand-dot { color: ${colors.primary}; }
`;

function brandMarkup(): string {
  return 'Momora<span class="brand-dot">.</span>';
}

interface ViewerMetadata {
  browserTitle: string;
  canonicalUrl: string | null;
  description: string;
  imageAlt: string;
  imageContentType: string | null;
  openGraphTitle: string;
  posterUrl: string | null;
}

function viewerMetadata(
  media: ResolvedMedia,
  options: ViewerPageOptions,
): ViewerMetadata {
  const dateLabel = formatMemoryDate(media.memoryDate);
  return {
    browserTitle: dateLabel ? `${dateLabel} · Momora` : 'A Momora memory · Momora',
    canonicalUrl: absoluteHttpUrl(options.canonicalUrl),
    description: openGraphDescription(media.caption),
    imageAlt: dateLabel ? `A Momora memory from ${dateLabel}` : 'A Momora memory',
    imageContentType: socialImageContentType(options.posterContentType),
    openGraphTitle: dateLabel ? `A memory from ${dateLabel}` : 'A Momora memory',
    posterUrl: absoluteHttpUrl(options.posterUrl),
  };
}

function socialMetadataHtml(metadata: ViewerMetadata): string {
  const tags = [
    `<meta name="description" content="${escapeHtml(metadata.description)}" />`,
    `<meta property="og:title" content="${escapeHtml(metadata.openGraphTitle)}" />`,
    `<meta property="og:description" content="${escapeHtml(metadata.description)}" />`,
    '<meta property="og:site_name" content="Momora" />',
    '<meta property="og:type" content="website" />',
    `<meta name="twitter:title" content="${escapeHtml(metadata.openGraphTitle)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(metadata.description)}" />`,
  ];

  if (metadata.canonicalUrl) {
    const safeCanonicalUrl = escapeHtml(metadata.canonicalUrl);
    tags.push(
      `<link rel="canonical" href="${safeCanonicalUrl}" />`,
      `<meta property="og:url" content="${safeCanonicalUrl}" />`,
    );
  }

  if (metadata.posterUrl) {
    const safePosterUrl = escapeHtml(metadata.posterUrl);
    const safeImageAlt = escapeHtml(metadata.imageAlt);
    tags.push(
      `<meta property="og:image" content="${safePosterUrl}" />`,
      `<meta property="og:image:alt" content="${safeImageAlt}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
      `<meta name="twitter:image" content="${safePosterUrl}" />`,
      `<meta name="twitter:image:alt" content="${safeImageAlt}" />`,
    );
    if (metadata.imageContentType) {
      tags.push(`<meta property="og:image:type" content="${metadata.imageContentType}" />`);
    }
  } else {
    tags.push('<meta name="twitter:card" content="summary" />');
  }

  return tags.join('\n');
}

function mediaUrlFromCanonical(canonicalUrl: string | null | undefined): string | null {
  const normalizedCanonicalUrl = absoluteHttpUrl(canonicalUrl);
  if (!normalizedCanonicalUrl) return null;

  const canonical = new URL(normalizedCanonicalUrl);
  const tokenMatch = /^\/m\/([A-Za-z0-9_-]{8,128})$/.exec(canonical.pathname);
  if (!tokenMatch) return null;

  return new URL(`/media/${tokenMatch[1]}`, canonical).toString();
}

/**
 * Render the `/m/:token` viewer page for an already-resolved media
 * asset. The preferred two-argument API derives the same-origin
 * `/media/:token` URL from the supplied canonical viewer URL. The three-
 * argument form retains the old explicit `mediaUrl` parameter so existing
 * callers/tests can migrate without a flag day.
 */
export function renderViewerPage(media: ResolvedMedia, options?: ViewerPageOptions): string;
export function renderViewerPage(media: ResolvedMedia, mediaUrl: string, options?: ViewerPageOptions): string;
export function renderViewerPage(
  media: ResolvedMedia,
  mediaUrlOrOptions: string | ViewerPageOptions = {},
  passedOptions: ViewerPageOptions = {},
): string {
  const hasExplicitMediaUrl = typeof mediaUrlOrOptions === 'string';
  const options = hasExplicitMediaUrl ? passedOptions : mediaUrlOrOptions;
  const mediaUrl = hasExplicitMediaUrl
    ? mediaUrlOrOptions
    : mediaUrlFromCanonical(options.canonicalUrl) ?? '';
  const dateLabel = formatMemoryDate(media.memoryDate);
  const caption = displayCaption(media.caption);
  // The resolver carries emotion with the media payload. Keep the option as
  // an override for callers that already have fresher data, but never make
  // matching the native detail-card treatment depend on that optional field.
  const emotion = emotionLabel(options.emotion ?? media.emotion);
  const emotionTheme = getEmotionColors(emotion);
  const metadata = viewerMetadata(media, options);
  const dateHtml = dateLabel ? `<p class="date">${escapeHtml(dateLabel)}</p>` : '';
  const captionHtml = caption ? `<p class="caption">${escapeHtml(caption)}</p>` : '';
  const emotionHtml = emotion && emotionTheme
    ? `<span class="emotion" style="background:${emotionTheme.soft};color:${emotionTheme.ink}"><span class="emotion-dot" style="background:${emotionTheme.c}"></span>${escapeHtml(emotion)}</span>`
    : '';
  const footerHtml = dateHtml || emotionHtml
    ? `<div class="meta-footer">${dateHtml}${emotionHtml}</div>`
    : '';
  const safeMediaUrl = escapeHtml(mediaUrl);

  let mediaHtml: string;
  if (media.kind === 'image') {
    mediaHtml = `<img class="media" src="${safeMediaUrl}" alt="A Momora memory" />`;
  } else if (media.kind === 'video') {
    // `posterUrl` can be the neutral Open Graph fallback for an active
    // video without a captured frame. It is intentionally not used as the
    // player poster: scanning a book should reveal the video's own first
    // frame, never a generic sharing image.
    mediaHtml = `<video class="media" src="${safeMediaUrl}" controls playsinline preload="metadata"></video>`;
  } else {
    mediaHtml = `<div class="audio-shell"><div class="audio-icon" aria-hidden="true">&#9835;</div><audio class="audio-player" src="${safeMediaUrl}" controls preload="metadata"></audio></div>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(metadata.browserTitle)}</title>
${socialMetadataHtml(metadata)}
<style>${viewerStyle(emotion)}</style>
</head>
<body>
<main class="wrap">
<div class="card">
<div class="media-wrap">${mediaHtml}</div>
<div class="meta">
${captionHtml}
${footerHtml}
</div>
</div>
<p class="brand" aria-label="Momora">${brandMarkup()}</p>
</main>
</body>
</html>`;
}

/** Shared by: malformed/missing share token, an unknown (never-minted)
 * token, no matching memory, no media asset, or an unsupported media type.
 * Deliberately says nothing about *why* -- see README "Privacy model" (a
 * distinguishing error message would let someone probe whether a token was
 * ever minted at all). A REVOKED token gets its own, different page --
 * `renderRevokedPage` below -- rather than this one. */
export function renderNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Memory not found &middot; Momora</title>
<style>${NOT_FOUND_STYLE}</style>
</head>
<body>
<main class="wrap">
<h1>This memory isn&rsquo;t available</h1>
<p>The link may be mistyped, or the memory it points to may have been removed. If you scanned this from a printed Momora book, please check with whoever shared the book with you.</p>
<p class="brand" aria-label="Momora">${brandMarkup()}</p>
</main>
</body>
</html>`;
}

/**
 * Round-19: shown for a share token that WAS minted but has since been
 * revoked (`media_share_tokens.revoked_at` set) -- see `classifyShareToken`
 * in resolve.ts. Distinct copy from `renderNotFoundPage`: the person
 * scanning this code once had a real, working link, so "this link is no
 * longer active" is a truer explanation than "isn't available" (which
 * reads as "you mistyped/mis-scanned it"). Still says nothing about *why*
 * it was revoked -- same privacy posture as the unknown-token page, just
 * more honest about which of the two situations this is.
 */
export function renderRevokedPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Link no longer active &middot; Momora</title>
<style>${NOT_FOUND_STYLE}</style>
</head>
<body>
<main class="wrap">
<h1>This link is no longer active</h1>
<p>Whoever shared this Momora book has turned this link off. If you think that&rsquo;s a mistake, check with them directly.</p>
<p class="brand" aria-label="Momora">${brandMarkup()}</p>
</main>
</body>
</html>`;
}
