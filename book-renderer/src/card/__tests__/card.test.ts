import { describe, expect, it } from 'vitest';
import { buildCardDocument, CARD_STYLE, wrapSignature, type CardInput } from '../document';
import { changeGreeting, emptyEdits, hasAnyEdit, normalizeEdits, resetFocal, resetLetter, resetText, setChoices, setFocal, setFrontImage, setLetter, setText } from '../edits';
import { cardInputFromData, defaultFrontId, frontOptionsOf, resolveFront, typographic } from '../fromData';
import { CARD, cardGeometry, coverCrop, distancesToTrim, fitBoxToImage, orientationFromImage, safeViolations } from '../geometry';
import { GREETINGS, greetingText } from '../greetings';
import { fitLetter, splitParagraphs, wrapBalanced, wrapLines, type FontSpec, type MeasureFn } from '../textFit';
import { CARD_GREETING_KEYS, parseCardData, type CardData } from '../types';

// A deterministic stand-in for the browser's canvas measure: 0.47 em per character.
const measure: MeasureFn = (text, _font, sizePt) => text.length * sizePt * 0.47 * (25.4 / 72);
const FONT: FontSpec = { family: 'Newsreader', weight: 400, style: 'normal' };

// Fictional family and text only (the repo is public).
const WORDS = 'la familia Rivera Soto salió al parque con Lía y Teo y comimos helado mientras el sol se escondía detrás de los árboles'.split(' ');
function letter(chars: number): string {
  let out = '';
  for (let i = 0; out.length < chars; i += 1) out += `${WORDS[i % WORDS.length]} `;
  return out.trim();
}

function input(overrides: Partial<CardInput> = {}): CardInput {
  return {
    orientation: null,
    frontLayout: 'full-bleed',
    frontImage: { url: '/x/front.jpg', width: 4032, height: 3024, focal: null },
    greetingPosition: 'bottom-left',
    imageId: 'photo-1',
    greeting: 'Feliz Navidad',
    subline: '2026',
    backHeading: 'Feliz Navidad',
    letter: `${letter(180)}\n\n${letter(160)}\n\n${letter(60)}`,
    signature: 'Con cariño, la familia Rivera Soto',
    qr: { url: 'https://m.usemomora.com/f/AAAAAAAAAAAAAAAAAAAAAA' },
    qrCaption: 'Escanea para ver nuestro año: el parque y los helados',
    portraits: [],
    ...overrides,
  };
}

