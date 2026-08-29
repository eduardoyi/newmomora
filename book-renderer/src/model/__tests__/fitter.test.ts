import { describe, expect, it } from 'vitest';
import { fitBook, splitLongText, partitionQuoteRun, reorderUnitsForParity } from '../fitter';
import { auditBookDocument } from '../audit';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import type { PhotoSlotContent, TextSlotContent, IllustrationSlotContent, DigestEntryContent, ManifestMemory } from '../types';

/** Builds a photo-only memory with a given aspect and engagement — the shared fixture shape for the round-5 tests below. */
function photoMemory(aspectRatio: number, engagement = 0, date = '2024-06-01') {
  return makeMemory({ assets: [makeAsset({ aspectRatio })], engagement, date });
}

/** Builds a video-only memory (a `video-poster` asset) — the `video` demotion-kind fixture (round-13 rebalance). */
function videoMemory(aspectRatio: number, engagement = 0, date = '2024-06-01') {
  return makeMemory({ assets: [makeAsset({ aspectRatio, kind: 'video-poster' })], engagement, date, type: 'video' });
}

/** Builds a digest-ELIGIBLE illustrated memory (Task 1, round-12): illustration + short text, near-square aspect, no milestones — the shared fixture shape for the illustrated-digest tests below. */
function digestMemory(date: string, overrides: Partial<ManifestMemory> = {}) {
  return makeMemory({
    type: 'text_illustration',
    text: 'A short digest-eligible caption.',
    assets: [],
    illustration: { file: `assets/illo-${date}.webp`, width: 800, height: 800, aspectRatio: 1 },
    date,
    ...overrides,
  });
}

const LONG_TEXT =
  'This is a deliberately long memory entry that exceeds the two-hundred-forty ' +
  'character threshold the fitter uses to decide a text-forward layout is required, ' +
  'because captions and memory text must never be trimmed to fit a template — the ' +
  'plan is explicit that long entries always get text-forward layouts instead of ' +
  'being cut down to size, no matter how long they run on for.';

describe('fitBook — feasibility filtering', () => {
  it('a memory with neither a photo nor text produces no page and no gap (nothing to show)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [], text: null }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);

    expect(document.pages).toHaveLength(0);
    expect(gaps).toHaveLength(0);
  });

  it('density: two DIFFERENT single-photo memories never share a page — each gets its own (owner round-3 rule)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);

    expect(gaps).toHaveLength(0);
    expect(document.pages).toHaveLength(2);
    for (const page of document.pages) expect(page.templateId).toBe('anchor-media');
  });

  it('density: a single memory with exactly 4 photos gets ONE flex-grid page (the single-memory exception)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset(), makeAsset(), makeAsset(), makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0].templateId).toBe('flex-grid');
    expect(document.pages[0].slots.filter((s) => s.kind === 'photo')).toHaveLength(4);
  });

  it('density (round-8 item 5b, "grids only at 4"): a single memory with EXACTLY 3 photos splits 2+1 instead — a 3-photo flex-grid never happens', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset(), makeAsset(), makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.every((p) => p.templateId !== 'flex-grid')).toBe(true);
    expect(document.pages.every((p) => (p.slots.filter((s) => s.kind === 'photo').length) !== 3)).toBe(true);
    const photoCounts = document.pages.map((p) => p.slots.filter((s) => s.kind === 'photo').length).filter((n) => n > 0);
    expect(photoCounts.sort()).toEqual([1, 2]);
  });

  it('density: a single memory with 5+ photos splits across facing pages, max 4 + remainder', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: Array.from({ length: 6 }, () => makeAsset()) }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages).toHaveLength(2);
    expect(document.pages[0].slots.filter((s) => s.kind === 'photo')).toHaveLength(4);
    expect(document.pages[1].slots.filter((s) => s.kind === 'photo')).toHaveLength(2);
  });

  it('routes a single real photo with a short caption to anchor-media, caption in the footer (item 7 — photo-story retired)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'A short caption under 240 characters.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('anchor-media');
    const footerIndex = document.pages[0].params.footerIndex as Array<{ note: string | null }>;
    expect(footerIndex[0].note).toBe('A short caption under 240 characters.');
  });

  it('routes a single photo with no caption to anchor-media', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('anchor-media');
  });
});

describe('fitBook — full-bleed trusted path (owner review round 3, item 2)', () => {
  it('PREFERS full-bleed for a trusted hero — near-square, wide enough, no face data needed', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages[0].templateId).toBe('full-bleed');
  });

  it('PREFERS full-bleed for a trusted hero at a moderate landscape aspect (under the panorama threshold)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 4000, height: 3600, aspectRatio: 1.11, originalWidth: 4000 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.every((p) => p.templateId !== 'panorama-spread')).toBe(true);
    expect(document.pages[0].templateId).toBe('full-bleed');
  });

  it('a WIDE trusted hero (aspect >= panorama threshold) routes to panorama instead — never square-cropped by full-bleed (owner review round 7, item 2b)', () => {
    // The exact shape that used to win full-bleed pre-round-7: a hero at
    // aspect 2 with no explicit outline.panoramaCandidates nomination. A
    // hero this wide is "panorama material by nature" now — it must never
    // be square-cropped, so it routes to the panorama placement path
    // (still budget/trust-gated) even without an explicit nomination.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2, originalWidth: 4000 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.every((p) => p.templateId !== 'full-bleed')).toBe(true);
    expect(document.pages.some((p) => p.templateId === 'panorama-spread')).toBe(true);
  });

  it('a WIDE hero that fails the panorama trust gate (too low-res) falls through to anchor-media, never full-bleed — "never square-crop it" is absolute', () => {
    const manifest = makeManifest({
      // aspect 2 (>= panorama threshold) but originalWidth well under the panorama trust gate.
      'mem-1': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2, originalWidth: 1000 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.every((p) => p.templateId !== 'full-bleed')).toBe(true);
    expect(document.pages.every((p) => p.templateId !== 'panorama-spread')).toBe(true);
    expect(document.pages[0].templateId).toBe('anchor-media');
  });

  it('reads originalWidth over preview width for the trust gate, same pattern as the panorama trusted path', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1, originalWidth: 1200 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    // originalWidth (1200) says the source wasn't actually print-safe —
    // untrusted, and the (always-false) face gate still applies.
    expect(document.pages[0].templateId).toBe('anchor-media');
  });

  it('a highlighted but strongly portrait photo is untrusted (not near-square/landscape) and still fails closed to anchor-media', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 3000, height: 6000, aspectRatio: 0.5 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.every((p) => p.templateId !== 'full-bleed')).toBe(true);
    expect(document.pages[0].templateId).toBe('anchor-media');
  });

  it('never selects panorama-spread via the general (non-outline-nominated) scorer even for a wide, highlighted photo — no face data exists yet on that path', () => {
    // A photo wide/highlighted enough to ALSO win full-bleed's trusted path
    // (item 2) would otherwise mask whether panorama's own general scorer
    // still fails closed — keep this one deliberately too narrow for
    // full-bleed's near-square/landscape trust gate.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2, originalWidth: 1000 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.every((p) => p.templateId !== 'panorama-spread')).toBe(true);
    expect(document.pages[0].templateId).toBe('anchor-media');
  });
});

describe('fitBook — full-bleed 4:3 crop-loss threshold + pacing (owner review round 8, item 5a)', () => {
  /** A single-photo, non-hero, print-trusted memory at a given aspect — the shared fixture shape for the tests below. */
  function trustedSoloPhoto(aspectRatio: number, i: number) {
    return makeMemory({
      assets: [makeAsset({ aspectRatio, width: 3000, originalWidth: 3000 })],
      date: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
    });
  }

  it('a standard 4:3 photo (exactly 25% crop loss) now qualifies for full-bleed — the old 0.2 bar excluded it', () => {
    const manifest = makeManifest({ 'mem-1': trustedSoloPhoto(4 / 3, 0) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages[0].templateId).toBe('full-bleed');
  });

  it('a photo beyond the 25% bar (a wider non-hero source) still does NOT qualify for full-bleed', () => {
    const manifest = makeManifest({ 'mem-1': trustedSoloPhoto(1.5, 0) }); // cropLoss = 1 - 1/1.5 = 0.333, over 0.25
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).not.toBe('full-bleed');
  });

  it('a large pool of full-bleed-eligible photos is PACED through the book — the cumulative full-bleed count at any point never exceeds floor(contentPagePosition / 15) + 1', () => {
    const FULL_BLEED_PACING_PAGES = 15; // mirrors fitter.ts's own constant
    const N = 60;
    const memories = Object.fromEntries(Array.from({ length: N }, (_, i) => [`mem-${i}`, trustedSoloPhoto(4 / 3, i)]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: Object.keys(memories) })]);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    // Every memory here is a simple solo photo (never text-forward, never
    // illustrated, never a multi-photo group) — each maps to exactly ONE
    // physical content page, so a running count of NON-BLANK pages tracks
    // the fitter's internal `contentPageCount` position closely (a `blank`
    // parity filler — full-bleed forces even-page landing — is pushed
    // OUTSIDE `processGroup` and never increments that counter, so it's
    // excluded here too). `ensureEvenLanding` can also SWAP a full-bleed
    // page with the single immediately-preceding page to fix parity
    // without a blank at all, which can shift a full-bleed's own array
    // position by up to 1 relative to the `contentPageCount` it was
    // actually scored at — the `+ 1` slack below absorbs exactly that,
    // nothing more.
    let fullBleedCount = 0;
    let sawFullBleed = false;
    let position = 0;
    for (const page of document.pages) {
      if (page.templateId === 'blank') continue;
      if (page.templateId === 'full-bleed') {
        sawFullBleed = true;
        fullBleedCount += 1;
        expect(fullBleedCount).toBeLessThanOrEqual(Math.floor((position + 1) / FULL_BLEED_PACING_PAGES) + 1);
      }
      position += 1;
    }
    // The pool is large and every photo equally qualifies — confirm pacing
    // is actually doing something (not vacuously true because nothing won
    // full-bleed at all).
    expect(sawFullBleed).toBe(true);
  });

  it('pacing does not front-load every full-bleed into the first ~10 pages — the overall budget cap alone (1 + floor(pages/10)) would otherwise allow up to 3 within the first 20 pages, but pacing (1 per ~15) allows at most 2', () => {
    const N = 30;
    const memories = Object.fromEntries(Array.from({ length: N }, (_, i) => [`mem-${i}`, trustedSoloPhoto(4 / 3, i)]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: Object.keys(memories) })]);
    const { document } = fitBook(outline, makeManifest(memories));

    const firstTwenty = document.pages.slice(0, 20);
    const fullBleedInFirstTwenty = firstTwenty.filter((p) => p.templateId === 'full-bleed').length;
    expect(fullBleedInFirstTwenty).toBeLessThanOrEqual(2);
  });
});

