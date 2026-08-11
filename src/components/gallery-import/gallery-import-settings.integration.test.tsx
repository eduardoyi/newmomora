import { fireEvent, render } from '@testing-library/react-native';

import { GalleryImportSettingsBlock } from '@/components/gallery-import/gallery-import-settings';
import { galleryCaptionSettingsRoute } from '@/lib/routes';
import { useGalleryCaptionSettings, useGalleryImport } from '@/hooks/useGalleryImport';
import { useFamily } from '@/hooks/use-family';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: true }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useGalleryImport', () => ({ useGalleryCaptionSettings: jest.fn(), useGalleryImport: jest.fn() }));

const mockedFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCaptionSettings = useGalleryCaptionSettings as jest.MockedFunction<typeof useGalleryCaptionSettings>;
const mockedImport = useGalleryImport as jest.MockedFunction<typeof useGalleryImport>;

describe('GalleryImportSettingsBlock', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedImport.mockReturnValue({ run: null } as never);
    mockedCaptionSettings.mockReturnValue({
      settings: { language: 'en-GB', instructions: '', updatedAt: null },
      save: jest.fn(),
    } as never);
  });

  it('shows the owner a human-readable language label, never a bare code', () => {
    const screen = render(<GalleryImportSettingsBlock />);
    const row = screen.getByTestId('settings-gallery-caption');
    expect(row).toBeTruthy();
    // The raw BCP-47 tag must never stand alone as the row's caption.
    expect(screen.queryByText('en-GB')).toBeNull();
    expect(screen.getByText('English (United Kingdom)')).toBeTruthy();
  });

  it('pushes the dedicated caption settings screen when an owner taps the row', () => {
    const screen = render(<GalleryImportSettingsBlock />);
    fireEvent.press(screen.getByTestId('settings-gallery-caption'));
    expect(mockPush).toHaveBeenCalledWith(galleryCaptionSettingsRoute);
  });

  it('gives a viewer only the disabled explanatory row, with no way to navigate or edit', () => {
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    const screen = render(<GalleryImportSettingsBlock />);
    expect(screen.getByTestId('settings-gallery-caption-viewer')).toBeTruthy();
    expect(screen.getByText('Only the family owner can change this setting.')).toBeTruthy();
    expect(screen.queryByTestId('settings-gallery-caption')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('gives a non-owner manager the same disabled caption row, not the owner-editable one', () => {
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as never);
    const screen = render(<GalleryImportSettingsBlock />);
    const row = screen.getByTestId('settings-gallery-caption');
    expect(screen.getByText('Only the family owner can change this setting.')).toBeTruthy();
    // A manager's row renders without a chevron/onPress at all -- SettingsRow
    // falls back to a plain, non-Pressable View, so there is no navigation
    // affordance to press in the first place.
    expect(row.props.onPress).toBeUndefined();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