describe('card geometry', () => {
  it('page = trim + 4 mm bleed on every side (Gelato 5R)', () => {
    const l = cardGeometry('landscape');
    expect([l.trimW, l.trimH, l.pageW, l.pageH]).toEqual([177.8, 127, 185.8, 135]);
    const p = cardGeometry('portrait');
    expect([p.trimW, p.trimH, p.pageW, p.pageH]).toEqual([127, 177.8, 135, 185.8]);
    expect(l.trim).toEqual({ x: 4, y: 4, w: 177.8, h: 127 });
  });

  it('orientation follows the picture; a square counts as landscape', () => {
    expect(orientationFromImage(4032, 3024)).toBe('landscape');
    expect(orientationFromImage(3024, 4032)).toBe('portrait');
    expect(orientationFromImage(2000, 2000)).toBe('landscape');
  });

  it('distances to trim and the safe-area check', () => {
    const g = cardGeometry('landscape');
    expect(distancesToTrim(g, { x: 12, y: 12, w: 50, h: 20 })).toEqual({ left: 8, top: 8, right: 119.8, bottom: 99 });
  });

  it('flags elements closer than the margin', () => {
    const g = cardGeometry('landscape');
    const ok = { name: 'ok', rect: { x: 4 + 8, y: 4 + 8, w: 40, h: 10 } };
    const bad = { name: 'bad', rect: { x: 4 + 5, y: 4 + 20, w: 40, h: 10 } };
    const hard = { name: 'hard', rect: { x: 4 + 3, y: 4 + 20, w: 40, h: 10 } };
    expect(safeViolations(g, [ok, bad, hard]).map((v) => v.name)).toEqual(['bad', 'hard']);
    expect(safeViolations(g, [bad, hard], CARD.safeMinMm).map((v) => v.name)).toEqual(['hard']);
  });

  it('cover crop: fills the box, centres on the focal point, never leaves the picture', () => {
    // 4:3 photo into the 185.8 x 135 page: width-limited, crops a little height.
    const c = coverCrop(4032, 3024, 185.8, 135);
    expect(c.draw.w).toBeCloseTo(185.8, 1);
    expect(c.cropX).toBe(0);
    expect(c.cropY).toBeGreaterThan(0.02);
    expect(c.dpi).toBeGreaterThan(500);
    // A focal point at the top keeps the top: offset 0; at the bottom keeps the bottom.
    expect(coverCrop(4032, 3024, 185.8, 135, { x: 0.5, y: 0 }).draw.y).toBe(0);
    const bottom = coverCrop(4032, 3024, 185.8, 135, { x: 0.5, y: 1 });
    expect(bottom.draw.y + bottom.draw.h).toBeCloseTo(135, 1);
    // A portrait photo on a landscape box crops heavily; the crop fraction says so.
    expect(coverCrop(3024, 4032, 185.8, 135).cropY).toBeGreaterThan(0.4);
  });

  it('fitBoxToImage: whole picture at maxCrop 0, follows the area when more crop is allowed', () => {
    const area = { x: 13, y: 13, w: 155.8, h: 87 };
    const whole = fitBoxToImage(area, 1.5, 0);
    expect(whole.w / whole.h).toBeCloseTo(1.5, 1);
    expect(whole.h).toBeLessThanOrEqual(area.h + 0.01);
    expect(whole.x + whole.w / 2).toBeCloseTo(area.x + area.w / 2, 1);
    const looser = fitBoxToImage(area, 4 / 3, 0.12);
    expect(looser.w / looser.h).toBeCloseTo(4 / 3 / 0.88, 1);
    expect(looser.w).toBeGreaterThan(fitBoxToImage(area, 4 / 3, 0).w);
  });
});

describe('greetings', () => {
  it('has es and en strings for every greeting key', () => {
    expect(greetingText('es', 'christmas')).toBe('Feliz Navidad');
    expect(greetingText('es', 'holidays')).toBe('Felices fiestas');
    expect(greetingText('es', 'new-year')).toBe('Feliz Año Nuevo');
    expect(greetingText('en', 'christmas')).toBe('Merry Christmas');
    expect(greetingText('en', 'holidays')).toBe('Happy Holidays');
    expect(greetingText('en', 'new-year')).toBe('Happy New Year');
    for (const lang of ['es', 'en'] as const) expect(Object.keys(GREETINGS[lang]).sort()).toEqual([...CARD_GREETING_KEYS].sort());
  });
});

