import { describe, expect, it } from 'vitest';
import { fictionalView } from '../../card/__tests__/helpers';
import { cardTilePreview } from '../cardPreview';
import { firstSignedKey, MAX_THUMBNAIL_CANDIDATES, pickListThumbnailCandidates } from '../thumbnail';

// Fictional keys only (the repo is public).
const doc = (coverCandidates: string[], memories: Record<string, string[]>) => ({
  outline: { coverCandidates },
  manifest: { memories: Object.fromEntries(Object.entries(memories).map(([id, files]) => [id, { assets: files.map((file) => ({ file })) }])) },
});

describe('book tile cover candidates', () => {
  it('puts the denormalized cover first, then the cover candidates\' photos, then other memories', () => {
    const keys = pickListThumbnailCandidates({ cover_asset_key: 'k/cover.jpg', book_document: doc(['m2'], { m1: ['k/a.jpg'], m2: ['k/b.jpg', 'k/c.jpg'] }) });
    expect(keys).toEqual(['k/cover.jpg', 'k/b.jpg', 'k/c.jpg', 'k/a.jpg']);
  });
  it('works with only one source, de-duplicates, and caps the list', () => {
    expect(pickListThumbnailCandidates({ cover_asset_key: 'k/cover.jpg', book_document: null })).toEqual(['k/cover.jpg']);
    expect(pickListThumbnailCandidates({ book_document: doc(['m1'], { m1: ['k/a.jpg'] }) })).toEqual(['k/a.jpg']);
    expect(pickListThumbnailCandidates({ cover_asset_key: 'k/a.jpg', book_document: doc(['m1'], { m1: ['k/a.jpg'] }) })).toEqual(['k/a.jpg']);
    const many = doc([], Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`m${i}`, [`k/${i}.jpg`]])));
    expect(pickListThumbnailCandidates({ book_document: many })).toHaveLength(MAX_THUMBNAIL_CANDIDATES);
    expect(pickListThumbnailCandidates({ book_document: null })).toEqual([]);
  });
  it('never offers a video or HEIC as a picture', () => {
    expect(pickListThumbnailCandidates({ cover_asset_key: 'k/clip.MP4', book_document: doc(['m1'], { m1: ['k/live.mov', 'k/photo.heic', 'k/ok.jpg'] }) })).toEqual(['k/ok.jpg']);
  });
  it('uses the first candidate the signer actually signed (it silently omits keys it cannot authorize)', () => {
    const urls = new Map([['k/b.jpg', 'https://cdn.example.test/b']]);
    expect(firstSignedKey(['k/cover.jpg', 'k/b.jpg'], urls)).toBe('k/b.jpg');
    expect(firstSignedKey(['k/cover.jpg'], urls)).toBeNull();
    expect(firstSignedKey([], urls)).toBeNull();
  });
});

describe('holiday card tile preview', () => {
  const candidates = [
    { mediaId: 'media-2', rank: 2, width: 3024, height: 4032, previewUrl: 'https://cdn.example.test/p2' },
    { mediaId: 'media-1', rank: 1, width: 4032, height: 3024, previewUrl: 'https://cdn.example.test/p1' },
  ];
  it('uses the card\'s own photo\'s small preview, with the greeting', () => {
    const p = cardTilePreview(fictionalView({ frontCandidates: candidates }));
    expect(p).toMatchObject({ url: 'https://cdn.example.test/p1', orientation: 'landscape', width: 4032, height: 3024, greeting: 'Merry Christmas' });
  });
  it('follows a picked front (portrait → 5:7), preferring its preview over the original', () => {
    const base = fictionalView({ frontCandidates: candidates });
    const view = { ...base, card: { ...base.card, edits: { ...base.card.edits, frontImage: 'media-2' } } };
    expect(cardTilePreview(view)).toMatchObject({ url: 'https://cdn.example.test/p2', orientation: 'portrait' });
  });
  it('a saved front that is not a candidate uses frontImage.previewUrl', () => {
    const base = fictionalView({ frontCandidates: candidates, frontImage: { mediaId: 'media-9', previewUrl: 'https://cdn.example.test/p9' } });
    const view = { ...base, card: { ...base.card, edits: { ...base.card.edits, frontImage: 'media-9' } } };
    expect(cardTilePreview(view)?.url).toBe('https://cdn.example.test/p9');
  });
  it('falls back to the editor view\'s signed original only when no preview exists, and to null with nothing', () => {
    const noPreview = fictionalView({ frontCandidates: candidates.map((c) => ({ ...c, previewUrl: null })) });
    expect(cardTilePreview(noPreview)?.url).toContain('front-1.jpg');
    expect(cardTilePreview(fictionalView({ frontCandidates: [] }, null))).toBeNull();
  });
  it('shows an edited greeting', () => {
    const base = fictionalView({ frontCandidates: candidates });
    const view = { ...base, card: { ...base.card, edits: { ...base.card.edits, text: { 'front.greeting': 'Happy everything' } } } };
    expect(cardTilePreview(view)?.greeting).toBe('Happy everything');
  });
});