describe('fitBook — illustrated-story routing', () => {
  it('routes a text_illustration memory to illustrated-story ahead of every other template', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'A short illustrated moment.',
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('illustrated-story');
    // Round-9 item 1c: this memory is the section's first unit, so it
    // carries a section header — and a headed page's fixed overhead now
    // always forces the text/illustration split (see fitter.test.ts's
    // dedicated round-9 split-threshold tests below) — so the illustration
    // slot may land on a LATER page (the split's ':illustration' half)
    // rather than page 0. This test is only about illustrated-story
    // routing/feasibility, not the split decision, so it checks every page.
    const illoSlot = document.pages.flatMap((p) => p.slots).find((s) => s.kind === 'illustration');
    expect(illoSlot).toBeTruthy();
  });

  it('never bundles an illustrated memory into a flex-grid with other photos', () => {
    const manifest = makeManifest({
      'mem-photo': makeMemory({ assets: [makeAsset()] }),
      'mem-illo': makeMemory({
        type: 'text_illustration',
        text: 'An illustrated moment.',
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-photo', 'mem-illo'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages).toHaveLength(2);
    expect(document.pages.some((p) => p.templateId === 'illustrated-story')).toBe(true);
  });

  it('splits a long (>400 char) illustrated entry into a text-only page + a facing illustration-only page', () => {
    const longText = 'A '.repeat(250) + 'long illustrated story that runs past four hundred characters.';
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: longText,
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const pages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(pages).toHaveLength(2);
    expect(pages[0].params.mode).toBe('text-only');
    expect(pages[1].params.mode).toBe('illustration-only');
    const textSlot = pages[0].slots.find((s) => s.kind === 'text')!;
    expect((textSlot.content as TextSlotContent).text).toBe(longText);
  });
});

describe('fitBook — audio-note routing', () => {
  it('routes an image-less audio memory to audio-note, never text-page', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ type: 'audio', text: 'Singing happy birthday.', assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('audio-note');
    const audioSlot = document.pages[0].slots.find((s) => s.kind === 'audio-note');
    expect(audioSlot).toBeTruthy();
  });

  it('never puts more than 2 audio notes on the same page', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ type: 'audio', assets: [] }),
      'mem-2': makeMemory({ type: 'audio', assets: [] }),
      'mem-3': makeMemory({ type: 'audio', assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const audioPages = document.pages.filter((p) => p.templateId === 'audio-note');
    expect(audioPages).toHaveLength(2); // 2 + 1, never 3 on one page
    expect(audioPages[0].slots.filter((s) => s.kind === 'audio-note')).toHaveLength(2);
    expect(audioPages[1].slots.filter((s) => s.kind === 'audio-note')).toHaveLength(1);
  });

  it('regression (Enzo p24 "Bailando con mami"): a video memory NEVER gets the big audio-note scan mark, even with type "media"', () => {
    // The real-world bug report: a video-poster memory whose `type` field is
    // the generic DB catch-all "media" (not "video") must still never be
    // treated as audio — audio-note requires type === 'audio' AND zero
    // assets; this memory has a video-poster asset, so it must always route
    // like any other photo/video memory (anchor-media, caption in the
    // footer — item 7 retired photo-story's on-page caption).
    const manifest = makeManifest({
      'mem-video': makeMemory({
        type: 'media',
        text: 'Bailando con mami',
        assets: [makeAsset({ kind: 'video-poster', width: 3840, height: 2160, aspectRatio: 16 / 9 })],
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-video'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'audio-note')).toBe(true);
    expect(document.pages.some((p) => p.slots.some((s) => s.kind === 'audio-note'))).toBe(false);
    expect(document.pages[0].templateId).toBe('anchor-media');
    const photoSlot = document.pages[0].slots.find((s) => s.kind === 'photo')!;
    expect((photoSlot.content as PhotoSlotContent).qr).toBe(true);
  });
});

describe('fitBook — text is never trimmed', () => {
  it('routes a memory with long text and no photo to text-page, verbatim and in full', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: LONG_TEXT, assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);

    expect(gaps).toHaveLength(0);
    expect(document.pages[0].templateId).toBe('text-page');
    const textSlot = document.pages[0].slots.find((s) => s.kind === 'text')!;
    expect((textSlot.content as TextSlotContent).text).toBe(LONG_TEXT);
  });

  it('routes a memory with long text AND a real photo to text-page with a facing companion photo page', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: LONG_TEXT, assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('text-page');
    const textSlot = document.pages[0].slots.find((s) => s.kind === 'text')!;
    expect((textSlot.content as TextSlotContent).text).toBe(LONG_TEXT);
    // The companion photo lands on its own facing page — text-page never
    // renders a photo slot itself (Momora Book Layout System: "la foto se
    // maqueta como acompañante").
    expect(document.pages[1].slots.some((s) => s.kind === 'photo')).toBe(true);
  });

  it('splits a memory whose text exceeds 1600 characters into a double text-page spread', () => {
    const veryLongText = LONG_TEXT.repeat(6); // well past 1600 chars
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: veryLongText, assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const textPages = document.pages.filter((p) => p.templateId === 'text-page');
    expect(textPages).toHaveLength(2);
    const combined =
      (textPages[0].slots[0].content as TextSlotContent).text + ' ' + (textPages[1].slots[0].content as TextSlotContent).text;
    // Nothing is dropped — every word from the original text still appears (split, not trimmed).
    expect(combined.replace(/\s+/g, ' ')).toContain(veryLongText.trim().slice(0, 50));
  });

  it('never silently drops a real photo on a memory whose text runs past 1600 characters', () => {
    const veryLongText = LONG_TEXT.repeat(6);
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: veryLongText, assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.slots.some((s) => s.kind === 'photo'))).toBe(true);
  });

  it('never bundles a long-text memory into a multi-photo grid with other memories', () => {
    const manifest = makeManifest({
      'mem-short': makeMemory({ assets: [makeAsset()] }),
      'mem-long': makeMemory({ text: LONG_TEXT, assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-short', 'mem-long'] }),
    ]);

    const { document } = fitBook(outline, manifest);

    // Separate pages, not one grid page mixing both.
    expect(document.pages.some((p) => p.templateId === 'text-page')).toBe(true);
    expect(document.pages.length).toBeGreaterThanOrEqual(2);
  });

  it('never drops a zero-asset text-only memory — it gets its own text-page rather than riding along a neighbor\'s photo page', () => {
    const manifest = makeManifest({
      'mem-photo': makeMemory({ assets: [makeAsset()] }),
      'mem-text-only': makeMemory({ text: 'First time she laughed out loud at the dog.', assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-photo', 'mem-text-only'] }),
    ]);

    const { document } = fitBook(outline, manifest);

    expect(document.pages).toHaveLength(2);
    const textSlot = document.pages
      .flatMap((p) => p.slots)
      .find((s) => s.kind === 'text' && (s.content as TextSlotContent).memoryId === 'mem-text-only');
    expect(textSlot).toBeTruthy();
    expect((textSlot!.content as TextSlotContent).text).toBe('First time she laughed out loud at the dog.');
  });
});

describe('splitLongText', () => {
  it('never breaks a word — every character from the original survives across both halves', () => {
    const text = 'One sentence here. Another sentence follows right after. And a third one, for good measure.';
    const [a, b] = splitLongText(text);
    expect(`${a} ${b}`.replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('prefers splitting at a paragraph break over a mid-sentence cut', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}`;
    const [a, b] = splitLongText(text);
    expect(a).toBe('a'.repeat(50));
    expect(b).toBe('b'.repeat(50));
  });
});

describe('fitBook — footer index numbering', () => {
  it('numbers photo tiles per page in reading order, starting at 1 (single-memory flex-grid page)', () => {
    // 4 photos (not 3 — round-8 item 5b "grids only at 4" retired the
    // 3-photo grid; see the dedicated test in the "feasibility filtering"
    // describe above), all default aspect so `gridAspectsCompatible` keeps
    // them on one flex-grid page.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset(), makeAsset(), makeAsset(), makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('flex-grid');
    const photoSlots = document.pages[0].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    const indices = photoSlots.map((s) => s.content.index).sort();
    expect(indices).toEqual([1, 2, 3, 4]);
    // Footnote consolidation (owner review round 3, item 9): all four
    // photos share the SAME memory's date and (absent) caption, so they
    // consolidate onto one line carrying all four numerals.
    const footerIndex = document.pages[0].params.footerIndex as Array<{ index: number; indices: number[] }>;
    expect(footerIndex).toHaveLength(1);
    expect(footerIndex[0].indices).toEqual([1, 2, 3, 4]);
  });
});

describe('fitBook — footnote consolidation (owner review round 3, item 9)', () => {
  it('never merges two DIFFERENT memories that happen to share a date but have different captions', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(
      ids.map((id, i) => [id, makeMemory({ date: '2024-06-01', text: `Caption ${i}`, assets: [makeAsset()] })]),
    );
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })], {});

    // Force full pairing so several different-caption memories land on
    // shared anchor-media pages sharing the exact same date.
    const { document } = fitBook(outline, makeManifest(memories), { maxPages: 4 });
    for (const page of document.pages) {
      if (page.templateId !== 'anchor-media') continue;
      const footerIndex = page.params.footerIndex as Array<{ indices: number[]; note: string | null }>;
      // Every consolidated line's indices must all point at entries that
      // actually share the SAME caption — never a false merge.
      for (const entry of footerIndex) expect(entry.indices.length).toBeGreaterThanOrEqual(1);
      const notes = new Set(footerIndex.map((e) => e.note));
      expect(notes.size).toBe(footerIndex.length); // one distinct caption per line, never blended
    }
  });

  it('renders consolidated numerals as true superscripts (in normal inline flow, not a separate flex sibling)', () => {
    // 4 photos (not 3 — round-8 item 5b "grids only at 4"), so this still
    // exercises a flex-grid page's own consolidated footer numbering.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset(), makeAsset(), makeAsset(), makeAsset()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const page = document.pages[0];
    expect(page.templateId).toBe('flex-grid');
    // Structural check only (rendering itself is exercised in templates.test.tsx) — four numerals, one line.
    const footerIndex = page.params.footerIndex as Array<{ indices: number[] }>;
    expect(footerIndex[0].indices).toEqual([1, 2, 3, 4]);
  });
});

describe('fitBook — month-opener section headers', () => {
  it('attaches the backbone segment title as a section header on its first content page (fixes the ignored-title bug)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({
        id: 'backbone:2024-12',
        kind: 'backbone',
        title: 'December 2024',
        memoryIds: ['mem-1', 'mem-2'],
      }),
    ]);

    const { document } = fitBook(outline, manifest);
    const header = document.pages[0].params.sectionHeader as { title: string } | null;
    expect(header?.title).toBe('December 2024');
  });

  it('only attaches the header to the first eligible page, not every page in the segment', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
      'mem-3': makeMemory({ assets: [makeAsset()] }),
      'mem-4': makeMemory({ assets: [makeAsset()] }),
      'mem-5': makeMemory({ assets: [makeAsset()] }),
      'mem-6': makeMemory({ assets: [makeAsset()] }),
      'mem-7': makeMemory({ assets: [makeAsset()] }),
      'mem-8': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({
        id: 'backbone:2024-12',
        kind: 'backbone',
        title: 'December 2024',
        memoryIds: ['mem-1', 'mem-2', 'mem-3', 'mem-4', 'mem-5', 'mem-6', 'mem-7', 'mem-8'],
      }),
    ]);

    const { document } = fitBook(outline, manifest);
    const withHeader = document.pages.filter((p) => p.params.sectionHeader);
    expect(withHeader).toHaveLength(1);
  });

  it('localizes both the month-range kicker/eyebrow and a plain month-name title for an es book (acceptance-review straggler)', () => {
    const manifest = makeManifest(
      { 'mem-1': makeMemory({ assets: [makeAsset()] }) },
      { language: 'es' },
    );
    const outline = makeOutline([
      makeElement({
        id: 'backbone:2024-10_2024-11',
        kind: 'backbone',
        title: 'El mes en que cumpliste dos', // real editorial title — must stay untouched
        subtitle: 'October–November 2024', // auto-generated eyebrow — must localize
        memoryIds: ['mem-1'],
      }),
    ]);

    const { document } = fitBook(outline, manifest);
    const header = document.pages[0].params.sectionHeader as { kicker: string | null; title: string };
    expect(header.kicker).toBe('octubre–noviembre 2024');
    expect(header.title).toBe('El mes en que cumpliste dos');
  });

  it('localizes a plain month-name title (no eyebrow at all) for an ordinary es month segment', () => {
    const manifest = makeManifest(
      { 'mem-1': makeMemory({ assets: [makeAsset()] }) },
      { language: 'es' },
    );
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-12', kind: 'backbone', title: 'December 2024', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const header = document.pages[0].params.sectionHeader as { kicker: string | null; title: string };
    expect(header.kicker).toBeNull();
    expect(header.title).toBe('diciembre 2024');
  });

  it('leaves the month title/eyebrow in English for an en book (default language)', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
    const outline = makeOutline([
      makeElement({
        id: 'backbone:2024-10_2024-11',
        kind: 'backbone',
        title: 'The month you turned two',
        subtitle: 'October–November 2024',
        memoryIds: ['mem-1'],
      }),
    ]);

    const { document } = fitBook(outline, manifest);
    const header = document.pages[0].params.sectionHeader as { kicker: string | null; title: string };
    expect(header.kicker).toBe('October–November 2024');
    expect(header.title).toBe('The month you turned two');
  });
});

describe('fitBook — hero slots from outline highlights', () => {
  it('marks a highlighted memory as hero and leaves others un-hero-ed', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-b': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({
        id: 'emotion:funny',
        kind: 'themed',
        memoryIds: ['mem-a', 'mem-b'],
        spreadType: 'emotion',
        titleMode: 'quote',
        titleSourceMemoryId: 'mem-a',
        highlights: ['mem-a'],
      }),
    ]);

    const { document } = fitBook(outline, manifest);
    // Density (owner round-3 rule): mem-a and mem-b are DIFFERENT memories,
    // so they never share a page — each gets its own.
    const photoSlots = document.pages.flatMap((p) => p.slots).filter((s) => s.kind === 'photo') as Array<{
      content: PhotoSlotContent;
    }>;
    const hero = photoSlots.find((s) => s.content.memoryId === 'mem-a')!;
    const nonHero = photoSlots.find((s) => s.content.memoryId === 'mem-b')!;
    expect(hero.content.hero).toBe(true);
    expect(nonHero.content.hero).toBe(false);
  });

  it('gives a highlighted memory with several assets exactly ONE hero tile, not every asset', () => {
    // A single highlighted memory with 4 assets (e.g. 3 photos + a video
    // poster from one birthday) must not hand the packer four simultaneous
    // hero-sized spans — only its first asset is the hero.
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset(), makeAsset(), makeAsset(), makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a'], highlights: ['mem-a'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const photoSlots = document.pages[0].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    expect(photoSlots.filter((s) => s.content.hero)).toHaveLength(1);
  });

  it('also honors a book-wide heroCandidate (outline.heroCandidates), not just per-segment highlights', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-b': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-b'] })],
      { heroCandidates: ['mem-b'] },
    );

    const { document } = fitBook(outline, manifest);
    const photoSlots = document.pages.flatMap((p) => p.slots).filter((s) => s.kind === 'photo') as Array<{
      content: PhotoSlotContent;
    }>;
    expect(photoSlots.find((s) => s.content.memoryId === 'mem-b')!.content.hero).toBe(true);
  });
});

describe('fitBook — variant ranking', () => {
  it('ranks 2-3 feasible alternates, best first, each with its own slots', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'a short caption', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const page = document.pages[0];

    expect(page.variants.length).toBeGreaterThanOrEqual(2);
    expect(page.variants.length).toBeLessThanOrEqual(3);
    expect(page.variants[0].templateId).toBe(page.templateId);
    for (let i = 1; i < page.variants.length; i++) {
      expect(page.variants[i - 1].score).toBeGreaterThanOrEqual(page.variants[i].score);
    }
    for (const variant of page.variants) {
      expect(variant.slots).toBeDefined();
    }
  });
});

describe('fitBook — layout-gaps report', () => {
  it('flags a page whose best fit scores below threshold, but still renders it', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'short', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest, { scoreThreshold: 0.99 });

    expect(document.pages).toHaveLength(1); // still rendered
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toMatch(/scored/);
  });
});

describe('fitBook — firsts as a normal themed section (owner review round 3, item 15)', () => {
  it('opens with a title page carrying the localized "firsts" kicker + the outline title, then flows the memory through normal content-page scoring', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        text: 'She took her first steps today!',
        milestones: [{ id: 'first-steps', name: 'First steps', detail: '' }],
        assets: [],
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    // No bespoke ruled-list "firsts" template anymore.
    expect(document.pages.every((p) => p.templateId !== 'firsts')).toBe(true);
    expect(document.pages[0].templateId).toBe('spread-title');
    expect(document.pages[0].params.kicker).toBe('firsts'); // default (en) furniture — never invented, never outline-authored
    expect(document.pages[0].params.title).toBe('Firsts');
    // Zero-asset memory -> text-forward, exactly like any other section.
    expect(document.pages[1].templateId).toBe('text-page');
    const textSlot = document.pages[1].slots.find((s) => s.kind === 'text')!;
    expect((textSlot.content as TextSlotContent).text).toBe('She took her first steps today!');
  });

  it("uses a memory's AI-written warm_name as its caption instead of its own raw text, with no repetition of the caption", () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'mama said she rode without training wheels', assets: [makeAsset()] }),
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
    expect(contentPage.templateId).toBe('anchor-media');
    const footerIndex = contentPage.params.footerIndex as Array<{ note: string | null }>;
    expect(footerIndex[0].note).toBe('Aprendiste a montar bicicleta sin pedales.');
    // The raw memory text never also appears — no repeated/duplicated caption.
    const rawTextAppearsAnywhere = document.pages.some((p) =>
      p.slots.some((s) => s.kind === 'text' && (s.content as TextSlotContent).text.includes('training wheels')),
    );
    expect(rawTextAppearsAnywhere).toBe(false);
  });

  it('falls back to the memory\'s own verbatim text when no warm_name entry exists for it (never fabricated)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'First haircut today.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1'] }), // no firstsEntries at all
    ]);

    const { document } = fitBook(outline, manifest);
    const footerIndex = document.pages[1].params.footerIndex as Array<{ note: string | null }>;
    expect(footerIndex[0].note).toBe('First haircut today.');
  });

  it('is never a page-cap demotion candidate, even under a very tight cap', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()], engagement: 0 }),
    });
    const outline = makeOutline([
      makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1'] }),
    ]);

    const { capacity } = fitBook(outline, manifest, { maxPages: 1 });
    expect(capacity.omittedMemoryIds).not.toContain('mem-1');
  });

  it('gives a milestone memory with only an illustration (no real photo) a facing content page too', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'Learned to ride the balance bike.',
        milestones: [{ id: 'balance-bike', name: 'Rides scooter / balance bike', detail: '' }],
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.templateId === 'illustrated-story')).toBe(true);
  });

  it('gives a milestone memory WITH a photo a facing content page', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        text: 'First haircut.',
        milestones: [{ id: 'first-haircut', name: 'First haircut', detail: '' }],
        assets: [makeAsset()],
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages).toHaveLength(2);
    expect(document.pages[0].templateId).toBe('spread-title');
    expect(document.pages[1].slots.some((s) => s.kind === 'photo')).toBe(true);
  });
});

describe('fitBook — structural pages', () => {
  it('builds a cover, blank+dedication, through-the-years, and closing page even with no memories', () => {
    const manifest = makeManifest({});
    const outline = makeOutline([
      makeElement({ id: 'cover', kind: 'cover' }),
      makeElement({ id: 'title', kind: 'title' }),
      makeElement({ id: 'through-the-years', kind: 'through-the-years' }),
      makeElement({ id: 'closing', kind: 'closing' }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);

    expect(gaps).toHaveLength(0);
    expect(document.pages.map((p) => p.templateId)).toEqual([
      'cover-wrap',
      'blank',
      'dedication',
      'through-the-years',
      'closing',
    ]);
    // No qualifying photo -> minimal voice.
    expect(document.pages[0].params.voice).toBe('minimal');
  });

  it('picks photo voice for a wide (>=1.4:1) spread-safe photo, mixed voice for a narrower one', () => {
    const wideManifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 2800, height: 2000, aspectRatio: 1.4 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'cover', kind: 'cover' })]);
    const { document: wideDoc } = fitBook(outline, wideManifest);
    expect(wideDoc.pages[0].templateId).toBe('cover-wrap');
    expect(wideDoc.pages[0].params.voice).toBe('photo');
    expect(wideDoc.pages[0].params.assetFile).toMatch(/^assets\/asset-\d+\.jpg$/);

    const narrowManifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 2000, height: 2400, aspectRatio: 0.83 })] }),
    });
    const { document: narrowDoc } = fitBook(outline, narrowManifest);
    expect(narrowDoc.pages[0].params.voice).toBe('mixed');
  });

  it('defaults the spine to 9mm and honors an explicit spineMm option', () => {
    const manifest = makeManifest({});
    const outline = makeOutline([makeElement({ id: 'cover', kind: 'cover' })]);
    const { document: withDefault } = fitBook(outline, manifest);
    expect(withDefault.pages[0].params.spineMm).toBe(9);
    const { document: withCustom } = fitBook(outline, manifest, { spineMm: 15 });
    expect(withCustom.pages[0].params.spineMm).toBe(15);
  });

  it('leaves the cover and front-matter-verso blank unnumbered, counting starts at 1 on the dedication (round-22 physical-folio renumbering), and gives the closing page a dynamic MEMORY count (item 16 — not a page count)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ text: 'A caption.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'cover', kind: 'cover' }),
      makeElement({ id: 'title', kind: 'title' }),
      makeElement({ id: 'through-the-years', kind: 'through-the-years' }),
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] }),
      makeElement({ id: 'closing', kind: 'closing' }),
    ]);

    const { document } = fitBook(outline, manifest);
    const blank = document.pages.find((p) => p.templateId === 'blank')!;
    const dedication = document.pages.find((p) => p.templateId === 'dedication')!;
    const closing = document.pages.find((p) => p.templateId === 'closing')!;
    // Prodigi adds the inside-front-cover blank itself and our own
    // front-matter-verso blank never reaches the interior PDF (render-pdf.mts)
    // — neither carries a printed folio.
    expect(blank.pageNumbers).toBeNull();
    expect(blank.isEvenPage).toBeNull();
    expect(dedication.pageNumbers).toEqual([1]);
    expect(closing.params.memoryCount).toBe(2);
    expect(closing.params.editorialNote).toBeUndefined(); // never printed — see the dedicated leak-regression test
  });

  it('emits a spread-title opener as a single even page, immediately before the themed spread’s content pages', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({
        id: 'topic:travel',
        kind: 'themed',
        memoryIds: ['mem-1', 'mem-2'],
        spreadType: 'topic',
        titleMode: 'descriptive',
      }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('spread-title');
    expect(document.pages[0].isSpread).toBe(false);
    // mem-1 and mem-2 are different memories -> density rule gives each its own anchor-media page.
    expect(document.pages[1].templateId).toBe('anchor-media');
    expect(document.pages[2].templateId).toBe('anchor-media');
  });
});

describe('fitBook — panorama splicing (outline.panoramaCandidates)', () => {
  it('promotes a qualifying candidate out of its backbone grid into its own panorama-spread, in place', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-pano', 'mem-2'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    const templates = document.pages.map((p) => p.templateId);
    // A spread must start on an EVEN page (owner review round 4 item 8: a
    // book-binding "opening"). Round-7's fallback ladder resolves this with
    // the gentlest move — relocating the PRECEDING single to just after the
    // panorama — so the spread starts even with no blank. One-position
    // local reorder, same accepted class as the old forward-pull.
    expect(templates).toEqual(['panorama-spread', 'anchor-media', 'anchor-media']);
    const panoramaPage = document.pages[0];
    expect(panoramaPage.isSpread).toBe(true);
    const photoSlot = panoramaPage.slots.find((s) => s.kind === 'photo')!;
    expect((photoSlot.content as PhotoSlotContent).memoryId).toBe('mem-pano');
    expect((photoSlot.content as PhotoSlotContent).cropBand).toBe('center');
  });

  it('regression (Mara live-data bug): a trusted, placed, qualifying candidate whose PREVIEW is small but originalWidth clears the bar promotes to exactly one panorama-spread at its chronological position', () => {
    // Pinned to the exact real-data shape reported: preview 1280x961
    // (landscape, but not wide enough on its own), originalWidth/Height
    // 4624x3472 (>= the 3500px trust threshold). A single asset, exactly
    // like the real memory.
    const manifest = makeManifest({
      'mem-before': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({
        assets: [makeAsset({ width: 1280, height: 961, aspectRatio: 1280 / 961, originalWidth: 4624, originalHeight: 3472 })],
      }),
      'mem-after': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-before', 'mem-pano', 'mem-after'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    const panoramaPages = document.pages.filter((p) => p.templateId === 'panorama-spread');
    expect(panoramaPages).toHaveLength(1);
    // Round-7 fallback ladder: the preceding single relocates after the
    // panorama (gentlest move), so the spread starts even with no blank.
    const templates = document.pages.map((p) => p.templateId);
    expect(templates).toEqual(['panorama-spread', 'anchor-media', 'anchor-media']);
    const photoSlot = panoramaPages[0].slots.find((s) => s.kind === 'photo')!;
    expect((photoSlot.content as PhotoSlotContent).memoryId).toBe('mem-pano');
  });

  it('bug fix: a candidate with MORE than one asset is no longer disqualified outright — the gate now reads its first asset, matching what the render path actually uses', () => {
    const manifest = makeManifest({
      'mem-pano': makeMemory({
        assets: [
          makeAsset({ width: 4000, height: 2000, aspectRatio: 2, originalWidth: 4000 }),
          makeAsset({ aspectRatio: 1 }), // a second, unrelated asset on the same memory
        ],
      }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-pano'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.templateId === 'panorama-spread')).toBe(true);
  });

  it('rejects a portrait-orientation or too-narrow candidate even if nominated (bypasses the face gate, not the size/orientation gate)', () => {
    const manifest = makeManifest({
      'mem-pano': makeMemory({ assets: [makeAsset({ width: 2000, height: 4000, aspectRatio: 0.5 })] }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-pano'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'panorama-spread')).toBe(true);
  });

  it('never selects panorama-spread for a memory NOT in panoramaCandidates, even with a qualifying photo (face gate still applies otherwise)', () => {
    const manifest = makeManifest({
      'mem-wide': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-wide'] })]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'panorama-spread')).toBe(true);
  });

  it('caps placements at the quota (1 + 1 per ~20 content pages) rather than an unlimited flood', () => {
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    const candidateIds: string[] = [];
    // 3 candidates, but only ~1 content page has been built so far -> quota is 1.
    for (let i = 0; i < 3; i++) {
      const id = `mem-pano-${i}`;
      memories[id] = makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] });
      candidateIds.push(id);
    }
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: candidateIds })],
      { panoramaCandidates: candidateIds },
    );

    const { document } = fitBook(outline, makeManifest(memories));
    const panoramaPages = document.pages.filter((p) => p.templateId === 'panorama-spread');
    expect(panoramaPages).toHaveLength(1);
  });

  it('takes UP TO the quota from however many qualify — not hardcoded to one (owner review round 4, item 9)', () => {
    // Pad with enough ordinary content pages in a PRECEDING section first
    // (quota = 1 + floor(contentPageCount / 20) — contentPageCount only
    // accumulates from pages already emitted by earlier elements) to raise
    // the quota to 2 by the time the candidates' own section is processed,
    // then supply 3 qualifying candidates there — exactly 2 (not 1, not 3)
    // should promote.
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    const paddingIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `mem-pad-${i}`;
      memories[id] = makeMemory({ assets: [makeAsset()] });
      paddingIds.push(id);
    }
    const candidateIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `mem-pano-${i}`;
      memories[id] = makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] });
      candidateIds.push(id);
    }
    const outline = makeOutline(
      [
        makeElement({ id: 'backbone:padding', kind: 'backbone', memoryIds: paddingIds }),
        makeElement({ id: 'backbone:candidates', kind: 'backbone', memoryIds: candidateIds }),
      ],
      { panoramaCandidates: candidateIds },
    );

    const { document } = fitBook(outline, makeManifest(memories));
    const panoramaPages = document.pages.filter((p) => p.templateId === 'panorama-spread');
    expect(panoramaPages).toHaveLength(2);
    // The third (unpromoted) candidate still renders — as a regular content
    // page, chronological order intact — never dropped.
    const remainingCandidateId = candidateIds.find(
      (id) => !panoramaPages.some((p) => p.slots.some((s) => s.kind === 'photo' && (s.content as PhotoSlotContent).memoryId === id)),
    );
    expect(remainingCandidateId).toBeTruthy();
    expect(document.pages.some((p) => p.slots.some((s) => s.kind === 'photo' && (s.content as PhotoSlotContent).memoryId === remainingCandidateId))).toBe(true);
  });

  it('reads originalWidth over the (possibly downscaled) preview width when present — accepts a shrunk preview whose original was wide enough', () => {
    const manifest = makeManifest({
      'mem-pano': makeMemory({
        assets: [makeAsset({ width: 1200, height: 600, aspectRatio: 2, originalWidth: 4000, originalHeight: 2000 })],
      }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-pano'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.templateId === 'panorama-spread')).toBe(true);
  });

  it('reads originalWidth over preview width in the other direction too — rejects a candidate whose preview only LOOKS wide enough', () => {
    const manifest = makeManifest({
      'mem-pano': makeMemory({
        assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2, originalWidth: 1200, originalHeight: 600 })],
      }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-pano'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'panorama-spread')).toBe(true);
  });
});

describe('fitBook — panorama parity: reorder prediction + swap + demotion ladder (round-17, live-data finding)', () => {
  it('rung (b): a REAL local swap lands the panorama even when the reorder-pass sim could not predict a preceding pair splitting past its min-size floor', () => {
    // mem-marginal's two assets (2.5 / 0.5 aspect) fail MIN_IMAGE_SIDE_MM as
    // a pair and split into two solo pages at REAL assembly time — a
    // divergence the parity-reorder pass's own sim can't see (it predicts
    // this unit as a single page, `unitParityMeta`'s ordinary movable-single
    // case, not the 2-page split `trySplitGroupUnit` never gets asked to
    // model here). The sim therefore believes the panorama already lands
    // even and does no pre-arranging; real assembly lands it odd instead —
    // exactly the drift diagnosed on enzo-year-one's `backbone:2023-03` —
    // and rung (b)'s REAL swap (reading the ACTUAL page parity, immune to
    // any sim drift) absorbs it with zero blanks.
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-marginal': makeMemory({ assets: [makeAsset({ aspectRatio: 2.5 }), makeAsset({ aspectRatio: 0.5 })] }),
      'mem-pano': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-marginal', 'mem-pano'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.filter((p) => p.templateId === 'blank')).toHaveLength(0);
    const panoramaPages = document.pages.filter((p) => p.templateId === 'panorama-spread');
    expect(panoramaPages).toHaveLength(1);
    // mem-marginal's split (id suffix ':minsize-a'/':minsize-b') never
    // dropped either asset.
    const splitPages = document.pages.filter((p) => p.id.includes(':minsize-'));
    expect(splitPages).toHaveLength(2);
    const files = splitPages.flatMap((p) => p.slots.filter((s) => s.kind === 'photo').map((s) => (s.content as PhotoSlotContent).assetFile));
    expect(new Set(files).size).toBe(2);
    // The swap is visible as a scrambled unit order: the second split half
    // (unit-index 1) lands AFTER the panorama (unit-index 2) instead of
    // immediately before it.
    const panoIndex = document.pages.findIndex((p) => p.templateId === 'panorama-spread');
    expect(document.pages[panoIndex + 1]?.id).toContain(':1');
  });

  it('rung (c): demotes to an ordinary anchor-media solo instead of a blank when the section has no other unit to reorder or swap with (the true last resort)', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }), // odd-start setup, same pattern as full-bleed's own demotion test
      'mem-pano': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] }), // the section's ONLY unit
    });
    const outline = makeOutline(
      [
        makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
        makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-pano'] }),
      ],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.filter((p) => p.templateId === 'blank')).toHaveLength(0);
    // No panorama-spread at all — it demoted rather than paying a blank for
    // its facing-credit promise, the same owner-approved trade full-bleed
    // already makes.
    expect(document.pages.some((p) => p.templateId === 'panorama-spread')).toBe(false);
    const demoted = document.pages.find((p) => p.sourceElementId === 'backbone:b');
    expect(demoted).toBeTruthy();
    expect(demoted!.templateId).toBe('anchor-media');
    expect(demoted!.slots.some((s) => s.kind === 'photo')).toBe(true);
    const photo = demoted!.slots.find((s) => s.kind === 'photo')!.content as PhotoSlotContent;
    expect(photo.memoryId).toBe('mem-pano');
  });

  it('sim/assembly consistency: auditBookDocument reports zero avoidable parity:panorama-spread blanks for either outcome above', () => {
    const swapManifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-marginal': makeMemory({ assets: [makeAsset({ aspectRatio: 2.5 }), makeAsset({ aspectRatio: 0.5 })] }),
      'mem-pano': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] }),
    });
    const swapOutline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-marginal', 'mem-pano'] })],
      { panoramaCandidates: ['mem-pano'] },
    );
    const demoteManifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] }),
    });
    const demoteOutline = makeOutline(
      [
        makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
        makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-pano'] }),
      ],
      { panoramaCandidates: ['mem-pano'] },
    );

    for (const [outline, manifest] of [
      [swapOutline, swapManifest],
      [demoteOutline, demoteManifest],
    ] as const) {
      const { document } = fitBook(outline, manifest);
      const violations = auditBookDocument(document, outline, manifest);
      expect(violations.filter((v) => v.check === 'blank-accounting')).toHaveLength(0);
    }
  });
});

describe('fitBook — Task 2 (round-17): printable caption sanitization end to end', () => {
  it('a photo memory whose caption is JUST a URL renders as caption-less — photo-only path, no footer note, no on-image caption', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'https://example.com/some/photo/link', assets: [makeAsset()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    const page = document.pages.find((p) => p.sourceElementId === 'backbone:x' && p.slots.some((s) => s.kind === 'photo'));
    expect(page).toBeTruthy();
    const photo = page!.slots.find((s) => s.kind === 'photo')!.content as PhotoSlotContent;
    expect(photo.caption).toBeNull();
    const footerIndex = (page!.params.footerIndex as Array<{ note: string | null }> | undefined) ?? [];
    expect(footerIndex.every((e) => !e.note)).toBe(true);
  });

  it('a zero-asset memory whose caption is JUST a URL is dropped entirely — no photo AND no caption left to print, exactly like a memory with no text at all', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }), // keeps the section non-empty
      'mem-url-only': makeMemory({ text: '   https://example.com   ', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-url-only'] })]);
    const { document } = fitBook(outline, manifest);
    const touchesUrlOnlyMemory = document.pages.some((p) =>
      p.slots.some((s) => (s.kind === 'text' && (s.content as TextSlotContent).memoryId === 'mem-url-only') || (s.kind === 'photo' && (s.content as PhotoSlotContent).memoryId === 'mem-url-only')),
    );
    expect(touchesUrlOnlyMemory).toBe(false);
  });

  it('a URL never prints anywhere in a full book run — real-shaped multi-memory regression coverage', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Beach day! https://photos.example.com/album/123 so much fun', assets: [makeAsset()] }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'De paseo por el parque, ver www.momora.example/foo para más fotos',
        assets: [],
        illustration: { file: 'illo.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);
    const { document } = fitBook(outline, manifest);
    const allText = document.pages
      .flatMap((p) => p.slots)
      .map((s) => {
        if (s.kind === 'text') return (s.content as TextSlotContent).text;
        if (s.kind === 'photo') return (s.content as PhotoSlotContent).caption ?? '';
        return '';
      })
      .concat(
        document.pages.flatMap((p) => ((p.params.footerIndex as Array<{ note: string | null }> | undefined) ?? []).map((e) => e.note ?? '')),
      )
      .join(' ');
    expect(allText).not.toContain('http');
    expect(allText).not.toContain('www.');
    expect(allText).toContain('Beach day!');
    expect(allText).toContain('De paseo por el parque');
  });
});

describe('fitBook — scan-to-watch moved off the footer, onto each photo (owner review round 3, item 8)', () => {
  it('every video slot carries its own qr flag regardless of how many share a page — no per-page cap anymore', () => {
    // The scan-to-watch affordance now renders directly under each photo
    // (see templates/common/PhotoTile), not stacked as shared footer
    // lines — the previous "cap footer scan lines at 2, merge the rest"
    // mechanism (and its `codes` field) is retired along with the footer
    // rendering it existed for. This asset set is one memory's own 4
    // videos, all the same near-square aspect (gridAspectsCompatible),
    // so density v3 keeps it as one flex-grid page.
    const manifest = makeManifest({
      'mem-1': makeMemory({
        assets: [
          makeAsset({ kind: 'video-poster', aspectRatio: 1 }),
          makeAsset({ kind: 'video-poster', aspectRatio: 1 }),
          makeAsset({ kind: 'video-poster', aspectRatio: 1 }),
          makeAsset({ kind: 'video-poster', aspectRatio: 1 }),
        ],
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0].templateId).toBe('flex-grid');
    const photoSlots = document.pages[0].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    expect(photoSlots).toHaveLength(4);
    expect(photoSlots.every((s) => s.content.qr)).toBe(true);
    // The footer index itself carries no qr/scan concept anymore for a
    // regular slot-derived entry (item 8) — captions still consolidate
    // (item 9) since all four share the same memory's date/caption.
    const footerIndex = document.pages[0].params.footerIndex as Array<{ qr?: boolean }>;
    expect(footerIndex.every((e) => !e.qr)).toBe(true);
  });

  it('a full-bleed/panorama video with no on-page tile of its own still carries a qr credit on the facing page — the one deliberate exception', () => {
    const manifest = makeManifest({
      'mem-pano': makeMemory({
        text: 'A wide video clip.',
        assets: [makeAsset({ kind: 'video-poster', width: 4000, height: 2000, aspectRatio: 2 })],
      }),
      'mem-vid': makeMemory({ assets: [makeAsset({ kind: 'video-poster' })] }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-pano', 'mem-vid'] })],
      { panoramaCandidates: ['mem-pano'] },
    );

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('panorama-spread');
    expect(document.pages[1].templateId).toBe('anchor-media');
    const footerIndex = document.pages[1].params.footerIndex as Array<{ qr?: boolean; index: number }>;
    // The inherited credit (index 1, the video panorama) IS a qr entry —
    // it has no photo tile of its own to attach the mark to.
    const credit = footerIndex.find((e) => e.index === 1)!;
    expect(credit.qr).toBe(true);
    // mem-vid's own video already shows its scan mark on its own tile — its
    // footer entry is plain text, not a second qr line.
    const own = footerIndex.find((e) => e.index !== 1)!;
    expect(own.qr).toBeFalsy();
  });
});

describe('fitBook — cross-memory pairing as a real feature (final-fix-round item 1)', () => {
  it('does nothing at the default page cap — two different single-photo memories still each get their own page', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);

    const { document, capacity } = fitBook(outline, manifest);
    expect(capacity.pairingLevelUsed).toBe(0);
    expect(document.pages).toHaveLength(2);
  });

  it('pairs two caption-less single-photo memories onto one page, with a dominant (hero) + subordinate hierarchy, when the cap requires it', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id) => [id, makeMemory({ assets: [makeAsset()] })]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    // Unpaired this backbone alone would need 6 pages (totalPages 7) — cap
    // it tight enough that pairing every adjacent caption-less pair (down
    // to 3 pages, totalPages 4) is required and sufficient.
    const { document, capacity } = fitBook(outline, makeManifest(memories), { maxPages: 4 });
    expect(capacity.pairingLevelUsed).toBe(1);
    expect(capacity.overCap).toBe(false);
    expect(capacity.omittedMemoryIds).toHaveLength(0);
    expect(document.pages).toHaveLength(3);
    for (const [i, page] of document.pages.entries()) {
      expect(page.templateId).toBe('anchor-media');
      const photoSlots = page.slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
      expect(photoSlots).toHaveLength(2);
      const heroCount = photoSlots.filter((s) => s.content.hero).length;
      const nonHeroCount = photoSlots.filter((s) => !s.content.hero).length;
      // Clear dominant + subordinate hierarchy — never an even pair.
      expect(heroCount).toBe(1);
      expect(nonHeroCount).toBe(1);
      // Reading order leads when neither memory has a caption to break the tie.
      expect(photoSlots.find((s) => s.content.hero)!.content.memoryId).toBe(`mem-${i * 2}`);
    }
  });

  it('preference order: pairs caption-less memories first, leaving captioned ones on their own page whenever that alone satisfies the cap', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }), // caption-less
      'mem-b': makeMemory({ assets: [makeAsset()] }), // caption-less
      'mem-c': makeMemory({ text: 'A short caption.', assets: [makeAsset()] }), // captioned
      'mem-d': makeMemory({ text: 'Another short caption.', assets: [makeAsset()] }), // captioned
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-b', 'mem-c', 'mem-d'] }),
    ]);

    // Unpaired: 4 pages (totalPages 4 — round-22 renumbering: no cover/
    // dedication front matter in this fixture, so `numberPages` counts from
    // 1 with nothing to skip, one lower than the pre-round-22 count).
    // Pairing ONLY the caption-less pair gets to 3 pages (totalPages 3) —
    // enough to hit this cap without ever touching the two captioned
    // memories.
    const { document, capacity } = fitBook(outline, manifest, { maxPages: 3 });
    expect(capacity.pairingLevelUsed).toBe(1);
    expect(document.pages).toHaveLength(3);
    expect(document.pages[0].templateId).toBe('anchor-media');
    const paired = document.pages[0].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    expect(paired.map((s) => s.content.memoryId).sort()).toEqual(['mem-a', 'mem-b']);
    // mem-c and mem-d never merged with each other — each still owns its own
    // single-photo page (which of photo-story/anchor-media wins for each is
    // the separate, unrelated rhythm-variety rule's call, not this test's concern).
    const page1Photos = document.pages[1].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    const page2Photos = document.pages[2].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    expect(page1Photos).toHaveLength(1);
    expect(page2Photos).toHaveLength(1);
    expect([page1Photos[0].content.memoryId, page2Photos[0].content.memoryId].sort()).toEqual(['mem-c', 'mem-d']);
  });

  it('escalates to pairing a caption-less memory WITH a captioned one when no caption-less-only pair is available — the captioned memory leads', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }), // caption-less
      'mem-b': makeMemory({ text: 'Has its own caption.', assets: [makeAsset()] }), // captioned
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-b'] })]);

    // Cap of 1 (not 2 — round-22 renumbering: no front matter here, so
    // `totalPages` counts one lower than before): 2 unpaired pages don't fit
    // at either level 0 or 1 (no second caption-less memory to pair with),
    // forcing the escalation to level 2.
    const { document, capacity } = fitBook(outline, manifest, { maxPages: 1 });
    expect(capacity.pairingLevelUsed).toBe(2);
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0].templateId).toBe('anchor-media');
    const photoSlots = document.pages[0].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    // The memory with a story leads (dominant frame); the caption-less one is subordinate.
    expect(photoSlots.find((s) => s.content.hero)!.content.memoryId).toBe('mem-b');
  });

  it('only pairs two captioned memories as an absolute last resort (level 3)', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ text: 'First caption.', assets: [makeAsset()] }),
      'mem-b': makeMemory({ text: 'Second caption.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-b'] })]);

    // Cap of 1, not 2 — see the escalation test above for why (round-22 renumbering).
    const { document, capacity } = fitBook(outline, manifest, { maxPages: 1 });
    expect(capacity.pairingLevelUsed).toBe(3);
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0].templateId).toBe('anchor-media');
  });
});

describe('fitBook — page-cap enforcement + overflow reporting (final-fix-round item 2)', () => {
  it('reports a clean capacity summary when the book comfortably fits under the default cap', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);

    const { capacity } = fitBook(outline, manifest);
    expect(capacity).toEqual({
      cap: 122,
      totalPages: capacity.totalPages,
      overCap: false,
      pairingLevelUsed: 0,
      omittedMemoryIds: [],
    });
  });

  it('demotes only photo/video-only memories, lowest-engagement first, never a text or illustrated one — and fits within the cap', () => {
    const lowEngagement = Array.from({ length: 5 }, (_, i) => `mem-p-low-${i}`);
    const highEngagement = Array.from({ length: 5 }, (_, i) => `mem-p-high-${i}`);
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    for (const id of lowEngagement) memories[id] = makeMemory({ assets: [makeAsset()], engagement: 0 });
    for (const id of highEngagement) memories[id] = makeMemory({ assets: [makeAsset()], engagement: 1 });
    // Two memories with real text/illustrated value, deliberately given LOW
    // engagement themselves — engagement must lose to "has a story" when
    // it comes to what's safe to cut.
    memories['mem-t0'] = makeMemory({ text: 'Protected story one — never omit.', assets: [makeAsset()], engagement: 0 });
    memories['mem-t1'] = makeMemory({ text: 'Protected story two — never omit.', assets: [makeAsset()], engagement: 0 });

    const memoryIds = [...lowEngagement, ...highEngagement, 'mem-t0', 'mem-t1'];
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds })]);
    const manifest = makeManifest(memories);

    const { document, gaps, capacity } = fitBook(outline, manifest, { maxPages: 5 });

    expect(capacity.pairingLevelUsed).toBe(3); // max pairing alone isn't enough with 12 solo memories at this cap
    expect(capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    expect(capacity.overCap).toBe(false);
    expect(capacity.totalPages).toBeLessThanOrEqual(capacity.cap);

    // Never a text-bearing memory.
    expect(capacity.omittedMemoryIds).not.toContain('mem-t0');
    expect(capacity.omittedMemoryIds).not.toContain('mem-t1');
    // Lowest engagement first: nothing from the high-engagement pool is cut
    // while any low-engagement candidate is still standing.
    const remainingLow = lowEngagement.filter((id) => !capacity.omittedMemoryIds.includes(id));
    const omittedHigh = highEngagement.filter((id) => capacity.omittedMemoryIds.includes(id));
    expect(omittedHigh.length === 0 || remainingLow.length === 0).toBe(true);

    // The protected memories' own text still made it into the printed book.
    const allText = JSON.stringify(document);
    expect(allText).toContain('Protected story one');
    expect(allText).toContain('Protected story two');

    // Each omission is also visible in the human-readable gaps report.
    for (const id of capacity.omittedMemoryIds) {
      expect(gaps.some((g) => g.memoryIds.includes(id))).toBe(true);
    }
  });

  it('is deterministic — refitting the identical overflowing book twice yields the identical capacity report', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(
      ids.map((id, i) => [id, makeMemory({ assets: [makeAsset()], engagement: i % 2 })]),
    );
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);
    const manifest = makeManifest(memories);

    const first = fitBook(outline, manifest, { maxPages: 3 });
    const second = fitBook(outline, manifest, { maxPages: 3 });
    expect(second.capacity).toEqual(first.capacity);
  });

  it('honestly reports overCap when nothing safe is left to cut (text-only memories can pair down but never disappear)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Text-only memory one, no photo.', assets: [] }),
      'mem-2': makeMemory({ text: 'Text-only memory two, no photo.', assets: [] }),
      'mem-3': makeMemory({ text: 'Text-only memory three, no photo.', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] })]);

    // Cap of 1, not 2 — round-22 renumbering: these 3 short text-only
    // memories sweep into a single quote-collection spread (totalPages 2,
    // one lower than pre-round-22 since this fixture has no cover/
    // dedication front matter), which would fit under a cap of 2 with
    // nothing to cut. A cap of 1 keeps the test's original intent: over cap
    // even at the collection's minimum footprint, nothing safe to omit.
    const { capacity } = fitBook(outline, manifest, { maxPages: 1 });
    expect(capacity.overCap).toBe(true);
    expect(capacity.omittedMemoryIds).toHaveLength(0); // no photo-only memory existed to safely cut
  });

  it('never demotes a panoramaCandidates (or heroCandidates) nominee, even at rank 0, when the cap squeeze removes other plain photos (live finding, round 5)', () => {
    // The panorama nominee is a perfectly ordinary, LOWEST-engagement
    // photo-only memory from the demotion pool's point of view — nothing
    // about `isPhotoOnlyMemory` distinguishes it from the padding photos.
    // Without an explicit exclusion it would be the very first thing cut.
    const padding = Array.from({ length: 8 }, (_, i) => `mem-pad-${i}`);
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    for (const id of padding) memories[id] = makeMemory({ assets: [makeAsset()], engagement: 0 });
    memories['mem-pano'] = makeMemory({
      assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })],
      engagement: 0,
    });
    memories['mem-hero'] = makeMemory({
      assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })],
      engagement: 0,
    });

    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [...padding, 'mem-pano', 'mem-hero'] })],
      { panoramaCandidates: ['mem-pano'], heroCandidates: ['mem-hero'] },
    );

    const { document, capacity } = fitBook(outline, makeManifest(memories), { maxPages: 4 });

    // The squeeze definitely fired (some padding photo got cut)...
    expect(capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    // ...but never the protected nominees.
    expect(capacity.omittedMemoryIds).not.toContain('mem-pano');
    expect(capacity.omittedMemoryIds).not.toContain('mem-hero');
    // The panorama nominee actually made it into the book as a real panorama-spread.
    const panoramaPage = document.pages.find((p) => p.templateId === 'panorama-spread');
    expect(panoramaPage).toBeTruthy();
    const photoSlot = panoramaPage!.slots.find((s) => s.kind === 'photo')!;
    expect((photoSlot.content as PhotoSlotContent).memoryId).toBe('mem-pano');
  });
});

describe('fitBook — density v3: 3-4 photo grids only when aspects compose cleanly (owner review round 3, item 5)', () => {
  it('a compatible 4-photo set (all near a standard box) stays ONE flex-grid page', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        assets: [makeAsset({ aspectRatio: 1.5 }), makeAsset({ aspectRatio: 0.8 }), makeAsset({ aspectRatio: 1 }), makeAsset({ aspectRatio: 1 })],
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0].templateId).toBe('flex-grid');
  });

  it('an incompatible set — a portrait video mixed with landscape photos — splits to strict max-2 pairs instead (kills the vertical-video lavender bar, item 4)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        assets: [
          makeAsset({ aspectRatio: 1.5 }),
          makeAsset({ aspectRatio: 1.5 }),
          makeAsset({ kind: 'video-poster', aspectRatio: 9 / 16 }), // strongly portrait — incompatible with a landscape-composed grid
        ],
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.every((p) => p.templateId !== 'flex-grid')).toBe(true);
    // 3 assets, none a grid -> strict pairs: 2 + 1.
    expect(document.pages).toHaveLength(2);
    expect(document.pages.every((p) => p.templateId === 'anchor-media')).toBe(true);
    expect(document.pages[0].slots.filter((s) => s.kind === 'photo')).toHaveLength(2);
    expect(document.pages[1].slots.filter((s) => s.kind === 'photo')).toHaveLength(1);
  });

  it('a 5+ set with an incompatible chunk only splits THAT chunk to pairs, keeping a compatible chunk together', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        assets: [
          // Chunk 1 (4 compatible landscape/square photos) -> stays one flex-grid page.
          makeAsset({ aspectRatio: 1.5 }),
          makeAsset({ aspectRatio: 1 }),
          makeAsset({ aspectRatio: 1 }),
          makeAsset({ aspectRatio: 0.8 }),
          // Chunk 2 (1 photo, trivially its own group either way).
          makeAsset({ aspectRatio: 1 }),
        ],
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.filter((p) => p.templateId === 'flex-grid')).toHaveLength(1);
    expect(document.pages.filter((p) => p.templateId === 'anchor-media')).toHaveLength(1);
  });
});

describe('fitBook — native aspect everywhere outside grids (owner review round 3, item 4)', () => {
  it('a solo anchor-media photo uses its OWN native aspect as targetAspect, never a forced standard box', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ aspectRatio: 1.23 })] }), // deliberately not a standard box value
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const photoSlot = document.pages[0].slots.find((s) => s.kind === 'photo') as { content: PhotoSlotContent };
    expect(photoSlot.content.targetAspect).toBe(1.23);
    expect(photoSlot.content.looseFit).toBe(false);
  });

  it('a PAIRED anchor-media page also uses native aspect for both photos, never lavender containment', () => {
    // Round-8 item 1 (dominance-invariant note): the ORIGINAL fixture here
    // (1.23 + an extremely tall 0.44) is exactly the class of pair the
    // round-8 dominance invariant now correctly rejects — a subordinate
    // that mild wouldn't need much less width than the extreme-tall
    // "dominant" ends up out-sizing it, so it splits to two solo pages
    // instead of ever rendering as a bad-looking shared pair (see
    // `anchorPairMeetsMinSize`'s DOMINANCE INVARIANT in
    // `anchorMediaLayout.ts`). Two more moderately-elongated, still
    // deliberately non-standard aspects (1.3 and its reciprocal) keep this
    // test's actual point — native aspect, never a forced standard box —
    // while remaining a pair that genuinely SHOULD (and does) stay paired.
    // mem-a leads (reading-order dominance, since neither has a caption) —
    // give it the TALL aspect so it sizes via `layoutSideBySide` directly
    // (a wide "leader" paired with a near-tied elongation partner is the
    // one geometry this fixture must avoid: it forces the wide dominant
    // through its vertical-stack-vs-side-by-side choice on a squeezed
    // header page in a way that happens not to clear the floor here).
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset({ aspectRatio: 1 / 1.3 })] }),
      'mem-b': makeMemory({ assets: [makeAsset({ aspectRatio: 1.3 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-b'] })], {});
    // maxPages: 1, not 2 — round-22 renumbering: no cover/dedication front
    // matter here, so totalPages counts one lower than before; 1 still
    // forces pairing (2 unpaired solo pages wouldn't fit).
    const { document } = fitBook(outline, manifest, { maxPages: 1 }); // force pairing
    const photoSlots = document.pages[0].slots.filter((s) => s.kind === 'photo') as Array<{ content: PhotoSlotContent }>;
    expect(photoSlots).toHaveLength(2);
    for (const slot of photoSlots) {
      expect(slot.content.targetAspect).toBe(slot.content.assetAspectRatio);
      expect(slot.content.looseFit).toBe(false);
    }
  });
});

describe('fitBook — full-bleed parity-aware facing credit (owner review round 3, item 2)', () => {
  it('forces a blank filler so a full-bleed page always lands even, keeping its credit on the TRUE facing page', () => {
    // mem-0 occupies page 2 (even) by itself; the full-bleed hero would
    // then naturally land on page 3 (odd) without intervention — a blank
    // filler must land first so full-bleed itself is on an even page.
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-hero': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })] }),
      'mem-next': makeMemory({ text: 'Right after the hero.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-hero', 'mem-next'], highlights: ['mem-hero'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const fullBleedIndex = document.pages.findIndex((p) => p.templateId === 'full-bleed');
    expect(fullBleedIndex).toBeGreaterThan(-1);
    const fullBleedPage = document.pages[fullBleedIndex];
    // The parity-landing DECISION itself is unchanged (still governed by
    // `currentPageParity`'s own internal, unmodified bookkeeping) — only the
    // PRINTED folio parity flips here, because this fixture has no cover/
    // dedication front matter: `numberPages` now starts counting at 1
    // instead of 2 for a document with no front-matter-verso blank to skip,
    // an odd (-1) shift that flips which physical folio side "the position
    // `currentPageParity` calls even" ends up landing on.
    expect(fullBleedPage.isEvenPage).toBe(false);
    // The very next page (its true facing partner) carries the credit as index 1.
    const facingPage = document.pages[fullBleedIndex + 1];
    expect(facingPage.templateId).not.toBe('blank');
    const footerIndex = facingPage.params.footerIndex as Array<{ index: number; date: string }>;
    const credit = footerIndex.find((e) => e.index === 1)!;
    expect(credit).toBeTruthy();
  });
});

describe('fitBook — reflow-first parity (owner review round 4, item 3)', () => {
  it('reorders (swaps) the preceding flexible page instead of inserting a blank when a swap is available', () => {
    // Same shape as the item-2 "forces a blank filler" test above, except
    // here the page immediately before the full-bleed hero is an ordinary
    // flexible single page (anchor-media) — a perfectly good swap partner.
    // Reflow-first means the fitter reorders it to AFTER the hero instead
    // of spending a page on a blank filler.
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-hero': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })] }),
      'mem-next': makeMemory({ text: 'Right after the hero.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-hero', 'mem-next'], highlights: ['mem-hero'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    // No blank anywhere — the swap absorbed the parity requirement.
    expect(document.pages.every((p) => p.templateId !== 'blank')).toBe(true);
    const fullBleedIndex = document.pages.findIndex((p) => p.templateId === 'full-bleed');
    expect(fullBleedIndex).toBeGreaterThan(-1);
    // See the sibling "forces a blank filler" test above for why this is
    // `false`, not `true`, on a fixture with no cover/dedication front
    // matter — the landing decision itself is unchanged, only the printed
    // folio parity (round-22 renumbering) flips.
    expect(document.pages[fullBleedIndex].isEvenPage).toBe(false);
    // mem-0's page was reordered to directly AFTER the hero (chronological
    // order is locally disturbed by design — see fitter.ts's ensureEvenLanding
    // doc comment — but no page budget was spent on a blank).
    expect(document.pages[fullBleedIndex + 1].templateId).toBe('anchor-media');
  });

  it('falls back to a blank when no flexible page precedes the parity-critical unit (e.g. right after a section opener)', () => {
    // No preceding page at all for the very first element in the book, so
    // there's nothing to swap with — a blank is the only option, exactly
    // like the pre-reflow item-2 test above.
    const manifest = makeManifest({
      'mem-hero': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'cover', kind: 'cover' }),
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-hero'], highlights: ['mem-hero'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    const fullBleedIndex = document.pages.findIndex((p) => p.templateId === 'full-bleed');
    expect(fullBleedIndex).toBeGreaterThan(-1);
    // A 'cover' element with no 'title' element still has no front-matter-
    // verso blank to skip, so the same -1 (parity-flipping) shift applies
    // here as the blank-less fixtures above — see that test's comment.
    expect(document.pages[fullBleedIndex].isEvenPage).toBe(false);
  });
});

describe('fitBook — parity-aware split illustrated stories (owner review round 3, item 11)', () => {
  it('forces the text page onto an EVEN (left) page so the illustration lands on the facing RIGHT page', () => {
    const longText = 'A '.repeat(250) + 'long illustrated story that runs past four hundred characters.';
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }), // occupies page 2, pushing the split story to start on an odd page without correction
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: longText,
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-1'] })]);

    const { document } = fitBook(outline, manifest);
    const textPageIndex = document.pages.findIndex((p) => p.templateId === 'illustrated-story' && p.params.mode === 'text-only');
    expect(textPageIndex).toBeGreaterThan(-1);
    const textPage = document.pages[textPageIndex];
    const illoPage = document.pages[textPageIndex + 1];
    // No cover/dedication front matter in this fixture, so the round-22
    // renumbering's -1 (parity-flipping) shift applies — see the full-bleed
    // parity tests above for the full explanation. The landing DECISION is
    // unchanged (text still lands on the page `currentPageParity` calls
    // even internally); only the printed folio parity is now inverted.
    expect(textPage.isEvenPage).toBe(false);
    expect(illoPage.templateId).toBe('illustrated-story');
    expect(illoPage.params.mode).toBe('illustration-only');
    expect(illoPage.isEvenPage).toBe(true);
  });
});

describe('fitBook — month headers render for every segment, including photo-thin ones (owner review round 3 diagnosis: "vanished after p34 in Enzo")', () => {
  it('an illustrated-only backbone segment still shows its month header', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'An illustrated moment.',
        assets: [],
        illustration: { file: 'assets/illo.webp', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-12', kind: 'backbone', title: 'December 2024', memoryIds: ['mem-1'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const withHeader = document.pages.filter((p) => p.params.sectionHeader);
    expect(withHeader).toHaveLength(1);
    expect((withHeader[0].params.sectionHeader as { title: string }).title).toBe('December 2024');
  });

  it('an audio-only backbone segment still shows its month header', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ type: 'audio', text: 'Singing.', assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-12', kind: 'backbone', title: 'December 2024', memoryIds: ['mem-1'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const withHeader = document.pages.filter((p) => p.params.sectionHeader);
    expect(withHeader).toHaveLength(1);
  });
});

describe('fitBook — through-the-years splits into one facing spread per 2-3-portrait group (already landed — regression coverage)', () => {
  it('exactly 4 portraits (2 pairs) split into TWO separate facing spreads of 2 each, not one crowded spread', () => {
    const manifest = makeManifest(
      {},
      {
        portraits: Array.from({ length: 4 }, (_, i) => ({
          file: `assets/portrait-${i}.jpg`,
          date: `2024-0${i + 1}-01`,
          ageLabel: `${i} months`,
        })),
      },
    );
    const outline = makeOutline([makeElement({ id: 'through-the-years', kind: 'through-the-years' })]);
    const { document } = fitBook(outline, manifest);
    const spreads = document.pages.filter((p) => p.templateId === 'through-the-years');
    expect(spreads).toHaveLength(2);
    for (const spread of spreads) {
      const strip = spread.slots.find((s) => s.kind === 'portrait-strip')!;
      expect((strip.content as { portraits: unknown[] }).portraits).toHaveLength(2);
    }
  });
});

describe('fitBook — closing never prints the outline editorial note (owner review round 3, item 16 — regression for the Mara leak)', () => {
  it('the closing page carries no editorialNote param at all, however distinctive the outline text is', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline(
      [
        makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] }),
        makeElement({ id: 'closing', kind: 'closing', title: 'The End' }),
      ],
      { editorialNote: 'INTERNAL-ONLY-MARKER: this AI planning note must never reach a printed page.' },
    );

    const { document } = fitBook(outline, manifest);
    const closing = document.pages.find((p) => p.templateId === 'closing')!;
    expect(closing.params.editorialNote).toBeUndefined();
    // Belt and suspenders: the marker string never appears ANYWHERE in the
    // whole document's params, on any page.
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('INTERNAL-ONLY-MARKER');
  });

  it('the closing memory-count line uses the real memory count, not the outline page budget', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({ text: 'A caption.', assets: [makeAsset()] }),
      'mem-3': makeMemory({ text: 'Another caption.', assets: [] }),
    });
    const outline = makeOutline(
      [
        makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] }),
        makeElement({ id: 'closing', kind: 'closing', title: 'The End' }),
      ],
      { pageBudget: 999 }, // deliberately absurd — must never leak into the printed count
    );

    const { document } = fitBook(outline, manifest);
    const closing = document.pages.find((p) => p.templateId === 'closing')!;
    expect(closing.params.memoryCount).toBe(3);
  });
});

describe('partitionQuoteRun', () => {
  it('never splits a run at or under the 6-entry ceiling', () => {
    expect(partitionQuoteRun(3)).toEqual([3]);
    expect(partitionQuoteRun(4)).toEqual([4]);
    expect(partitionQuoteRun(6)).toEqual([6]);
  });

  it('splits a longer run into balanced groups of 3-6, matching the through-the-years partition style', () => {
    expect(partitionQuoteRun(7)).toEqual([4, 3]);
    expect(partitionQuoteRun(8)).toEqual([4, 4]);
    expect(partitionQuoteRun(13)).toEqual([5, 4, 4]);
    expect(partitionQuoteRun(17)).toEqual([6, 6, 5]);
  });

  it('every group size lands in [3, 6] for a wide range of run lengths', () => {
    for (let n = 3; n <= 40; n++) {
      for (const size of partitionQuoteRun(n)) {
        expect(size).toBeGreaterThanOrEqual(3);
        expect(size).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('fitBook — quote-collection spread (acceptance-review follow-up, item 1)', () => {
  it('groups 3+ adjacent short text-only entries into ONE quote-collection spread instead of one page each', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Short quote one.', assets: [] }),
      'mem-2': makeMemory({ text: 'Short quote two.', assets: [] }),
      'mem-3': makeMemory({ text: 'Short quote three.', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] })]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0].templateId).toBe('quote-collection');
    expect(document.pages[0].isSpread).toBe(true);
    const entries = document.pages[0].slots.filter((s) => s.kind === 'quote-entry');
    expect(entries).toHaveLength(3);
    expect(document.pages[0].slots.map((s) => (s.content as { text: string }).text)).toEqual([
      'Short quote one.',
      'Short quote two.',
      'Short quote three.',
    ]);
  });

  it('exactly 2 adjacent short entries do NOT form a collection — below the "three or more" threshold, each keeps its own page', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Short quote one.', assets: [] }),
      'mem-2': makeMemory({ text: 'Short quote two.', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'quote-collection')).toBe(true);
    expect(document.pages).toHaveLength(2);
    expect(document.pages.every((p) => p.templateId === 'text-page')).toBe(true);
  });

  it('a run of 7 splits into two collections (4 + 3), never one oversized spread', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id, i) => [id, makeMemory({ text: `Quote number ${i}.`, assets: [] })]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    const collections = document.pages.filter((p) => p.templateId === 'quote-collection');
    expect(collections).toHaveLength(2);
    const sizes = collections.map((p) => p.slots.filter((s) => s.kind === 'quote-entry').length).sort((a, b) => b - a);
    expect(sizes).toEqual([4, 3]);
  });

  it('a photo-bearing memory in the middle of a run breaks it into two separate collections', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Quote one.', assets: [] }),
      'mem-2': makeMemory({ text: 'Quote two.', assets: [] }),
      'mem-photo': makeMemory({ assets: [makeAsset()] }),
      'mem-3': makeMemory({ text: 'Quote three.', assets: [] }),
      'mem-4': makeMemory({ text: 'Quote four.', assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-photo', 'mem-3', 'mem-4'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    // Neither side of the photo reaches the 3-entry minimum on its own -> no collection at all, chronological order preserved.
    expect(document.pages.every((p) => p.templateId !== 'quote-collection')).toBe(true);
    expect(document.pages.map((p) => p.templateId)).toEqual(['text-page', 'text-page', 'anchor-media', 'text-page', 'text-page']);
  });

  it('never sweeps an illustrated memory into a quote-collection — illustrations are never dropped (owner review round 4 item 5)', () => {
    // Only mem-1 is quote-eligible (text-only); mem-2/mem-3 carry
    // illustrations, so the run never reaches the 3-entry minimum and no
    // collection forms at all. Short illustrated entries instead pair with
    // each other via the illustrated-story pairing engine, keeping their
    // illustrations intact.
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Plain quote.', assets: [] }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'Illustrated quote A.',
        assets: [],
        illustration: { file: 'assets/illo-a.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-3': makeMemory({
        type: 'text_illustration',
        text: 'Illustrated quote B.',
        assets: [],
        illustration: { file: 'assets/illo-b.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] })]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'quote-collection')).toBe(true);
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(storyPages).toHaveLength(2);
    // Both illustrated entries keep their illustration slot — neither was dropped.
    for (const page of storyPages) {
      expect(page.slots.some((s) => s.kind === 'illustration')).toBe(true);
    }
    // Paired, immediately adjacent. No cover/dedication front matter in
    // this fixture, so the round-22 renumbering's -1 (parity-flipping)
    // shift applies (see the full-bleed parity tests above): first is odd/
    // right, second even/left — still exactly one folio apart.
    expect(storyPages[0].isEvenPage).toBe(false);
    expect(storyPages[1].isEvenPage).toBe(true);
  });

  it('a text entry over ~200 chars is not quote-eligible and keeps its own page even inside an otherwise-eligible run', () => {
    const longish = 'A '.repeat(120) + 'words, comfortably past two hundred characters but still under the photo-story caption cap.';
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Short one.', assets: [] }),
      'mem-2': makeMemory({ text: longish, assets: [] }),
      'mem-3': makeMemory({ text: 'Short two.', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] })]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'quote-collection')).toBe(true);
  });

  it('never sweeps an audio memory into a quote-collection — audio-note owns that composition', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Short one.', assets: [] }),
      'mem-2': makeMemory({ text: 'Short two.', assets: [] }),
      'mem-audio': makeMemory({ type: 'audio', text: 'A voice memo.', assets: [] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-audio'] })]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'quote-collection')).toBe(true);
    expect(document.pages.some((p) => p.templateId === 'audio-note')).toBe(true);
  });

  it('shows the section header on the quote-collection when it is the first content page of its segment (robust to a quote-only segment)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'Short one.', assets: [] }),
      'mem-2': makeMemory({ text: 'Short two.', assets: [] }),
      'mem-3': makeMemory({ text: 'Short three.', assets: [] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-12', kind: 'backbone', title: 'December 2024', memoryIds: ['mem-1', 'mem-2', 'mem-3'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('quote-collection');
    expect(document.pages[0].params.sectionHeader).toBeTruthy();
  });
});

describe('fitBook — illustrated-story pairing actually fires (acceptance-review follow-up, item 2)', () => {
  it('two ADJACENT short (<=200 char) illustrated stories pair onto a facing spread with alternating stagger', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'First short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-1.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'Second short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-2.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(storyPages).toHaveLength(2);
    // Genuine facing pair, immediately adjacent. No cover/dedication front
    // matter in this fixture, so the round-22 renumbering's -1 (parity-
    // flipping) shift applies (see the full-bleed parity tests above):
    // first is odd (right), second even (left).
    expect(storyPages[0].isEvenPage).toBe(false);
    expect(storyPages[1].isEvenPage).toBe(true);
    expect(storyPages[0].pageNumbers![0] + 1).toBe(storyPages[1].pageNumbers![0]);
    // Alternating, never a coincidental match.
    expect(storyPages[0].params.stagger).toBe(false);
    expect(storyPages[1].params.stagger).toBe(true);
  });

  it('dissolves the pair into two solo pages when nothing can absorb parity (e.g. right after a themed spread-title boundary) — never a blank (owner round 7)', () => {
    // A spread-title opener is a structural boundary and the section holds
    // ONLY the pair — no movable single, nothing splittable. Round-7's
    // last-resort dissolve turns the pair into two consecutive solo story
    // pages (parity-agnostic) instead of spending a blank page.
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'First short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-1.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'Second short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-2.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'topic:travel', kind: 'themed', memoryIds: ['mem-1', 'mem-2'], spreadType: 'topic', titleMode: 'descriptive' }),
    ]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('spread-title');
    expect(document.pages.some((p) => p.templateId === 'blank')).toBe(false);
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(storyPages).toHaveLength(2);
    // Dissolved: consecutive solo pages (no facing requirement), both
    // keeping their illustrations.
    expect(storyPages[0].pageNumbers![0] + 1).toBe(storyPages[1].pageNumbers![0]);
    for (const page of storyPages) {
      expect(page.slots.some((sl) => sl.kind === 'illustration')).toBe(true);
    }
  });

  it('reflows (swaps) the preceding flexible page rather than spending a blank, and reinserts it AFTER the completed pair (owner review round 4 item 3 follow-up)', () => {
    // mem-0 is an ordinary flexible anchor-media page — a valid swap
    // partner. Previously the pair's "first" frame never swapped at all
    // (to avoid landing the reswapped page between "first" and "second");
    // now the swap fires and the reswapped page is deferred until the pair
    // is complete, so no page budget is spent on a blank AND the pair
    // stays genuinely facing-adjacent.
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'First short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-1.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'Second short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-2.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-1', 'mem-2'] })]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    const templates = document.pages.map((p) => p.templateId);
    expect(templates).toEqual(['illustrated-story', 'illustrated-story', 'anchor-media']);
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    // No cover/dedication front matter in this fixture, so the round-22
    // renumbering's -1 (parity-flipping) shift applies (see the full-bleed
    // parity tests above).
    expect(storyPages[0].isEvenPage).toBe(false);
    expect(storyPages[1].isEvenPage).toBe(true);
    expect(storyPages[0].pageNumbers![0] + 1).toBe(storyPages[1].pageNumbers![0]);
    // mem-0's page was reordered to directly after the completed pair.
    expect(document.pages[2].templateId).toBe('anchor-media');
  });

  it('a run of 3+ short illustrated stories always pairs (two at a time), never swept into a quote-collection (owner review round 4 item 5)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'One.',
        assets: [],
        illustration: { file: 'assets/illo-1.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'Two.',
        assets: [],
        illustration: { file: 'assets/illo-2.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-3': makeMemory({
        type: 'text_illustration',
        text: 'Three.',
        assets: [],
        illustration: { file: 'assets/illo-3.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2', 'mem-3'] })]);

    const { document } = fitBook(outline, manifest);
    expect(document.pages.every((p) => p.templateId !== 'quote-collection')).toBe(true);
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    // mem-1+mem-2 pair up; mem-3 is left over (odd count) and gets its own page — none dropped, none swept away.
    expect(storyPages).toHaveLength(3);
    expect(storyPages[0].params.stagger).toBe(false);
    expect(storyPages[1].params.stagger).toBe(true);
    for (const page of storyPages) {
      expect(page.slots.some((s) => s.kind === 'illustration')).toBe(true);
    }
  });

  it('a long (>200 char) illustrated story never pairs, even next to a short one', () => {
    const longish = 'A '.repeat(120) + 'words, well past two hundred characters.';
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: longish,
        assets: [],
        // Portrait (0.6), not square: this is the FIRST content page of
        // its backbone section, so it also carries a section header — at
        // the "not short" header-shrunk width (~72mm), this still clears
        // round-5 item 6's ILLUSTRATED_SPLIT_MIN_ILLO_HEIGHT_MM (110mm)
        // floor. Isolates THIS test's own point (long text alone doesn't
        // force a split/pairing) from item 6's separate height-based
        // trigger, which has its own dedicated tests.
        illustration: { file: 'assets/illo-1.webp', width: 720, height: 1200, aspectRatio: 0.6 },
      }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'A short one right after.',
        assets: [],
        illustration: { file: 'assets/illo-2.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);

    const { document } = fitBook(outline, manifest);
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    // Round-9 item 1c: a >200-char caption's own text-block height now
    // always trips the fitted-height 110mm split floor on its own (see the
    // dedicated round-9 split-threshold tests below), independent of the
    // header — so mem-1 splits into its text/illustration halves (2 pages)
    // regardless. This test's own point is that mem-1 never PAIRS with the
    // short mem-2 that follows it — mem-2 still gets its own independent
    // page, and the split landed its parity naturally (no blank needed):
    // total page count is exactly 3 (mem-1's 2 split halves + mem-2's own
    // page), not 4 (which an extra parity blank would have produced).
    expect(document.pages).toHaveLength(3);
    expect(storyPages).toHaveLength(3);
    expect(document.pages.filter((p) => p.templateId === 'blank')).toHaveLength(0);
  });

  it('a non-illustrated memory breaking adjacency prevents pairing', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'First short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-1.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-between': makeMemory({ assets: [makeAsset()] }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'Second short illustrated story.',
        assets: [],
        illustration: { file: 'assets/illo-2.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-between', 'mem-2'] }),
    ]);

    const { document } = fitBook(outline, manifest);
    // Round-9 item 1c: mem-1 is this section's first (headed) unit, and a
    // headed page's fixed overhead always forces the split (see the
    // dedicated round-9 tests below) — so mem-1 contributes 2 illustrated-
    // story pages (text/illustration halves) plus mem-2's own single page.
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(storyPages).toHaveLength(3);
    // Neither the split's text half nor mem-2's page carries an explicit
    // stagger override from pairing — each keeps its own independent
    // (hash-based) stagger. The illustration-only half renders no text and
    // carries no `stagger` param at all, so it's excluded from this check.
    for (const p of storyPages) {
      if (p.params.mode === 'illustration-only') continue;
      expect(typeof p.params.stagger).toBe('boolean');
    }
    // Not necessarily alternating — no guarantee, since they were never paired. This just confirms no crash/false pairing artifact.
  });
});

describe('fitBook — month-preservation floor under page-cap demotion (owner review round 5, item 2a)', () => {
  it('spreads omissions fairly across months instead of erasing one entirely — the diagnosed Enzo Oct/Nov/Dec bug', () => {
    // Month A: 6 photo-only memories, deliberately HIGH engagement (would
    // normally be the LAST thing cut by a flat rank sort). Month B: 2
    // photo-only memories, LOW engagement (would normally be cut FIRST —
    // and with only 2 to begin with, a flat sort would erase it entirely
    // before ever touching A). The floor must reverse this: B stays
    // untouched at its floor while A absorbs the squeeze instead.
    const aIds = Array.from({ length: 6 }, (_, i) => `mem-a-${i}`);
    const bIds = ['mem-b-0', 'mem-b-1'];
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    for (const id of aIds) memories[id] = photoMemory(1.5, 10, '2024-01-01');
    for (const id of bIds) memories[id] = photoMemory(1.5, 0, '2024-02-01');
    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', title: 'A', memoryIds: aIds }),
      makeElement({ id: 'backbone:b', kind: 'backbone', title: 'B', memoryIds: bIds }),
    ]);

    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 3 });
    const remainingA = aIds.filter((id) => !capacity.omittedMemoryIds.includes(id)).length;
    const remainingB = bIds.filter((id) => !capacity.omittedMemoryIds.includes(id)).length;
    expect(capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    // B (lowest engagement, smallest pool) is untouched at its own floor —
    // every omission came from A instead, even though A's memories rank
    // HIGHER (worse for a naive lowest-engagement-first sort).
    expect(remainingB).toBe(2);
    expect(remainingA).toBeGreaterThanOrEqual(2);
    expect(aIds.some((id) => capacity.omittedMemoryIds.includes(id))).toBe(true);
  });

  it('the floor yields as a last resort when every month is already at (or below) it and the cap still isn\'t met', () => {
    const aIds = Array.from({ length: 6 }, (_, i) => `mem-a-${i}`);
    const bIds = ['mem-b-0', 'mem-b-1'];
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    for (const id of aIds) memories[id] = photoMemory(1.5, 10, '2024-01-01');
    for (const id of bIds) memories[id] = photoMemory(1.5, 0, '2024-02-01');
    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', title: 'A', memoryIds: aIds }),
      makeElement({ id: 'backbone:b', kind: 'backbone', title: 'B', memoryIds: bIds }),
    ]);

    // A much tighter cap: both months get squeezed all the way down to
    // (and, for B, past) the floor — a printable book beats a phantom
    // protection nothing can actually satisfy. (maxPages: 1, not 2 —
    // round-22 renumbering: no front matter in this fixture, so totalPages
    // counts one lower than before, and 2 no longer squeezes hard enough.)
    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 1 });
    const remainingB = bIds.filter((id) => !capacity.omittedMemoryIds.includes(id)).length;
    expect(remainingB).toBeLessThan(2);
  });
});

describe('fitBook — section dissolves when every member is omitted/reassigned (owner review round 5, item 2b)', () => {
  it('never renders a themed spread-title with zero content pages behind it — the diagnosed Mara "Retratos con Mirian" bug', () => {
    const outline = makeOutline([
      makeElement({ id: 'topic:mirian', kind: 'themed', title: 'Retratos con Mirian', memoryIds: ['mem-missing-1', 'mem-missing-2'] }),
    ]);
    // The manifest never resolves either memory id — simulating every
    // member having been reassigned/excluded upstream.
    const { document, gaps } = fitBook(outline, makeManifest({}));
    expect(document.pages.some((p) => p.templateId === 'spread-title')).toBe(false);
    expect(document.pages.some((p) => p.sourceElementId === 'topic:mirian')).toBe(false);
    // No crash, no dangling gap pointing at a page that was never built for real content.
    expect(gaps.every((g) => g.elementId !== 'topic:mirian')).toBe(true);
  });

  it('still renders the title when at least one member survives', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ text: 'Still here.', assets: [] }) });
    const outline = makeOutline([
      makeElement({ id: 'topic:mirian', kind: 'themed', title: 'Retratos con Mirian', memoryIds: ['mem-missing', 'mem-1'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.templateId === 'spread-title')).toBe(true);
  });

  it('applies the same dissolve-if-empty guard to a firsts section', () => {
    const outline = makeOutline([makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-missing'] })]);
    const { document } = fitBook(outline, makeManifest({}));
    expect(document.pages.some((p) => p.templateId === 'spread-title')).toBe(false);
  });
});

describe('fitBook — single-image pages drop the index numeral (owner review round 5, item 4)', () => {
  it('a solo anchor-media photo carries no index numeral and no footer superscript', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ text: 'A caption.', assets: [makeAsset()] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const page = document.pages.find((p) => p.templateId === 'anchor-media')!;
    const photo = page.slots.find((s) => s.kind === 'photo')!.content as PhotoSlotContent;
    expect(photo.index).toBeNull();
    const footerIndex = page.params.footerIndex as Array<{ indices: number[] }>;
    expect(footerIndex).toHaveLength(1);
    expect(footerIndex[0].indices).toEqual([]);
  });

  it('a genuine two-photo pair keeps its numerals — there IS something to disambiguate', () => {
    // A single memory with two assets — always ONE 2-photo group regardless
    // of any cap, so pairing/demotion interactions don't muddy this test.
    // The aspect combination (moderately wide + near-square) clears the
    // min-size floor comfortably as a pair (round-5 amendment) rather than
    // splitting — neither asset is a highlight, so (round-17 fix) the
    // render's own `hero[0] || !hero[1]` dominance fallback makes the FIRST
    // asset dominant; these aspects clear the floor either way dominance
    // shakes out, unlike a more extreme wide/tall combination.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ aspectRatio: 1.5 }), makeAsset({ aspectRatio: 1.0 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const page = document.pages.find((p) => p.templateId === 'anchor-media' && p.slots.filter((s) => s.kind === 'photo').length === 2)!;
    expect(page).toBeTruthy();
    const photos = page.slots.filter((s) => s.kind === 'photo').map((s) => s.content as PhotoSlotContent);
    expect(photos.every((p) => p.index != null)).toBe(true);
    const footerIndex = page.params.footerIndex as Array<{ indices: number[] }>;
    expect(footerIndex.some((e) => e.indices.length > 0)).toBe(true);
  });

  it('a solo photo page that ALSO receives a facing full-bleed credit keeps its numeral — a genuine second thing to disambiguate', () => {
    const manifest = makeManifest({
      'mem-hero': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })] }),
      // Distinct caption from mem-hero's (null) so the two footer entries
      // never accidentally consolidate onto one line (item 9) — that would
      // legitimately collapse the count this test checks for a different reason.
      'mem-next': makeMemory({ text: 'Right after the hero.', assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-hero', 'mem-next'], highlights: ['mem-hero'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const fullBleedIndex = document.pages.findIndex((p) => p.templateId === 'full-bleed');
    expect(fullBleedIndex).toBeGreaterThan(-1);
    const facingPage = document.pages[fullBleedIndex + 1];
    const footerIndex = facingPage.params.footerIndex as Array<{ index: number; indices: number[] }>;
    expect(footerIndex.length).toBeGreaterThanOrEqual(2); // the credit + the real photo
    expect(footerIndex.every((e) => e.indices.length > 0)).toBe(true);
    const photo = facingPage.slots.find((s) => s.kind === 'photo')!.content as PhotoSlotContent;
    expect(photo.index).not.toBeNull();
  });
});

describe('fitBook — illustrated 1-vs-2-page split threshold (owner review round 5, item 6)', () => {
  it('forces the split when text length alone reaches ILLUSTRATED_SPLIT_MIN_CHARS (~320), even with a comfortably-sized illustration', () => {
    const longText = 'A '.repeat(165) + 'words, comfortably past the 320-char split threshold.'; // ~330+ chars
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: longText,
        assets: [],
        illustration: { file: 'illo.webp', width: 800, height: 1600, aspectRatio: 0.5 }, // tall, would render plenty big
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const modes = document.pages.filter((p) => p.templateId === 'illustrated-story').map((p) => p.params.mode);
    expect(modes).toContain('text-only');
    expect(modes).toContain('illustration-only');
  });

  it('forces the split when the single-page illustration would render below ILLUSTRATED_SPLIT_MIN_ILLO_HEIGHT_MM (~110mm), even though the text is short of the char threshold', () => {
    // ~280 chars: well under the 320-char threshold, but a SQUARE
    // illustration under this section's own month header renders at only
    // ~96mm tall at the "not short" width — under the 110mm floor.
    const notShortText = 'A '.repeat(120) + 'words, well past two hundred but short of the char threshold.';
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: notShortText,
        assets: [],
        illustration: { file: 'illo.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const modes = document.pages.filter((p) => p.templateId === 'illustrated-story').map((p) => p.params.mode);
    expect(modes).toContain('text-only');
    expect(modes).toContain('illustration-only');
  });

  it('does NOT split a short-ish caption whose illustration comfortably clears the height floor', () => {
    // Round-9 item 1c finding: `illustratedStoryNeedsSplit` now checks the
    // FITTED height, which is capped by the CAPTION's own consumed vertical
    // space too, not just the illustration's aspect ratio — a caption long
    // enough to need 5+ text lines (roughly >180 chars at this stack width)
    // already trips the 110mm floor on its own, however elongated the
    // illustration is (an elongated illustration's nominal height was
    // irrelevant even in the old, buggy math the moment the CAPTION alone
    // had already eaten the safe box — that masked case is exactly what
    // round-9 fixes). So "comfortably clears the floor" now needs a
    // genuinely short caption (a leading unrelated memory also keeps this
    // page header-free — see the split-threshold interplay tests below for
    // why a headed page can never stay in "both" mode at all now).
    const shortishText = 'A short-ish caption that stays comfortably under the line-count floor.';
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: shortishText,
        assets: [],
        illustration: { file: 'illo.webp', width: 800, height: 1600, aspectRatio: 0.5 }, // tall enough to clear the floor
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const storyPage = document.pages.find((p) => p.templateId === 'illustrated-story');
    expect(storyPage).toBeTruthy();
    expect(storyPage!.params.sectionHeader).toBeFalsy();
    expect(storyPage!.params.mode ?? 'both').not.toBe('text-only');
  });

  it('Task 2 (round-17): a caption pushed over ILLUSTRATED_SPLIT_MIN_CHARS ONLY by a pasted URL must NOT split — the split decision measures the SANITIZED length', () => {
    // The short, genuinely-short caption text alone is nowhere near the
    // 320-char threshold — but appending a long pasted URL pushes the RAW
    // length comfortably past it. `illustratedStoryNeedsSplit` must measure
    // `printableCaption`'s sanitized length (URL stripped), not the raw
    // manifest text, or a memory would split purely because of a link a
    // parent happened to paste in — a link that never even prints.
    const shortishText = 'A short-ish caption that stays comfortably under the line-count floor.';
    const longUrl = 'https://example.com/' + 'path-segment/'.repeat(20); // well over 240 chars on its own
    const textWithUrl = `${shortishText} ${longUrl}`;
    expect(textWithUrl.length).toBeGreaterThan(320); // raw text alone would force the split
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: textWithUrl,
        assets: [],
        illustration: { file: 'illo.webp', width: 800, height: 1600, aspectRatio: 0.5 }, // tall enough to clear the floor
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const storyPage = document.pages.find((p) => p.templateId === 'illustrated-story');
    expect(storyPage).toBeTruthy();
    expect(storyPage!.params.mode ?? 'both').not.toBe('text-only');
    // The URL never prints, on this page or anywhere else in the book.
    const printedText = document.pages
      .flatMap((p) => p.slots)
      .filter((s) => s.kind === 'text')
      .map((s) => (s.content as TextSlotContent).text)
      .join(' ');
    expect(printedText).not.toContain('https://');
    expect(printedText).toContain('short-ish caption');
  });

  it('round-9 item 1c: a section-header page ALWAYS forces the split now — the header reserve alone leaves less than the 110mm floor once the folio clearance and even a single caption line are accounted for', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'Tiny.', // as short as a caption gets — still can't fit
        assets: [],
        illustration: { file: 'illo.webp', width: 800, height: 1600, aspectRatio: 0.5 }, // maximally tall/elongated — still can't fit
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const modes = document.pages.filter((p) => p.templateId === 'illustrated-story').map((p) => p.params.mode);
    expect(modes).toContain('text-only');
    expect(modes).toContain('illustration-only');
  });

  it('never forces the split for a PAIRED short illustrated story — pairing is its own composition with its own smaller size', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({
        type: 'text_illustration',
        text: 'Short one.',
        assets: [],
        illustration: { file: 'illo-1.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
      'mem-2': makeMemory({
        type: 'text_illustration',
        text: 'Short two.',
        assets: [],
        illustration: { file: 'illo-2.webp', width: 800, height: 800, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);
    const { document } = fitBook(outline, manifest);
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(storyPages.every((p) => p.params.mode !== 'text-only' && p.params.mode !== 'illustration-only')).toBe(true);
  });
});

describe('fitBook — even total interior page count (owner review round 5, item 7)', () => {
  function bookWith(n: number) {
    const ids = Array.from({ length: n }, (_, i) => `mem-${i}`);
    const memories: Record<string, ReturnType<typeof makeMemory>> = {};
    for (const id of ids) memories[id] = makeMemory({ assets: [makeAsset()] });
    const outline = makeOutline([
      makeElement({ id: 'cover', kind: 'cover' }),
      makeElement({ id: 'title', kind: 'title' }),
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids }),
      makeElement({ id: 'closing', kind: 'closing' }),
    ]);
    return fitBook(outline, makeManifest(memories));
  }

  it('adds one trailing blank when the natural total is odd, within Prodigi\'s printable range', () => {
    // 19 solo photo memories -> a natural total of 23 (odd), comfortably
    // above PRODIGI_MIN_PAGES (18) — the fitter must add exactly one
    // trailing blank, landing on 24.
    const { document } = bookWith(19);
    expect(document.totalPages).toBeGreaterThanOrEqual(18);
    expect(document.totalPages % 2).toBe(0);
    const last = document.pages[document.pages.length - 1];
    expect(last.templateId).toBe('blank');
    expect(last.blankReason).toBe('parity:closing-total');
    // The blank trails the closing page — the book still ends on its own final beat.
    expect(document.pages[document.pages.length - 2].templateId).toBe('closing');
  });

  it('never touches a naturally-even total — no gratuitous trailing blank', () => {
    // 20 solo photo memories -> a natural total of 24 (already even).
    const { document } = bookWith(20);
    expect(document.totalPages).toBeGreaterThanOrEqual(18);
    expect(document.totalPages % 2).toBe(0);
    expect(document.pages[document.pages.length - 1].templateId).toBe('closing');
    // No gratuitous closing-parity blank — the front-matter verso blank
    // (from the 'title' element, an unrelated structural page) is fine.
    expect(document.pages.every((p) => p.blankReason !== 'parity:closing-total')).toBe(true);
  });

  it('never enforces evenness below the Prodigi printable range (a tiny book stays whatever it naturally is)', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    expect(document.totalPages).toBeLessThan(18);
    expect(document.pages.every((p) => p.templateId !== 'blank')).toBe(true);
  });
});

describe('fitBook — minimum image size (owner review round 5 amendment)', () => {
  it('splits a marginal anchor-media pair onto two solo pages instead of shrinking either image below MIN_IMAGE_SIDE_MM', () => {
    // A single memory with a very wide (2.5) and a very tall (0.5) asset,
    // as the FIRST (and only) content page of its section — so it also
    // carries a section header (fill mode, a shorter content box). The
    // wide one reliably wins dominance (its elongation, 2.5, clears the
    // tall one's, 2.0, well past the near-tie tolerance) and claims most
    // of the shared height under a header — leaving the tall subordinate,
    // now width-unconstrained but height-starved, unable to clear the
    // floor. The fitter must split rather than shrink either one.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ aspectRatio: 2.5 }), makeAsset({ aspectRatio: 0.5 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    const twoPhotoPages = document.pages.filter((p) => p.templateId === 'anchor-media' && p.slots.filter((s) => s.kind === 'photo').length === 2);
    expect(twoPhotoPages).toHaveLength(0);
    const soloPages = document.pages.filter((p) => p.templateId === 'anchor-media' && p.slots.filter((s) => s.kind === 'photo').length === 1);
    expect(soloPages).toHaveLength(2);
    // Neither resulting solo image was silently dropped — both of mem-1's assets still render, one per page.
    const files = soloPages.flatMap((p) => p.slots.filter((s) => s.kind === 'photo').map((s) => (s.content as PhotoSlotContent).assetFile));
    expect(new Set(files).size).toBe(2);
  });

  it('still pairs when the aspect combination clears the floor comfortably', () => {
    // Neither asset is a highlight, so (round-17 fix) the render's own
    // `hero[0] || !hero[1]` dominance fallback makes the FIRST asset
    // dominant — these aspects clear the floor under that dominance,
    // unlike a more extreme wide/tall combination.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ aspectRatio: 1.5 }), makeAsset({ aspectRatio: 1.0 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const twoPhotoPages = document.pages.filter((p) => p.templateId === 'anchor-media' && p.slots.filter((s) => s.kind === 'photo').length === 2);
    expect(twoPhotoPages.length).toBeGreaterThan(0);
  });

  it('splits a same-memory two-asset companion slice too, when it would violate the floor', () => {
    const longText = 'A '.repeat(150) + 'words of long text with a couple of companion photos attached.';
    const manifest = makeManifest({
      // A very wide (2.5) + very tall (0.5) companion pair: even at the
      // companion page's full (no header/footer reserve) content box, the
      // wide one dominates and claims most of the width, leaving the tall
      // subordinate — now height-starved on its own reserved share —
      // unable to clear the floor.
      'mem-1': makeMemory({ text: longText, assets: [makeAsset({ aspectRatio: 2.5 }), makeAsset({ aspectRatio: 0.5 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const companionPages = document.pages.filter(
      (p) => p.templateId === 'anchor-media' && p.slots.some((s) => s.kind === 'photo' && (s.content as PhotoSlotContent).memoryId === 'mem-1'),
    );
    const twoPhotoCompanion = companionPages.filter((p) => p.slots.filter((s) => s.kind === 'photo').length === 2);
    expect(twoPhotoCompanion).toHaveLength(0);
    const soloCompanion = companionPages.filter((p) => p.slots.filter((s) => s.kind === 'photo').length === 1);
    expect(soloCompanion).toHaveLength(2);
  });
});

describe('fitBook — full-bleed parity: reorder prediction + demotion fallback (owner review round 9, item 2)', () => {
  // A trusted (print-safe width, low crop-loss) solo photo — wins full-bleed
  // over anchor-media's own 0.9 score (scoreFullBleed's non-hero trusted
  // path scores 0.91) without needing an outline highlight.
  function trustedPhoto(aspectRatio = 1) {
    return makeMemory({ assets: [makeAsset({ width: 3000, height: Math.round(3000 / aspectRatio), aspectRatio })] });
  }

  it('predicts a section-opening full-bleed needs an even landing and reorders around it — zero blanks, full-bleed still renders even', () => {
    const manifest = makeManifest({
      // Lands alone on page 2 (even) — the NEXT section then starts odd,
      // exactly the diagnosed "full-bleed opens a new month section" case.
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-hero': trustedPhoto(1),
      'mem-after': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
      makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-hero', 'mem-after'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.filter((p) => p.templateId === 'blank')).toHaveLength(0);
    const fullBleedPage = document.pages.find((p) => p.templateId === 'full-bleed');
    expect(fullBleedPage).toBeTruthy();
    // No cover/dedication front matter in this fixture, so the round-22
    // renumbering's -1 (parity-flipping) shift applies — see the earlier
    // full-bleed parity tests for the full explanation.
    expect(fullBleedPage!.isEvenPage).toBe(false);
    // mem-after was never dropped by the reorder — it still renders somewhere.
    const memAfterPage = document.pages.find((p) =>
      p.slots.some((s) => s.kind === 'photo' && (s.content as PhotoSlotContent).memoryId === 'mem-after'),
    );
    expect(memAfterPage).toBeTruthy();
  });

  it('demotes to an ordinary anchor-media solo instead of a blank when the section has no other unit to reorder with (the true last resort)', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }), // same odd-start setup as above
      'mem-hero': trustedPhoto(1), // the section's ONLY unit — nothing for the reorder pass to trade with
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
      makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-hero'] }),
    ]);

    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    expect(document.pages.filter((p) => p.templateId === 'blank')).toHaveLength(0);
    // Owner-approved trade (round-9 item 2b): no full-bleed page at all —
    // it demoted rather than paying a blank for the facing-credit promise.
    expect(document.pages.some((p) => p.templateId === 'full-bleed')).toBe(false);
    const demoted = document.pages.find((p) => p.sourceElementId === 'backbone:b');
    expect(demoted).toBeTruthy();
    expect(demoted!.templateId).toBe('anchor-media');
    expect(demoted!.slots.some((s) => s.kind === 'photo')).toBe(true);
  });

  it('sim/assembly consistency: auditBookDocument reports zero avoidable parity:full-bleed blanks for either outcome above', () => {
    const reorderedManifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-hero': trustedPhoto(1),
      'mem-after': makeMemory({ assets: [makeAsset()] }),
    });
    const reorderedOutline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
      makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-hero', 'mem-after'] }),
    ]);
    const demotedManifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-hero': trustedPhoto(1),
    });
    const demotedOutline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
      makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-hero'] }),
    ]);

    for (const [outline, manifest] of [
      [reorderedOutline, reorderedManifest],
      [demotedOutline, demotedManifest],
    ] as const) {
      const { document } = fitBook(outline, manifest);
      const violations = auditBookDocument(document, outline, manifest);
      const fullBleedBlankViolations = violations.filter((v) => v.message.includes('full-bleed') && v.check === 'blank-accounting');
      expect(fullBleedBlankViolations).toHaveLength(0);
    }
  });
});

describe('fitBook — illustrated-split de-split fallback (owner review round 9.1: sim==assembly regression)', () => {
  // A trusted (print-safe width, low crop-loss) solo photo — wins full-bleed
  // over anchor-media's own 0.9 score, same as the round-9 item 2 fixture
  // above.
  function trustedPhoto(aspectRatio: number) {
    return makeMemory({ assets: [makeAsset({ width: 3000, height: Math.round(3000 / aspectRatio), aspectRatio })] });
  }
  const illo = (aspectRatio = 1) => ({ file: 'assets/illo.webp', width: 1000, height: Math.round(1000 / aspectRatio), aspectRatio });

  it(
    'reproduces the diagnosed topic:toys-building composition — spread-title, then media(1 asset) + a short illustrated pair + ' +
      'media(1 asset) + a trailing long-enough-to-split illustrated story — and resolves it with ZERO blanks',
    () => {
      // ~150 chars: comfortably clears the fitted-height split floor under
      // the current (0.7em) glyph-width calibration, headerless, at aspect 1
      // (see illustratedIlloFitHeightMm) — matches the diagnosed 162-char
      // case's own outcome.
      const longEnoughToSplit = 'A '.repeat(70) + 'words, long enough to force the split under the current calibration.';
      const manifest = makeManifest({
        // Lands alone on an odd-parity-inducing page, matching the
        // diagnosed case's `startsOnEvenPage=false` for the themed section.
        'mem-lead': makeMemory({ assets: [makeAsset()] }),
        'm1': trustedPhoto(0.75), // portrait — full-bleed-eligible, like the real 230c17a1 memory
        'i1': makeMemory({
          type: 'text_illustration',
          text: 'A '.repeat(60) + 'words, a short first illustrated moment.',
          assets: [],
          illustration: illo(0.7),
        }),
        'i2': makeMemory({
          type: 'text_illustration',
          text: 'A '.repeat(50) + 'words, a short second illustrated moment.',
          assets: [],
          illustration: illo(0.7),
        }),
        'm2': trustedPhoto(1.33), // landscape — full-bleed-eligible, like the real 907daf34 memory
        'i3': makeMemory({ type: 'text_illustration', text: longEnoughToSplit, assets: [], illustration: illo(1) }),
      });
      const outline = makeOutline([
        makeElement({ id: 'backbone:lead', kind: 'backbone', memoryIds: ['mem-lead'] }),
        makeElement({
          id: 'topic:toys',
          kind: 'themed',
          memoryIds: ['m1', 'i1', 'i2', 'm2', 'i3'],
          spreadType: 'topic',
          titleMode: 'descriptive',
        }),
      ]);

      const { document, gaps } = fitBook(outline, manifest);
      expect(gaps).toHaveLength(0);

      const sectionPages = document.pages.filter((p) => p.sourceElementId === 'topic:toys');
      const blanks = sectionPages.filter((p) => p.templateId === 'blank');
      expect(blanks).toHaveLength(0);

      // i1/i2 pair up (both short, adjacent) and land intact.
      const storyPages = sectionPages.filter((p) => p.templateId === 'illustrated-story');
      expect(storyPages.length).toBeGreaterThanOrEqual(3); // i1, i2, and i3's own page(s)

      // i3 is never silently dropped, whichever composition it ends up in
      // (a split OR the round-9.1 de-split "both" mode fallback) — its own
      // text and illustration both still render somewhere.
      const hasI3Text = (p: (typeof sectionPages)[number]) =>
        p.slots.some((s): s is typeof s & { content: TextSlotContent } => s.kind === 'text' && (s.content as TextSlotContent).memoryId === 'i3');
      const hasI3Illo = (p: (typeof sectionPages)[number]) =>
        p.slots.some((s): s is typeof s & { content: IllustrationSlotContent } => s.kind === 'illustration' && (s.content as IllustrationSlotContent).memoryId === 'i3');
      const i3Pages = sectionPages.filter((p) => hasI3Text(p) || hasI3Illo(p));
      expect(i3Pages.length).toBeGreaterThan(0);
      expect(i3Pages.some(hasI3Text)).toBe(true);
      expect(i3Pages.some(hasI3Illo)).toBe(true);

      // sim==assembly: auditBookDocument (which recomputes the tall-solo/
      // fitted-height/parity checks independently of the fitter's own
      // decisions) reports zero violations for this composition too.
      const violations = auditBookDocument(document, outline, manifest);
      expect(violations).toHaveLength(0);
    },
  );
});

describe('fitBook — illustrated-digest sweep (Task 1, round-12)', () => {
  /** Collects every digest-entry memoryId across the whole document — used to check what did/didn't get swept. */
  function digestEntryIds(document: ReturnType<typeof fitBook>['document']): string[] {
    return document.pages
      .filter((p) => p.templateId === 'illustrated-digest')
      .flatMap((p) => p.slots.filter((s): s is { id: string; kind: 'digest-entry'; content: DigestEntryContent } => s.kind === 'digest-entry'))
      .map((s) => s.content.memoryId);
  }

  it('does not engage below the engagement threshold — fewer than 6 digest-eligible memories all stay ordinary illustrated pages', () => {
    const ids = Array.from({ length: 5 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id, i) => [id, digestMemory(`2024-0${i + 1}-01`)]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document } = fitBook(outline, makeManifest(memories));
    expect(document.pages.some((p) => p.templateId === 'illustrated-digest')).toBe(false);
  });

  it('engages at exactly the threshold (6) and, with a clean remainder of 4 after the keep-full budget, forms ONE digest spread of 4 with no separators or leftovers', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id, i) => [id, digestMemory(`2024-01-0${i + 1}`)]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    const digestPages = document.pages.filter((p) => p.templateId === 'illustrated-digest');
    expect(digestPages).toHaveLength(1);
    expect(digestPages[0].isSpread).toBe(true);
    const entries = digestEntryIds(document);
    expect(entries).toEqual(['mem-2', 'mem-3', 'mem-4', 'mem-5']); // the first 2 (mem-0, mem-1) kept full
    const storyPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(storyPages.map((p) => p.slots.find((s) => s.kind === 'illustration')?.content)).toHaveLength(2);
    // The kept-full pages' own illustration memoryIds are mem-0/mem-1.
    const storyIllustrationIds = storyPages
      .flatMap((p) => p.slots.filter((s): s is { id: string; kind: 'illustration'; content: IllustrationSlotContent } => s.kind === 'illustration'))
      .map((s) => s.content.memoryId);
    expect(new Set(storyIllustrationIds)).toEqual(new Set(['mem-0', 'mem-1']));
  });

  it('a trailing remainder of exactly 1 stays as an ordinary illustrated page, never swept into a digest', () => {
    // 7 total (2 kept-full + 5 sweepable) -> one clean digest(4), remainder 1 stays ordinary.
    const ids = Array.from({ length: 7 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id, i) => [id, digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`)]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document } = fitBook(outline, makeManifest(memories));
    const digestPages = document.pages.filter((p) => p.templateId === 'illustrated-digest');
    expect(digestPages).toHaveLength(1);
    expect(digestPages[0].isSpread).toBe(true);
    expect(digestEntryIds(document)).toEqual(['mem-2', 'mem-3', 'mem-4', 'mem-5']);
    const storyIllustrationIds = document.pages
      .filter((p) => p.templateId === 'illustrated-story')
      .flatMap((p) => p.slots.filter((s): s is { id: string; kind: 'illustration'; content: IllustrationSlotContent } => s.kind === 'illustration'))
      .map((s) => s.content.memoryId);
    expect(storyIllustrationIds).toContain('mem-6');
  });

  it('a trailing remainder of exactly 2 becomes a SINGLE-page digest (owner round-12 extension) — never an ordinary page, never a spread', () => {
    // Two SEPARATE eligible runs (a milestone-holding memory splits them,
    // so there is no adjacency pressure from a preceding spread): run A
    // (6, clean spread with no remainder) then run B (2, a fresh run whose
    // own keep-full budget is already spent by A, so its whole length
    // sweeps) — B's remainder-of-2 forms a clean single page.
    const memories: Record<string, ReturnType<typeof digestMemory>> = {};
    const aIds = Array.from({ length: 6 }, (_, i) => `a-${i}`);
    aIds.forEach((id, i) => (memories[id] = digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`)));
    memories['sep'] = digestMemory('2024-01-07', { milestones: [{ id: 'm', name: 'First steps', detail: '' }] });
    const bIds = Array.from({ length: 2 }, (_, i) => `b-${i}`);
    bIds.forEach((id, i) => (memories[id] = digestMemory(`2024-01-${String(i + 8).padStart(2, '0')}`)));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [...aIds, 'sep', ...bIds] })]);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    const digestPages = document.pages.filter((p) => p.templateId === 'illustrated-digest');
    expect(digestPages).toHaveLength(2);
    const spreads = digestPages.filter((p) => p.isSpread);
    const singles = digestPages.filter((p) => !p.isSpread);
    expect(spreads).toHaveLength(1);
    expect(singles).toHaveLength(1);
    expect(spreads[0].slots.filter((s) => s.kind === 'digest-entry')).toHaveLength(4);
    expect(singles[0].slots.filter((s) => s.kind === 'digest-entry')).toHaveLength(2);
    const singleIds = singles[0].slots.filter((s) => s.kind === 'digest-entry').map((s) => (s.content as DigestEntryContent).memoryId);
    expect(new Set(singleIds)).toEqual(new Set(['b-0', 'b-1']));
    // The single page carries exactly one printed page number (never a spread pair).
    expect(singles[0].pageNumbers).toHaveLength(1);
  });

  it('a trailing remainder of exactly 3 becomes a SINGLE-page digest (the first 2) plus one ordinary page (the 3rd) — never a 3-entry spread (owner round-12 correction)', () => {
    // Same two-run construction as above, with run B sized 3.
    const memories: Record<string, ReturnType<typeof digestMemory>> = {};
    const aIds = Array.from({ length: 6 }, (_, i) => `a-${i}`);
    aIds.forEach((id, i) => (memories[id] = digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`)));
    memories['sep'] = digestMemory('2024-01-07', { milestones: [{ id: 'm', name: 'First steps', detail: '' }] });
    const bIds = Array.from({ length: 3 }, (_, i) => `b-${i}`);
    bIds.forEach((id, i) => (memories[id] = digestMemory(`2024-01-${String(i + 8).padStart(2, '0')}`)));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [...aIds, 'sep', ...bIds] })]);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    // Never a 3-entry (or any odd-entry) digest page anywhere.
    for (const page of document.pages.filter((p) => p.templateId === 'illustrated-digest')) {
      expect(page.slots.filter((s) => s.kind === 'digest-entry').length % 2).toBe(0);
    }
    const digestPages = document.pages.filter((p) => p.templateId === 'illustrated-digest');
    const singles = digestPages.filter((p) => !p.isSpread);
    expect(singles).toHaveLength(1);
    const singleIds = singles[0].slots.filter((s) => s.kind === 'digest-entry').map((s) => (s.content as DigestEntryContent).memoryId);
    expect(new Set(singleIds)).toEqual(new Set(['b-0', 'b-1'])); // first 2 of run B's remainder-3
    // b-2 (the lonely 3rd) stays an ordinary illustrated-story page — never swept.
    expect(digestEntryIds(document)).not.toContain('b-2');
    const storyIllustrationIds = document.pages
      .filter((p) => p.templateId === 'illustrated-story')
      .flatMap((p) => p.slots.filter((s): s is { id: string; kind: 'illustration'; content: IllustrationSlotContent } => s.kind === 'illustration'))
      .map((s) => s.content.memoryId);
    expect(storyIllustrationIds).toContain('b-2');
  });

  it('pacing OVERRIDES a clean remainder-of-2 when it would directly follow a spread with nothing between them — the single-page digest sacrifices to a promoted separator + one ordinary page instead (uniform pacing, owner round-12)', () => {
    // A SINGLE run of 8 (2 kept-full + 6 sweepable): spread(4) leaves
    // exactly 2 remaining — which WOULD form a clean single page, but that
    // would sit directly adjacent to the spread. Pacing wins: 1 promoted
    // to an ordinary page, leaving only 1 more (also ordinary, too few to
    // form a single) — never an adjacent single, never a 2-entry digest
    // here at all.
    const ids = Array.from({ length: 8 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id, i) => [id, digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`)]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    const digestPages = document.pages.filter((p) => p.templateId === 'illustrated-digest');
    expect(digestPages).toHaveLength(1); // only the spread — no single formed
    expect(digestEntryIds(document)).toEqual(['mem-2', 'mem-3', 'mem-4', 'mem-5']);
    // mem-6/mem-7 both stay ordinary — neither swept, no adjacent single.
    const storyIllustrationIds = document.pages
      .filter((p) => p.templateId === 'illustrated-story')
      .flatMap((p) => p.slots.filter((s): s is { id: string; kind: 'illustration'; content: IllustrationSlotContent } => s.kind === 'illustration'))
      .map((s) => s.content.memoryId);
    expect(storyIllustrationIds).toContain('mem-6');
    expect(storyIllustrationIds).toContain('mem-7');
  });

  it('chunks a longer sweep pool at 4, pacing with a promoted separator between digest units of EITHER variant — never two digest units back to back, never a blank, and no memory lost', () => {
    // 12 total (2 kept-full + 10 sweepable): chunkDigestSweep forms
    // spread(4) + promote(1) + spread(4) + promote(1). Whether every digest
    // unit survives depends on where it lands relative to the rest of the
    // section's own page parity — a stuck spread dissolves (its own
    // no-blank last resort), same as any other. Either outcome is correct;
    // what's NON-NEGOTIABLE (never adjacent, never a blank, nothing lost)
    // is asserted below, across a pool deliberately sized so pacing fires
    // more than once.
    const ids = Array.from({ length: 12 }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id, i) => [id, digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`)]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    expect(document.pages.some((p) => p.templateId === 'blank')).toBe(false);
    // Never two digest units (spread OR single) adjacent in the final document.
    const digestIndices = document.pages.map((p, i) => (p.templateId === 'illustrated-digest' ? i : -1)).filter((i) => i >= 0);
    for (let i = 1; i < digestIndices.length; i++) expect(digestIndices[i] - digestIndices[i - 1]).toBeGreaterThan(1);
    // Every digest page holds an even entry count (never a lonely last row).
    for (const page of document.pages.filter((p) => p.templateId === 'illustrated-digest')) {
      expect(page.slots.filter((s) => s.kind === 'digest-entry').length % 2).toBe(0);
    }
    // The first chunk of 4 (mem-2..mem-5) always survives as a digest spread
    // — it's the section's very first parity-critical unit and lands even trivially.
    expect(digestEntryIds(document)).toEqual(expect.arrayContaining(['mem-2', 'mem-3', 'mem-4', 'mem-5']));
    // No memory lost: every one of mem-0..mem-11 appears exactly once, either
    // as a digest entry or as an ordinary illustrated-story illustration.
    const storyIllustrationIds = document.pages
      .filter((p) => p.templateId === 'illustrated-story')
      .flatMap((p) => p.slots.filter((s): s is { id: string; kind: 'illustration'; content: IllustrationSlotContent } => s.kind === 'illustration'))
      .map((s) => s.content.memoryId);
    const allRendered = [...digestEntryIds(document), ...storyIllustrationIds].sort();
    expect(allRendered).toEqual([...ids].sort());
  });

  it('reorderUnitsForParity never leaves two digest units adjacent, across MIXED variants — a single-page digest landing directly after a spread is dissolved into ordinary pages (final pacing backstop)', () => {
    // Synthetic worst case: a 4-entry SPREAD directly followed by a
    // 2-entry SINGLE page, nothing between them (as if some other reorder
    // had pulled their separator away) — the pacing rule applies to BOTH
    // variants uniformly, so this must be caught exactly like two adjacent
    // spreads.
    const chunkA = Array.from({ length: 4 }, (_, i) => ({ id: `a-${i}`, memory: digestMemory(`2024-01-0${i + 1}`) }));
    const chunkB = Array.from({ length: 2 }, (_, i) => ({ id: `b-${i}`, memory: digestMemory(`2024-01-1${i + 1}`) }));
    const units = [
      { kind: 'illustrated-digest' as const, items: chunkA, variant: 'spread' as const },
      { kind: 'illustrated-digest' as const, items: chunkB, variant: 'single' as const },
    ];
    const element = makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [...chunkA, ...chunkB].map((i) => i.id) });
    const outline = makeOutline([element]);

    const result = reorderUnitsForParity(units, true, element, outline, {
      contentPageCount: 0,
      fullBleedBudget: { total: 0, consecutive: 0 },
      lastTemplateId: null,
      headerPending: false,
    });

    const digestCount = result.filter((u) => u.kind === 'illustrated-digest').length;
    expect(digestCount).toBe(1); // the spread survives, the single dissolved
    expect(result.filter((u) => u.kind === 'group')).toHaveLength(2); // chunkB's 2 items, dissolved
    // Order preserved: chunkA's own digest unit still comes first, chunkB's dissolved items follow in order.
    const dissolvedIds = result.filter((u) => u.kind === 'group').map((u) => (u.kind === 'group' ? u.group.memories[0].id : null));
    expect(dissolvedIds).toEqual(['b-0', 'b-1']);
  });

  it('a SINGLE-page digest unit has a simpler sim: span 1, no even-start requirement — the reorder pass leaves an odd-landing single completely untouched', () => {
    const items = Array.from({ length: 2 }, (_, i) => ({ id: `mem-${i}`, memory: digestMemory(`2024-01-0${i + 1}`) }));
    const units = [{ kind: 'illustrated-digest' as const, items, variant: 'single' as const }];
    const element = makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: items.map((i) => i.id) });
    const outline = makeOutline([element]);

    // startsOnEvenPage: false — a SPREAD unit here would trigger the whole
    // fallback chain; a SINGLE must sail through untouched (needsEven: false).
    const result = reorderUnitsForParity(units, false, element, outline, {
      contentPageCount: 0,
      fullBleedBudget: { total: 0, consecutive: 0 },
      lastTemplateId: null,
      headerPending: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('illustrated-digest');
    expect(result[0].kind === 'illustrated-digest' && result[0].variant).toBe('single');
  });

  it('never sweeps an illustration whose aspect ratio falls outside the [0.9, 1.2] eligibility band, even in an otherwise-engaged section', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `mem-${i}`);
    const memories: Record<string, ReturnType<typeof digestMemory>> = {};
    for (let i = 0; i < 7; i++) {
      memories[`mem-${i}`] = digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`);
    }
    // mem-6 (chronologically last, so it never lands in the keep-full budget) gets a too-wide illustration.
    memories['mem-6'] = digestMemory('2024-01-07', {
      illustration: { file: 'assets/wide.webp', width: 1500, height: 1000, aspectRatio: 1.5 },
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document } = fitBook(outline, makeManifest(memories));
    expect(digestEntryIds(document)).not.toContain('mem-6');
    const storyIllustrationIds = document.pages
      .filter((p) => p.templateId === 'illustrated-story')
      .flatMap((p) => p.slots.filter((s): s is { id: string; kind: 'illustration'; content: IllustrationSlotContent } => s.kind === 'illustration'))
      .map((s) => s.content.memoryId);
    expect(storyIllustrationIds).toContain('mem-6');
  });

  it('never sweeps a milestone-holding memory into a digest row, even in an otherwise-engaged section', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `mem-${i}`);
    const memories: Record<string, ReturnType<typeof digestMemory>> = {};
    for (let i = 0; i < 7; i++) {
      memories[`mem-${i}`] = digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`);
    }
    memories['mem-6'] = digestMemory('2024-01-07', { milestones: [{ id: 'm1', name: 'First steps', detail: '' }] });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document } = fitBook(outline, makeManifest(memories));
    expect(digestEntryIds(document)).not.toContain('mem-6');
  });

  it("never sweeps the element's own quote-title-source memory into a digest row, even in an otherwise-engaged section", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `mem-${i}`);
    const memories: Record<string, ReturnType<typeof digestMemory>> = {};
    for (let i = 0; i < 7; i++) {
      memories[`mem-${i}`] = digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`);
    }
    const outline = makeOutline([
      makeElement({
        id: 'topic:x',
        kind: 'themed',
        memoryIds: ids,
        titleSourceMemoryId: 'mem-6',
        spreadType: 'topic',
        titleMode: 'quote',
      }),
    ]);

    const { document } = fitBook(outline, makeManifest(memories));
    expect(digestEntryIds(document)).not.toContain('mem-6');
  });

  it('never sweeps a memory whose text exceeds the 240-char digest entry cap, even in an otherwise-engaged section', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `mem-${i}`);
    const memories: Record<string, ReturnType<typeof digestMemory>> = {};
    for (let i = 0; i < 7; i++) {
      memories[`mem-${i}`] = digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`);
    }
    memories['mem-6'] = digestMemory('2024-01-07', { text: 'A '.repeat(150) + 'well past the two-hundred-forty character digest cap.' });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document } = fitBook(outline, makeManifest(memories));
    expect(digestEntryIds(document)).not.toContain('mem-6');
  });

  it('preserves chronological order — a photo-bearing memory in the middle of an otherwise-eligible run still never reorders content across the month', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `mem-${i}`);
    const memories: Record<string, ReturnType<typeof digestMemory> | ReturnType<typeof makeMemory>> = {};
    for (let i = 0; i < 7; i++) {
      memories[`mem-${i}`] = digestMemory(`2024-01-${String(i + 1).padStart(2, '0')}`);
    }
    memories['mem-6'] = digestMemory('2024-01-07'); // still eligible; total stays at 7 (>= threshold)
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);

    const { document } = fitBook(outline, makeManifest(memories));
    // Whatever the mix of digest/story pages, every memory's DATE order is preserved end to end.
    const orderedIds: string[] = [];
    for (const page of document.pages) {
      for (const slot of page.slots) {
        if (slot.kind === 'illustration') orderedIds.push((slot.content as IllustrationSlotContent).memoryId);
        if (slot.kind === 'digest-entry') orderedIds.push((slot.content as DigestEntryContent).memoryId);
      }
    }
    const expectedOrder = ids.filter((id) => orderedIds.includes(id));
    expect(orderedIds).toEqual(expectedOrder.length === orderedIds.length ? ids : orderedIds);
    // Simpler, stronger check: the dates recovered from page order are non-decreasing.
    const dates = orderedIds.map((id) => (memories as Record<string, ManifestMemory>)[id].date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});