describe('text fitting', () => {
  it('wraps greedily within the width and keeps every word', () => {
    const lines = wrapLines(letter(300), FONT, 10, 90, measure);
    for (const line of lines) expect(measure(line, FONT, 10)).toBeLessThanOrEqual(90 + 1e-6);
    expect(lines.join(' ')).toBe(letter(300));
  });

  it('balanced wrap never adds a line and fixes a short last line', () => {
    const text = letter(210);
    const greedy = wrapLines(text, FONT, 11, 80, measure);
    const balanced = wrapBalanced(text, FONT, 11, 80, measure);
    expect(balanced.length).toBeLessThanOrEqual(greedy.length);
    expect(balanced.join(' ')).toBe(text);
    const last = (ls: string[]) => measure(ls[ls.length - 1], FONT, 11);
    expect(last(balanced)).toBeGreaterThanOrEqual(Math.min(last(greedy), 80 * 0.45) - 1e-6);
  });

  it('splits paragraphs on blank lines', () => {
    expect(splitParagraphs('a b\nc\n\nd e\n\n\nf')).toEqual(['a b c', 'd e', 'f']);
  });

  const base = { font: FONT, widthMm: 100, minPt: 9, maxPt: 12, lineHeight: 1.45, paragraphGap: 0.55, measure };

  it('letter auto-fit picks the largest size within [min, max] that fits', () => {
    const roomy = fitLetter({ ...base, text: letter(120), heightMm: 200 });
    expect(roomy.fontPt).toBe(12);
    expect(roomy.fits).toBe(true);
    expect(roomy.cappedByMax).toBe(true);
    const tight = fitLetter({ ...base, text: `${letter(300)}\n\n${letter(300)}`, heightMm: 60 });
    expect(tight.fits).toBe(true);
    expect(tight.fontPt).toBeGreaterThanOrEqual(9);
    expect(tight.fontPt).toBeLessThan(12);
    expect(tight.heightMm).toBeLessThanOrEqual(60);
    // One step larger would not fit (the fit is maximal).
    const bigger = fitLetter({ ...base, text: `${letter(300)}\n\n${letter(300)}`, heightMm: 60, minPt: tight.fontPt + 0.25, maxPt: tight.fontPt + 0.25 });
    expect(bigger.fits).toBe(false);
  });

  it('never shrinks below the readable minimum: reports fits = false at minPt', () => {
    const r = fitLetter({ ...base, text: letter(1500), heightMm: 40 });
    expect(r.fits).toBe(false);
    expect(r.fontPt).toBe(9);
  });
});

describe('card document', () => {
  it('follows the picture orientation and can be overridden', () => {
    expect(buildCardDocument(input(), measure).geometry.orientation).toBe('landscape');
    const portrait = input({ frontImage: { url: '/x', width: 3024, height: 4032 } });
    expect(buildCardDocument(portrait, measure).geometry.orientation).toBe('portrait');
    expect(buildCardDocument(input({ orientation: 'portrait' }), measure).geometry.orientation).toBe('portrait');
  });

  it('every layout x orientation x QR keeps text and QR 8 mm inside the trim and the letter within its bounds', () => {
    for (const layout of ['full-bleed', 'bordered', 'illustrated'] as const) {
      for (const orientation of ['landscape', 'portrait'] as const) {
        for (const qr of [true, false]) {
          const doc = buildCardDocument(input({ frontLayout: layout, orientation, qr: qr ? { url: 'https://m.usemomora.com/f/AAAAAAAAAAAAAAAAAAAAAA' } : null }), measure);
          const label = `${layout}/${orientation}/${qr ? 'qr' : 'noqr'}`;
          expect(doc.safeViolations, label).toEqual([]);
          const fit = doc.back.letter.fit;
          expect(fit.fits, label).toBe(true);
          expect(fit.fontPt, label).toBeGreaterThanOrEqual(CARD_STYLE.letter.minPt);
          expect(fit.fontPt, label).toBeLessThanOrEqual(CARD_STYLE.letter.maxPt);
          expect(doc.back.hasQr, label).toBe(qr);
          expect(doc.back.qr?.rect.w ?? 26, label).toBeGreaterThanOrEqual(22);
          expect(doc.back.qr?.rect.w ?? 26, label).toBeLessThanOrEqual(26);
        }
      }
    }
  });

  it('the QR is 26 mm with the book\'s play badge size and sits inside the safe area; the no-QR back gives the letter more room', () => {
    const withQr = buildCardDocument(input({ letter: letter(560) }), measure);
    const noQr = buildCardDocument(input({ letter: letter(560), qr: null, qrCaption: null }), measure);
    expect(withQr.back.qr?.rect.w).toBe(26);
    expect(noQr.back.qr).toBeNull();
    expect(noQr.back.caption).toBeNull();
    expect(noQr.back.letter.fit.fontPt).toBeGreaterThanOrEqual(withQr.back.letter.fit.fontPt);
  });

  it('reports an overflowing letter instead of shrinking it', () => {
    const doc = buildCardDocument(input({ letter: letter(2600) }), measure);
    expect(doc.back.letter.fit.fits).toBe(false);
    expect(doc.back.letter.fit.fontPt).toBe(CARD_STYLE.letter.minPt);
    expect(doc.warnings.some((w) => w.includes('does not fit'))).toBe(true);
  });

  it('full-bleed covers the whole page (bleed included); bordered keeps the picture inside the trim', () => {
    const full = buildCardDocument(input(), measure);
    expect(full.front.image.clip).toEqual({ x: 0, y: 0, w: 185.8, h: 135 });
    expect(full.front.image.dpi).toBeGreaterThan(300);
    const bordered = buildCardDocument(input({ frontLayout: 'bordered' }), measure);
    const c = bordered.front.image.clip;
    expect(c.x).toBeGreaterThanOrEqual(4 + 8);
    expect(c.y + c.h).toBeLessThan(4 + 127 - 18);
    // 4:3 photo, at most 15% cropped.
    expect(Math.max(bordered.front.image.cropX, bordered.front.image.cropY)).toBeLessThanOrEqual(0.151);
  });

  it('illustrated art is never cropped and its dpi is reported', () => {
    const art = input({ frontLayout: 'illustrated', frontImage: { url: '/x/art.webp', width: 1024, height: 1536 } });
    const doc = buildCardDocument(art, measure);
    expect(doc.geometry.orientation).toBe('portrait');
    expect(doc.front.image.cropX).toBeLessThan(0.01);
    expect(doc.front.image.cropY).toBeLessThan(0.01);
    expect(doc.front.image.dpi).toBeGreaterThan(250);
  });

  it('warns on a low-resolution picture', () => {
    const doc = buildCardDocument(input({ frontImage: { url: '/x', width: 1200, height: 900 } }), measure);
    expect(doc.warnings.some((w) => w.includes('dpi'))).toBe(true);
  });
});

