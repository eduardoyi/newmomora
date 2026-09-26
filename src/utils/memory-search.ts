// Pure helpers for the Timeline search screen (docs/features/memory-search.md).

import type { MemoryWithTags } from '@/services/memories';
import { formatMemoryExcerpt } from '@/utils/memories';
import { toLinkPreviewMap } from '@/utils/links';
import { memoryFallbackKind, type MemoryFallbackKind } from '@/utils/memory-fallback';

/** Lower-case and strip accents, matching the server's search_normalize(). */
function normalizeChar(char: string): string {
  return char.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function normalizeSearchText(value: string): string {
  return Array.from(value).map(normalizeChar).join('');
}

/** Same word split as the server's memory_search_query(). */
export function searchWords(query: string): string[] {
  return normalizeSearchText(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const EXCERPT_LEAD = 24;

/**
 * Splits `text` into plain and highlighted segments: any word starting
 * with a query word (accent- and case-insensitive, like the server's
 * prefix match) has that prefix highlighted. When the first match is deep
 * in a long text, the excerpt starts shortly before it with an ellipsis so
 * a two-line row still shows why it matched.
 */
export function highlightSearchMatches(text: string, query: string): HighlightSegment[] {
  const words = searchWords(query);
  if (!text || words.length === 0) return text ? [{ text, match: false }] : [];

  const ranges: [number, number][] = [];
  for (const token of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const tokenChars = Array.from(token[0]);
    const normalized = tokenChars.map(normalizeChar);
    const joined = normalized.join('');
    const word = words.find((candidate) => joined.startsWith(candidate));
    if (!word) continue;
    // Map the matched normalized length back to original characters.
    let consumed = 0;
    let chars = 0;
    while (consumed < word.length && chars < tokenChars.length) {
      consumed += normalized[chars].length;
      chars += 1;
    }
    const start = token.index ?? 0;
    ranges.push([start, start + tokenChars.slice(0, chars).join('').length]);
  }
  if (ranges.length === 0) return [{ text, match: false }];

  let offset = 0;
  let prefix = '';
  if (ranges[0][0] > EXCERPT_LEAD * 2) {
    const lead = text.lastIndexOf(' ', ranges[0][0] - EXCERPT_LEAD);
    offset = lead > 0 ? lead + 1 : ranges[0][0] - EXCERPT_LEAD;
    prefix = '…';
  }

  const segments: HighlightSegment[] = [];
  let cursor = offset;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  if (prefix && segments.length > 0) segments[0] = { ...segments[0], text: `${prefix}${segments[0].text}` };
  return segments;
}

/** The visible text for a result row: the memory's words, or its kind. */
export function searchResultText(memory: MemoryWithTags): string {
  const excerpt = formatMemoryExcerpt(memory.content, 400, toLinkPreviewMap(memory.link_previews));
  if (excerpt) return excerpt;
  if (memory.memory_type === 'audio') return 'Voice memory';
  const cover = memory.mediaAssets[0]?.content_type ?? memory.media_content_type;
  if (cover?.startsWith('video/')) return 'Video';
  if (memory.memory_type === 'media') return 'Photo';
  return 'Memory';
}

export interface SearchResultThumbnail {
  /** R2 key of the still to show, if any. */
  key: string | null;
  fallback: MemoryFallbackKind;
}

/**
 * Picks a result row's thumbnail: the illustration (unless reported), then
 * the cover's list-sized preview or video poster, then an image original --
 * never a video/audio original. Otherwise the drawer's quote/sound tile.
 */
export function searchResultThumbnail(memory: MemoryWithTags, illustrationHidden: boolean): SearchResultThumbnail {
  const fallback = memoryFallbackKind(memory.memory_type, memory.media_content_type);
  if (memory.illustration_key && !illustrationHidden) return { key: memory.illustration_key, fallback };
  const cover = memory.mediaAssets[0];
  if (cover?.preview_object_key) return { key: cover.preview_object_key, fallback };
  if (cover?.content_type.startsWith('image/')) return { key: cover.object_key, fallback };
  if (!cover && memory.media_key && memory.media_content_type?.startsWith('image/')) {
    return { key: memory.media_key, fallback };
  }
  return { key: null, fallback };
}
