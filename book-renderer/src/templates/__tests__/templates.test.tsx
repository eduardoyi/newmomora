import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fitBook } from '../../model/fitter';
import { applyPostFit } from '../../model/edits';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from '../../model/__tests__/fixtures/build';
import { TemplateRenderer } from '../index';
import { FooterIndex } from '../common/FooterIndex';
import { Folio } from '../common/Folio';
import { illustratedIlloWidthMm, illustratedIlloFitHeightMm, canvasPxToTrimMm } from '../mm';
import type { BookManifest } from '../../model/types';

function renderPage(manifest: BookManifest, outline: ReturnType<typeof makeOutline>, pageIndex = 0) {
  const { document } = fitBook(outline, manifest);
  const page = document.pages[pageIndex];
  expect(page).toBeTruthy();
  const html = renderToStaticMarkup(
    <TemplateRenderer page={page} manifest={manifest} bookSlug="test-book" showGuides={false} />,
  );
  return { page, html };
}

describe('template snapshots', () => {
  it('FlexGrid renders the single-memory multi-photo exception with a numbered footer index', () => {
    // Density (owner round-3 rule): flex-grid only fires for ONE memory's
    // own 3-4 photos (e.g. a burst from one moment) — never a cross-memory
    // grid, AND (density v3, item 5) only when the whole set composes
    // cleanly at native aspect — every aspect below is an EXACT standard
    // box match (0.8/1/1.5), so all four stay together as one grid.
    const manifest = makeManifest({
      'mem-a': makeMemory({
        text: 'Splashing in the pool.',
        assets: [makeAsset(), makeAsset({ aspectRatio: 0.8 }), makeAsset({ aspectRatio: 1 }), makeAsset({ aspectRatio: 1.5 })],
      }),
    });
    const outline = makeOutline([
      makeElement({
        id: 'emotion:funny',
        kind: 'themed',
        memoryIds: ['mem-a'],
        spreadType: 'emotion',
        titleMode: 'quote',
        titleSourceMemoryId: 'mem-a',
        highlights: ['mem-a'],
      }),
    ]);
    const { html } = renderPage(manifest, outline, 1); // index 0 is the spread-title opener
    // The memory's caption is consolidated onto one footer line (item 9) —
    // all four photos share the same date/caption, so they merge under
    // several superscript numerals rather than repeating the text 4 times.
    expect(html).toContain('Splashing in the pool.');
    expect(html).toContain('flex-grid__cell');
    expect(html).toMatchSnapshot();
  });

  it('a solo photo memory with a short caption renders on anchor-media with the caption in the footer, not on the page (item 7)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'A short caption under the threshold.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { page, html } = renderPage(manifest, outline);
    // photo-story is retired from the fitter's own scoring (owner review
    // round 3 item 7) — a captioned solo photo is anchor-media now, its
    // caption always in the footer index, never printed on the page itself.
    expect(page.templateId).toBe('anchor-media');
    expect(html).toContain('A short caption under the threshold.');
    expect(html).toContain('footer-index');
    expect(html).toMatchSnapshot();
  });

  it('IllustratedStory renders text above the illustration', () => {
    // Round-9 item 1 finding: a section-header page's fixed overhead (46mm
    // header reserve + 8mm folio clearance + 8mm text-to-illo gap + the
    // caption's own minimum ~1-line height) already exceeds
    // `SAFE_BOX_MM - 110mm`, so a headed illustrated-story ALWAYS now routes
    // through the text/illustration split rather than rendering "both" on
    // one page (see `illustratedIlloFitHeightMm`'s doc comment) — this test
    // is about "both" mode's own text-above-illustration ordering, so a
    // second, unrelated leading memory consumes the section's header first,
    // keeping `mem-1`'s page header-free.
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'Enzo built a very tall tower.',
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-1'] })]);
    const { page, html } = renderPage(manifest, outline, 1);
    expect(page.templateId).toBe('illustrated-story');
    expect(page.params.sectionHeader).toBeFalsy();
    expect(page.params.mode ?? 'both').toBe('both');
    const textIndex = html.indexOf('illustrated-story__text');
    const illoIndex = html.indexOf('illustrated-story__illo');
    expect(textIndex).toBeGreaterThan(-1);
    expect(illoIndex).toBeGreaterThan(textIndex); // text markup precedes the illustration markup — text is always above
    expect(html).toMatchSnapshot();
  });

  it('round-8 item 4 regression: the illustration renders at its EXACT intended mm width, not ~74% of it', () => {
    // Bug fix: `illoWidthPct` used to be computed as a percentage of the
    // PAGE's own width but applied as the CSS `width` of a DESCENDANT
    // element (`.illustrated-story__stack`, itself sized to ~74% of the
    // page) — a `width: X%` always resolves against the immediate
    // containing block, so the illustration silently rendered ~26%
    // smaller than intended. This asserts the rendered width, decoded
    // straight from the emitted inline styles, equals `illustratedIlloWidthMm`
    // to sub-millimeter precision.
    // Round-9 item 1 finding: a section-header page's fixed vertical
    // overhead now ALWAYS forces the text/illustration split (see the doc
    // comment on the previous test) — this test is about the %-basis width
    // decode, so a leading unrelated memory consumes the header first,
    // keeping the illustrated-story page header-free and in "both" mode.
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'Enzo built a very tall tower.',
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-1'] })]);
    const { html } = renderPage(manifest, outline, 1);

    const stackWidthPctMatch = html.match(/class="illustrated-story__stack" style="[^"]*width:([\d.]+)%/);
    const illoWidthPctMatch = html.match(/class="illustrated-story__illo" style="[^"]*width:([\d.]+)%/);
    expect(stackWidthPctMatch).toBeTruthy();
    expect(illoWidthPctMatch).toBeTruthy();
    const stackWidthPct = Number(stackWidthPctMatch![1]);
    const illoWidthPct = Number(illoWidthPctMatch![1]);

    // The stack is absolutely positioned INSIDE SafeArea, so its CSS width
    // percentage resolves against the 190mm safe box — decoding it against
    // the 216mm page frame here was the second instance of the very bug
    // this test guards (and made the test pass against a wrong render).
    const SAFE_BOX_MM = 190; // PHYSICAL.pageSizeMm - PHYSICAL.safeMarginMm * 2
    const stackWidthMm = (stackWidthPct / 100) * SAFE_BOX_MM;
    const renderedIlloWidthMm = (illoWidthPct / 100) * stackWidthMm;

    // Round-9 item 1 finding: even this ordinary, headerless, short-caption
    // square-aspect illustration is now capped BELOW its plain nominal
    // width (`illustratedIlloWidthMm` would say 160mm) — the OLD (uncapped)
    // math already overflowed the safe box here by ~2.5mm before folio
    // clearance is even considered (stack = 5mm top + ~19.5mm caption +
    // 8mm gap + 160mm nominal illo = ~192.5mm on a 190mm safe box), a
    // previously-undetected instance of the very "folio stamped on the
    // illustration" bug round-9 fixes. The rendered width now matches the
    // FITTED size, not the nominal one.
    const expectedIlloHeightMm = illustratedIlloFitHeightMm('Enzo built a very tall tower.'.length, false, false, 1);
    const expectedIlloWidthMm = expectedIlloHeightMm * 1; // aspect 1 -> width === height
    expect(expectedIlloWidthMm).toBeLessThan(illustratedIlloWidthMm('Enzo built a very tall tower.'.length, false));
    expect(renderedIlloWidthMm).toBeCloseTo(expectedIlloWidthMm, 3);
    // Sanity: the stack's own width should be exactly the documented 640
    // canvas-px constant (160mm), confirming the % decode above is sound.
    expect(stackWidthMm).toBeCloseTo(canvasPxToTrimMm(640), 3);

    // The same bug applied to the illustration's own `marginTop` flow gap
    // (also a % of the stack, not the page) — confirm it too renders at
    // its exact intended mm value (32 canvas px = 8mm).
    const marginTopMatch = html.match(/class="illustrated-story__illo" style="margin-top:([\d.]+)%/);
    expect(marginTopMatch).toBeTruthy();
    const marginTopPct = Number(marginTopMatch![1]);
    const renderedMarginTopMm = (marginTopPct / 100) * stackWidthMm;
    expect(renderedMarginTopMm).toBeCloseTo(canvasPxToTrimMm(32), 3);
  });

  it('Dedication renders the child name; the preceding page is a blank page', () => {
    const manifest = makeManifest({});
    const outline = makeOutline([makeElement({ id: 'title', kind: 'title', title: 'Title & dedication' })]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('blank');
    expect(document.pages[1].templateId).toBe('dedication');
    const html = renderToStaticMarkup(
      <TemplateRenderer page={document.pages[1]} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('Test Child');
    expect(html).toMatchSnapshot();
  });

  it('Dedication renders NO scan-instruction footnote when the book has no scan marks (print-polish round, item D1)', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ text: 'A quiet memory.', assets: [makeAsset()] }) });
    const outline = makeOutline([
      makeElement({ id: 'title', kind: 'title', title: 'Title & dedication' }),
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const dedicationPage = document.pages.find((p) => p.templateId === 'dedication')!;
    expect(dedicationPage.params.hasScanMarks).toBe(false);
    const html = renderToStaticMarkup(
      <TemplateRenderer page={dedicationPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).not.toContain('dedication__scan-instruction');
  });

  it('Dedication renders the scan-instruction footnote (sample mark + italic line) when the book has a video scan mark (item D1)', () => {
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'video',
        text: 'Dancing in the kitchen.',
        assets: [makeAsset({ kind: 'video-poster', durationMs: 9000 })],
        shareToken: 'tok-video-abc',
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'title', kind: 'title', title: 'Title & dedication' }),
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-video'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const dedicationPage = document.pages.find((p) => p.templateId === 'dedication')!;
    expect(dedicationPage.params.hasScanMarks).toBe(true);
    const html = renderToStaticMarkup(
      <TemplateRenderer page={dedicationPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('dedication__scan-instruction');
    // React HTML-escapes the apostrophe as `&#x27;` in the SSR'd markup.
    expect(html).toContain('scan it with your phone');
    expect(html).toContain('watch or listen to that memory');
    // The dedication sample mark is a real QR (badge=play), encoding the
    // stable, decorative usemomora.com URL — never a fabricated share link.
    expect(html).toContain('data-testid="qr-code"');
    expect(html).toContain('data-qr-badge="play"');
  });

  it('Dedication renders the scan-instruction footnote when the book has only an audio scan mark (item D1 — covers audio, not just video)', () => {
    const manifest = makeManifest({
      'mem-audio': makeMemory({ type: 'audio', text: 'Singing happy birthday.', assets: [], shareToken: 'tok-audio-abc' }),
    });
    const outline = makeOutline([
      makeElement({ id: 'title', kind: 'title', title: 'Title & dedication' }),
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-audio'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const dedicationPage = document.pages.find((p) => p.templateId === 'dedication')!;
    expect(dedicationPage.params.hasScanMarks).toBe(true);
  });

  it('Dedication scan-instruction respects a saved furniture:scanInstruction override', () => {
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'video',
        assets: [makeAsset({ kind: 'video-poster', durationMs: 9000 })],
        shareToken: 'tok-video-abc',
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'title', kind: 'title', title: 'Title & dedication' }),
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-video'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const { document: edited } = applyPostFit(document, {
      text: { 'furniture:scanInstruction': { target: 'furniture:scanInstruction', value: 'A custom scan instruction.' } },
    });
    const dedicationPage = edited.pages.find((p) => p.templateId === 'dedication')!;
    const html = renderToStaticMarkup(
      <TemplateRenderer page={dedicationPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('A custom scan instruction.');
  });

  it('SpreadTitle renders quote mode with attribution and descriptive mode with a kicker when present', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ date: '2024-05-04', assets: [makeAsset()] }),
    });
    const quoteOutline = makeOutline([
      makeElement({
        id: 'emotion:funny',
        kind: 'themed',
        memoryIds: ['mem-1'],
        title: 'Vamos, vamos, banana!',
        spreadType: 'emotion',
        titleMode: 'quote',
        titleSourceMemoryId: 'mem-1',
      }),
    ]);
    const { html: quoteHtml } = renderPage(manifest, quoteOutline, 0);
    expect(quoteHtml).toContain('Vamos, vamos, banana!');
    expect(quoteHtml).toContain('spread-title__attribution');

    const descriptiveOutline = makeOutline([
      makeElement({
        id: 'topic:travel',
        kind: 'themed',
        memoryIds: ['mem-1'],
        title: 'First flights',
        spreadType: 'topic',
        titleMode: 'descriptive',
        kicker: 'places we went',
      }),
    ]);
    const { html: descriptiveHtml } = renderPage(manifest, descriptiveOutline, 0);
    expect(descriptiveHtml).toContain('First flights');
    expect(descriptiveHtml).toContain('places we went');
    expect(descriptiveHtml).not.toContain('spread-title__attribution');
  });

  it('AudioNote never prints the transcription, only the parent caption and the scan mark (furniture follows journal language)', () => {
    const esManifest = makeManifest(
      { 'mem-audio': makeMemory({ type: 'audio', text: 'Singing happy birthday.', assets: [] }) },
      { language: 'es' },
    );
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-audio'] }),
    ]);
    const { page, html: esHtml } = renderPage(esManifest, outline);
    expect(page.templateId).toBe('audio-note');
    expect(esHtml).toContain('Singing happy birthday.');
    expect(esHtml).toContain('escúchalo');
    expect(esHtml).not.toContain('footer-index');

    // No `language` on the manifest -> defaults to "en" furniture, never Spanish.
    const enManifest = makeManifest({
      'mem-audio': makeMemory({ type: 'audio', text: 'Singing happy birthday.', assets: [] }),
    });
    const { html: enHtml } = renderPage(enManifest, outline);
    expect(enHtml).toContain('listen to it');
    expect(enHtml).not.toContain('escúchalo');
  });

  it('a captioned video renders on anchor-media with its own scan-to-watch directly under the image (item 8)', () => {
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'video',
        text: 'Dancing in the kitchen.',
        assets: [makeAsset({ kind: 'video-poster', durationMs: 9000 })],
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-video'] }),
    ]);
    const { page, html } = renderPage(manifest, outline);
    expect(page.templateId).toBe('anchor-media'); // photo-story is retired — see item 7
    expect(html).toContain('scan-mark');
    // The scan-to-watch affordance sits with the photo tile itself now
    // (item 8), not stacked in the shared footer strip.
    expect(html).toContain('photo-tile__scan');
  });

  it('a no-caption video without a highlight lands on anchor-media with its scan mark under the photo and its (empty) caption line still in the footer', () => {
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'video',
        assets: [makeAsset({ kind: 'video-poster', durationMs: 9000 })],
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-video'] }),
    ]);
    const { page, html } = renderPage(manifest, outline);
    expect(page.templateId).toBe('anchor-media');
    expect(html).toContain('scan-mark');
    expect(html).toContain('footer-index');
  });

  it('Firsts renders as a normal themed section — eyebrow + title page, then its memory like any other content page (item 15)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        text: 'She said her first word today: dada!',
        milestones: [{ id: 'first-word', name: 'First word', detail: 'dada' }],
        assets: [],
      }),
    });
    const outline = makeOutline([makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    // No bespoke ruled-list "firsts" template anymore — a title page (like
    // any themed section) followed by the memory's own normal content page.
    expect(document.pages[0].templateId).toBe('spread-title');
    expect(document.pages[1].templateId).toBe('text-page'); // zero-asset memory -> text-forward, same as anywhere else
    const html = renderToStaticMarkup(
      <TemplateRenderer page={document.pages[1]} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('She said her first word today: dada!');
  });

  it('WraparoundCover: mixed-voice spine text is dark ink, not white — the spine sits on paper-white paper, not the photo (item 17 bug fix; full-bleed "photo" voice removed 2026-08-31, so this is now the only photo-bearing voice)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ kind: 'photo', width: 2400, aspectRatio: 0.9 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'cover', kind: 'cover' })], { heroCandidates: ['mem-1'] });
    const { page, html } = renderPage(manifest, outline);
    expect(page.templateId).toBe('cover-wrap');
    expect(page.params.voice).toBe('mixed');
    const spineNameMarkup = html.slice(html.indexOf('cover-wrap__spine-name'), html.indexOf('cover-wrap__spine-name') + 200);
    expect(spineNameMarkup).toContain('#2C2418'); // colors.ink
    expect(spineNameMarkup).not.toContain('#fff');
  });

  it('WraparoundCover: a wide (>=1.4:1) photo also gets mixed voice, not a full-bleed wrap — the "photo" voice was removed after owner review (enzo-year-one/enzo-year-two)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ kind: 'photo', width: 2400, aspectRatio: 1.8 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'cover', kind: 'cover' })], { heroCandidates: ['mem-1'] });
    const { page, html } = renderPage(manifest, outline);
    expect(page.params.voice).toBe('mixed');
    const spineNameMarkup = html.slice(html.indexOf('cover-wrap__spine-name'), html.indexOf('cover-wrap__spine-name') + 200);
    expect(spineNameMarkup).toContain('#2C2418'); // colors.ink — spine is always paper-white now, never photo-wrapped
    expect(spineNameMarkup).not.toContain('#fff');
  });

  it('Folio sits 10mm inside the trim, matching SafeArea\'s own inset — not at the bleed edge (item 10 bug fix)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);
    const { html } = renderPage(manifest, outline);
    // SafeArea's own inset percentage (10mm safe margin + 3mm bleed, over the 216mm full-bleed box).
    const expectedInsetPct = ((10 + 3) / 216) * 100;
    expect(html).toContain(`bottom:${expectedInsetPct}%`);
  });

  it('a short illustrated caption (<=200 chars) gets a BIG illustration (item 12)', () => {
    // Round-9 item 1 finding: `illustratedStoryNeedsSplit` now checks the
    // FITTED height (capped so the stack never overflows the safe box) —
    // and a caption long enough to land in the "not short" (>200 char)
    // width tier also generates enough text-block height on its own to
    // usually trip the 110mm split floor before this width difference could
    // even render on a shared page (see the dedicated round-9 fitted-height
    // tests below for that interplay). This test is specifically about the
    // WIDTH TIER itself (`illustratedIlloWidthMm`'s own short/long
    // branching), so it checks that pure function directly rather than via
    // a full page render.
    const shortWidth = illustratedIlloWidthMm(150, false);
    const longWidth = illustratedIlloWidthMm(250, false);
    expect(shortWidth).toBeGreaterThan(longWidth);
  });

  it('the illustration sits in normal document flow below the text (item 13 bug fix) — no independent absolute `top` of its own', () => {
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'Enzo built a very tall tower with many many many blocks stacked precariously high, one on top of the other, for what felt like ages.',
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-1'] })]);
    const { html } = renderPage(manifest, outline, 1);
    const illoStart = html.indexOf('illustrated-story__illo"');
    const illoStyle = html.slice(illoStart, illoStart + 300);
    expect(illoStyle).toContain('margin-top');
    expect(illoStyle).not.toMatch(/[^-]top:/); // no OWN absolute `top` (only the outer `.illustrated-story__stack` has one)
  });

  it("Firsts uses a memory's AI-written warm_name as its caption instead of its raw text, when the outline supplies one (item 15)", () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'she rode the bike today', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({
        id: 'firsts',
        kind: 'firsts',
        title: 'Firsts',
        memoryIds: ['mem-1'],
        firstsEntries: [{ memoryId: 'mem-1', warmName: 'Aprendiste a montar bicicleta sin pedales.' }],
      }),
    ]);
    const { document } = fitBook(outline, manifest);
    const contentPage = document.pages[1];
    const html = renderToStaticMarkup(
      <TemplateRenderer page={contentPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('Aprendiste a montar bicicleta sin pedales.');
    // No repetition of the caption (item 15) — the raw memory text is
    // replaced, not printed alongside the warm line.
    expect(html).not.toContain('she rode the bike today');
  });

  it('Closing renders the furniture memory-count line by default, and a saved closing-line edit override in its place (wave-1/5b wiring gap fix)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
      makeElement({ id: 'closing', kind: 'closing' }),
    ]);
    const { document } = fitBook(outline, manifest);
    const closingPage = document.pages.find((p) => p.templateId === 'closing')!;
    expect(closingPage).toBeTruthy();

    // Absent override: byte-identical to the pre-fix furniture line.
    const defaultHtml = renderToStaticMarkup(
      <TemplateRenderer page={closingPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(defaultHtml).toContain('closing__count');
    const memoryCount = Number(closingPage.params.memoryCount ?? 0);
    expect(memoryCount).toBeGreaterThan(0);

    // Overridden: the saved edit's text replaces the computed line, not adds a third one.
    const overriddenPage = { ...closingPage, params: { ...closingPage.params, closingLine: 'Thanks for a wonderful year, little one.' } };
    const overriddenHtml = renderToStaticMarkup(
      <TemplateRenderer page={overriddenPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(overriddenHtml).toContain('Thanks for a wonderful year, little one.');
    expect((overriddenHtml.match(/closing__count/g) ?? []).length).toBe(1);
  });

  it('Closing renders the furniture headline by default, and a saved furniture:closingTitle edit override in its place (owner-approved follow-up round, item 5)', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) }, { language: 'en' });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
      makeElement({ id: 'closing', kind: 'closing' }),
    ]);
    const { document } = fitBook(outline, manifest);
    const closingPage = document.pages.find((p) => p.templateId === 'closing')!;
    expect(closingPage).toBeTruthy();

    const defaultHtml = renderToStaticMarkup(
      <TemplateRenderer page={closingPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(defaultHtml).toContain('See you next year.');

    const overriddenPage = { ...closingPage, params: { ...closingPage.params, closingTitle: 'Until next time, little one.' } };
    const overriddenHtml = renderToStaticMarkup(
      <TemplateRenderer page={overriddenPage} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(overriddenHtml).toContain('Until next time, little one.');
    expect(overriddenHtml).not.toContain('See you next year.');
    expect((overriddenHtml.match(/closing__headline/g) ?? []).length).toBe(1);
  });

  it('QuoteCollection renders every entry with its date kicker (text-only — owner review round 4 item 5: illustrated entries never enter a collection)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ date: '2025-03-01', text: 'First short quote.', assets: [] }),
      'mem-2': makeMemory({ date: '2025-03-02', text: 'Second short quote.', assets: [] }),
      'mem-3': makeMemory({ date: '2025-03-03', text: 'Third short quote.', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] })]);
    const { page, html } = renderPage(manifest, outline);
    expect(page.templateId).toBe('quote-collection');
    expect(html).toContain('First short quote.');
    expect(html).toContain('Second short quote.');
    expect(html).toContain('Third short quote.');
    expect(html).toContain('quote-collection__date');
    // No illustrated entry is quote-eligible (item 5) — a collection is now
    // necessarily pure text, so no illustration image renders at all.
    expect(html).not.toContain('quote-collection__illo-img');
  });

  it('IllustratedDigest renders every swept entry\'s illustration and caption (Task 1, round-12: real fitter-emitted composition, not just the preview demo)', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `mem-${i}`);
    const manifest = makeManifest(
      Object.fromEntries(
        ids.map((id, i) => [
          id,
          makeMemory({
            date: `2025-01-0${i + 1}`,
            type: 'text_illustration',
            text: `Digest test entry ${i}.`,
            assets: [],
            illustration: { file: `assets/illo-${i}.webp`, width: 800, height: 800, aspectRatio: 1 },
          }),
        ]),
      ),
    );
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);
    const { document } = fitBook(outline, manifest);
    const digestPage = document.pages.find((p) => p.templateId === 'illustrated-digest');
    expect(digestPage).toBeTruthy();
    const html = renderToStaticMarkup(
      <TemplateRenderer page={digestPage!} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    // The first 2 (mem-0, mem-1) always keep their full composition — never swept.
    expect(html).not.toContain('Digest test entry 0.');
    expect(html).not.toContain('Digest test entry 1.');
    // The remaining 4 (mem-2..mem-5) are the swept digest chunk.
    expect(html).toContain('Digest test entry 2.');
    expect(html).toContain('Digest test entry 3.');
    expect(html).toContain('Digest test entry 4.');
    expect(html).toContain('Digest test entry 5.');
    expect(html).toContain('illustrated-digest__illo-img');
  });

  it('the preview "Digest demo" toggle (buildDigestDemoPages) still renders through the same digest-entry slot shape (round-12 migration)', async () => {
    const { buildDigestDemoPages } = await import('../../preview/digestDemo');
    const ids = Array.from({ length: 4 }, (_, i) => `mem-${i}`);
    const manifest = makeManifest(
      Object.fromEntries(
        ids.map((id, i) => [
          id,
          makeMemory({
            date: `2025-02-0${i + 1}`,
            type: 'text_illustration',
            text: `Demo entry ${i}.`,
            assets: [],
            illustration: { file: `assets/demo-${i}.webp`, width: 800, height: 800, aspectRatio: 1 },
          }),
        ]),
      ),
    );
    const pages = buildDigestDemoPages(manifest);
    expect(pages).toHaveLength(1);
    expect(pages[0].templateId).toBe('illustrated-digest');
    expect(pages[0].slots.every((s) => s.kind === 'digest-entry')).toBe(true);
    const html = renderToStaticMarkup(
      <TemplateRenderer page={pages[0]} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('Demo entry 0.');
    expect(html).toContain('Demo entry 3.');
    expect(html).toContain('illustrated-digest__illo-img');
  });

  it('IllustratedDigest renders the SINGLE-page variant (owner round-12 extension): one column, 2 entries, ONE folio, FULL_PAGE basis', () => {
    // Two separate eligible runs (a milestone-holding memory splits them)
    // so run B's remainder-of-2 forms a clean single page — same
    // construction as the matching fitter.test.ts chunking test.
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    const aIds = Array.from({ length: 6 }, (_, i) => `a-${i}`);
    aIds.forEach((id, i) => {
      memories[id] = makeMemory({
        date: `2025-01-${String(i + 1).padStart(2, '0')}`,
        type: 'text_illustration',
        text: `Digest single-page entry a${i}.`,
        assets: [],
        illustration: { file: `assets/illo-a-${i}.webp`, width: 800, height: 800, aspectRatio: 1 },
      });
    });
    memories['sep'] = makeMemory({ date: '2025-01-07', assets: [makeAsset()], milestones: [{ id: 'm', name: 'First steps', detail: '' }] });
    const bIds = Array.from({ length: 2 }, (_, i) => `b-${i}`);
    bIds.forEach((id, i) => {
      memories[id] = makeMemory({
        date: `2025-01-${String(i + 8).padStart(2, '0')}`,
        type: 'text_illustration',
        text: `Digest single-page entry b${i}.`,
        assets: [],
        illustration: { file: `assets/illo-b-${i}.webp`, width: 800, height: 800, aspectRatio: 1 },
      });
    });
    const manifest = makeManifest(memories);
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [...aIds, 'sep', ...bIds] })]);
    const { document } = fitBook(outline, manifest);
    const singlePage = document.pages.find((p) => p.templateId === 'illustrated-digest' && !p.isSpread);
    expect(singlePage).toBeTruthy();
    expect(singlePage!.slots.filter((s) => s.kind === 'digest-entry')).toHaveLength(2);
    // Exactly ONE printed page number — never a spread pair — which is
    // what drives the template's own single-folio branch (see
    // IllustratedDigest.tsx: `isSpread ? <two folios> : <one folio>`).
    expect(singlePage!.pageNumbers).toHaveLength(1);
    expect(singlePage!.isSpread).toBe(false);

    const html = renderToStaticMarkup(
      <TemplateRenderer page={singlePage!} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('Digest single-page entry b0.');
    expect(html).toContain('Digest single-page entry b1.');
    expect(html).toContain('illustrated-digest__illo-img');
    // The printed page number itself renders exactly once (one folio, not two).
    const pageNumberStr = String(singlePage!.pageNumbers![0]);
    const occurrences = html.split(`>${pageNumberStr}<`).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('Folio + FooterIndex verso/recto mirroring (owner review round 4, item 4)', () => {
  const entries = [{ index: 1, indices: [1], date: '2025-03-01', note: 'A caption.' }];

  it('on a recto (odd) page, the folio sits outer-right and the footer index stays left-aligned — no collision to begin with', () => {
    const folioHtml = renderToStaticMarkup(<Folio pageNumber={3} isEvenPage={false} isSpread={false} />);
    const indexHtml = renderToStaticMarkup(
      <FooterIndex entries={entries} isSpread={false} language="en" isEvenPage={false} />,
    );
    expect(folioHtml).toContain('right:');
    expect(folioHtml).not.toMatch(/left:\s*\d/);
    expect(indexHtml).toContain('justify-content:flex-start');
  });

  it('on a verso (even) page, the folio stays outer-left but the footer index mirrors to right-aligned, so they never share the outer corner', () => {
    const folioHtml = renderToStaticMarkup(<Folio pageNumber={2} isEvenPage={true} isSpread={false} />);
    const indexHtml = renderToStaticMarkup(
      <FooterIndex entries={entries} isSpread={false} language="en" isEvenPage={true} />,
    );
    // Folio unchanged: still the outer (left) corner on a verso page.
    expect(folioHtml).toContain('left:');
    expect(folioHtml).not.toMatch(/right:\s*\d/);
    // Footer index mirrors to the right — hugging the inner gutter, clear of the folio's outer-left corner.
    expect(indexHtml).toContain('justify-content:flex-end');
    expect(indexHtml).not.toContain('justify-content:flex-start');
  });

  it('defaults to recto (left-aligned) when isEvenPage is omitted', () => {
    const indexHtml = renderToStaticMarkup(<FooterIndex entries={entries} isSpread={false} language="en" />);
    expect(indexHtml).toContain('justify-content:flex-start');
  });
});

describe('ThroughTheYears portrait distribution (owner review round 5, item 8)', () => {
  function makePortrait(file: string): { file: string; date: string; ageLabel: string } {
    return { file, date: '2024-06-01', ageLabel: '6 months' };
  }

  // The spread canvas is 1680px wide (two 840px trim halves side by side) —
  // a portrait's own `left%` tells us which physical page it landed on.
  function leftPercentsOf(html: string): number[] {
    return Array.from(html.matchAll(/class="ttty__item" style="[^"]*left:([\d.]+)%/g)).map((m) => Number(m[1]));
  }

  it('a 2-portrait chunk puts ONE portrait per page instead of both on the left page (bug fix)', () => {
    const manifest = makeManifest({}, { portraits: [makePortrait('p1.jpg'), makePortrait('p2.jpg')] });
    const outline = makeOutline([makeElement({ id: 'tty', kind: 'through-the-years' })]);
    const { html } = renderPage(manifest, outline);

    const lefts = leftPercentsOf(html);
    expect(lefts).toHaveLength(2);
    // One portrait's left% must fall on each half of the 1680px spread canvas.
    expect(lefts.some((l) => l < 50)).toBe(true);
    expect(lefts.some((l) => l >= 50)).toBe(true);
  });

  it('a 3-portrait chunk still splits 2 (left) + 1 (right) — unchanged, already correct before the fix', () => {
    const manifest = makeManifest({}, { portraits: [makePortrait('p1.jpg'), makePortrait('p2.jpg'), makePortrait('p3.jpg')] });
    const outline = makeOutline([makeElement({ id: 'tty', kind: 'through-the-years' })]);
    const { html } = renderPage(manifest, outline);

    const lefts = leftPercentsOf(html);
    expect(lefts).toHaveLength(3);
    expect(lefts.filter((l) => l < 50)).toHaveLength(2);
    expect(lefts.filter((l) => l >= 50)).toHaveLength(1);
  });

  it('a solo portrait renders on the right page, balancing the kicker/title on the left', () => {
    const manifest = makeManifest({}, { portraits: [makePortrait('p1.jpg')] });
    const outline = makeOutline([makeElement({ id: 'tty', kind: 'through-the-years' })]);
    const { html } = renderPage(manifest, outline);

    const lefts = leftPercentsOf(html);
    expect(lefts).toHaveLength(1);
    expect(lefts[0]).toBeGreaterThanOrEqual(50);
  });
});

