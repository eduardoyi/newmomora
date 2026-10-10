import { renderHook, waitFor } from '@testing-library/react-native';
import { useIncomingShare } from 'expo-sharing';

import { useIncomingMemoryShare } from './use-incoming-memory-share';
import { extractImageCaptureDateIso } from '@/utils/image-exif-capture-date';
import { prepareSharedMedia } from '@/utils/prepare-shared-media';
import { deleteShareCopies } from '@/utils/shared-file-cleanup';
import { extractVideoCaptureDateIso } from '@/utils/video-capture-date';

jest.mock('expo-sharing', () => ({ useIncomingShare: jest.fn() }));
jest.mock('@/utils/local-files', () => ({
  getLocalFileSizeBytes: jest.fn(async () => 2048),
}));
jest.mock('@/utils/image-exif-capture-date', () => ({
  extractImageCaptureDateIso: jest.fn(async () => '2024-03-05'),
}));
jest.mock('@/utils/shared-video-duration', () => ({
  getSharedVideoDurationMs: jest.fn(async () => 25_000),
}));
jest.mock('@/utils/prepare-shared-media', () => {
  const actual = jest.requireActual<typeof import('@/utils/prepare-shared-media')>(
    '@/utils/prepare-shared-media',
  );
  return { ...actual, prepareSharedMedia: jest.fn(actual.prepareSharedMedia) };
});
jest.mock('@/utils/shared-file-cleanup', () => ({ deleteShareCopies: jest.fn(async () => {}) }));
jest.mock('@/utils/video-capture-date', () => ({
  extractVideoCaptureDateIso: jest.fn(async () => '2024-02-01'),
}));

const mockUseIncomingShare = useIncomingShare as jest.MockedFunction<typeof useIncomingShare>;
const mockExtractImageCaptureDateIso = extractImageCaptureDateIso as jest.MockedFunction<
  typeof extractImageCaptureDateIso
>;
const mockExtractVideoCaptureDateIso = extractVideoCaptureDateIso as jest.MockedFunction<
  typeof extractVideoCaptureDateIso
>;
const mockPrepareSharedMedia = prepareSharedMedia as jest.MockedFunction<typeof prepareSharedMedia>;
const mockDeleteShareCopies = deleteShareCopies as jest.MockedFunction<typeof deleteShareCopies>;
const clearSharedPayloads = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockExtractImageCaptureDateIso.mockResolvedValue('2024-03-05');
  mockExtractVideoCaptureDateIso.mockResolvedValue('2024-02-01');
});

it('prepares a native shared photo for the memory composer and clears the intent', async () => {
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [{ value: 'file:///shared.jpg', shareType: 'image', mimeType: 'image/jpeg' }],
    resolvedSharedPayloads: [{
      value: 'file:///shared.jpg',
      shareType: 'image',
      mimeType: 'image/jpeg',
      contentUri: 'file:///cache/shared.jpg',
      contentType: 'image',
      contentMimeType: 'image/jpeg',
      originalName: 'shared.jpg',
      contentSize: 2048,
    }],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared.mock.calls[0][0].attachments[0]).toMatchObject({
    uri: 'file:///cache/shared.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 2048,
    capturedAtIso: '2024-03-05',
  });
  expect(mockExtractImageCaptureDateIso).toHaveBeenCalledWith('file:///cache/shared.jpg');
  expect(mockExtractVideoCaptureDateIso).not.toHaveBeenCalled();
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
});

it('wires the video capture-date extractor and keeps its scalar on the prepared attachment', async () => {
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [{ value: 'file:///shared.mov', shareType: 'video', mimeType: 'video/quicktime' }],
    resolvedSharedPayloads: [{
      value: 'file:///shared.mov',
      shareType: 'video',
      mimeType: 'video/quicktime',
      contentUri: 'file:///cache/shared.mov',
      contentType: 'video',
      contentMimeType: 'video/quicktime',
      originalName: 'shared.mov',
      contentSize: 2048,
    }],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(mockExtractVideoCaptureDateIso).toHaveBeenCalledWith('file:///cache/shared.mov');
  expect(mockExtractImageCaptureDateIso).not.toHaveBeenCalled();
  expect(onPrepared.mock.calls[0][0].attachments[0]).toMatchObject({ capturedAtIso: '2024-02-01' });
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
});

