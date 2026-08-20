import { fireEvent, render } from '@testing-library/react-native';

import { PendingMemoryUploadCard } from './pending-memory-upload-card';
import type { PendingMemoryUpload } from '@/hooks/use-pending-memory-uploads';

function buildUpload(overrides: Partial<PendingMemoryUpload> = {}): PendingMemoryUpload {
  return {
    memoryId: 'memory-1',
    familyId: 'family-1',
    status: 'posting',
    totalAssets: 1,
    uploadedAssets: 0,
    errorMessage: null,
    previewUri: null,
    previewContentType: null,
    isNetworkFailure: false,
    ...overrides,
  };
}

describe('PendingMemoryUploadCard photo/video (unchanged behavior)', () => {
  it('shows the generic uploading copy for a photo upload', () => {
    const upload = buildUpload({ previewContentType: 'image/jpeg', uploadedAssets: 0, totalAssets: 2 });
    const { getByText } = render(
      <PendingMemoryUploadCard onDiscard={jest.fn()} onRetry={jest.fn()} upload={upload} />,
    );

    expect(getByText('Posting memory…')).toBeTruthy();
    expect(getByText('Uploading 1 of 2')).toBeTruthy();
  });
});

describe('PendingMemoryUploadCard audio (docs/plans/audio-memories-v1.md P3.3)', () => {
  it('renders the sound tile instead of a photo thumb, with honest posting copy', () => {
    const upload = buildUpload({ previewContentType: 'audio/mp4', previewUri: 'file:///clip.m4a' });
    const { getByText, getByTestId } = render(
      <PendingMemoryUploadCard onDiscard={jest.fn()} onRetry={jest.fn()} upload={upload} />,
    );

    // The sound tile renders instead of an <Image> pointed at the clip's
    // local audio file uri (which would be a broken/garbage decode).
    expect(getByTestId('pending-memory-card-memory-1-sound')).toBeTruthy();
    expect(getByText('Posting memory…')).toBeTruthy();
    expect(getByText('Keep Momora open just a moment.')).toBeTruthy();
  });

  it('shows the audio-specific failed copy with Retry/Discard', () => {
    const onRetry = jest.fn();
    const onDiscard = jest.fn();
    const upload = buildUpload({ status: 'failed', previewContentType: 'audio/mp4' });
    const { getByText, getByTestId } = render(
      <PendingMemoryUploadCard onDiscard={onDiscard} onRetry={onRetry} upload={upload} />,
    );

    expect(getByText('The sound didn’t finish posting')).toBeTruthy();
    expect(getByText('It’s still on this phone — try again.')).toBeTruthy();

    fireEvent.press(getByTestId('pending-memory-retry-memory-1'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.press(getByTestId('pending-memory-discard-memory-1'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
