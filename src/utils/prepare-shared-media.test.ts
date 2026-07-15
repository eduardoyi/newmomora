import type { ResolvedSharePayload } from 'expo-sharing';

import { prepareSharedMedia } from './prepare-shared-media';

function payload(overrides: Partial<ResolvedSharePayload> = {}): ResolvedSharePayload {
  return {
    value: 'file:///photo.jpg',
    shareType: 'image',
    mimeType: 'image/jpeg',
    contentUri: 'file:///photo.jpg',
    contentType: 'image',
    contentMimeType: 'image/jpeg',
    originalName: 'photo.jpg',
    contentSize: 1024,
    ...overrides,
  } as ResolvedSharePayload;
}

const dependencies = {
  createId: jest.fn(() => 'asset-id'),
  getVideoDurationMs: jest.fn(async () => 30_000),
};

beforeEach(() => jest.clearAllMocks());

it('converts shared photos and videos into composer attachments', async () => {
  const result = await prepareSharedMedia([
    payload(),
    payload({
      value: 'file:///clip.mov',
      shareType: 'video',
      mimeType: 'video/quicktime',
      contentUri: 'file:///clip.mov',
      contentType: 'video',
      contentMimeType: 'video/quicktime',
    }),
  ], dependencies);

  expect(result.errorMessage).toBeNull();
  expect(result.attachments).toHaveLength(2);
  expect(result.attachments[1]).toMatchObject({
    uri: 'file:///clip.mov',
    contentType: 'video/quicktime',
    durationMs: 30_000,
  });
});

it('rejects a shared video longer than 3 minutes', async () => {
  dependencies.getVideoDurationMs.mockResolvedValueOnce(180_001);

  const result = await prepareSharedMedia([
    payload({
      shareType: 'video',
      mimeType: 'video/mp4',
      contentType: 'video',
      contentMimeType: 'video/mp4',
    }),
  ], dependencies);

  expect(result).toEqual({ attachments: [], errorMessage: 'Videos must be 3 minutes or shorter.' });
});

it('accepts a shared video source file well over the old 100MB pick-time cap (share-sheet intake shares media-validation constants)', async () => {
  const result = await prepareSharedMedia([
    payload({
      shareType: 'video',
      mimeType: 'video/mp4',
      contentType: 'video',
      contentMimeType: 'video/mp4',
      contentSize: 150 * 1024 * 1024,
    }),
  ], dependencies);

  expect(result.errorMessage).toBeNull();
  expect(result.attachments).toHaveLength(1);
});

it('keeps the first 10 supported items and explains the limit', async () => {
  const result = await prepareSharedMedia(Array.from({ length: 11 }, () => payload()), dependencies);

  expect(result.attachments).toHaveLength(10);
  expect(result.errorMessage).toContain('first 10 items');
});

it('rejects shares without photos or videos', async () => {
  const result = await prepareSharedMedia([
    payload({ shareType: 'text', contentType: 'text', contentUri: null }),
  ], dependencies);

  expect(result.attachments).toEqual([]);
  expect(result.errorMessage).toBe('Momora can only attach shared photos and videos.');
});
