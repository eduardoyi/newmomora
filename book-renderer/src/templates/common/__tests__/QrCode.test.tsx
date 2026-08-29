import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import QRCode from 'qrcode';
import { fitBook } from '../../../model/fitter';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from '../../../model/__tests__/fixtures/build';
import { TemplateRenderer } from '../../index';
import { shareViewerUrl } from '../../../model/qr';
import type { PhotoSlotContent } from '../../../model/types';

describe('real QR codes render wherever a scan mark appears', () => {
  it('a video slot renders a scannable SVG QR with the expected module count, encoding the share-token viewer URL', () => {
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'video',
        text: 'First steps on the beach.',
        assets: [makeAsset({ kind: 'video-poster', durationMs: 9000 })],
        shareToken: 'tok-video-abc123',
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-video'] })]);
    const { document } = fitBook(outline, manifest);
    const page = document.pages.find((p) =>
      p.slots.some((s) => s.kind === 'photo' && (s.content as PhotoSlotContent).qr),
    );
    expect(page).toBeTruthy();

    const html = renderToStaticMarkup(
      <TemplateRenderer page={page!} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );

    const expectedModules = QRCode.create(shareViewerUrl('tok-video-abc123'), { errorCorrectionLevel: 'M' }).modules.size;
    expect(html).toContain('data-testid="qr-code"');
    expect(html).toContain(`data-qr-modules="${expectedModules}"`);
    // Still the same shared scan-mark hook the rest of the codebase (and its
    // existing tests) key off of — a pure visual/data swap, not a new class.
    expect(html).toContain('scan-mark');
  });

  it('an audio-note renders its 26mm mark as a real QR too', () => {
    const manifest = makeManifest({
      'mem-audio': makeMemory({ type: 'audio', text: 'Singing happy birthday.', assets: [], shareToken: 'tok-audio-xyz789' }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-audio'] })]);
    const { document } = fitBook(outline, manifest);
    const page = document.pages.find((p) => p.templateId === 'audio-note');
    expect(page).toBeTruthy();

    const html = renderToStaticMarkup(
      <TemplateRenderer page={page!} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );

    const expectedModules = QRCode.create(shareViewerUrl('tok-audio-xyz789'), { errorCorrectionLevel: 'M' }).modules.size;
    expect(html).toContain(`data-qr-modules="${expectedModules}"`);
  });

  it('falls back to the static placeholder mark (never a fabricated URL) when the manifest has no shareToken', () => {
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'video',
        text: 'A memory exported before Round-19.',
        assets: [makeAsset({ kind: 'video-poster', durationMs: 4000 })],
        // shareToken omitted -- makeMemory defaults it to null, simulating a
        // pre-token manifest (or a mint that never ran).
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-video'] })]);
    const { document } = fitBook(outline, manifest);
    const page = document.pages.find((p) =>
      p.slots.some((s) => s.kind === 'photo' && (s.content as PhotoSlotContent).qr),
    );
    expect(page).toBeTruthy();

    const html = renderToStaticMarkup(
      <TemplateRenderer page={page!} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );

    expect(html).not.toContain('data-testid="qr-code"');
    expect(html).toContain('scan-mark');
  });
});