it('fails open when an optional image date extractor rejects and clears the payload once', async () => {
  mockExtractImageCaptureDateIso.mockRejectedValueOnce(new Error('unreadable metadata'));
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [{ value: 'file:///shared.jpg', shareType: 'image', mimeType: 'image/jpeg' }],
    resolvedSharedPayloads: [{
      value: 'file:///shared.jpg',
      shareType: 'image',
      mimeType: 'image/jpeg',
      contentUri: 'file:///cache/shared.jpg',
      contentType: 'image',
      contentMimeType: 'image/jpeg',
      originalName: 'shared.jpg',
      contentSize: 2048,
    }],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared).toHaveBeenCalledWith({
    kind: 'media',
    attachments: [expect.objectContaining({ uri: 'file:///cache/shared.jpg' })],
    errorMessage: null,
  });
  expect(onPrepared.mock.calls[0][0].attachments[0]).not.toHaveProperty('capturedAtIso');
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
});

it('returns the duplicate shared-URI error and clears the native payload once', async () => {
  const duplicatePayload = {
    value: 'file:///shared.jpg',
    shareType: 'image',
    mimeType: 'image/jpeg',
    contentUri: 'file:///cache/duplicate.jpg',
    contentType: 'image',
    contentMimeType: 'image/jpeg',
    originalName: 'duplicate.jpg',
    contentSize: 2048,
  };
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [duplicatePayload, duplicatePayload],
    resolvedSharedPayloads: [duplicatePayload, duplicatePayload],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared).toHaveBeenCalledWith({
    kind: 'media',
    attachments: [],
    errorMessage: 'Momora could not distinguish same-named shared files. Please attach them from inside Momora instead.',
  });
  expect(mockExtractImageCaptureDateIso).not.toHaveBeenCalled();
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
});

it('handles an unexpected preparation rejection once, including after a rerender', async () => {
  mockPrepareSharedMedia.mockRejectedValueOnce(new Error('unexpected preparation failure'));
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [{ value: 'file:///shared.jpg', shareType: 'image', mimeType: 'image/jpeg' }],
    resolvedSharedPayloads: [{
      value: 'file:///shared.jpg',
      shareType: 'image',
      mimeType: 'image/jpeg',
      contentUri: 'file:///cache/shared.jpg',
      contentType: 'image',
      contentMimeType: 'image/jpeg',
      originalName: 'shared.jpg',
      contentSize: 2048,
    }],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  const { rerender } = renderHook(
    ({ callback }: { callback: typeof onPrepared }) => useIncomingMemoryShare({ onPrepared: callback }),
    { initialProps: { callback: onPrepared } },
  );

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared).toHaveBeenCalledWith({
    kind: 'error',
    errorMessage: 'Could not open the shared photos or videos. Try sharing them again.',
  });
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);

  rerender({ callback: onPrepared });
  await waitFor(() => expect(clearSharedPayloads).toHaveBeenCalledTimes(1));
  expect(onPrepared).toHaveBeenCalledTimes(1);
});

it('resets the consumed payload state so sharing the same photo again is prepared again', async () => {
  const refreshSharePayloads = jest.fn();
  const rawPayload = {
    value: 'file:///same-photo.jpg',
    shareType: 'image' as const,
    mimeType: 'image/jpeg',
  };
  const resolvedPayload = {
    ...rawPayload,
    contentUri: 'file:///cache/same-photo.jpg',
    contentType: 'image' as const,
    contentMimeType: 'image/jpeg',
    originalName: 'same-photo.jpg',
    contentSize: 2048,
  };
  let incomingShareResult = {
    sharedPayloads: [rawPayload],
    resolvedSharedPayloads: [resolvedPayload],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads,
  };
  mockUseIncomingShare.mockImplementation(() => incomingShareResult);

  const onPrepared = jest.fn();
  const { rerender } = renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(refreshSharePayloads).toHaveBeenCalledTimes(1);

  incomingShareResult = {
    ...incomingShareResult,
    sharedPayloads: [],
    resolvedSharedPayloads: [],
  };
  rerender({});

  incomingShareResult = {
    ...incomingShareResult,
    sharedPayloads: [rawPayload],
    resolvedSharedPayloads: [resolvedPayload],
  };
  rerender({});

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(2));
  expect(onPrepared.mock.calls[1][0].attachments[0]).toMatchObject({
    uri: 'file:///cache/same-photo.jpg',
    capturedAtIso: '2024-03-05',
  });
  expect(clearSharedPayloads).toHaveBeenCalledTimes(2);
  expect(refreshSharePayloads).toHaveBeenCalledTimes(2);
});

