import { renderHook, waitFor } from '@testing-library/react-native';
import { useIncomingShare } from 'expo-sharing';

import { useIncomingMemoryShare } from './use-incoming-memory-share';

jest.mock('expo-sharing', () => ({ useIncomingShare: jest.fn() }));
jest.mock('@/utils/shared-video-duration', () => ({
  getSharedVideoDurationMs: jest.fn(async () => 25_000),
}));

const mockUseIncomingShare = useIncomingShare as jest.MockedFunction<typeof useIncomingShare>;
const clearSharedPayloads = jest.fn();

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
  });
  expect(clearSharedPayloads).toHaveBeenCalledTimes(1);
});
