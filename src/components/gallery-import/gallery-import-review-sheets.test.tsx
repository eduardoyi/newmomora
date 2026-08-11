import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  GALLERY_IMPORT_PHOTO_CHOICE_MAX,
  GalleryImportPhotoChooser,
  GalleryImportSetAsideSheet,
} from '@/components/gallery-import/gallery-import-review-sheets';

jest.mock('expo-image', () => { const { View: MockView } = require('react-native'); return { Image: (props: any) => <MockView testID={props.testID} /> }; });
jest.mock('react-native-safe-area-context', () => { const { View: MockView } = require('react-native'); return { SafeAreaView: MockView, useSafeAreaInsets: () => ({ bottom: 28, top: 0, left: 0, right: 0 }) }; });
jest.mock('@/utils/gallery-import-e2e-adapter', () => ({ getGalleryImportE2eAdapter: () => undefined }));
jest.mock('@/utils/gallery-import-scanner', () => ({
  createExpoGalleryMediaLibraryAdapter: () => ({ resolveAssetUri: jest.fn(async (osAssetId: string) => `file://local/${osAssetId}`) }),
}));

/** Lets the chooser's sequential local-uri resolution settle inside act(). */
async function flushUriResolution() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const hour = 60 * 60 * 1000;
const base = Date.UTC(2024, 0, 14, 9, 0, 0);
function poolAsset(index: number) {
  return { assetToken: `token-${index}`, osAssetId: `os-${index}`, captureAtMs: base + index * hour, width: 100, height: 100 };
}
const pool = Array.from({ length: 12 }, (_, index) => poolAsset(index));
const candidate = {
  memoryDate: '2024-01-14',
  selectedAssetTokens: ['token-0', 'token-1'],
  previewUrls: ['https://preview-0', 'https://preview-1'],
};

describe('gallery import photo chooser', () => {
  it('selects in tap order, enforces the ten-photo cap with the locked message, and never drops below one photo', async () => {
    const onUseSelection = jest.fn();
    const screen = render(
      <GalleryImportPhotoChooser candidate={candidate} mode="select" onClose={jest.fn()} onUseSelection={onUseSelection} pool={pool} />,
    );
    await flushUriResolution();

    expect(screen.getByText(/choosing one does not send anything new anywhere/)).toBeTruthy();
    expect(screen.getByText(/all still on your phone/)).toBeTruthy();
    expect(screen.getByText('Tap a photo to add or remove it.')).toBeTruthy();

    // The third photo joins the ordered selection as number 3.
    fireEvent.press(screen.getByTestId('gallery-import-chooser-photo-token-2'));
    expect(screen.getByTestId('gallery-import-chooser-order-token-2').props.children).toBe(3);

    // Fill to the cap of ten...
    for (let index = 3; index < 10; index += 1) {
      fireEvent.press(screen.getByTestId(`gallery-import-chooser-photo-token-${index}`));
    }
    expect(screen.getByText(`10 of ${GALLERY_IMPORT_PHOTO_CHOICE_MAX} chosen`)).toBeTruthy();
    expect(screen.getByText('That is the most one memory can hold.')).toBeTruthy();
    // ...an eleventh photo cannot join.
    fireEvent.press(screen.getByTestId('gallery-import-chooser-photo-token-10'));
    expect(screen.queryByTestId('gallery-import-chooser-order-token-10')).toBeNull();

    // Deselect down to one; the last photo cannot be removed.
    for (let index = 9; index >= 1; index -= 1) {
      fireEvent.press(screen.getByTestId(`gallery-import-chooser-photo-token-${index}`));
    }
    fireEvent.press(screen.getByTestId('gallery-import-chooser-photo-token-0'));
    expect(screen.getByText(`1 of ${GALLERY_IMPORT_PHOTO_CHOICE_MAX} chosen`)).toBeTruthy();

    fireEvent.press(screen.getByTestId('gallery-import-chooser-use'));
    expect(onUseSelection).toHaveBeenCalledWith([{ assetToken: 'token-0', uri: 'https://preview-0' }]);
  });

  it('hands back device uris for pool photos beyond the candidate previews', async () => {
    const onUseSelection = jest.fn();
    const screen = render(
      <GalleryImportPhotoChooser candidate={candidate} mode="select" onClose={jest.fn()} onUseSelection={onUseSelection} pool={pool} />,
    );
    await flushUriResolution();
    fireEvent.press(screen.getByTestId('gallery-import-chooser-photo-token-5'));
    await waitFor(() => {
      fireEvent.press(screen.getByTestId('gallery-import-chooser-use'));
      expect(onUseSelection).toHaveBeenLastCalledWith([
        { assetToken: 'token-0', uri: 'https://preview-0' },
        { assetToken: 'token-1', uri: 'https://preview-1' },
        { assetToken: 'token-5', uri: 'file://local/os-5' },
      ]);
    });
  });

  it('is browse-only from the read-only deck: no toggling, no footer, a composer hint instead', async () => {
    const onUseSelection = jest.fn();
    const screen = render(
      <GalleryImportPhotoChooser candidate={candidate} mode="browse" onClose={jest.fn()} onUseSelection={onUseSelection} pool={pool} />,
    );
    await flushUriResolution();
    expect(screen.getByTestId('gallery-import-chooser-browse-hint').props.children).toBe('Keeping opens the memory, where the photos can be changed.');
    expect(screen.queryByTestId('gallery-import-chooser-use')).toBeNull();
    fireEvent.press(screen.getByTestId('gallery-import-chooser-photo-token-2'));
    expect(screen.queryByTestId('gallery-import-chooser-order-token-2')).toBeNull();
  });
});

describe('gallery import set-aside sheet', () => {
  const skipped = [
    { id: 'candidate-9', caption: 'A rainy market morning with both kids.', memoryDate: '2024-01-14', selectedAssetTokens: ['token-0'], familyMemberIds: [], status: 'skipped' as const, previewUrls: ['https://preview-9'] },
  ];

  it('shows thumb, excerpt, date, the Bring back action, and the reassurance card', () => {
    const onBringBack = jest.fn();
    const screen = render(
      <GalleryImportSetAsideSheet candidates={skipped} isActioning={false} onBringBack={onBringBack} onClose={jest.fn()} />,
    );
    expect(screen.getByText('Nothing here was deleted. Bring any of them back for the next 30 days.')).toBeTruthy();
    expect(screen.getByText('A rainy market morning with both kids.')).toBeTruthy();
    // Same long-form date as the deck card and photo chooser header --
    // never the raw ISO date, and never a shorter one-off format either
    // (defect #3 guard).
    expect(screen.getByText('Sunday, January 14, 2024')).toBeTruthy();
    expect(screen.queryByText('Jan 14, 2024')).toBeNull();
    expect(screen.queryByText('2024-01-14')).toBeNull();
    expect(screen.getByTestId('gallery-import-aside-thumb-candidate-9')).toBeTruthy();
    expect(screen.getByText(/not a judgement of the photo/)).toBeTruthy();
    expect(screen.queryByText('Restore')).toBeNull();
    fireEvent.press(screen.getByTestId('gallery-import-restore-candidate-9'));
    expect(onBringBack).toHaveBeenCalledWith(skipped[0]);
  });
});
