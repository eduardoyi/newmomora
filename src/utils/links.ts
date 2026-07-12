import type { Json } from '@/types/database';

// Inline links (docs/features/inline-links.md): client mirror of URL
// extraction used by supabase/functions/_shared/link-preview.ts. Deno
// functions can't import from src/, so the extraction regex and trimming
// rules are kept identical by hand in both places -- this file has no
// fetching/SSRF logic (that only ever runs server-side).

export interface LinkPreviewEntry {
  title: string | null;
  fetchedAt: string;
}

export type LinkPreviewMap = Record<string, LinkPreviewEntry>;

export type ContentSegment = { type: 'text'; text: string } | { type: 'link'; url: string };

const MAX_LINKED_URLS = 5;

// Must stay identical to supabase/functions/_shared/link-preview.ts: greedy
// http(s) URL match, then trailing punctuation/ellipsis trimmed off. A
// missed exotic URL just stays plain text -- deliberately conservative.
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}"'…]+$/;

function urlMatchPattern(): RegExp {
  return /https?:\/\/\S+/g;
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCTUATION_REGEX, '');
}

export function extractUrls(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }

  const matches = text.match(urlMatchPattern()) ?? [];
  return matches.map(stripTrailingPunctuation).filter((url) => url.length > 0);
}

/**
 * Splits `text` into alternating plain-text and link segments for the first
 * five unique URLs. Repeats of those URLs remain links; later destinations
 * stay raw. A URL already wrapped in parens by the user renders as
 * `((Title))` -- the opening/closing parens stay in the surrounding text
 * segments and the link's own parens are added on top by the renderer.
 * Known accepted edge case (docs/plans/inline-links.md §5).
 */
export function splitContentIntoSegments(text: string | null | undefined): ContentSegment[] {
  if (!text) {
    return [];
  }

  const segments: ContentSegment[] = [];
  const pattern = urlMatchPattern();
  const linkedUrls = new Set<string>();
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const url = stripTrailingPunctuation(match[0]);

    if (!url) {
      // The whole match was punctuation (e.g. a bare "https://") -- leave
      // it as plain text by not advancing lastIndex past it here; it will
      // be included in the next text slice.
      continue;
    }

    const isAlreadyLinked = linkedUrls.has(url);

    if (!isAlreadyLinked && linkedUrls.size >= MAX_LINKED_URLS) {
      // Keep additional unique URLs byte-for-byte in the surrounding text.
      // Repeated occurrences of any of the first five URLs remain linked.
      continue;
    }

    linkedUrls.add(url);

    const matchStart = match.index;
    const urlEnd = matchStart + url.length;

    if (matchStart > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, matchStart) });
    }

    segments.push({ type: 'link', url });
    lastIndex = urlEnd;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}

function hostnameLabel(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  } catch {
    return url;
  }
}

/** Preview title if fetched and non-null, else the URL's domain (no `www.`). */
export function linkLabel(url: string, linkPreviews: LinkPreviewMap | null | undefined): string {
  const entry = linkPreviews?.[url];

  if (entry && typeof entry.title === 'string' && entry.title.trim()) {
    return entry.title;
  }

  return hostnameLabel(url);
}

/**
 * Replaces each link segment with `(label)` for plain-text card previews
 * (timeline/calendar/family list). URLs beyond the first five unique
 * destinations stay raw. Preview labels are not tappable there, just quieter
 * than a raw URL in a truncated excerpt.
 */
export function substituteLinkLabels(
  content: string | null | undefined,
  linkPreviews: LinkPreviewMap | null | undefined,
): string {
  if (!content) {
    return '';
  }

  return splitContentIntoSegments(content)
    .map((segment) => (segment.type === 'link' ? `(${linkLabel(segment.url, linkPreviews)})` : segment.text))
    .join('');
}

function isLinkPreviewEntry(value: unknown): value is LinkPreviewEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (typeof entry.title === 'string' || entry.title === null) && typeof entry.fetchedAt === 'string';
}

/**
 * Defensively narrows the jsonb `link_previews` column at the service
 * boundary: malformed entries (wrong shape, non-object map, etc.) are
 * treated as absent rather than thrown on.
 */
export function toLinkPreviewMap(value: Json | null | undefined): LinkPreviewMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: LinkPreviewMap = {};

  for (const [url, entry] of Object.entries(value as Record<string, Json>)) {
    if (isLinkPreviewEntry(entry)) {
      result[url] = entry;
    }
  }

  return result;
}
