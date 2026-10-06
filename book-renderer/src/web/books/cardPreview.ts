import { greetingText } from '../../card/greetings';
import type { HolidayCardView } from '../card/cardTypes';

/**
 * What the home page's holiday card tile shows: the card's front photo (a small
 * signed preview, never the multi-MB original when a preview exists) with its
 * greeting under it, like a little card. Pure, from the `holiday-cards get` view.
 */
export interface CardTilePreview {
  url: string;
  /** Pixel size when known (sets the tile's aspect: 7:5 landscape, 5:7 portrait). */
  width: number | null;
  height: number | null;
  orientation: 'landscape' | 'portrait';
  greeting: string;
}

export function cardTilePreview(view: HolidayCardView): CardTilePreview | null {
  const editor = view.editorView;
  const data = editor?.cardData ?? null;
  // The chosen front: an explicit pick, else the card's own photo, else the top-ranked candidate.
  const ranked = [...view.frontCandidates].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const chosenId = view.card.edits.frontImage ?? data?.photo.mediaId ?? ranked[0]?.mediaId ?? null;
  if (!chosenId) return null;

  const candidate = view.frontCandidates.find((c) => c.mediaId === chosenId) ?? null;
  const option = data?.frontOptions?.find((o) => o.id === chosenId) ?? null;
  const previewUrl = candidate?.previewUrl ?? (view.frontImage?.mediaId === chosenId ? view.frontImage.previewUrl : null);
  // Only when no small preview exists: the editor view's signed original (an ordered card's frozen front).
  const originalUrl = option && editor ? (editor.assets[option.file] ?? null) : null;
  const url = previewUrl ?? originalUrl;
  if (!url) return null;

  const width = candidate?.width ?? option?.width ?? null;
  const height = candidate?.height ?? option?.height ?? null;
  const orientation = width !== null && height !== null && height > width ? 'portrait' : 'landscape';
  const greetingKey = editor?.edits.choices.greeting ?? view.card.greeting;
  const greeting = view.card.edits.text['front.greeting'] ?? greetingText(view.card.language, greetingKey);
  return { url, width, height, orientation, greeting };
}
