import { describe, expect, it } from 'vitest';

import { renderNotFoundPage, renderRevokedPage, renderViewerPage } from '../src/page';
import type { ResolvedMedia } from '../src/resolve';

const baseMedia: ResolvedMedia = {
  kind: 'image',
  objectKey: 'user-1/memories/mem-1/media/asset-1.jpg',
  contentType: 'image/jpeg',
  memoryDate: '2026-06-01',
  caption: 'First splash in the pool',
  durationMs: null,
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
