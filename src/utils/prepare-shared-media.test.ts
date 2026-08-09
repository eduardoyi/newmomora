import type { ResolvedSharePayload } from 'expo-sharing';

import {
  DUPLICATE_SHARED_MEDIA_URI_ERROR,
  prepareSharedMedia,
  type PrepareSharedMediaDependencies,
  UNREADABLE_SHARED_MEDIA_COPY_ERROR,
} from './prepare-shared-media';

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

const dependencies: jest.Mocked<PrepareSharedMediaDependencies> = {
  createId: jest.fn(() => 'asset-id'),
  getLocalFileSizeBytes: jest.fn(async () => 1024),
  getVideoDurationMs: jest.fn(async () => 30_000),
  getImageCaptureDateIso: jest.fn(async () => null),
  getVideoCaptureDateIso: jest.fn(async () => null),
};

beforeEach(() => {
  jest.resetAllMocks();
  dependencies.createId.mockReturnValue('asset-id');
  dependencies.getLocalFileSizeBytes.mockResolvedValue(1024);
  dependencies.getVideoDurationMs.mockResolvedValue(30_000);
  dependencies.getImageCaptureDateIso.mockResolvedValue(null);
  dependencies.getVideoCaptureDateIso.mockResolvedValue(null);
});

afterEach(() => jest.useRealTimers());

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
  expect(dependencies.getImageCaptureDateIso).toHaveBeenCalledWith('file:///photo.jpg');
  expect(dependencies.getVideoCaptureDateIso).toHaveBeenCalledWith('file:///clip.mov');
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
  dependencies.getLocalFileSizeBytes.mockResolvedValueOnce(150 * 1024 * 1024);
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

it('rejects a missing or partially copied cache file before metadata probing', async () => {
  dependencies.getLocalFileSizeBytes.mockResolvedValueOnce(null);

  await expect(prepareSharedMedia([payload()], dependencies)).resolves.toEqual({
    attachments: [],
    errorMessage: UNREADABLE_SHARED_MEDIA_COPY_ERROR,
  });
  expect(dependencies.getImageCaptureDateIso).not.toHaveBeenCalled();

  dependencies.getLocalFileSizeBytes.mockResolvedValueOnce(512);
  await expect(prepareSharedMedia([payload()], dependencies)).resolves.toEqual({
    attachments: [],
    errorMessage: UNREADABLE_SHARED_MEDIA_COPY_ERROR,
  });
  expect(dependencies.getImageCaptureDateIso).not.toHaveBeenCalled();

  dependencies.getLocalFileSizeBytes.mockRejectedValueOnce(new Error('stat failed'));
  await expect(prepareSharedMedia([payload()], dependencies)).resolves.toEqual({
    attachments: [],
    errorMessage: UNREADABLE_SHARED_MEDIA_COPY_ERROR,
  });
  expect(dependencies.getImageCaptureDateIso).not.toHaveBeenCalled();
});