it('does not let a stale preparation clear or replace a newer same-length share', async () => {
  const refreshSharePayloads = jest.fn();
  const firstRawPayload = {
    value: 'file:///first-photo.jpg',
    shareType: 'image' as const,
    mimeType: 'image/jpeg',
  };
  const secondRawPayload = {
    value: 'file:///second-photo.jpg',
    shareType: 'image' as const,
    mimeType: 'image/jpeg',
  };
  const firstResolvedPayload = {
    ...firstRawPayload,
    contentUri: 'file:///cache/first-photo.jpg',
    contentType: 'image' as const,
    contentMimeType: 'image/jpeg',
    originalName: 'first-photo.jpg',
    contentSize: 2048,
  };
  const secondResolvedPayload = {
    ...secondRawPayload,
    contentUri: 'file:///cache/second-photo.jpg',
    contentType: 'image' as const,
    contentMimeType: 'image/jpeg',
    originalName: 'second-photo.jpg',
    contentSize: 2048,
  };
  let resolveFirstPreparation: ((value: Awaited<ReturnType<typeof prepareSharedMedia>>) => void) | null = null;
  mockPrepareSharedMedia
    .mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstPreparation = resolve;
    }))
    .mockResolvedValueOnce({
      attachments: [{
        id: 'second-attachment',
        uri: secondResolvedPayload.contentUri,
        contentType: 'image/jpeg',
        sizeBytes: 2048,
      }],
      errorMessage: null,
    });
  let incomingShareResult = {
    sharedPayloads: [firstRawPayload],
    resolvedSharedPayloads: [firstResolvedPayload],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads,
  };
  mockUseIncomingShare.mockImplementation(() => incomingShareResult);

  const onPrepared = jest.fn();
  const { rerender } = renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(mockPrepareSharedMedia).toHaveBeenCalledTimes(1));
  incomingShareResult = {
    ...incomingShareResult,
    sharedPayloads: [secondRawPayload],
    resolvedSharedPayloads: [secondResolvedPayload],
  };
  rerender({});

  await waitFor(() => expect(mockPrepareSharedMedia).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared.mock.calls[0][0].attachments[0]).toMatchObject({ uri: secondResolvedPayload.contentUri });
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);

  resolveFirstPreparation?.({ kind: 'media', attachments: [], errorMessage: null });
  await Promise.resolve();
  await Promise.resolve();

  expect(onPrepared).toHaveBeenCalledTimes(1);
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
  expect(refreshSharePayloads).toHaveBeenCalledTimes(1);
});

it('hands a shared voice note to the callback as an audio result and clears the native payload', async () => {
  const audioPayload = {
    value: 'file:///group/AUDIO-2026-10-10-15-31-04.m4a',
    shareType: 'audio' as const,
    mimeType: 'audio/mp4',
    contentUri: 'file:///group/AUDIO-2026-10-10-15-31-04.m4a',
    contentType: 'audio' as const,
    contentMimeType: 'audio/mp4',
    originalName: 'AUDIO-2026-10-10-15-31-04.m4a',
    contentSize: 240_000,
  };
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [audioPayload],
    resolvedSharedPayloads: [audioPayload],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  const { result } = renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared).toHaveBeenCalledWith({
    kind: 'audio',
    uri: 'file:///group/AUDIO-2026-10-10-15-31-04.m4a',
    mimeType: 'audio/mp4',
    fileName: 'AUDIO-2026-10-10-15-31-04.m4a',
    sizeBytes: 240_000,
  });
  expect(mockExtractImageCaptureDateIso).not.toHaveBeenCalled();
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
  expect(result.current).toBe(false);
});

it('reports a voice note mixed with a photo as an error result', async () => {
  const audioPayload = {
    value: 'file:///group/voice.m4a',
    shareType: 'audio' as const,
    mimeType: 'audio/mp4',
    contentUri: 'file:///group/voice.m4a',
    contentType: 'audio' as const,
    contentMimeType: 'audio/mp4',
    originalName: 'voice.m4a',
    contentSize: 1000,
  };
  const photoPayload = {
    value: 'file:///shared.jpg',
    shareType: 'image' as const,
    mimeType: 'image/jpeg',
    contentUri: 'file:///cache/shared.jpg',
    contentType: 'image' as const,
    contentMimeType: 'image/jpeg',
    originalName: 'shared.jpg',
    contentSize: 2048,
  };
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [audioPayload, photoPayload],
    resolvedSharedPayloads: [audioPayload, photoPayload],
    clearSharedPayloads,
    isResolving: false,
    error: null,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared).toHaveBeenCalledWith({
    kind: 'error',
    errorMessage: 'Share one voice note at a time, or photos and videos together.',
  });
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
});

it('reports the native share error as an error result', async () => {
  mockUseIncomingShare.mockReturnValue({
    sharedPayloads: [{ value: 'file:///shared.jpg', shareType: 'image', mimeType: 'image/jpeg' }],
    resolvedSharedPayloads: [],
    clearSharedPayloads,
    isResolving: false,
    error: new Error('resolve failed') as never,
    refreshSharePayloads: jest.fn(),
  });

  const onPrepared = jest.fn();
  renderHook(() => useIncomingMemoryShare({ onPrepared }));

  await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
  expect(onPrepared).toHaveBeenCalledWith({
    kind: 'error',
    errorMessage: 'Could not open the shared photos or videos. Try sharing them again.',
  });
});

