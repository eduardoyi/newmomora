import {
  extractUrls,
  linkLabel,
  splitContentIntoSegments,
  substituteLinkLabels,
  toLinkPreviewMap,
  type LinkPreviewMap,
} from '@/utils/links';

describe('links utils', () => {
  describe('extractUrls', () => {
    it('finds a single URL', () => {
      expect(extractUrls('Check out https://example.com for more')).toEqual([
        'https://example.com',
      ]);
    });

    it('strips trailing punctuation and ellipsis', () => {
      expect(extractUrls('See https://example.com/path.')).toEqual(['https://example.com/path']);
      expect(extractUrls('Nice (https://example.com)!')).toEqual(['https://example.com']);
      expect(extractUrls('Wow https://example.com…')).toEqual(['https://example.com']);
    });

    it('finds multiple URLs in one text', () => {
      expect(extractUrls('First https://a.com then https://b.com/x?y=1')).toEqual([
        'https://a.com',
        'https://b.com/x?y=1',
      ]);
    });

    it('keeps all occurrences uncapped for content-change trigger detection', () => {
      expect(
        extractUrls(
          'https://a.com https://b.com https://c.com https://d.com https://e.com https://f.com https://a.com',
        ),
      ).toEqual([
        'https://a.com',
        'https://b.com',
        'https://c.com',
        'https://d.com',
        'https://e.com',
        'https://f.com',
        'https://a.com',
      ]);
    });

    it('returns an empty array for text with no URLs', () => {
      expect(extractUrls('Just a regular memory about the park.')).toEqual([]);
      expect(extractUrls('')).toEqual([]);
      expect(extractUrls(null)).toEqual([]);
      expect(extractUrls(undefined)).toEqual([]);
    });
  });

  describe('splitContentIntoSegments', () => {
    it('returns a single text segment for URL-less content', () => {
      expect(splitContentIntoSegments('Just words here')).toEqual([
        { type: 'text', text: 'Just words here' },
      ]);
    });

    it('splits text/link/text around a single URL', () => {
      expect(splitContentIntoSegments('See https://example.com today')).toEqual([
        { type: 'text', text: 'See ' },
        { type: 'link', url: 'https://example.com' },
        { type: 'text', text: ' today' },
      ]);
    });

    it('keeps trailing punctuation as trailing text', () => {
      expect(splitContentIntoSegments('See https://example.com.')).toEqual([
        { type: 'text', text: 'See ' },
        { type: 'link', url: 'https://example.com' },
        { type: 'text', text: '.' },
      ]);
    });

    it('handles a URL at the very start and end of the content', () => {
      expect(splitContentIntoSegments('https://a.com then https://b.com')).toEqual([
        { type: 'link', url: 'https://a.com' },
        { type: 'text', text: ' then ' },
        { type: 'link', url: 'https://b.com' },
      ]);
    });

    it('returns an empty array for empty content', () => {
      expect(splitContentIntoSegments('')).toEqual([]);
      expect(splitContentIntoSegments(null)).toEqual([]);
    });

    it('renders a user-parenthesized URL as the known ((Title)) edge case', () => {
      // The user's own '(' and ')' stay as plain text around the link
      // segment; the renderer adds its own parens around the label.
      const segments = splitContentIntoSegments('Look (https://example.com) neat');
      expect(segments).toEqual([
        { type: 'text', text: 'Look (' },
        { type: 'link', url: 'https://example.com' },
        { type: 'text', text: ') neat' },
      ]);
    });

    it('links only the first five unique URLs while preserving later URLs as raw text', () => {
      expect(
        splitContentIntoSegments(
          'https://a.com, https://b.com https://c.com https://d.com https://e.com https://f.com! https://a.com.',
        ),
      ).toEqual([
        { type: 'link', url: 'https://a.com' },
        { type: 'text', text: ', ' },
        { type: 'link', url: 'https://b.com' },
        { type: 'text', text: ' ' },
        { type: 'link', url: 'https://c.com' },
        { type: 'text', text: ' ' },
        { type: 'link', url: 'https://d.com' },
        { type: 'text', text: ' ' },
        { type: 'link', url: 'https://e.com' },
        { type: 'text', text: ' https://f.com! ' },
        { type: 'link', url: 'https://a.com' },
        { type: 'text', text: '.' },
      ]);
    });
  });

  describe('linkLabel', () => {
    it('uses the preview title when present and non-null', () => {
      const previews: LinkPreviewMap = {
        'https://example.com': { title: 'Example Site', fetchedAt: '2026-07-01T00:00:00Z' },
      };
      expect(linkLabel('https://example.com', previews)).toBe('Example Site');
    });

    it('falls back to the hostname (without www.) when title is null', () => {
      const previews: LinkPreviewMap = {
        'https://www.example.com/page': { title: null, fetchedAt: '2026-07-01T00:00:00Z' },
      };
      expect(linkLabel('https://www.example.com/page', previews)).toBe('example.com');
    });

    it('falls back to the hostname when there is no preview entry at all', () => {
      expect(linkLabel('https://www.youtube.com/watch?v=abc', null)).toBe('youtube.com');
      expect(linkLabel('https://example.com', undefined)).toBe('example.com');
    });

    it('falls back to the raw URL when it fails to parse', () => {
      expect(linkLabel('not-a-real-url', {})).toBe('not-a-real-url');
    });
  });

  describe('substituteLinkLabels', () => {
    it('replaces each URL with (label) and preserves surrounding text', () => {
      const previews: LinkPreviewMap = {
        'https://example.com': { title: 'Example Site', fetchedAt: '2026-07-01T00:00:00Z' },
      };
      expect(substituteLinkLabels('Check out https://example.com today', previews)).toBe(
        'Check out (Example Site) today',
      );
    });

    it('falls back to domain labels for unfetched/failed titles', () => {
      const previews: LinkPreviewMap = {
        'https://example.com': { title: null, fetchedAt: '2026-07-01T00:00:00Z' },
      };
      expect(substituteLinkLabels('See https://example.com', previews)).toBe('See (example.com)');
    });

    it('handles multiple URLs and no linkPreviews map at all', () => {
      expect(substituteLinkLabels('https://a.com and https://b.com', null)).toBe(
        '(a.com) and (b.com)',
      );
    });

    it('returns an empty string for empty content', () => {
      expect(substituteLinkLabels(null, {})).toBe('');
      expect(substituteLinkLabels('', {})).toBe('');
    });

    it('is a no-op for content with no URLs', () => {
      expect(substituteLinkLabels('No links in this memory.', {})).toBe(
        'No links in this memory.',
      );
    });

    it('substitutes the first five unique URLs and every repeat but leaves later URLs raw', () => {
      expect(
        substituteLinkLabels(
          'https://a.com https://b.com https://c.com https://d.com https://e.com https://f.com then https://a.com',
          {},
        ),
      ).toBe('(a.com) (b.com) (c.com) (d.com) (e.com) https://f.com then (a.com)');
    });
  });

  describe('toLinkPreviewMap', () => {
    it('passes through well-formed entries', () => {
      const raw = { 'https://a.com': { title: 'A', fetchedAt: '2026-07-01T00:00:00Z' } };
      expect(toLinkPreviewMap(raw)).toEqual(raw);
    });

    it('treats malformed entries as absent', () => {
      const raw = {
        'https://a.com': { title: 'A', fetchedAt: '2026-07-01T00:00:00Z' },
        'https://b.com': { title: 42 },
        'https://c.com': 'not an object',
        'https://d.com': null,
      };
      expect(toLinkPreviewMap(raw)).toEqual({
        'https://a.com': { title: 'A', fetchedAt: '2026-07-01T00:00:00Z' },
      });
    });

    it('treats a null title as a valid (failed-fetch) entry', () => {
      const raw = { 'https://a.com': { title: null, fetchedAt: '2026-07-01T00:00:00Z' } };
      expect(toLinkPreviewMap(raw)).toEqual(raw);
    });

    it('handles non-object, array, and nullish input', () => {
      expect(toLinkPreviewMap(null)).toEqual({});
      expect(toLinkPreviewMap(undefined)).toEqual({});
      expect(toLinkPreviewMap([])).toEqual({});
      expect(toLinkPreviewMap('oops' as unknown as null)).toEqual({});
    });
  });
});