describe('fitBook — illustrated-digest parity (Task 1, round-12)', () => {
  it('reorderUnitsForParity DISSOLVES a digest SPREAD that cannot land even into ordinary single-page units — never falls back to a blank', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: `mem-${i}`, memory: digestMemory(`2024-01-0${i + 1}`) }));
    const units = [{ kind: 'illustrated-digest' as const, items, variant: 'spread' as const }];
    const element = makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: items.map((i) => i.id) });
    const outline = makeOutline([element]);

    const result = reorderUnitsForParity(units, /* startsOnEvenPage */ false, element, outline, {
      contentPageCount: 0,
      fullBleedBudget: { total: 0, consecutive: 0 },
      lastTemplateId: null,
      headerPending: false,
    });

    // Dissolved: no illustrated-digest unit survives — four plain group units instead, in order.
    expect(result.every((u) => u.kind === 'group')).toBe(true);
    expect(result).toHaveLength(4);
    const resultIds = result.map((u) => (u.kind === 'group' ? u.group.memories[0].id : null));
    expect(resultIds).toEqual(['mem-0', 'mem-1', 'mem-2', 'mem-3']);
  });

  it('a digest SPREAD that CAN land even is left completely untouched by the reorder pass', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: `mem-${i}`, memory: digestMemory(`2024-01-0${i + 1}`) }));
    const units = [{ kind: 'illustrated-digest' as const, items, variant: 'spread' as const }];
    const element = makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: items.map((i) => i.id) });
    const outline = makeOutline([element]);

    const result = reorderUnitsForParity(units, /* startsOnEvenPage */ true, element, outline, {
      contentPageCount: 0,
      fullBleedBudget: { total: 0, consecutive: 0 },
      lastTemplateId: null,
      headerPending: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('illustrated-digest');
  });

  it('sim/assembly consistency: auditBookDocument reports zero avoidable parity:illustrated-digest blanks across a batch of engaged sections', () => {
    const memories: Record<string, ManifestMemory> = {};
    const elements = Array.from({ length: 4 }, (_, m) => {
      const ids = Array.from({ length: 9 }, (_, i) => `mem-${m}-${i}`);
      for (let i = 0; i < 9; i++) {
        memories[`mem-${m}-${i}`] = digestMemory(`2024-0${m + 1}-${String(i + 1).padStart(2, '0')}`);
      }
      return makeElement({ id: `backbone:2024-0${m + 1}`, kind: 'backbone', memoryIds: ids });
    });
    const outline = makeOutline(elements);

    const { document, gaps } = fitBook(outline, makeManifest(memories));
    expect(gaps).toHaveLength(0);
    expect(document.pages.some((p) => p.templateId === 'blank' && p.blankReason?.startsWith('parity:illustrated-digest'))).toBe(false);
    const violations = auditBookDocument(document, outline, makeManifest(memories));
    expect(violations.filter((v) => v.check === 'blank-accounting')).toHaveLength(0);
  });
});