const FOUR = ['a', 'b', 'c', 'd'].map((n) => ({ url: `/x/portrait-${n}.jpg`, name: n, width: 1024, height: 1024 }));

describe('round 2: layout, wordmark, portraits, regions', () => {
  it('bordered landscape photo covers at least 65% of the card (4:3 photo)', () => {
    const doc = buildCardDocument(input({ frontLayout: 'bordered' }), measure);
    const c = doc.front.image.clip;
    expect((c.w * c.h) / (177.8 * 127)).toBeGreaterThanOrEqual(0.65);
    // greeting + year share one line under the photo, 8 mm from the trim at least
    expect(doc.front.greeting.mode).toBe('inline');
    expect(doc.safeViolations).toEqual([]);
  });

  it('the wordmark sits bottom right inside the safe area; there is no "made with" text', () => {
    for (const orientation of ['landscape', 'portrait'] as const) {
      const doc = buildCardDocument(input({ orientation }), measure);
      const d = distancesToTrim(doc.geometry, doc.back.wordmark.rect);
      expect(d.right).toBeGreaterThanOrEqual(CARD.safeMm);
      expect(d.bottom).toBeGreaterThanOrEqual(CARD.safeMm);
      expect(doc.back.wordmark.rect.x).toBeGreaterThan(doc.geometry.pageW / 2);
      expect(doc.back.wordmark.fontPt).toBeGreaterThanOrEqual(7);
      expect(doc.back.wordmark.fontPt).toBeLessThanOrEqual(8);
    }
  });

  it('family portraits: round 11-14 mm, inside the safe area, never overlapping the letter, letter keeps 9-12 pt', () => {
    for (const orientation of ['landscape', 'portrait'] as const) {
      for (const qr of [true, false]) {
        const doc = buildCardDocument(input({ orientation, portraits: FOUR, qr: qr ? { url: 'https://m.usemomora.com/f/AAAAAAAAAAAAAAAAAAAAAA' } : null }), measure);
        const label = `${orientation}/${qr}`;
        expect(doc.back.portraits.length, label).toBe(4);
        for (const p of doc.back.portraits) {
          expect(p.rect.w, label).toBeGreaterThanOrEqual(11);
          expect(p.rect.w, label).toBeLessThanOrEqual(14);
          expect(p.rect.y, label).toBeGreaterThanOrEqual(doc.back.letter.rect.y + doc.back.letter.rect.h - 0.01);
        }
        expect(doc.safeViolations, label).toEqual([]);
        expect(doc.back.letter.fit.fits, label).toBe(true);
        expect(doc.back.letter.fit.fontPt, label).toBeGreaterThanOrEqual(9);
      }
    }
  });

  it('no portraits, empty sign-off and empty caption/subline simply disappear', () => {
    const doc = buildCardDocument(input({ signature: '', subline: '', qrCaption: '' }), measure);
    expect(doc.back.signature).toBeNull();
    expect(doc.back.caption).toBeNull();
    expect(doc.front.greeting.sublineRect).toBeNull();
    expect(doc.regions.some((r) => r.target === 'front.subline')).toBe(false);
    expect(buildCardDocument(input(), measure).back.portraits).toEqual([]);
  });

  it('every text field is an editable region (greeting, year, heading, letter, sign-off, caption)', () => {
    const doc = buildCardDocument(input(), measure);
    expect(doc.regions.map((r) => r.target).sort()).toEqual(['back.heading', 'back.qrCaption', 'back.signature', 'front.greeting', 'front.subline', 'letter']);
    for (const r of doc.regions) expect(r.rect.w).toBeGreaterThan(0);
    // No QR: no caption region.
    expect(buildCardDocument(input({ qr: null, qrCaption: null }), measure).regions.some((r) => r.target === 'back.qrCaption')).toBe(false);
  });

  it('reposition is offered only when the picture is actually cropped (the book gate)', () => {
    // 4:3 photo full-bleed on a 1.376 page: a 3% crop is just past the threshold; a 3:2 photo in a bordered box fits exactly.
    const cropped = buildCardDocument(input({ frontImage: { url: '/x', width: 3000, height: 4000 }, orientation: 'landscape' }), measure);
    expect(cropped.front.image.canReposition).toBe(true);
    const art = buildCardDocument(input({ frontLayout: 'illustrated', frontImage: { url: '/x', width: 1536, height: 1024 } }), measure);
    expect(art.front.image.canReposition).toBe(false);
  });

  it('a focal point moves the crop like CSS object-position (what the reposition modal previews)', () => {
    const top = buildCardDocument(input({ frontImage: { url: '/x', width: 3000, height: 4000, focal: { x: 0.5, y: 0 } }, orientation: 'landscape' }), measure);
    const bottom = buildCardDocument(input({ frontImage: { url: '/x', width: 3000, height: 4000, focal: { x: 0.5, y: 1 } }, orientation: 'landscape' }), measure);
    expect(top.front.image.draw.y).toBe(0);
    expect(bottom.front.image.draw.y + bottom.front.image.draw.h).toBeCloseTo(135, 1);
  });

  it('the portrait back is vertically balanced: the stack is centred above the QR block', () => {
    const doc = buildCardDocument(input({ orientation: 'portrait', letter: letter(150) }), measure);
    const g = doc.geometry;
    const top = doc.back.heading.rect.y - g.trim.y;
    const sig = doc.back.signature!;
    const bottomOfStack = sig.rect.y + sig.rect.h;
    const ruleY = doc.back.blockRule!.y;
    // Space above the heading (from the content top) ~ space below the signature (to the QR block rule).
    const above = top - 14;
    const below = ruleY - bottomOfStack - 6;
    expect(Math.abs(above - below)).toBeLessThan(1.5);
  });
});

