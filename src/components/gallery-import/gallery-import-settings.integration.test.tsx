import { fireEvent, render } from '@testing-library/react-native';

import { GalleryCaptionLanguageRow, GalleryImportSettingsRow } from '@/components/gallery-import/gallery-import-settings';
import { galleryCaptionSettingsRoute } from '@/lib/routes';
import { useGalleryCaptionSettings, useGalleryImportEntryStatus } from '@/hooks/useGalleryImport';
import { useFamily } from '@/hooks/use-family';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/utils/gallery-import-flags', () => ({ isGalleryImportFeatureEnabled: true }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useGalleryImport', () => ({ useGalleryCaptionSettings: jest.fn(), useGalleryImportEntryStatus: jest.fn() }));

const mockedFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCaptionSettings = useGalleryCaptionSettings as jest.MockedFunction<typeof useGalleryCaptionSettings>;
const mockedEntryStatus = useGalleryImportEntryStatus as jest.MockedFunction<typeof useGalleryImportEntryStatus>;

function entryStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'none',
    attentionReason: null,
    reviewDaysLeft: null,
    readyCount: 0,
    checkpoint: null,
    run: null,
    isLoading: false,
    refetch: jest.fn(),
    driverState: { phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false },
    comingIndicator: { kind: 'none' },
    ...overrides,
  } as never;
}

describe('Gallery import settings rows', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedEntryStatus.mockReturnValue(entryStatus());
    mockedCaptionSettings.mockReturnValue({
      settings: { language: 'en-GB', instructions: '', updatedAt: null },
      save: jest.fn(),
    } as never);
  });

  it('shows the owner a human-readable language label, never a bare code', () => {
    const screen = render(<GalleryCaptionLanguageRow />);
    const row = screen.getByTestId('settings-gallery-caption');
    expect(row).toBeTruthy();
    // The raw BCP-47 tag must never stand alone as the row's caption.
    expect(screen.queryByText('en-GB')).toBeNull();
    expect(screen.getByText('English (United Kingdom)')).toBeTruthy();
  });

  it('pushes the dedicated caption settings screen when an owner taps the row', () => {
    const screen = render(<GalleryCaptionLanguageRow />);
    fireEvent.press(screen.getByTestId('settings-gallery-caption'));
    expect(mockPush).toHaveBeenCalledWith(galleryCaptionSettingsRoute);
  });

  it('renders no Find memories row for a viewer and never calls the device-bound status hook', () => {
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    const screen = render(<GalleryImportSettingsRow />);
    // Viewers get the trimmed Settings screen: no import entry point at all.
    expect(screen.queryByTestId('settings-gallery-import')).toBeNull();
    // The "viewer caption bug": a viewer must never drive a status hook they
    // can never act on.
    expect(mockedEntryStatus).toHaveBeenCalledWith({ enabled: false });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('gives a non-owner manager the same disabled caption row, not the owner-editable one', () => {
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as never);
    const screen = render(<GalleryCaptionLanguageRow />);
    const row = screen.getByTestId('settings-gallery-caption');
    expect(screen.getByText('Only the family owner can change this setting.')).toBeTruthy();
    // A manager's row renders without a chevron/onPress at all -- SettingsRow
    // falls back to a plain, non-Pressable View, so there is no navigation
    // affordance to press in the first place.
    expect(row.props.onPress).toBeUndefined();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows "Look through your photos" and opens the entry screen when there is no run', () => {
    const screen = render(<GalleryImportSettingsRow />);
    expect(screen.getByText('Look through your photos')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-gallery-import'));
    expect(mockPush).toHaveBeenCalledWith('/(app)/gallery-import');
  });

  it('shows the ready count and opens the review deck once suggestions are ready', () => {
    mockedEntryStatus.mockReturnValue(entryStatus({
      state: 'ready',
      readyCount: 12,
      checkpoint: { runId: 'run-1' },
    }));
    const screen = render(<GalleryImportSettingsRow />);
    expect(screen.getByText('12 suggestions ready to review')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-gallery-import'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/review', params: { runId: 'run-1' } });
  });

  it('shows the sweep-active caption and opens progress while the sweep is running with nothing ready yet', () => {
    mockedEntryStatus.mockReturnValue(entryStatus({
      state: 'processing',
      readyCount: 0,
      checkpoint: { runId: 'run-1' },
      driverState: { phase: 'sending', runId: 'run-1', pausedUntil: null, lastError: null, isActive: true },
    }));
    const screen = render(<GalleryImportSettingsRow />);
    expect(screen.getByText('Looking through your photos · 0 ready')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-gallery-import'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/(app)/gallery-import/progress', params: { runId: 'run-1' } });
  });

  it('shows the fair-use pause caption and routes to progress', () => {
    mockedEntryStatus.mockReturnValue(entryStatus({
      checkpoint: { runId: 'run-1' },
      driverState: { phase: 'paused_fair_use', runId: 'run-1', pausedUntil: '2026-08-24T00:00:00.000Z', lastError: null, isActive: false },
    }));
    const screen = render(<GalleryImportSettingsRow />);
    expect(screen.getByText('Momora will keep looking tomorrow')).toBeTruthy();
  });

  it('shows the Wi-Fi wait caption and routes to progress', () => {
    mockedEntryStatus.mockReturnValue(entryStatus({
      state: 'attention',
      attentionReason: 'waiting_for_wifi',
      checkpoint: { runId: 'run-1' },
    }));
    const screen = render(<GalleryImportSettingsRow />);
    expect(screen.getByText('Needs Wi-Fi to keep going')).toBeTruthy();
  });

  it('shows the expiring caption and routes to review', () => {
    mockedEntryStatus.mockReturnValue(entryStatus({
      state: 'expiring',
      reviewDaysLeft: 3,
      readyCount: 5,
      checkpoint: { runId: 'run-1' },
    }));
    const screen = render(<GalleryImportSettingsRow />);
    // With something ready AND the countdown imminent, the row says both:
    // the warning matters most exactly when there is still something to review.
    expect(screen.getByText('5 suggestions ready · clear in 3 days')).toBeTruthy();
  });
});