describe('AnchorMedia solo-video scan-group placement (owner review round 9, item 4)', () => {
  it('a narrow (tall) solo video renders its scan group beside the image, not in the below strip', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }), // consumes this section's header, keeping mem-video's page header-free
      'mem-video': makeMemory({ assets: [makeAsset({ kind: 'video-poster', aspectRatio: 0.56 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-video'] })]);
    const { page, html } = renderPage(manifest, outline, 1);
    expect(page.templateId).toBe('anchor-media');
    expect(html).toContain('photo-tile__meta--right');
    expect(html).not.toMatch(/photo-tile__meta"/); // never the bare (below-strip) class for this page
  });

  it('a wide solo video falls back to the below strip (no side room)', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-video': makeMemory({ assets: [makeAsset({ kind: 'video-poster', aspectRatio: 1.9 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-video'] })]);
    const { page, html } = renderPage(manifest, outline, 1);
    expect(page.templateId).toBe('anchor-media');
    expect(html).not.toContain('photo-tile__meta--left');
    expect(html).not.toContain('photo-tile__meta--right');
    expect(html).toContain('photo-tile__meta"');
  });

  it('a non-video solo photo always keeps the ordinary below strip, even at a narrow aspect', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-photo': makeMemory({ text: 'A caption to keep the numeral visible.', assets: [makeAsset({ aspectRatio: 0.56 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-photo'] })]);
    const { html } = renderPage(manifest, outline, 1);
    expect(html).not.toContain('photo-tile__meta--left');
    expect(html).not.toContain('photo-tile__meta--right');
  });
});