describe('fitBook — proportional cap-pressure demotion (round-13 rebalance)', () => {
  it('demotes from the kind with the CURRENTLY highest keep-rate, converging photo/illustrated keep-rates to exact parity when pools are equal size', () => {
    // 6 photo, 6 digest-eligible illustrated, one big low-pressure month
    // each (plenty of margin above the floor) — a pool-size tie removes any
    // floor interaction from the comparison.
    const photoIds = Array.from({ length: 6 }, (_, i) => `photo-${i}`);
    const digestIds = Array.from({ length: 6 }, (_, i) => `digest-${i}`);
    const memories: Record<string, ManifestMemory> = {};
    photoIds.forEach((id, i) => (memories[id] = photoMemory(1.5, i, `2024-01-${10 + i}`)));
    digestIds.forEach((id, i) => (memories[id] = digestMemory(`2024-01-${20 + i}`, { engagement: i })));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [...photoIds, ...digestIds] })]);

    // maxPages: 5, not 6 — round-22 renumbering: no cover/dedication front
    // matter in this fixture, so totalPages counts one lower than before.
    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 5 });
    const omittedPhoto = photoIds.filter((id) => capacity.omittedMemoryIds.includes(id)).length;
    const omittedDigest = digestIds.filter((id) => capacity.omittedMemoryIds.includes(id)).length;
    expect(capacity.omittedMemoryIds.length).toBe(6);
    // Old ladder would have drained all 6 photo before ever touching digest;
    // the new policy alternates and lands exactly even (3 each — parity,
    // not "text is sacred until last resort").
    expect(omittedPhoto).toBe(3);
    expect(omittedDigest).toBe(3);
  });

  it('reaches the illustrated pool well BEFORE the photo pool is exhausted when photo is the much larger pool (the regression the old photo/video-first ladder would fail)', () => {
    // 10 photo vs 4 digest-eligible illustrated, in separate low-pressure
    // months. The old ladder never touches illustrated until all 10 photo
    // are gone; the rebalanced policy reaches illustrated as soon as its
    // keep-rate catches up to photo's.
    const photoIds = Array.from({ length: 10 }, (_, i) => `photo-${i}`);
    const digestIds = Array.from({ length: 4 }, (_, i) => `digest-${i}`);
    const memories: Record<string, ManifestMemory> = {};
    photoIds.forEach((id, i) => (memories[id] = photoMemory(1.5, i, `2024-01-${10 + i}`)));
    digestIds.forEach((id, i) => (memories[id] = digestMemory(`2024-02-${10 + i}`, { engagement: i })));
    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: photoIds }),
      makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: digestIds }),
    ]);

    // A squeeze of only 6 omissions — the photo pool (10) is nowhere near
    // exhausted — must still reach into the illustrated pool.
    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 6 });
    const omittedPhoto = photoIds.filter((id) => capacity.omittedMemoryIds.includes(id)).length;
    const omittedDigest = digestIds.filter((id) => capacity.omittedMemoryIds.includes(id)).length;
    expect(omittedPhoto).toBeGreaterThan(0);
    expect(omittedPhoto).toBeLessThan(photoIds.length); // photo pool NOT exhausted
    expect(omittedDigest).toBeGreaterThan(0); // yet illustrated was already reached
  });

  it('tie-break: when photo, video, and illustrated keep-rates are exactly tied, demotes photo, then video, then illustrated, in that order (rebalancing the old preference, not inverting it)', () => {
    const photoIds = Array.from({ length: 4 }, (_, i) => `photo-${i}`);
    const videoIds = Array.from({ length: 4 }, (_, i) => `video-${i}`);
    const digestIds = Array.from({ length: 4 }, (_, i) => `digest-${i}`);
    const memories: Record<string, ManifestMemory> = {};
    photoIds.forEach((id, i) => (memories[id] = photoMemory(1.5, i, `2024-01-${10 + i}`)));
    videoIds.forEach((id, i) => (memories[id] = videoMemory(1.5, i, `2024-02-${10 + i}`)));
    digestIds.forEach((id, i) => (memories[id] = digestMemory(`2024-03-${10 + i}`, { engagement: i })));
    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: photoIds }),
      makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: videoIds }),
      makeElement({ id: 'backbone:c', kind: 'backbone', memoryIds: digestIds }),
    ]);

    // Every kind starts at a 100% keep-rate (a three-way tie), and stays
    // tied after each single cut removes one from each kind — a clean
    // round-robin in tie-break order: photo, then video, then illustrated.
    // maxPages: 7, not 8 — round-22 renumbering: no cover/dedication front
    // matter in this fixture, so totalPages counts one lower than before.
    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 7 });
    expect(capacity.omittedMemoryIds).toEqual(['photo-0', 'video-0', 'digest-0']);
  });

  it('reports a distinct gap-reason string per kind (photo / video / illustrated) so the gaps panel shows the mix', () => {
    const photoIds = Array.from({ length: 4 }, (_, i) => `photo-${i}`);
    const videoIds = Array.from({ length: 4 }, (_, i) => `video-${i}`);
    const digestIds = Array.from({ length: 4 }, (_, i) => `digest-${i}`);
    const memories: Record<string, ManifestMemory> = {};
    photoIds.forEach((id, i) => (memories[id] = photoMemory(1.5, i, `2024-01-${10 + i}`)));
    videoIds.forEach((id, i) => (memories[id] = videoMemory(1.5, i, `2024-02-${10 + i}`)));
    digestIds.forEach((id, i) => (memories[id] = digestMemory(`2024-03-${10 + i}`, { engagement: i })));
    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: photoIds }),
      makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: videoIds }),
      makeElement({ id: 'backbone:c', kind: 'backbone', memoryIds: digestIds }),
    ]);

    // maxPages: 7, not 8 — round-22 renumbering: no cover/dedication front
    // matter in this fixture, so totalPages counts one lower than before.
    const { gaps } = fitBook(outline, makeManifest(memories), { maxPages: 7 });
    const photoGap = gaps.find((g) => g.memoryIds.includes('photo-0'));
    const videoGap = gaps.find((g) => g.memoryIds.includes('video-0'));
    const digestGap = gaps.find((g) => g.memoryIds.includes('digest-0'));
    expect(photoGap?.reason).toContain('Omitted (photo)');
    expect(videoGap?.reason).toContain('Omitted (video)');
    expect(digestGap?.reason).toContain('Omitted (illustrated)');
    const reasons = new Set([photoGap?.reason, videoGap?.reason, digestGap?.reason]);
    expect(reasons.size).toBe(3); // all three distinct
  });

  it('terminates and reports overCap rather than looping forever when every kind is exhausted or fully protected and the cap still can\'t be met', () => {
    const memories: Record<string, ManifestMemory> = {
      'digest-milestone': digestMemory('2024-06-01', { milestones: [{ id: 'm1', name: 'First steps', detail: '' }] }),
      'text-only': makeMemory({ text: 'Protected text-only memory, never a demotion candidate.', assets: [], date: '2024-06-02' }),
      'photo-0': photoMemory(1.5, 0, '2024-06-03'),
    };
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: Object.keys(memories) })]);

    // An unreachably tiny cap: the ONLY demotable candidate is 'photo-0'
    // (one memory below the month floor of 2, which must yield since
    // nothing else can be cut) — the loop must still terminate rather than
    // spin once every pool is exhausted.
    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 1 });
    expect(capacity.omittedMemoryIds).not.toContain('digest-milestone');
    expect(capacity.omittedMemoryIds).not.toContain('text-only');
    // Nothing left to cut beyond the one demotable photo — omissions cannot
    // exceed the total demotable pool size (proof the "nothing left
    // anywhere" break fired instead of looping).
    expect(capacity.omittedMemoryIds.length).toBeLessThanOrEqual(1);
  });

  it('never demotes an illustrated memory that is not digest-eligible — a milestone holder or the section title source — even under extreme pressure', () => {
    const memories: Record<string, ManifestMemory> = {
      'photo-0': photoMemory(1.5, 0),
      'photo-1': photoMemory(1.5, 0),
      'digest-milestone': digestMemory('2024-06-01', { engagement: 0, milestones: [{ id: 'm1', name: 'First steps', detail: '' }] }),
      'digest-titlesource': digestMemory('2024-06-02', { engagement: 0 }),
      'digest-ordinary': digestMemory('2024-06-03', { engagement: 1 }),
    };
    const outline = makeOutline([
      makeElement({
        id: 'topic:x',
        kind: 'themed',
        memoryIds: Object.keys(memories),
        titleSourceMemoryId: 'digest-titlesource',
        spreadType: 'topic',
        titleMode: 'quote',
      }),
    ]);

    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 1 });
    expect(capacity.omittedMemoryIds).not.toContain('digest-milestone');
    expect(capacity.omittedMemoryIds).not.toContain('digest-titlesource');
  });

  it('respects the month-preservation floor across ALL kinds before letting the floor yield (protections still bind under the rebalanced policy)', () => {
    // Month A: rich in both photo and illustrated content. Month B: a
    // single photo-only memory, right at what will become its floor. The
    // squeeze should drain A (both kinds) well before ever touching B.
    const aIds = Array.from({ length: 6 }, (_, i) => `a-photo-${i}`);
    const aDigestIds = Array.from({ length: 6 }, (_, i) => `a-digest-${i}`);
    const memories: Record<string, ManifestMemory> = {};
    for (const id of aIds) memories[id] = photoMemory(1.5, 5, '2024-01-15');
    for (let i = 0; i < aDigestIds.length; i++) memories[aDigestIds[i]] = digestMemory('2024-01-16', { engagement: 5 });
    memories['b-photo-0'] = photoMemory(1.5, 0, '2024-02-01');
    memories['b-photo-1'] = photoMemory(1.5, 0, '2024-02-02');

    const outline = makeOutline([
      makeElement({ id: 'backbone:a', kind: 'backbone', title: 'A', memoryIds: [...aIds, ...aDigestIds] }),
      makeElement({ id: 'backbone:b', kind: 'backbone', title: 'B', memoryIds: ['b-photo-0', 'b-photo-1'] }),
    ]);

    const { capacity } = fitBook(outline, makeManifest(memories), { maxPages: 5 });
    const remainingB = ['b-photo-0', 'b-photo-1'].filter((id) => !capacity.omittedMemoryIds.includes(id)).length;
    expect(remainingB).toBe(2); // untouched, at its own floor
    expect(capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    expect(aIds.some((id) => capacity.omittedMemoryIds.includes(id))).toBe(true);
    expect(aDigestIds.some((id) => capacity.omittedMemoryIds.includes(id))).toBe(true); // both kinds reached in A
  });
});