describe('share-copy cleanup for payloads that never become attachments', () => {
  const sharedPhoto = (name: string) => ({
    value: `file:///group/${name}`,
    shareType: 'image' as const,
    mimeType: 'image/jpeg',
    contentUri: `file:///group/${name}`,
    contentType: 'image' as const,
    contentMimeType: 'image/jpeg',
    originalName: name,
    contentSize: 2048,
  });
  const sharedVoice = {
    value: 'file:///group/voice.m4a',
    shareType: 'audio' as const,
    mimeType: 'audio/mp4',
    contentUri: 'file:///group/voice.m4a',
    contentType: 'audio' as const,
    contentMimeType: 'audio/mp4',
    originalName: 'voice.m4a',
    contentSize: 1000,
  };

  function share(payloads: ReturnType<typeof sharedPhoto>[] | (typeof sharedVoice | ReturnType<typeof sharedPhoto>)[]) {
    mockUseIncomingShare.mockReturnValue({
      sharedPayloads: payloads,
      resolvedSharedPayloads: payloads,
      clearSharedPayloads,
      isResolving: false,
      error: null,
      refreshSharePayloads: jest.fn(),
    } as never);
    const onPrepared = jest.fn();
    renderHook(() => useIncomingMemoryShare({ onPrepared }));
    return onPrepared;
  }

  it('deletes nothing when every payload became an attachment', async () => {
    const onPrepared = share([sharedPhoto('a.jpg'), sharedPhoto('b.jpg')]);
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
    expect(onPrepared.mock.calls[0][0].attachments).toHaveLength(2);
    expect(mockDeleteShareCopies).toHaveBeenCalledWith([]);
  });

  it('deletes the copies beyond the 10-item cap', async () => {
    const onPrepared = share(Array.from({ length: 12 }, (_, i) => sharedPhoto(`p${i}.jpg`)));
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
    expect(onPrepared.mock.calls[0][0].attachments).toHaveLength(10);
    expect(mockDeleteShareCopies).toHaveBeenCalledWith([
      'file:///group/p10.jpg',
      'file:///group/p11.jpg',
    ]);
  });

  it('deletes every copy when validation fails', async () => {
    const { getLocalFileSizeBytes } = jest.requireMock('@/utils/local-files');
    getLocalFileSizeBytes.mockResolvedValueOnce(1);
    const onPrepared = share([sharedPhoto('a.jpg')]);
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
    expect(onPrepared.mock.calls[0][0].attachments).toEqual([]);
    expect(mockDeleteShareCopies).toHaveBeenCalledWith(['file:///group/a.jpg']);
  });

  it('leaves a lone voice note to the audio import path', async () => {
    const onPrepared = share([sharedVoice]);
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
    expect(onPrepared.mock.calls[0][0].kind).toBe('audio');
    expect(mockDeleteShareCopies).not.toHaveBeenCalledWith(['file:///group/voice.m4a']);
    for (const [uris] of mockDeleteShareCopies.mock.calls) {
      expect(uris).toEqual([]);
    }
  });

  it('deletes a refused voice note + photo mix (no audio import will run)', async () => {
    const onPrepared = share([sharedVoice, sharedPhoto('a.jpg')]);
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
    expect(mockDeleteShareCopies).toHaveBeenCalledWith([
      'file:///group/voice.m4a',
      'file:///group/a.jpg',
    ]);
  });

  it('deletes the raw payload files when the native share resolution fails', async () => {
    mockUseIncomingShare.mockReturnValue({
      sharedPayloads: [{ value: 'file:///group/a.jpg', shareType: 'image', mimeType: 'image/jpeg' }],
      resolvedSharedPayloads: [],
      clearSharedPayloads,
      isResolving: false,
      error: new Error('resolve failed') as never,
      refreshSharePayloads: jest.fn(),
    });
    const onPrepared = jest.fn();
    renderHook(() => useIncomingMemoryShare({ onPrepared }));
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
    expect(mockDeleteShareCopies).toHaveBeenCalledWith(['file:///group/a.jpg']);
  });

  it('deletes the resolved copies when preparation itself rejects', async () => {
    mockPrepareSharedMedia.mockRejectedValueOnce(new Error('boom'));
    const onPrepared = share([sharedPhoto('a.jpg')]);
    await waitFor(() => expect(onPrepared).toHaveBeenCalledTimes(1));
    expect(mockDeleteShareCopies).toHaveBeenCalledWith(['file:///group/a.jpg']);
  });
});
