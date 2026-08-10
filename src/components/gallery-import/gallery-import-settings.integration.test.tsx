import { act, fireEvent, render } from '@testing-library/react-native';

import { GalleryImportSettingsBlock } from '@/components/gallery-import/gallery-import-settings';
import { useGalleryCaptionSettings, useGalleryImport } from '@/hooks/useGalleryImport';
import { useFamily } from '@/hooks/use-family';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: true }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useGalleryImport', () => ({ useGalleryCaptionSettings: jest.fn(), useGalleryImport: jest.fn() }));

const mockedFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCaptionSettings = useGalleryCaptionSettings as jest.MockedFunction<typeof useGalleryCaptionSettings>;
const mockedImport = useGalleryImport as jest.MockedFunction<typeof useGalleryImport>;

describe('GalleryImportSettingsBlock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedImport.mockReturnValue({ run: null } as never);
    mockedCaptionSettings.mockReturnValue({
      settings: { language: 'en-GB', instructions: '', updatedAt: null },
      save: jest.fn().mockResolvedValue({ language: 'en-GB', instructions: 'Warm and simple.', updatedAt: null }),
    } as never);
  });

  afterEach(() => jest.useRealTimers());

  it('debounces a dirty owner edit once and exposes its saved state', async () => {
    const save = mockedCaptionSettings().save as jest.Mock;
    const screen = render(<GalleryImportSettingsBlock />);
    fireEvent.press(screen.getByTestId('settings-gallery-caption'));
    expect(save).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByTestId('gallery-caption-instructions'), 'Warm and simple.');
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ language: 'en-GB', instructions: 'Warm and simple.' });
    expect(screen.getByText('Saved')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(1_500); });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not fetch or expose cached caption values to a viewer', () => {
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    const screen = render(<GalleryImportSettingsBlock />);
    expect(screen.getByTestId('settings-gallery-caption-viewer')).toBeTruthy();
    expect(screen.queryByTestId('gallery-caption-settings-editor')).toBeNull();
  });

  it('keeps the searchable combobox available and retries an autosave after an error', async () => {
    const save = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ language: 'en-US', instructions: 'Try again.', updatedAt: null });
    mockedCaptionSettings.mockReturnValue({ settings: { language: 'en-GB', instructions: '', updatedAt: null }, save } as never);
    const screen = render(<GalleryImportSettingsBlock />);
    fireEvent.press(screen.getByTestId('settings-gallery-caption'));
    expect(screen.getByLabelText('Caption language options')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('gallery-caption-instructions'), 'First try.');
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(screen.getByText(/Could not save/)).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('gallery-caption-instructions'), 'Try again.');
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Saved')).toBeTruthy();
  });
});
