import * as ImagePicker from 'expo-image-picker';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';

import { MemoryMediaPicker } from './memory-media-picker';
import { extractVideoCaptureDateIso } from '@/utils/video-capture-date';

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  getMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

// Video container parsing is unit-tested on its own in
// video-capture-date.test.ts; this file only asserts the picker's wiring
// (calls it for video assets, awaits it, maps the result onto
// capturedAtIso) against a mock.
jest.mock('@/utils/video-capture-date', () => ({
  extractVideoCaptureDateIso: jest.fn(),
}));

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const mockedExtractVideoCaptureDateIso = extractVideoCaptureDateIso as jest.Mock;

describe('MemoryMediaPicker', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  function choosePhotoLibrary() {
    const buttons = (Alert.alert as jest.Mock).mock.calls[0]?.[2] as
      | { text: string; onPress?: () => void }[]
      | undefined;
    buttons?.find((button) => button.text === 'Photo library')?.onPress?.();
  }

  it('reports a native gallery launch failure and does not request an existing permission again', async () => {
    mockedImagePicker.launchImageLibraryAsync.mockRejectedValue(new Error('native launch failed'));
    const onError = jest.fn();
    const screen = render(<MemoryMediaPicker onError={onError} onSelect={jest.fn()} />);

    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    choosePhotoLibrary();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });

    await waitFor(() => {
      expect(onError).toHaveBeenLastCalledWith(
        'Could not open the photo library. Please try again.',
      );
    });
    expect(mockedImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  it('prevents concurrent native picker launches', async () => {
    let resolvePicker: ((result: ImagePicker.ImagePickerResult) => void) | undefined;
    mockedImagePicker.launchImageLibraryAsync.mockImplementation(
      () => new Promise((resolve) => { resolvePicker = resolve; }),
    );
    const screen = render(<MemoryMediaPicker onError={jest.fn()} onSelect={jest.fn()} />);

    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    choosePhotoLibrary();
    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    const secondButtons = (Alert.alert as jest.Mock).mock.calls[1]?.[2] as {
      text: string;
      onPress?: () => void;
    }[];
    secondButtons.find((button) => button.text === 'Photo library')?.onPress?.();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });
    expect(mockedImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePicker?.({ canceled: true, assets: null });
    });
  });

  it('rounds a fractional iOS video duration before emitting the attachment', async () => {
    // iOS expo-image-picker reports duration as a fractional Double in ms
    // (asset.duration.value / timescale * 1000) -- the RPC's `::integer`
    // cast throws on fractional text, so this must be rounded at the
    // source. See supabase/migrations/20260716120000_round_media_duration_ms_cast.sql.
    mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///clip.mov',
          width: 100,
          height: 100,
          fileSize: 2048,
          mimeType: 'video/quicktime',
          duration: 21894.666666666668,
        },
      ],
    } as ImagePicker.ImagePickerResult);
    const onSelect = jest.fn();
    const screen = render(<MemoryMediaPicker onError={jest.fn()} onSelect={onSelect} />);

    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    choosePhotoLibrary();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    const [[attachments]] = onSelect.mock.calls;
    expect(attachments[0].durationMs).toBe(21895);
    expect(Number.isInteger(attachments[0].durationMs)).toBe(true);
  });

  it('emits durationMs undefined (not NaN) when a video reports no duration', async () => {
    mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///clip.mp4',
          width: 100,
          height: 100,
          fileSize: 2048,
          mimeType: 'video/mp4',
          duration: undefined,
        },
      ],
    } as ImagePicker.ImagePickerResult);
    const onError = jest.fn();
    const onSelect = jest.fn();
    const screen = render(<MemoryMediaPicker onError={onError} onSelect={onSelect} />);

    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    choosePhotoLibrary();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });

    // No duration -> validateMediaFile rejects the video before onSelect fires.
    expect(onSelect).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith('Could not read video duration. Try another clip.');
  });

  describe('includeCaptureDate', () => {
    function buildImageAsset(overrides: Partial<ImagePicker.ImagePickerAsset> = {}) {
      return {
        uri: 'file:///photo.jpg',
        width: 100,
        height: 100,
        fileSize: 1024,
        mimeType: 'image/jpeg',
        exif: { DateTimeOriginal: '2024:06:01 10:00:00' },
        ...overrides,
      } as ImagePicker.ImagePickerAsset;
    }

    async function pickLibraryAndFlush() {
      const screen = render(
        <MemoryMediaPicker onError={jest.fn()} onSelect={onSelect} includeCaptureDate={includeCaptureDate} />,
      );
      fireEvent.press(screen.getByTestId('new-memory-attach-media'));
      choosePhotoLibrary();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(300);
      });
      return screen;
    }

    function buildVideoAsset(overrides: Partial<ImagePicker.ImagePickerAsset> = {}) {
      return {
        uri: 'file:///clip.mp4',
        width: 100,
        height: 100,
        fileSize: 2048,
        mimeType: 'video/mp4',
        duration: 5000,
        ...overrides,
      } as ImagePicker.ImagePickerAsset;
    }

    let onSelect: jest.Mock;
    let includeCaptureDate: boolean | undefined;

    beforeEach(() => {
      onSelect = jest.fn();
      includeCaptureDate = undefined;
      mockedExtractVideoCaptureDateIso.mockReset();
      mockedExtractVideoCaptureDateIso.mockResolvedValue(null);
    });

    it('passes exif: true to launchImageLibraryAsync when includeCaptureDate is true', async () => {
      includeCaptureDate = true;
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [buildImageAsset()],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(mockedImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
        expect.objectContaining({ exif: true }),
      );
    });

    it('passes exif: false when includeCaptureDate is omitted (default false)', async () => {
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [buildImageAsset()],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(mockedImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
        expect.objectContaining({ exif: false }),
      );
    });

    it('passes exif: false when includeCaptureDate is explicitly false', async () => {
      includeCaptureDate = false;
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [buildImageAsset()],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(mockedImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
        expect.objectContaining({ exif: false }),
      );
    });

    it('emits only a derived capturedAtIso scalar for an image with valid EXIF, never the raw EXIF object', async () => {
      includeCaptureDate = true;
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [
          buildImageAsset({
            exif: {
              DateTimeOriginal: '2024:06:01 10:00:00',
              GPSLatitude: [37, 46, 26.4],
              GPSLongitude: [122, 25, 9.6],
              Make: 'Apple',
              Model: 'iPhone 15',
            },
          }),
        ],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(onSelect).toHaveBeenCalledTimes(1);
      const [[attachments]] = onSelect.mock.calls;
      expect(attachments).toHaveLength(1);
      expect(attachments[0].capturedAtIso).toBe('2024-06-01');
      expect(attachments[0].aspectRatio).toBe(1);
      expect(attachments[0]).not.toHaveProperty('exif');
      expect(attachments[0]).not.toHaveProperty('GPSLatitude');
      expect(attachments[0]).not.toHaveProperty('GPSLongitude');
      expect(attachments[0]).not.toHaveProperty('Make');
      expect(attachments[0]).not.toHaveProperty('Model');
      expect(JSON.stringify(attachments[0])).not.toContain('GPS');
    });

    it('does not attach a capture date when includeCaptureDate is false, even if exif is present on the asset', async () => {
      includeCaptureDate = false;
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [buildImageAsset()],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(onSelect).toHaveBeenCalledTimes(1);
      const [[attachments]] = onSelect.mock.calls;
      expect(attachments[0].capturedAtIso).toBeUndefined();
    });

    it('ignores EXIF on a video asset', async () => {
      includeCaptureDate = true;
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [
          buildImageAsset({
            uri: 'file:///clip.mp4',
            mimeType: 'video/mp4',
            duration: 5000,
            exif: { DateTimeOriginal: '2024:06:01 10:00:00' },
          }),
        ],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(onSelect).toHaveBeenCalledTimes(1);
      const [[attachments]] = onSelect.mock.calls;
      expect(attachments[0].contentType).toBe('video/mp4');
      expect(attachments[0].capturedAtIso).toBeUndefined();
    });

    it('emits a valid attachment without a capture date when EXIF is absent', async () => {
      includeCaptureDate = true;
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [buildImageAsset({ exif: undefined })],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(onSelect).toHaveBeenCalledTimes(1);
      const [[attachments]] = onSelect.mock.calls;
      expect(attachments[0].capturedAtIso).toBeUndefined();
      expect(attachments[0].uri).toBe('file:///photo.jpg');
    });

    it('emits a valid attachment without a capture date when EXIF is malformed', async () => {
      includeCaptureDate = true;
      mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [buildImageAsset({ exif: { DateTimeOriginal: 'not-a-date' } })],
      } as ImagePicker.ImagePickerResult);

      await pickLibraryAndFlush();

      expect(onSelect).toHaveBeenCalledTimes(1);
      const [[attachments]] = onSelect.mock.calls;
      expect(attachments[0].capturedAtIso).toBeUndefined();
    });

    describe('video container capture date', () => {
      it('attaches a capturedAtIso derived from the video file when includeCaptureDate is true', async () => {
        includeCaptureDate = true;
        mockedExtractVideoCaptureDateIso.mockResolvedValue('2024-06-01');
        mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
          canceled: false,
          assets: [buildVideoAsset()],
        } as ImagePicker.ImagePickerResult);

        await pickLibraryAndFlush();

        expect(mockedExtractVideoCaptureDateIso).toHaveBeenCalledWith('file:///clip.mp4');
        expect(onSelect).toHaveBeenCalledTimes(1);
        const [[attachments]] = onSelect.mock.calls;
        expect(attachments[0].capturedAtIso).toBe('2024-06-01');
      });

      it('does not call the video extractor when includeCaptureDate is false', async () => {
        includeCaptureDate = false;
        mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
          canceled: false,
          assets: [buildVideoAsset()],
        } as ImagePicker.ImagePickerResult);

        await pickLibraryAndFlush();

        expect(mockedExtractVideoCaptureDateIso).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledTimes(1);
        const [[attachments]] = onSelect.mock.calls;
        expect(attachments[0].capturedAtIso).toBeUndefined();
      });

      it('emits a valid attachment without a capture date when the video extractor resolves null (parse failure)', async () => {
        includeCaptureDate = true;
        mockedExtractVideoCaptureDateIso.mockResolvedValue(null);
        mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
          canceled: false,
          assets: [buildVideoAsset()],
        } as ImagePicker.ImagePickerResult);

        await pickLibraryAndFlush();

        expect(onSelect).toHaveBeenCalledTimes(1);
        const [[attachments]] = onSelect.mock.calls;
        expect(attachments[0].capturedAtIso).toBeUndefined();
        expect(attachments[0].uri).toBe('file:///clip.mp4');
      });

      it('does not call the video extractor for a photo asset', async () => {
        includeCaptureDate = true;
        mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
          canceled: false,
          assets: [buildImageAsset()],
        } as ImagePicker.ImagePickerResult);

        await pickLibraryAndFlush();

        expect(mockedExtractVideoCaptureDateIso).not.toHaveBeenCalled();
        expect(onSelect).toHaveBeenCalledTimes(1);
        const [[attachments]] = onSelect.mock.calls;
        expect(attachments[0].capturedAtIso).toBe('2024-06-01');
      });
    });
  });
});
