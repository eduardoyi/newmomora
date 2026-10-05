import { filmTitle, type FilmLanguage, type ResolvedFilm } from './film';
import { WORDMARK_DOT_PATH, WORDMARK_VIEWBOX, WORDMARK_WORD_PATH } from './wordmark';

/**
 * HTML for the public film page (`/f/:token`) and its calm no-film pages.
 * Same constraints as page.ts: inline CSS and script, no build step, no third
 * party requests (the wordmark is inline SVG outlines, not a webfont).
 *
 * The palette is the holiday film's (film-renderer/assemble.mjs, theme
 * 'holiday'): dusky rose-lilac, candlelit cream, wine night, berry, gold.
 * Copied by value like theme.ts; keep in sync by hand.
 */

const holiday = {
  lav: '#E9DEE4',
  cream: '#F6EBDD',
  plum: '#2F1F2B',
  ink: '#2C2418',
  ink2: '#6B5E4F',
  ink3: '#8E7F6D',
  berry: '#BE4568',
  paper: '#FFFDF9',
  gold: '#C79A4E',
} as const;

const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

interface FilmCopy {
  lang: string;
  playLabel: string;
  playHint: string;
  replayHint: string;
  description: string;
  imageAlt: string;
}

const COPY: Record<FilmLanguage, FilmCopy> = {
  es: {
    lang: 'es',
    playLabel: 'Reproducir con sonido',
    playHint: 'Toca para ver con sonido',
    replayHint: 'Toca para verla otra vez',
    description: 'Una película de nuestro año, hecha con Momora.',
    imageAlt: 'Portada de la película',
  },
  en: {
    lang: 'en',
    playLabel: 'Play with sound',
    playHint: 'Tap to play with sound',
    replayHint: 'Tap to watch again',
    description: 'A short film of our year, made with Momora.',
    imageAlt: 'Film cover',
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wordmarkSvg(): string {
  return `<svg class="wordmark" viewBox="${WORDMARK_VIEWBOX}" role="img" aria-label="Momora" xmlns="http://www.w3.org/2000/svg"><path class="wm-word" d="${WORDMARK_WORD_PATH}"/><path class="wm-dot" d="${WORDMARK_DOT_PATH}"/></svg>`;
}

const BASE_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { background: ${holiday.cream}; }
  .wordmark { display: block; height: 21px; width: auto; }
  .wm-word { fill: ${holiday.ink3}; }
  .wm-dot { fill: ${holiday.berry}; }
`;

const FILM_STYLE = `${BASE_STYLE}
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    background: linear-gradient(180deg, ${holiday.lav} 0%, ${holiday.cream} 100%);
    color: ${holiday.ink};
    font-family: ${SANS};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
  }
  /* The film is 9:16. The frame is as tall as the screen allows (minus the
     wordmark strip) and exactly 9:16, so the film is never cropped; extra
     width becomes warm margin, extra height a little more strip. */
  .stage {
    --strip: 44px;
    width: min(100vw, calc((100vh - var(--strip)) * 9 / 16));
    width: min(100vw, calc((100dvh - var(--strip)) * 9 / 16));
    aspect-ratio: 9 / 16;
    position: relative;
    background: ${holiday.plum};
    overflow: hidden;
    border-radius: 0;
    box-shadow: 0 24px 60px rgba(47, 31, 43, 0.28);
  }
  @media (min-width: 560px) { .stage { border-radius: 22px; } }
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: ${holiday.plum};
  }
  .play {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    cursor: pointer;
    color: #fff;
    font-family: ${SANS};
    -webkit-tap-highlight-color: transparent;
    background: linear-gradient(180deg, rgba(47, 31, 43, 0.12) 0%, rgba(47, 31, 43, 0.34) 100%);
  }
  .js .play { display: flex; }
  .js .play[hidden] { display: none; }
  .play-disc {
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: ${holiday.berry};
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 10px 30px rgba(47, 31, 43, 0.4), 0 0 0 8px rgba(255, 253, 249, 0.22);
    transition: transform 0.15s ease;
  }
  .play:active .play-disc { transform: scale(0.95); }
  .play-disc svg { width: 38px; height: 38px; margin-left: 6px; fill: ${holiday.paper}; }
  .play-hint {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.01em;
    text-shadow: 0 1px 8px rgba(47, 31, 43, 0.65);
  }
  .strip {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;

const NOTICE_STYLE = `${BASE_STYLE}
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    background: linear-gradient(180deg, ${holiday.lav} 0%, ${holiday.cream} 100%);
    color: ${holiday.ink};
    font-family: ${SANS};
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 20px;
    text-align: center;
  }
  .wrap { max-width: 360px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  h1 { margin: 0; font-family: ${SERIF}; font-size: 24px; line-height: 1.25; color: ${holiday.ink}; }
  p { margin: 0; font-size: 15px; line-height: 1.5; color: ${holiday.ink2}; }
  .rule { width: 36px; height: 2px; background: ${holiday.gold}; border: 0; margin: 6px 0; }
  .other { margin-top: 10px; padding-top: 14px; border-top: 1px solid rgba(47, 31, 43, 0.12); }
  .wordmark { margin-top: 22px; }
`;

/** Inline player script. No user data is interpolated into it. */
const PLAYER_SCRIPT = `
(function () {
  var root = document.documentElement;
  var video = document.getElementById('film');
  var play = document.getElementById('play');
  var hint = document.getElementById('play-hint');
  if (!video || !play) return;
  root.className += ' js';
  video.controls = false;
  var replayHint = play.getAttribute('data-replay-hint') || '';
  function start() {
    // A tap is the user gesture that lets the film play with sound.
    video.muted = false;
    if (video.ended) { try { video.currentTime = 0; } catch (e) {} }
    var started = video.play();
    play.hidden = true;
    video.controls = true;
    if (started && typeof started.catch === 'function') {
      started.catch(function () {
        // The browser refused (or the file failed): give the viewer the native
        // controls and the button back so a second tap can retry.
        play.hidden = false;
        video.controls = true;
      });
    }
  }
  play.addEventListener('click', start);
  video.addEventListener('ended', function () {
    if (hint && replayHint) hint.textContent = replayHint;
    play.hidden = false;
    video.controls = false;
  });
})();
`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self'",
  "media-src 'self'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers every `/f/` response carries on top of its own content-type. */
export const FILM_COMMON_HEADERS: Record<string, string> = {
  'x-robots-tag': 'noindex, nofollow',
  // The token is the credential: never leak it through Referer.
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export const FILM_HTML_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY;

export interface FilmPageOptions {
  /** Absolute canonical `/f/:token` URL (never derived from the request Host). */
  canonicalUrl: string;
  /** Absolute `/f/:token/poster` URL for the Open Graph image. */
  posterUrl: string;
  /** Same-origin video URL, `/f/:token/video`. */
  videoUrl: string;
  /** Same-origin poster URL for the player, `/f/:token/poster`. */
  posterPath: string;
}

export function renderFilmPage(film: ResolvedFilm, options: FilmPageOptions): string {
  const copy = COPY[film.language];
  const title = filmTitle(film);
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(copy.description);
  const safeCanonical = escapeHtml(options.canonicalUrl);
  const safePosterUrl = escapeHtml(options.posterUrl);

  return `<!doctype html>
<html lang="${copy.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<meta name="theme-color" content="${holiday.plum}" />
<title>${safeTitle} &middot; Momora</title>
<meta name="description" content="${safeDescription}" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDescription}" />
<meta property="og:site_name" content="Momora" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${safeCanonical}" />
<meta property="og:image" content="${safePosterUrl}" />
<meta property="og:image:type" content="image/jpeg" />
<meta property="og:image:width" content="1080" />
<meta property="og:image:height" content="1920" />
<meta property="og:image:alt" content="${escapeHtml(copy.imageAlt)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${safeTitle}" />
<meta name="twitter:description" content="${safeDescription}" />
<meta name="twitter:image" content="${safePosterUrl}" />
<link rel="canonical" href="${safeCanonical}" />
<style>${FILM_STYLE}</style>
</head>
<body>
<main class="stage">
<video id="film" src="${escapeHtml(options.videoUrl)}" poster="${escapeHtml(options.posterPath)}" controls playsinline webkit-playsinline preload="metadata" controlslist="nodownload"></video>
<button id="play" class="play" type="button" aria-label="${escapeHtml(copy.playLabel)}" data-replay-hint="${escapeHtml(copy.replayHint)}">
<span class="play-disc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg></span>
<span id="play-hint" class="play-hint">${escapeHtml(copy.playHint)}</span>
</button>
</main>
<footer class="strip">${wordmarkSvg()}</footer>
<script>${PLAYER_SCRIPT}</script>
</body>
</html>`;
}

function noticePage(lang: string, title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(title)} &middot; Momora</title>
<style>${NOTICE_STYLE}</style>
</head>
<body>
<main class="wrap">
${bodyHtml}
${wordmarkSvg()}
</main>
</body>
</html>`;
}

/** The film is blocked (content was removed from it) or not rendered yet. */
export function renderFilmUpdatingPage(language: FilmLanguage): string {
  if (language === 'es') {
    return noticePage(
      'es',
      'Estamos actualizando esta película',
      '<h1>Estamos actualizando esta película</h1><hr class="rule" /><p>Vuelve a intentarlo en un rato.</p>',
    );
  }
  return noticePage(
    'en',
    'This film is being updated',
    '<h1>This film is being updated</h1><hr class="rule" /><p>Please check back in a little while.</p>',
  );
}

/** Never-minted, malformed, or deleted: says nothing about which. The film's
 * language is unknown here, so both languages are shown. */
export function renderFilmNotFoundPage(): string {
  return noticePage(
    'es',
    'Enlace no disponible',
    '<h1>Este enlace no está disponible</h1><p>Puede que esté mal escrito o que la película ya no exista.</p>' +
      '<div class="other"><h1>This link isn&rsquo;t available</h1><p>It may be mistyped, or the film may no longer exist.</p></div>',
  );
}

/** A real link the family turned off. Distinct copy (and a 410) from not-found. */
export function renderFilmRevokedPage(): string {
  return noticePage(
    'es',
    'Enlace desactivado',
    '<h1>Esta familia desactivó este enlace</h1><p>Si crees que es un error, pregúntales directamente.</p>' +
      '<div class="other"><h1>This link has been turned off</h1><p>The family who shared it has switched it off. If that seems wrong, check with them directly.</p></div>',
  );
}
