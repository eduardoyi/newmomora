import type { ResolvedSharePayload } from 'expo-sharing';

import {
  DUPLICATE_SHARED_MEDIA_URI_ERROR,
  MIXED_SHARED_AUDIO_ERROR,
  prepareSharedMedia as prepareAnySharedPayloads,
  type PreparedSharedMedia,
  type PrepareSharedMediaDependencies,
  UNREADABLE_SHARED_MEDIA_COPY_ERROR,
  unattachedSharedPayloadUris,
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

// The photo/video tests below only ever expect a media result; narrow it once
// here so each assertion keeps reading `result.attachments`.
async function prepareSharedMedia(
  payloads: ResolvedSharePayload[],
  deps: PrepareSharedMediaDependencies,
): Promise<PreparedSharedMedia> {
  const result = await prepareAnySharedPayloads(payloads, deps);
  if (result.kind !== 'media') {
    throw new Error(`Expected a media result, got ${result.kind}`);
  }
  return result;
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

  expect(result).toEqual({ kind: 'media', attachments: [], errorMessage: 'Videos must be 3 minutes or shorter.' });
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
    kind: 'media',
    attachments: [],
    errorMessage: UNREADABLE_SHARED_MEDIA_COPY_ERROR,
  });
  expect(dependencies.getImageCaptureDateIso).not.toHaveBeenCalled();

  dependencies.getLocalFileSizeBytes.mockResolvedValueOnce(512);
  await expect(prepareSharedMedia([payload()], dependencies)).resolves.toEqual({
    kind: 'media',
    attachments: [],
    errorMessage: UNREADABLE_SHARED_MEDIA_COPY_ERROR,
  });
  expect(dependencies.getImageCaptureDateIso).not.toHaveBeenCalled();

  dependencies.getLocalFileSizeBytes.mockRejectedValueOnce(new Error('stat failed'));
  await expect(prepareSharedMedia([payload()], dependencies)).resolves.toEqual({
    kind: 'media',
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
    kind: 'media',
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

  expect(result).toEqual({ kind: 'media', attachments: [], errorMessage: DUPLICATE_SHARED_MEDIA_URI_ERROR });
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
    kind: 'media',
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

describe('shared voice notes', () => {
  function audioPayload(overrides: Partial<ResolvedSharePayload> = {}): ResolvedSharePayload {
    return payload({
      value: 'file:///shared/AUDIO-2026-10-10-15-31-04.m4a',
      shareType: 'audio',
      mimeType: 'audio/mp4',
      contentUri: 'file:///shared/AUDIO-2026-10-10-15-31-04.m4a',
      contentType: 'audio',
      contentMimeType: 'audio/mp4',
      originalName: 'AUDIO-2026-10-10-15-31-04.m4a',
      contentSize: 240_000,
      ...overrides,
    });
  }

  it('returns an audio result for a payload routed as audio', async () => {
    const result = await prepareAnySharedPayloads([audioPayload()], dependencies);

    expect(result).toEqual({
      kind: 'audio',
      uri: 'file:///shared/AUDIO-2026-10-10-15-31-04.m4a',
      mimeType: 'audio/mp4',
      fileName: 'AUDIO-2026-10-10-15-31-04.m4a',
      sizeBytes: 240_000,
    });
    expect(dependencies.getLocalFileSizeBytes).not.toHaveBeenCalled();
  });

  it.each([
    ['an Android application/ogg file', { contentType: 'file', contentMimeType: 'application/ogg', originalName: 'PTT-20261010-WA0007.opus' }],
    ['an iOS opus with a dynamic UTI', { contentType: 'file', contentMimeType: 'application/octet-stream', mimeType: 'application/octet-stream', originalName: 'voice.opus' }],
    ['a file with an audio mime type and no extension', { contentType: 'file', contentMimeType: 'audio/x-whatever', originalName: 'voice' }],
    ['a file recognised only by its uri extension', { contentType: 'file', contentMimeType: null, mimeType: undefined, originalName: null, contentUri: 'file:///cache/My%20Note.AMR?x=1', value: 'file:///cache/My%20Note.AMR' }],
  ] as const)('classifies %s as audio', async (_label, overrides) => {
    const result = await prepareAnySharedPayloads(
      [audioPayload(overrides as unknown as Partial<ResolvedSharePayload>)],
      dependencies,
    );

    expect(result.kind).toBe('audio');
  });

  it.each(['opus', 'ogg', 'oga', 'm4a', 'mp3', 'wav', 'caf', 'amr', 'aac', 'aiff'])(
    'allow-lists the .%s extension for generic file payloads',
    async (extension) => {
      const result = await prepareAnySharedPayloads(
        [audioPayload({
          contentType: 'file',
          contentMimeType: 'application/octet-stream',
          originalName: `note.${extension}`,
        } as Partial<ResolvedSharePayload>)],
        dependencies,
      );

      expect(result.kind).toBe('audio');
    },
  );

  it('uses the last path component when the platform gives no original name', async () => {
    const result = await prepareAnySharedPayloads(
      [audioPayload({ originalName: null, contentUri: 'file:///cache/Voice%20Note.m4a' })],
      dependencies,
    );

    expect(result).toMatchObject({ kind: 'audio', fileName: 'Voice Note.m4a' });
  });

  it('reports a missing size as null', async () => {
    const result = await prepareAnySharedPayloads([audioPayload({ contentSize: null })], dependencies);

    expect(result).toMatchObject({ kind: 'audio', sizeBytes: null });
  });

  it('does not treat other generic files (PDF, zip) as audio', async () => {
    const result = await prepareAnySharedPayloads(
      [audioPayload({
        contentType: 'file',
        contentMimeType: 'application/pdf',
        originalName: 'report.pdf',
      } as Partial<ResolvedSharePayload>)],
      dependencies,
    );

    expect(result).toEqual({
      kind: 'media',
      attachments: [],
      errorMessage: 'Momora can only attach shared photos and videos.',
    });
  });

  it('refuses a voice note mixed with photos or videos', async () => {
    const result = await prepareAnySharedPayloads([audioPayload(), payload()], dependencies);

    expect(result).toEqual({ kind: 'error', errorMessage: MIXED_SHARED_AUDIO_ERROR });
    expect(MIXED_SHARED_AUDIO_ERROR).toBe('Share one voice note at a time, or photos and videos together.');
    expect(dependencies.getLocalFileSizeBytes).not.toHaveBeenCalled();
  });

  it('refuses more than one voice note', async () => {
    const result = await prepareAnySharedPayloads(
      [audioPayload(), audioPayload({ contentUri: 'file:///shared/second.m4a', originalName: 'second.m4a' })],
      dependencies,
    );

    expect(result).toEqual({ kind: 'error', errorMessage: MIXED_SHARED_AUDIO_ERROR });
  });

  it('ignores unsupported extras (e.g. text) next to a single voice note', async () => {
    const result = await prepareAnySharedPayloads(
      [audioPayload(), { value: 'hello', shareType: 'text', mimeType: 'text/plain', contentUri: null, contentType: 'text', contentMimeType: null, originalName: null, contentSize: null } as unknown as ResolvedSharePayload],
      dependencies,
    );

    expect(result.kind).toBe('audio');
  });
});

describe('share-copy ownership', () => {
  const photo = (index: number) => payload({
    contentUri: `file:///photo-${index}.jpg`,
    value: `file:///photo-${index}.jpg`,
  });
  const audio = payload({
    contentUri: 'file:///voice.m4a',
    value: 'file:///voice.m4a',
    shareType: 'audio',
    contentType: 'audio',
    contentMimeType: 'audio/mp4',
    mimeType: 'audio/mp4',
    originalName: 'voice.m4a',
  });

  it('marks every attachment as a share copy', async () => {
    const result = await prepareSharedMedia([photo(1), photo(2)], dependencies);
    expect(result.attachments.every((attachment) => attachment.isShareCopy === true)).toBe(true);
  });

  it('returns nothing to delete when every payload became an attachment', async () => {
    const payloads = [photo(1), photo(2)];
    const result = await prepareAnySharedPayloads(payloads, dependencies);
    expect(unattachedSharedPayloadUris(payloads, result)).toEqual([]);
  });

  it('returns the payloads beyond the 10-item cap', async () => {
    const payloads = Array.from({ length: 12 }, (_, index) => photo(index));
    const result = await prepareAnySharedPayloads(payloads, dependencies);
    expect(unattachedSharedPayloadUris(payloads, result)).toEqual([
      'file:///photo-10.jpg',
      'file:///photo-11.jpg',
    ]);
  });

  it('returns every payload when validation fails', async () => {
    dependencies.getLocalFileSizeBytes.mockResolvedValue(1);
    const payloads = [photo(1), photo(2)];
    const result = await prepareAnySharedPayloads(payloads, dependencies);
    expect(unattachedSharedPayloadUris(payloads, result)).toEqual([
      'file:///photo-1.jpg',
      'file:///photo-2.jpg',
    ]);
  });

  it('returns unsupported files but not text without a uri', async () => {
    const pdf = payload({
      contentUri: 'file:///doc.pdf',
      value: 'file:///doc.pdf',
      shareType: 'file',
      contentType: 'file',
      contentMimeType: 'application/pdf',
      mimeType: 'application/pdf',
      originalName: 'doc.pdf',
    });
    const text = { value: 'hi', shareType: 'text', contentUri: null, contentType: 'text' } as unknown as ResolvedSharePayload;
    const payloads = [pdf, text];
    const result = await prepareAnySharedPayloads(payloads, dependencies);
    expect(unattachedSharedPayloadUris(payloads, result)).toEqual(['file:///doc.pdf']);
  });

  it('leaves the single voice note to the audio import path', async () => {
    const payloads = [audio];
    const result = await prepareAnySharedPayloads(payloads, dependencies);
    expect(result.kind).toBe('audio');
    expect(unattachedSharedPayloadUris(payloads, result)).toEqual([]);
  });

  it('returns the voice note and photos of a refused mixed share (no audio import will run)', async () => {
    const payloads = [audio, photo(1)];
    const result = await prepareAnySharedPayloads(payloads, dependencies);
    expect(result.kind).toBe('error');
    expect(unattachedSharedPayloadUris(payloads, result)).toEqual([
      'file:///voice.m4a',
      'file:///photo-1.jpg',
    ]);
  });
});