it('keeps the first 10 supported items and explains the limit', async () => {
  const result = await prepareSharedMedia(
    Array.from({ length: 11 }, (_, index) => payload({
      contentUri: `file:///photo-${index}.jpg`,
      value: `file:///photo-${index}.jpg`,
    })),
    dependencies,
  );

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

it('uses the matching extractor and adds its derived ISO date to each attachment', async () => {
  dependencies.getImageCaptureDateIso.mockResolvedValueOnce('2024-03-05');
  dependencies.getVideoCaptureDateIso.mockResolvedValueOnce('2024-03-04');

  const result = await prepareSharedMedia([
    payload(),
    payload({
      contentUri: 'file:///clip.mp4',
      value: 'file:///clip.mp4',
      contentType: 'video',
      contentMimeType: 'video/mp4',
      mimeType: 'video/mp4',
    }),
  ], dependencies);

  expect(result.errorMessage).toBeNull();
  expect(result.attachments).toEqual([
    expect.objectContaining({ uri: 'file:///photo.jpg', capturedAtIso: '2024-03-05' }),
    expect.objectContaining({ uri: 'file:///clip.mp4', capturedAtIso: '2024-03-04' }),
  ]);
});

it('starts a video duration probe and optional date probe together', async () => {
  let resolveDuration: ((value: number | null) => void) | null = null;
  dependencies.getVideoDurationMs.mockImplementationOnce(() => new Promise((resolve) => {
    resolveDuration = resolve;
  }));
  const sharedVideo = payload({
    contentUri: 'file:///clip.mp4',
    value: 'file:///clip.mp4',
    contentType: 'video',
    contentMimeType: 'video/mp4',
    mimeType: 'video/mp4',
  });

  const resultPromise = prepareSharedMedia([sharedVideo], dependencies);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(dependencies.getVideoDurationMs).toHaveBeenCalledWith('file:///clip.mp4');
  expect(dependencies.getVideoCaptureDateIso).toHaveBeenCalledWith('file:///clip.mp4');

  resolveDuration?.(30_000);
  await expect(resultPromise).resolves.toMatchObject({ errorMessage: null, attachments: [{}] });
});

it('fails open when an optional extractor returns null or rejects', async () => {
  dependencies.getImageCaptureDateIso.mockResolvedValueOnce(null);
  dependencies.getVideoCaptureDateIso.mockRejectedValueOnce(new Error('unreadable'));

  const result = await prepareSharedMedia([
    payload(),
    payload({
      contentUri: 'file:///clip.mp4',
      value: 'file:///clip.mp4',
      contentType: 'video',
      contentMimeType: 'video/mp4',
      mimeType: 'video/mp4',
    }),
  ], dependencies);

  expect(result).toMatchObject({ errorMessage: null, attachments: [{}, {}] });
  expect(result.attachments[0].capturedAtIso).toBeUndefined();
  expect(result.attachments[1].capturedAtIso).toBeUndefined();
});

it('preflights cheap validation before starting duration or metadata work', async () => {
  const result = await prepareSharedMedia([
    payload({ contentMimeType: 'application/pdf', mimeType: 'application/pdf' }),
    payload({
      contentUri: 'file:///clip.mp4',
      value: 'file:///clip.mp4',
      contentType: 'video',
      contentMimeType: 'video/mp4',
      mimeType: 'video/mp4',
    }),
  ], dependencies);

  expect(result).toEqual({
    attachments: [],
    errorMessage: 'Unsupported file type. Use JPEG, PNG, HEIC, WEBP, MP4, or MOV.',
  });
  expect(dependencies.getVideoDurationMs).not.toHaveBeenCalled();
  expect(dependencies.getLocalFileSizeBytes).not.toHaveBeenCalled();
  expect(dependencies.getImageCaptureDateIso).not.toHaveBeenCalled();
  expect(dependencies.getVideoCaptureDateIso).not.toHaveBeenCalled();
});

it('rejects duplicate content URIs in the selected first ten before any probe starts', async () => {
  const result = await prepareSharedMedia([
    payload(),
    payload(),
  ], dependencies);

  expect(result).toEqual({ attachments: [], errorMessage: DUPLICATE_SHARED_MEDIA_URI_ERROR });
  expect(dependencies.getVideoDurationMs).not.toHaveBeenCalled();
  expect(dependencies.getLocalFileSizeBytes).not.toHaveBeenCalled();
  expect(dependencies.getImageCaptureDateIso).not.toHaveBeenCalled();
  expect(dependencies.getVideoCaptureDateIso).not.toHaveBeenCalled();
});

it('ignores a duplicate URI outside the selected first ten', async () => {
  const payloads = Array.from({ length: 10 }, (_, index) => payload({
    contentUri: `file:///photo-${index}.jpg`,
    value: `file:///photo-${index}.jpg`,
  }));
  payloads.push(payload({ contentUri: 'file:///photo-0.jpg', value: 'file:///photo-0.jpg' }));

  const result = await prepareSharedMedia(payloads, dependencies);

  expect(result.attachments).toHaveLength(10);
  expect(result.errorMessage).toContain('first 10 items');
});

it('uses at most three workers and returns results in payload order', async () => {
  let activeCount = 0;
  let highestActiveCount = 0;
  const resolveDates: ((value: string) => void)[] = [];
  dependencies.getImageCaptureDateIso.mockImplementation(() => new Promise((resolve) => {
    activeCount += 1;
    highestActiveCount = Math.max(highestActiveCount, activeCount);
    resolveDates.push((value) => {
      activeCount -= 1;
      resolve(value);
    });
  }));
  const payloads = Array.from({ length: 5 }, (_, index) => payload({
    contentUri: `file:///photo-${index}.jpg`,
    value: `file:///photo-${index}.jpg`,
  }));

  const resultPromise = prepareSharedMedia(payloads, dependencies);
  await Promise.resolve();
  await Promise.resolve();
  expect(resolveDates).toHaveLength(3);
  expect(highestActiveCount).toBe(3);

  while (resolveDates.length > 0) {
    resolveDates.shift()?.('2024-03-05');
    await Promise.resolve();
    await Promise.resolve();
  }

  const result = await resultPromise;
  expect(highestActiveCount).toBe(3);
  expect(result.attachments.map((attachment) => attachment.uri)).toEqual(
    payloads.map((item) => item.contentUri),
  );
});

it('returns the first validation error in payload order and stops scheduling after a known failure', async () => {
  const durationResolvers: ((value: number | null) => void)[] = [];
  dependencies.getVideoDurationMs.mockImplementation(() => new Promise((resolve) => {
    durationResolvers.push(resolve);
  }));
  const payloads = Array.from({ length: 5 }, (_, index) => payload({
    contentUri: `file:///clip-${index}.mp4`,
    value: `file:///clip-${index}.mp4`,
    contentType: 'video',
    contentMimeType: 'video/mp4',
    mimeType: 'video/mp4',
  }));

  const resultPromise = prepareSharedMedia(payloads, dependencies);
  await Promise.resolve();
  await Promise.resolve();
  expect(durationResolvers).toHaveLength(3);

  durationResolvers[1](180_001);
  await Promise.resolve();
  await Promise.resolve();
  durationResolvers[0](0);
  durationResolvers[2](30_000);

  const result = await resultPromise;
  expect(result).toEqual({
    attachments: [],
    errorMessage: 'Could not read video duration. Try another clip.',
  });
  expect(dependencies.getVideoDurationMs).toHaveBeenCalledTimes(3);
});

it('uses one absolute 750ms metadata deadline rather than one per worker wave', async () => {
  jest.useFakeTimers();
  const lateDate = new Promise<string | null>(() => undefined);
  dependencies.getImageCaptureDateIso.mockImplementation(() => lateDate);
  const payloads = Array.from({ length: 10 }, (_, index) => payload({
    contentUri: `file:///photo-${index}.jpg`,
    value: `file:///photo-${index}.jpg`,
  }));

  const resultPromise = prepareSharedMedia(payloads, dependencies);
  await Promise.resolve();
  await Promise.resolve();
  expect(dependencies.getImageCaptureDateIso).toHaveBeenCalledTimes(3);

  await jest.advanceTimersByTimeAsync(750);
  const result = await resultPromise;

  expect(result).toMatchObject({ errorMessage: null, attachments: Array(10).fill({}) });
  expect(result.attachments.every((attachment) => attachment.capturedAtIso === undefined)).toBe(true);
  expect(dependencies.getImageCaptureDateIso).toHaveBeenCalledTimes(3);
  jest.useRealTimers();
});

it('does not apply a capture-date result that resolves after the deadline', async () => {
  jest.useFakeTimers();
  let resolveDate: ((value: string | null) => void) | null = null;
  dependencies.getImageCaptureDateIso.mockImplementation(() => new Promise((resolve) => {
    resolveDate = resolve;
  }));

  const resultPromise = prepareSharedMedia([payload()], dependencies);
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(750);
  const result = await resultPromise;
  resolveDate?.('2024-03-05');
  await Promise.resolve();

  expect(result.attachments[0].capturedAtIso).toBeUndefined();
  jest.useRealTimers();
});

it('discards a late date result even when its microtask runs before an overdue timeout callback', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(0));
  let resolveDate: ((value: string | null) => void) | null = null;
  dependencies.getImageCaptureDateIso.mockImplementation(() => new Promise((resolve) => {
    resolveDate = resolve;
  }));

  const resultPromise = prepareSharedMedia([payload()], dependencies);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Move the wall clock past the batch deadline without advancing fake
  // timers, then resolve the native read. This makes its promise microtask
  // run before the still-pending timeout callback.
  jest.setSystemTime(new Date(751));
  resolveDate?.('2024-03-05');

  const result = await resultPromise;
  expect(result.attachments[0].capturedAtIso).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});