describe('signature wrap', () => {
  const sig: FontSpec = { family: 'Caveat', weight: 600, style: 'normal' };
  it('one line when it fits, else after the first comma', () => {
    expect(wrapSignature('Con cariño, la familia Rivera', sig, 17, 500, measure)).toEqual(['Con cariño, la familia Rivera']);
    const narrow = measure('la familia Rivera Soto', sig, 17) + 1;
    expect(wrapSignature('Con cariño, la familia Rivera Soto', sig, 17, narrow, measure)).toEqual(['Con cariño,', 'la familia Rivera Soto']);
    // No comma: balanced words.
    expect(wrapSignature('La familia Rivera Soto os desea', sig, 17, measure('La familia Rivera', sig, 17) + 2, measure).length).toBeGreaterThan(1);
  });
});

describe('edits model', () => {
  it('normalizes tolerantly and applies updates immutably', () => {
    expect(normalizeEdits(null)).toEqual(emptyEdits());
    expect(normalizeEdits({ text: { 'back.heading': 7, 'front.greeting': 'Hola' }, focalPoints: { a: { x: 2, y: -1 }, b: 'x' }, choices: { layout: 'nope', tone: 'short' } })).toMatchObject({
      text: { 'front.greeting': 'Hola' },
      focalPoints: { a: { x: 1, y: 0 } },
      choices: { layout: 'bordered', tone: 'short' },
    });
    const base = emptyEdits();
    const a = setText(base, 'front.greeting', 'Hola');
    expect(base.text).toEqual({});
    expect(resetText(a, 'front.greeting').text).toEqual({});
    expect(setLetter(base, 'classic', 'x').letters).toEqual({ classic: 'x' });
    expect(resetLetter(setLetter(base, 'classic', 'x'), 'classic').letters).toEqual({});
    expect(resetFocal(setFocal(base, 'p', { x: 0.2, y: 0.8 }), 'p').focalPoints).toEqual({});
    expect(hasAnyEdit(base)).toBe(false);
    expect(hasAnyEdit(setFrontImage(base, 'p'))).toBe(true);
  });

  it('a new greeting makes the greeting texts follow it again', () => {
    const edited = setText(setText(setText(emptyEdits(), 'front.greeting', 'X'), 'back.heading', 'Y'), 'back.signature', 'Z');
    const next = changeGreeting(edited, 'holidays');
    expect(next.text).toEqual({ 'back.signature': 'Z' });
    expect(next.choices.greeting).toBe('holidays');
  });
});

