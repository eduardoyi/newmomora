import type { CardInput } from './document';
import type { CardChoices, CardEdits } from './edits';
import { emptyEdits } from './edits';
import { greetingText } from './greetings';
import type { CardData, CardLayout, FrontOption } from './types';

/** Resolves a card.json asset path to a URL (preview: dev server, print: local server). */
export type AssetUrlFn = (file: string) => string;

/** Straight quotes and apostrophes to typographic ones; no period right after a closing quote that already ends a sentence. */
export function typographic(text: string): string {
  return text
    .replace(/"([^"\n]*)"/g, '“$1”')
    .replace(/(\p{L})'(\p{L})/gu, '$1’$2')
    .replace(/'([^'\n]*)'/g, '‘$1’')
    // "…mágico!”." → "…mágico!”": the quote already closed the sentence.
    .replace(/([!?.])(”|»|’)\./g, '$1$2');
}

export function letterFor(data: CardData, tone: string, edits?: CardEdits): string {
  const edited = edits?.letters[tone];
  if (edited !== undefined) return edited;
  return (data.letters.find((l) => l.tone === tone) ?? data.letters[0]).text;
}

/** The picker's candidates; older card.json files (no `frontOptions`) fall back to the card's own photo + illustrations. */
export function frontOptionsOf(data: CardData): FrontOption[] {
  if (data.frontOptions && data.frontOptions.length > 0) return data.frontOptions;
  return [
    { id: data.photo.mediaId ?? 'photo', kind: 'photo', file: data.photo.file, width: data.photo.width, height: data.photo.height },
    ...data.illustrations.map((i) => ({ id: `illustration-${i.id}`, kind: 'illustration' as const, file: i.file, width: i.width, height: i.height, label: i.id })),
  ];
}

/** The card's own photo id (the default front). */
export function defaultFrontId(data: CardData): string {
  return data.photo.mediaId ?? 'photo';
}

export interface ResolvedFront {
  option: FrontOption;
  layout: CardLayout;
}

/** The chosen front picture and its layout: an illustration always gets the band layout, a photo follows the Layout choice. */
export function resolveFront(data: CardData, edits: CardEdits): ResolvedFront {
  const options = frontOptionsOf(data);
  const id = edits.frontImage ?? defaultFrontId(data);
  const option = options.find((o) => o.id === id) ?? options.find((o) => o.id === defaultFrontId(data)) ?? options[0];
  return { option, layout: option.kind === 'illustration' ? 'illustrated' : edits.choices.layout };
}

export function cardInputFromData(data: CardData, edits: CardEdits | undefined, assetUrl: AssetUrlFn): CardInput {
  const e = edits ?? emptyEdits();
  const choices: CardChoices = e.choices;
  const greetingKey = choices.greeting ?? data.greeting;
  const greeting = greetingText(data.language, greetingKey);
  const { option, layout } = resolveFront(data, e);
  const savedFocal = e.focalPoints[option.id] ?? (option.id === defaultFrontId(data) ? data.photo.focal : undefined) ?? null;
  const qrEnabled = choices.qr ?? data.qr.enabled;
  const showPortraits = choices.portraits ?? true;
  return {
    orientation: choices.orientation ?? null,
    format: data.format ?? '5R',
    frontLayout: layout,
    frontImage: { url: assetUrl(option.file), width: option.width, height: option.height, focal: savedFocal },
    imageId: option.id,
    // The card's saved position was chosen for its own photo; another picture starts at the default.
    greetingPosition: choices.greetingPosition ?? (option.id === defaultFrontId(data) ? data.photo.greetingPosition : undefined) ?? 'bottom-left',
    greeting: e.text['front.greeting'] ?? greeting,
    subline: e.text['front.subline'] ?? String(data.year),
    backHeading: e.text['back.heading'] ?? greeting,
    letter: typographic(letterFor(data, choices.tone, e)),
    signature: e.text['back.signature'] ?? data.signature,
    qr: qrEnabled ? { url: data.qr.url } : null,
    qrCaption: qrEnabled ? (e.text['back.qrCaption'] ?? data.qrCaption) : null,
    portraits: showPortraits ? (data.portraits ?? []).map((p) => ({ url: assetUrl(p.file), name: p.name, width: p.width, height: p.height })) : [],
  };
}
