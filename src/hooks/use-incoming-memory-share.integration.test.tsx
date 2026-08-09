import { renderHook, waitFor } from '@testing-library/react-native';
import { useIncomingShare } from 'expo-sharing';

import { useIncomingMemoryShare } from './use-incoming-memory-share';
import { extractImageCaptureDateIso } from '@/utils/image-exif-capture-date';
import { prepareSharedMedia } from '@/utils/prepare-shared-media';
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
  expect(onPrepared.mock.calls[0][0][0]).toMatchObject({
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
  expect(onPrepared.mock.calls[0][0][0]).toMatchObject({ capturedAtIso: '2024-02-01' });
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
  expect(onPrepared).toHaveBeenCalledWith([
    expect.objectContaining({ uri: 'file:///cache/shared.jpg' }),
  ], null);
  expect(onPrepared.mock.calls[0][0][0]).not.toHaveProperty('capturedAtIso');
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
  expect(onPrepared).toHaveBeenCalledWith([], 'Momora could not distinguish same-named shared files. Please attach them from inside Momora instead.');
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
  expect(onPrepared).toHaveBeenCalledWith(
    [],
    'Could not open the shared photos or videos. Try sharing them again.',
  );
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
  expect(onPrepared.mock.calls[1][0][0]).toMatchObject({
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
  expect(onPrepared.mock.calls[0][0][0]).toMatchObject({ uri: secondResolvedPayload.contentUri });
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);

  resolveFirstPreparation?.({ attachments: [], errorMessage: null });
  await Promise.resolve();
  await Promise.resolve();

  expect(onPrepared).toHaveBeenCalledTimes(1);
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
  expect(refreshSharePayloads).toHaveBeenCalledTimes(1);
});
