import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import QRCode from 'qrcode';
import { fitBook } from '../../../model/fitter';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from '../../../model/__tests__/fixtures/build';
import { TemplateRenderer } from '../../index';
import { memoryViewerUrl } from '../../../model/qr';
import type { PhotoSlotContent } from '../../../model/types';

describe('real QR codes render wherever a scan mark appears', () => {
  it('a video slot renders a scannable SVG QR with the expected module count, encoding the memory-viewer URL', () => {
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'video',
        text: 'First steps on the beach.',
        assets: [makeAsset({ kind: 'video-poster', durationMs: 9000 })],
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

    const expectedModules = QRCode.create(memoryViewerUrl('mem-video'), { errorCorrectionLevel: 'M' }).modules.size;
    expect(html).toContain('data-testid="qr-code"');
    expect(html).toContain(`data-qr-modules="${expectedModules}"`);
    // Still the same shared scan-mark hook the rest of the codebase (and its
    // existing tests) key off of — a pure visual/data swap, not a new class.
    expect(html).toContain('scan-mark');
  });

  it('an audio-note renders its 26mm mark as a real QR too', () => {
    const manifest = makeManifest({
      'mem-audio': makeMemory({ type: 'audio', text: 'Singing happy birthday.', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-audio'] })]);
    const { document } = fitBook(outline, manifest);
    const page = document.pages.find((p) => p.templateId === 'audio-note');
    expect(page).toBeTruthy();

    const html = renderToStaticMarkup(
      <TemplateRenderer page={page!} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );

    const expectedModules = QRCode.create(memoryViewerUrl('mem-audio'), { errorCorrectionLevel: 'M' }).modules.size;
    expect(html).toContain(`data-qr-modules="${expectedModules}"`);
  });
});
