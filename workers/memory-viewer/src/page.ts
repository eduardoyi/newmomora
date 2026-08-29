import { colors, fonts, radius } from './theme';
import type { ResolvedMedia } from './resolve';

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
  const parsed = new Date(`${memoryDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const BASE_STYLE = `
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
    padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
  }
  .wrap { width: 100%; max-width: 480px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .card {
    width: 100%;
    background: ${colors.surface};
    border: 1px solid ${colors.border};
    border-radius: ${radius.lg}px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(44, 36, 24, 0.08), 0 8px 24px rgba(44, 36, 24, 0.06);
  }
  .media { display: block; width: 100%; max-height: 80vh; background: ${colors.ink}; }
  img.media, video.media { object-fit: contain; }
  .meta { padding: 16px 20px 20px; }
  .date {
    margin: 0 0 6px;
    font-family: ${fonts.sans};
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: ${colors.ink3};
  }
  .caption {
    margin: 0;
    font-family: ${fonts.display};
    font-size: 19px;
    line-height: 1.45;
    color: ${colors.ink};
  }
  .audio-shell {
    padding: 40px 20px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    background: ${colors.primaryTint};
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
    font-style: italic;
    font-size: 15px;
    color: ${colors.ink3};
  }
`;

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
    font-style: italic;
    font-size: 15px;
    color: ${colors.ink3};
  }
`;

/**
 * Render the `/m/:memoryId` viewer page for an already-resolved media
 * asset. `mediaUrl` is the same worker's `/media/:memoryId` route --
 * kept as a plain parameter (rather than hardcoded here) so this stays a
 * pure function of its inputs for testing.
 */
export function renderViewerPage(media: ResolvedMedia, mediaUrl: string): string {
  const dateLabel = formatMemoryDate(media.memoryDate);
  const dateHtml = dateLabel ? `<p class="date">${escapeHtml(dateLabel)}</p>` : '';
  const captionHtml = media.caption ? `<p class="caption">${escapeHtml(media.caption)}</p>` : '';
  const safeMediaUrl = escapeHtml(mediaUrl);

  let mediaHtml: string;
  if (media.kind === 'image') {
    mediaHtml = `<img class="media" src="${safeMediaUrl}" alt="A shared Momora memory" />`;
  } else if (media.kind === 'video') {
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
<title>A Momora memory</title>
<style>${BASE_STYLE}</style>
</head>
<body>
<main class="wrap">
<div class="card">
${mediaHtml}
<div class="meta">
${dateHtml}
${captionHtml}
</div>
</div>
<p class="brand">Momora</p>
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
<p class="brand">Momora</p>
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
<p class="brand">Momora</p>
</main>
</body>
</html>`;
}
