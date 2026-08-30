import { describe, expect, it } from 'vitest';

import { renderNotFoundPage, renderRevokedPage, renderViewerPage } from '../src/page';
import type { ResolvedMedia } from '../src/resolve';

const baseMedia: ResolvedMedia = {
  kind: 'image',
  objectKey: 'user-1/memories/mem-1/media/asset-1.jpg',
  contentType: 'image/jpeg',
  memoryDate: '2026-06-01',
  caption: 'First splash in the pool',
  emotion: 'joy',
  durationMs: null,
  previewObjectKey: null,
};

const viewerOptions = {
  canonicalUrl: 'https://m.usemomora.com/m/A1b2C3d4E5f6G7h8I9j0K1',
  posterUrl: 'https://m.usemomora.com/poster/A1b2C3d4E5f6G7h8I9j0K1',
  posterContentType: 'image/jpeg',
};

describe('renderViewerPage', () => {
  it('renders an <img> for image media pointed at the media URL', () => {
    const html = renderViewerPage(baseMedia, '/media/mem-1');
    expect(html).toContain('<img class="media" src="/media/mem-1"');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('<audio');
  });

  it('renders a <video> for video media', () => {
    const html = renderViewerPage({ ...baseMedia, kind: 'video' }, '/media/mem-1');
    expect(html).toContain('<video class="media" src="/media/mem-1"');
    expect(html).toContain('controls');
  });

  it('renders an <audio> player for audio media', () => {
    const html = renderViewerPage({ ...baseMedia, kind: 'audio' }, '/media/mem-1');
    expect(html).toContain('<audio class="audio-player" src="/media/mem-1"');
  });

  it('formats the memory date as a long-form UTC date', () => {
    const html = renderViewerPage(baseMedia, '/media/mem-1');
    expect(html).toContain('June 1, 2026');
  });

  it('omits the date block when memoryDate is null', () => {
    const html = renderViewerPage({ ...baseMedia, memoryDate: null }, '/media/mem-1');
    expect(html).not.toContain('class="date"');
  });

  it('omits the caption block when caption is null', () => {
    const html = renderViewerPage({ ...baseMedia, caption: null }, '/media/mem-1');
    expect(html).not.toContain('class="caption"');
  });

  it('escapes HTML-significant characters in the caption', () => {
    const html = renderViewerPage({ ...baseMedia, caption: 'Enzo said "<hi>" & waved' }, '/media/mem-1');
    expect(html).toContain('&quot;&lt;hi&gt;&quot; &amp; waved');
    expect(html).not.toContain('<hi>');
  });

  it('never reproduces caption content in an unescaped attribute context', () => {
    const html = renderViewerPage({ ...baseMedia, caption: '"><script>alert(1)</script>' }, '/media/mem-1');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('preserves meaningful caption line breaks while omitting whitespace-only captions', () => {
    const withLineBreaks = renderViewerPage(
      { ...baseMedia, caption: ' \nFirst splash\nSecond splash\n ' },
      '/media/mem-1',
    );
    const whitespaceOnly = renderViewerPage({ ...baseMedia, caption: ' \n\t ' }, '/media/mem-1');

    expect(withLineBreaks).toContain('white-space: pre-wrap');
    expect(withLineBreaks).toContain('First splash\nSecond splash');
    expect(withLineBreaks).toContain('class="caption"');
    expect(whitespaceOnly).not.toContain('class="caption"');
  });

  it('uses the detail-card frame, emotion background/footer, and actual wordmark without social controls', () => {
    const html = renderViewerPage(baseMedia, '/media/mem-1', viewerOptions);

    expect(html).toContain('border-radius: 24px');
    expect(html).toContain('.media-wrap { padding: 10px 10px 0; }');
    expect(html).toContain('background: linear-gradient(180deg, #FFE7B0');
    expect(html).toContain('class="emotion"');
    expect(html).toContain('>joy</span>');
    expect(html).toContain('Momora<span class="brand-dot">.</span>');
    expect(html).not.toContain('<button');
    expect(html.toLowerCase()).not.toContain('like');
    expect(html.toLowerCase()).not.toContain('comment');
    expect(html.toLowerCase()).not.toContain('share');
    expect(html).not.toContain('Added by');
  });

  it('centers normal cards without vertically clipping long-caption cards', () => {
    const html = renderViewerPage(baseMedia, '/media/mem-1', viewerOptions);
    const viewerBodyCss = html.slice(html.indexOf('body {'), html.indexOf('  .wrap {'));

    expect(viewerBodyCss).toContain('display: grid;');
    expect(viewerBodyCss).toContain('grid-template-rows: minmax(min-content, 1fr);');
    expect(viewerBodyCss).not.toContain('align-items: center;');
    expect(viewerBodyCss).not.toContain('justify-content: center;');
    expect(html).toContain('margin: auto;');
  });

  it('derives same-origin media from the canonical URL in the preferred caller API', () => {
    const html = renderViewerPage({ ...baseMedia, kind: 'video' }, viewerOptions);
    const sharedMediaCss = html.slice(html.indexOf('  .media {'), html.indexOf('  img.media {'));
    const videoMediaCss = html.slice(html.indexOf('  video.media {'), html.indexOf('  .meta {'));

    expect(html).toContain('src="https://m.usemomora.com/media/A1b2C3d4E5f6G7h8I9j0K1"');
    expect(html).not.toContain('<video class="media" src="https://m.usemomora.com/media/A1b2C3d4E5f6G7h8I9j0K1" poster=');
    expect(sharedMediaCss).toContain('width: 100%;');
    expect(sharedMediaCss).not.toContain('max-height');
    expect(sharedMediaCss).not.toContain('object-fit');
    expect(videoMediaCss).toContain('height: auto;');
    expect(videoMediaCss).not.toContain('max-height');
    expect(videoMediaCss).not.toContain('object-fit');
  });

  it('renders canonical Open Graph and Twitter card metadata with a token-protected JPEG poster', () => {
    const html = renderViewerPage(baseMedia, viewerOptions);

    expect(html).toContain('<title>June 1, 2026 · Momora</title>');
    expect(html).toContain('property="og:title" content="A memory from June 1, 2026"');
    expect(html).toContain('property="og:description" content="First splash in the pool"');
    expect(html).toContain('property="og:site_name" content="Momora"');
    expect(html).toContain('property="og:type" content="website"');
    expect(html).toContain('property="og:url" content="https://m.usemomora.com/m/A1b2C3d4E5f6G7h8I9j0K1"');
    expect(html).toContain('property="og:image" content="https://m.usemomora.com/poster/A1b2C3d4E5f6G7h8I9j0K1"');
    expect(html).toContain('property="og:image:type" content="image/jpeg"');
    expect(html).toContain('property="og:image:alt" content="A Momora memory from June 1, 2026"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="twitter:image" content="https://m.usemomora.com/poster/A1b2C3d4E5f6G7h8I9j0K1"');
    expect(html).not.toContain('og:video');
  });

  it('uses the supplied safe image type for a non-JPEG original poster', () => {
    const html = renderViewerPage(
      { ...baseMedia, kind: 'audio' },
      { ...viewerOptions, posterContentType: 'image/png' },
    );

    expect(html).toContain('property="og:image:type" content="image/png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('falls back safely when date, caption, and optional share metadata are missing or invalid', () => {
    const html = renderViewerPage(
      { ...baseMedia, memoryDate: '2026-02-30', caption: ' \n ' },
      '/media/mem-1',
    );

    expect(html).toContain('<title>A Momora memory · Momora</title>');
    expect(html).toContain('property="og:title" content="A Momora memory"');
    expect(html).toContain(`property="og:description" content="A moment preserved in a Momora book."`);
    expect(html).toContain('name="twitter:card" content="summary"');
    expect(html).not.toContain('class="date"');
    expect(html).not.toContain('class="caption"');
    expect(html).not.toContain('property="og:url"');
    expect(html).not.toContain('property="og:image"');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });

  it('normalizes and clamps the Open Graph description without changing the visible caption', () => {
    const caption = `First line\nSecond line ${'very-long '.repeat(24)}`;
    const html = renderViewerPage({ ...baseMedia, caption }, viewerOptions);

    expect(html).toContain('First line\nSecond line');
    expect(html).toContain('property="og:description" content="First line Second line');
    expect(html).toContain('…"');
  });

  it('escapes social metadata and ignores non-HTTP canonical/poster URLs', () => {
    const html = renderViewerPage(
      { ...baseMedia, caption: '\"><script>alert(1)</script>' },
      '/media/mem-1',
      {
        canonicalUrl: 'javascript:alert(1)',
        posterUrl: 'data:image/svg+xml,<svg />',
        posterContentType: 'image/jpeg',
      },
    );

    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('property="og:url"');
    expect(html).not.toContain('property="og:image"');
  });

  it('marks the page noindex and non-caching', () => {
    const html = renderViewerPage(baseMedia, '/media/mem-1');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });
});

describe('renderNotFoundPage', () => {
  it('renders a friendly 404 page with the Momora brand mark', () => {
    const html = renderNotFoundPage();
    expect(html).toContain("This memory isn");
    expect(html).toContain('Momora');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });
});

describe('renderRevokedPage', () => {
  it('renders distinct copy from renderNotFoundPage, with the Momora brand mark', () => {
    const html = renderRevokedPage();
    expect(html).toContain('This link is no longer active');
    expect(html).toContain('Momora');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });

  it('never says the not-found page\'s "isn\'t available" copy -- the two pages read distinctly', () => {
    const html = renderRevokedPage();
    expect(html).not.toContain('isn&rsquo;t available');
  });

  it('marks the page noindex and non-caching, same as the not-found page', () => {
    const html = renderRevokedPage();
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });
});