describe('card data', () => {
  const data: CardData = {
    version: 1,
    slug: 'sample',
    year: 2026,
    language: 'es',
    locale: 'es-CO',
    greeting: 'christmas',
    familyName: 'Rivera Soto',
    signature: 'Con cariño, la familia Rivera Soto',
    qrCaption: 'Escanea para ver nuestro año',
    qr: { enabled: true, token: 'AAAAAAAAAAAAAAAAAAAAAA', url: 'https://m.usemomora.com/f/AAAAAAAAAAAAAAAAAAAAAA' },
    letters: [
      { tone: 'classic', text: 'Hola "todos".' },
      { tone: 'short', text: 'Corto.' },
    ],
    photo: { mediaId: 'photo-1', file: 'assets/photo-1.jpg', width: 4032, height: 3024, focal: { x: 0.4, y: 0.4 } },
    illustrations: [{ id: 'tree', file: 'assets/illustration-tree.webp', width: 1536, height: 1024 }],
    frontOptions: [
      { id: 'photo-1', kind: 'photo', file: 'assets/photo-1.jpg', width: 4032, height: 3024, date: '2026-06-04', rank: 1 },
      { id: 'photo-2', kind: 'photo', file: 'assets/photo-2.jpg', width: 3000, height: 4000, date: '2026-05-18', rank: 2 },
      { id: 'illustration-tree', kind: 'illustration', file: 'assets/illustration-tree.webp', width: 1536, height: 1024, label: 'tree' },
    ],
    portraits: [{ memberId: 'm1', name: 'Lia', role: 'child', file: 'assets/portrait-m1.jpg', width: 1024, height: 1024 }],
  };
  const url = (f: string) => `/sample/${f}`;

  it('parses and validates card.json', () => {
    expect(parseCardData(data).slug).toBe('sample');
    expect(() => parseCardData({ ...data, version: 2 })).toThrow();
    expect(() => parseCardData({ ...data, letters: [] })).toThrow();
  });

  it('builds the input from data + edits (greeting, tone, QR, text overrides, chosen picture, focal)', () => {
    const base = emptyEdits();
    const a = cardInputFromData(data, setChoices(setChoices(base, { tone: 'short' }), { greeting: 'new-year' }), url);
    expect(a.greeting).toBe('Feliz Año Nuevo');
    expect(a.backHeading).toBe('Feliz Año Nuevo');
    expect(a.subline).toBe('2026');
    expect(a.letter).toBe('Corto.');
    expect(a.frontImage).toMatchObject({ url: '/sample/assets/photo-1.jpg', focal: { x: 0.4, y: 0.4 } });
    expect(a.portraits).toHaveLength(1);
    expect(a.qr?.url).toContain('/f/');
    // Text overrides win; the edited letter replaces the generated one for its tone only.
    const edited = setLetter(setText(setText(base, 'back.signature', 'Los Rivera'), 'back.qrCaption', 'Mira'), 'classic', 'Mi carta');
    const b = cardInputFromData(data, edited, url);
    expect(b.signature).toBe('Los Rivera');
    expect(b.qrCaption).toBe('Mira');
    expect(b.letter).toBe('Mi carta');
    expect(cardInputFromData(data, setChoices(edited, { tone: 'short' }), url).letter).toBe('Corto.');
    // QR off drops the caption; portraits can be turned off.
    const c = cardInputFromData(data, setChoices(setChoices(base, { qr: false }), { portraits: false }), url);
    expect(c.qr).toBeNull();
    expect(c.qrCaption).toBeNull();
    expect(c.portraits).toEqual([]);
  });

  it('an illustration as the chosen picture gives the band layout; a photo follows the Layout choice; focal per picture', () => {
    expect(resolveFront(data, setChoices(emptyEdits(), { layout: 'full-bleed' }))).toMatchObject({ layout: 'full-bleed' });
    expect(resolveFront(data, setFrontImage(emptyEdits(), 'illustration-tree'))).toMatchObject({ layout: 'illustrated' });
    const portraitPhoto = cardInputFromData(data, setFrontImage(emptyEdits(), 'photo-2'), url);
    expect(portraitPhoto.frontImage).toMatchObject({ url: '/sample/assets/photo-2.jpg', focal: null });
    expect(buildCardDocument(portraitPhoto, measure).geometry.orientation).toBe('portrait');
    const withFocal = cardInputFromData(data, setFocal(setFrontImage(emptyEdits(), 'photo-2'), 'photo-2', { x: 0.3, y: 0.9 }), url);
    expect(withFocal.frontImage.focal).toEqual({ x: 0.3, y: 0.9 });
    // Unknown picture id falls back to the card's own photo.
    expect(resolveFront(data, setFrontImage(emptyEdits(), 'gone')).option.id).toBe('photo-1');
    expect(frontOptionsOf({ ...data, frontOptions: [] })).toHaveLength(2); // legacy fallback: photo + illustration
    expect(defaultFrontId(data)).toBe('photo-1');
  });

  it('typographic quotes, and no period right after a closing quote that ended the sentence', () => {
    expect(typographic('dijo "hola" y l\'amie')).toBe('dijo \u201Chola\u201D y l\u2019amie');
    expect(typographic('Dijo: "es un lugar mágico!". Lucía')).toBe('Dijo: \u201Ces un lugar mágico!\u201D Lucía');
    expect(typographic('Dijo "sí?". Y "no."." ok')).toContain('\u201Csí?\u201D Y');
    expect(typographic('Dijo "sí". Fin.')).toBe('Dijo \u201Csí\u201D. Fin.');
  });
});

describe('card formats (Gelato: 5R in US/CA, A5 in Europe)', () => {
  it('A5 is 210 x 148 mm trim + 4 mm bleed in both orientations; 5R stays the default', () => {
    expect(cardGeometry('landscape', 'A5')).toMatchObject({ format: 'A5', trimW: 210, trimH: 148, pageW: 218, pageH: 156 });
    expect(cardGeometry('portrait', 'A5')).toMatchObject({ trimW: 148, trimH: 210, pageW: 156, pageH: 218 });
    expect(cardGeometry('landscape')).toMatchObject({ format: '5R', trimW: 177.8, trimH: 127 });
  });
});
