import type { MemoryWithTags } from '@/services/memories';
import { highlightSearchMatches, searchResultText, searchResultThumbnail, searchWords } from '@/utils/memory-search';

function memory(overrides: Partial<MemoryWithTags> = {}): MemoryWithTags {
  return {
    id: 'memory-1',
    content: null,
    memory_type: 'text_only',
    illustration_key: null,
    media_key: null,
    media_content_type: null,
    link_previews: {},
    emotion: null,
    mediaAssets: [],
    taggedMembers: [],
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    ...overrides,
  } as MemoryWithTags;
}

function asset(overrides: Record<string, unknown>) {
  return { id: 'a', object_key: 'u/m/a.jpg', content_type: 'image/jpeg', preview_object_key: null, ...overrides } as never;
}

describe('searchWords', () => {
  it('splits like the server: lower-cased, accent-free, punctuation dropped, max 8 words', () => {
    expect(searchWords('  Cumpleaños, de MARÍA!  ')).toEqual(['cumpleanos', 'de', 'maria']);
    expect(searchWords('":*&|')).toEqual([]);
    expect(searchWords('a b c d e f g h i j')).toHaveLength(8);
  });
});

describe('highlightSearchMatches', () => {
  it('highlights word prefixes, ignoring accents and case', () => {
    expect(highlightSearchMatches('Cumpleaños de Mara en el café', 'cumple cafe')).toEqual([
      { text: 'Cumple', match: true },
      { text: 'años de Mara en el ', match: false },
      { text: 'café', match: true },
    ]);
  });

  it('only matches at the start of words', () => {
    expect(highlightSearchMatches('Enzo and Lorenzo', 'enzo')).toEqual([
      { text: 'Enzo', match: true },
      { text: ' and Lorenzo', match: false },
    ]);
  });

  it('starts a long text shortly before a deep first match, with an ellipsis', () => {
    const text = 'Today we went to the market and bought so many things for the week, and then at the very end Enzo found a frog';
    const segments = highlightSearchMatches(text, 'frog');
    expect(segments[0].text.startsWith('…')).toBe(true);
    expect(segments.find((segment) => segment.match)?.text).toBe('frog');
    expect(segments.map((segment) => segment.text).join('').length).toBeLessThan(text.length);
  });

  it('returns the text unhighlighted when nothing matches or there is no query', () => {
    expect(highlightSearchMatches('Bedtime', 'dientes')).toEqual([{ text: 'Bedtime', match: false }]);
    expect(highlightSearchMatches('Bedtime', '')).toEqual([{ text: 'Bedtime', match: false }]);
  });
});

describe('searchResultText', () => {
  it('uses the memory text, or names the kind of memory', () => {
    expect(searchResultText(memory({ content: 'First steps!' }))).toBe('First steps!');
    expect(searchResultText(memory({ memory_type: 'audio', content: null }))).toBe('Voice memory');
    expect(searchResultText(memory({ memory_type: 'media', mediaAssets: [asset({ content_type: 'video/mp4' })] }))).toBe('Video');
    expect(searchResultText(memory({ memory_type: 'media', media_content_type: 'image/jpeg' }))).toBe('Photo');
  });
});

describe('searchResultThumbnail', () => {
  it('prefers the illustration unless it was reported', () => {
    const illustrated = memory({ memory_type: 'text_illustration', illustration_key: 'u/i.webp' });
    expect(searchResultThumbnail(illustrated, false)).toEqual({ key: 'u/i.webp', fallback: 'quote' });
    expect(searchResultThumbnail(illustrated, true)).toEqual({ key: null, fallback: 'quote' });
  });

  it('uses the cover preview or poster, then an image original, never a video or audio original', () => {
    expect(searchResultThumbnail(memory({ memory_type: 'media', mediaAssets: [asset({ preview_object_key: 'u/p.jpg' })] }), false).key).toBe('u/p.jpg');
    expect(searchResultThumbnail(memory({ memory_type: 'media', mediaAssets: [asset({})] }), false).key).toBe('u/m/a.jpg');
    expect(searchResultThumbnail(memory({ memory_type: 'media', mediaAssets: [asset({ object_key: 'u/v.mp4', content_type: 'video/mp4' })] }), false).key).toBeNull();
    expect(searchResultThumbnail(memory({ memory_type: 'audio', media_content_type: 'audio/mp4', mediaAssets: [asset({ object_key: 'u/c.m4a', content_type: 'audio/mp4' })] }), false)).toEqual({ key: null, fallback: 'sound' });
    expect(searchResultThumbnail(memory({ memory_type: 'media', media_key: 'u/legacy.jpg', media_content_type: 'image/jpeg' }), false).key).toBe('u/legacy.jpg');
  });
});
