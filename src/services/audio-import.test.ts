import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import type { AudioEnergies, AudioProbe } from '../../modules/momora-audio';
import * as MomoraAudio from '../../modules/momora-audio';
import {
  AUDIO_IMPORT_ERROR_COPY,
  AUDIO_IMPORT_OGG_IOS_COPY,
  importAudioFile,
  type ImportedClip,
  type NeedsTrim,
} from './audio-import';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  copyAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

jest.mock('../../modules/momora-audio', () => ({
  isAvailable: jest.fn(),
  probe: jest.fn(),
  analyze: jest.fn(),
  render: jest.fn(),
}));

const mockedFs = FileSystem as jest.Mocked<typeof FileSystem>;
const mockedAudio = MomoraAudio as jest.Mocked<typeof MomoraAudio>;

const PICKER_URI = 'file:///cache/DocumentPicker/AUDIO-2026-10-10-15-31-04.m4a';
const NOW = new Date(2026, 9, 11, 9, 0, 0);
const CLAIM_RE = /^file:\/\/\/documents\/audio-recordings\/\d{13}-[a-f0-9-]+\./;

function probeResult(overrides: Partial<AudioProbe> = {}): AudioProbe {
  return {
    durationMs: 30_000,
    container: 'mp4',
    codec: 'aac',
    sampleRate: 48000,
    channels: 1,
    creationDate: null,
    sizeBytes: 240_000,
    ...overrides,
  };
}

function energiesResult(durationMs: number, overrides: Partial<AudioEnergies> = {}): AudioEnergies {
  const bucketMs = 100;
  const count = Math.ceil(durationMs / bucketMs);
  return {
    durationMs,
    bucketMs,
    energies: Array.from({ length: count }, (_, i) => (i % 7 === 0 ? 0.04 : 0.01)),
    ...overrides,
  };
}

function deleted(): string[] {
  return mockedFs.deleteAsync.mock.calls.map(([target]) => target);
}

describe('importAudioFile', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (Platform as { OS: string }).OS = 'ios';
    mockedAudio.isAvailable.mockReturnValue(true);
    mockedAudio.probe.mockResolvedValue(probeResult());
    mockedAudio.analyze.mockImplementation(async () => energiesResult(30_000));
    mockedAudio.render.mockImplementation(async (_uri, options) => ({
      uri: options.outputUri,
      durationMs: options.endMs - options.startMs,
      sizeBytes: 360_000,
    }));
    mockedFs.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: true, uri: '' } as never);
    mockedFs.copyAsync.mockResolvedValue(undefined);
    mockedFs.deleteAsync.mockResolvedValue(undefined);
  });

  it('passes an AAC/MP4 voice note through untouched and deletes the picker cache copy', async () => {
    const result = (await importAudioFile({
      uri: PICKER_URI,
      fileName: 'AUDIO-2026-10-10-15-31-04.m4a',
      mimeType: 'audio/mp4',
      sizeBytes: 240_000,
      entry: 'picker',
      now: NOW,
    })) as ImportedClip;

    expect(result.kind).toBe('clip');
    expect(mockedAudio.render).not.toHaveBeenCalled();
    expect(mockedFs.copyAsync).toHaveBeenCalledWith({
      from: PICKER_URI,
      to: expect.stringMatching(new RegExp(`${CLAIM_RE.source}m4a$`)),
    });
    expect(result.clip).toMatchObject({
      durationMs: 30_000,
      sizeBytes: 240_000,
      source: 'imported',
    });
    expect(result.clip.localUri).toBe(result.original.localUri);
    expect(result.clip.localUri).toMatch(CLAIM_RE);
    expect(result.clip.waveform).toHaveLength(64);
    expect(result.original).toMatchObject({
      durationMs: 30_000,
      sizeBytes: 240_000,
      uploadable: true,
      transcription: null,
    });
    expect(result.original.energies.energies.length).toBeGreaterThan(0);
    expect(result.suggestedDateIso).toBe('2026-10-10');
    expect(mockedAudio.analyze).toHaveBeenCalledWith(result.original.localUri, {
      maxBuckets: 4000,
      minBucketMs: 20,
    });
    // Source copy removed after the claim; the claimed file is kept.
    expect(deleted()).toEqual([PICKER_URI]);
  });

  it('copies before deleting the source (never delete first)', async () => {
    const order: string[] = [];
    mockedFs.copyAsync.mockImplementation(async () => {
      order.push('copy');
    });
    mockedFs.deleteAsync.mockImplementation(async () => {
      order.push('delete');
    });

    await importAudioFile({ uri: PICKER_URI, fileName: 'a.m4a', mimeType: 'audio/mp4', entry: 'picker', now: NOW });

    expect(order).toEqual(['copy', 'delete']);
  });

  it('re-encodes AAC/MP4 above 4.5 MB instead of passing it through', async () => {
    mockedAudio.probe.mockResolvedValue(probeResult({ sizeBytes: 5_000_000 }));

    const result = (await importAudioFile({
      uri: PICKER_URI,
      fileName: 'long.m4a',
      mimeType: 'audio/mp4',
      entry: 'picker',
      now: NOW,
    })) as ImportedClip;

    expect(mockedAudio.render).toHaveBeenCalledTimes(1);
    const [renderFrom, renderOptions] = mockedAudio.render.mock.calls[0];
    expect(renderFrom).toBe(result.original.localUri);
    expect(renderOptions).toMatchObject({ startMs: 0, endMs: 30_000, bitrate: 96_000 });
    expect(result.clip.localUri).toBe(renderOptions.outputUri);
    expect(result.clip.localUri).not.toBe(result.original.localUri);
    expect(result.clip.sizeBytes).toBe(360_000);
    expect(result.original).toMatchObject({ sizeBytes: 5_000_000, uploadable: false });
  });

  it('renders a non-AAC source (iOS MP3 is playable, so it stays the original) at 96 kbps', async () => {
    mockedAudio.probe.mockResolvedValue(probeResult({ container: 'mp3', codec: 'mp3', sizeBytes: 400_000 }));

    const result = (await importAudioFile({
      uri: PICKER_URI,
      fileName: 'song.mp3',
      mimeType: 'audio/mpeg',
      entry: 'picker',
      now: NOW,
    })) as ImportedClip;

    expect(mockedFs.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ to: expect.stringMatching(/\.mp3$/) }),
    );
    expect(mockedAudio.render).toHaveBeenCalledTimes(1);
    expect(result.clip.localUri).not.toBe(result.original.localUri);
    expect(result.original.uploadable).toBe(false);
  });

  it('renders an unplayable Ogg Opus source whole to an intermediate m4a that becomes the original', async () => {
    mockedAudio.probe.mockResolvedValue(
      probeResult({ container: 'ogg', codec: 'opus', durationMs: 45_000, sizeBytes: 90_000 }),
    );
    mockedAudio.analyze.mockImplementation(async () => energiesResult(45_000));
    mockedAudio.render.mockImplementation(async (_uri, options) => ({
      uri: options.outputUri,
      durationMs: 45_000,
      sizeBytes: 540_000,
    }));
    const claimedFrom: string[] = [];
    mockedFs.copyAsync.mockImplementation(async ({ to }) => {
      claimedFrom.push(to);
    });

    const result = (await importAudioFile({
      uri: 'file:///cache/PTT-20261010-WA0007.opus',
      fileName: 'PTT-20261010-WA0007.opus',
      mimeType: 'application/ogg',
      entry: 'share',
      now: NOW,
    })) as ImportedClip;

    expect(claimedFrom[0]).toMatch(/\.ogg$/);
    // Only ONE render: the intermediate is already AAC/MP4 <= 4.5 MB, so it is the passthrough clip.
    expect(mockedAudio.render).toHaveBeenCalledTimes(1);
    expect(mockedAudio.render).toHaveBeenCalledWith(claimedFrom[0], {
      startMs: 0,
      endMs: 45_000,
      outputUri: expect.stringMatching(new RegExp(`${CLAIM_RE.source}m4a$`)),
      bitrate: 96_000,
    });
    expect(result.original.localUri).toMatch(/\.m4a$/);
    expect(result.clip.localUri).toBe(result.original.localUri);
    expect(result.original).toMatchObject({ sizeBytes: 540_000, uploadable: true });
    // The claimed Ogg copy and the share payload are both gone; the intermediate stays.
    expect(deleted()).toEqual(expect.arrayContaining([claimedFrom[0], 'file:///cache/PTT-20261010-WA0007.opus']));
    expect(deleted()).not.toContain(result.original.localUri);
    // WhatsApp Android file name supplies the send date.
    expect(result.suggestedDateIso).toBe('2026-10-10');
  });

  it('returns needsTrim above 5:00 with a trim suggestion and no clip render', async () => {
    mockedAudio.probe.mockResolvedValue(probeResult({ durationMs: 400_000, sizeBytes: 3_200_000 }));
    // 400 s: loud only between 20 s and 380 s so suggestTrim has something to cut.
    mockedAudio.analyze.mockImplementation(async () => ({
      durationMs: 400_000,
      bucketMs: 100,
      energies: Array.from({ length: 4000 }, (_, i) => (i >= 200 && i < 3800 ? 0.05 : 0.0000001)),
    }));

    const result = (await importAudioFile({
      uri: PICKER_URI,
      fileName: 'long.m4a',
      mimeType: 'audio/mp4',
      entry: 'picker',
      now: NOW,
    })) as NeedsTrim;

    expect(result.kind).toBe('needsTrim');
    expect(mockedAudio.render).not.toHaveBeenCalled();
    expect(result.original).toMatchObject({ durationMs: 400_000, uploadable: false, transcription: null });
    expect(result.original.energies.energies).toHaveLength(4000);
    expect(result.suggested).toEqual({ startMs: 19_750, endMs: 380_250 });
    expect(deleted()).toEqual([PICKER_URI]);
  });

  it('returns a null suggestion when nothing is worth cutting from a long source', async () => {
    mockedAudio.probe.mockResolvedValue(probeResult({ durationMs: 400_000, sizeBytes: 3_200_000 }));
    mockedAudio.analyze.mockImplementation(async () => energiesResult(400_000));

    const result = (await importAudioFile({
      uri: PICKER_URI,
      fileName: 'long.m4a',
      mimeType: 'audio/mp4',
      entry: 'picker',
      now: NOW,
    })) as NeedsTrim;

    expect(result.kind).toBe('needsTrim');
    expect(result.suggested).toBeNull();
  });

  it('treats exactly 5:00 as importable', async () => {
    mockedAudio.probe.mockResolvedValue(probeResult({ durationMs: 300_000, sizeBytes: 2_000_000 }));
    mockedAudio.analyze.mockImplementation(async () => energiesResult(300_000));

    const result = await importAudioFile({
      uri: PICKER_URI,
      fileName: 'a.m4a',
      mimeType: 'audio/mp4',
      entry: 'picker',
      now: NOW,
    });

    expect(result.kind).toBe('clip');
  });

  it('uses the analyzed (decoded) duration, not container metadata, for the limit', async () => {
    mockedAudio.probe.mockResolvedValue(probeResult({ durationMs: 299_000 }));
    mockedAudio.analyze.mockImplementation(async () => energiesResult(301_000));

    const result = await importAudioFile({
      uri: PICKER_URI,
      fileName: 'a.m4a',
      mimeType: 'audio/mp4',
      entry: 'picker',
      now: NOW,
    });

    expect(result.kind).toBe('needsTrim');
  });

  describe('guards', () => {
    it('rejects a reported size above 200 MB before probing or copying, and deletes our source', async () => {
      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'big.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 201 * 1024 * 1024,
        entry: 'picker',
      });

      expect(result).toEqual({ kind: 'error', code: 'too_long', message: AUDIO_IMPORT_ERROR_COPY.too_long });
      expect(mockedAudio.probe).not.toHaveBeenCalled();
      expect(mockedFs.copyAsync).not.toHaveBeenCalled();
      expect(deleted()).toEqual([PICKER_URI]);
    });

    it('rejects sources longer than 30 minutes without copying', async () => {
      mockedAudio.probe.mockResolvedValue(probeResult({ durationMs: 31 * 60 * 1000 }));

      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'long.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
      });

      expect(result).toMatchObject({ kind: 'error', code: 'too_long' });
      expect(mockedFs.copyAsync).not.toHaveBeenCalled();
      expect(deleted()).toEqual([PICKER_URI]);
    });

    it('accepts exactly 30 minutes', async () => {
      mockedAudio.probe.mockResolvedValue(probeResult({ durationMs: 30 * 60 * 1000, sizeBytes: 21_000_000 }));
      mockedAudio.analyze.mockImplementation(async () => ({ durationMs: 30 * 60 * 1000, bucketMs: 450, energies: [0.01, 0.02] }));

      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'long.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
      });

      expect(result.kind).toBe('needsTrim');
    });

    it('refuses when the native module is unavailable', async () => {
      mockedAudio.isAvailable.mockReturnValue(false);

      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'a.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
      });

      expect(result).toEqual({
        kind: 'error',
        code: 'unavailable',
        message: 'Update Momora to bring in voice notes.',
      });
      expect(mockedAudio.probe).not.toHaveBeenCalled();
    });
  });

  describe('source cleanup', () => {
    it('deletes iOS app-group share payloads', async () => {
      const groupUri = 'file:///private/var/mobile/Containers/Shared/AppGroup/ABC/shared/voice.m4a';

      await importAudioFile({ uri: groupUri, fileName: 'voice.m4a', mimeType: 'audio/mp4', entry: 'share', now: NOW });

      expect(deleted()).toEqual([groupUri]);
    });

    it('never deletes a source outside the app cache or app-group container', async () => {
      const filesUri = 'file:///private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/voice.m4a';

      const result = await importAudioFile({
        uri: filesUri,
        fileName: 'voice.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
        now: NOW,
      });

      expect(result.kind).toBe('clip');
      expect(deleted()).toEqual([]);

      mockedAudio.probe.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'decode_failed' }));
      await importAudioFile({ uri: filesUri, fileName: 'voice.m4a', mimeType: 'audio/mp4', entry: 'picker' });
      expect(deleted()).toEqual([]);

      const documentsUri = 'file:///documents/audio-recordings/1760000000000-other.m4a';
      mockedAudio.probe.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'decode_failed' }));
      await importAudioFile({ uri: documentsUri, fileName: 'x.m4a', mimeType: 'audio/mp4', entry: 'share' });
      expect(deleted()).toEqual([]);
    });

    it('reports io_failed when the claim copy fails and still deletes our source copy', async () => {
      mockedFs.copyAsync.mockRejectedValue(new Error('disk full'));

      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'a.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
      });

      expect(result).toMatchObject({ kind: 'error', code: 'io_failed' });
      expect(deleted()).toContain(PICKER_URI);
    });
  });

  describe('error mapping', () => {
    it.each([
      ['unsupported_format', "Momora can't open this kind of sound file yet."],
      ['decode_failed', "Couldn't open that sound. Try again."],
      ['io_failed', "Couldn't open that sound. Try again."],
      ['too_long', 'That recording is longer than 30 minutes.'],
    ])('maps a native %s from probe to friendly copy', async (code, message) => {
      mockedAudio.probe.mockRejectedValue(Object.assign(new Error('native'), { code }));

      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'a.wma',
        mimeType: 'audio/x-ms-wma',
        entry: 'picker',
      });

      expect(result).toEqual({ kind: 'error', code, message });
      expect(deleted()).toEqual([PICKER_URI]);
    });

    it('maps an unknown error to decode_failed', async () => {
      mockedAudio.probe.mockRejectedValue(new Error('???'));

      await expect(
        importAudioFile({ uri: PICKER_URI, fileName: 'a.m4a', mimeType: null, entry: 'picker' }),
      ).resolves.toMatchObject({ kind: 'error', code: 'decode_failed' });
    });

    it('points iOS picker Ogg users to WhatsApp share, but not share-sheet or Android ones', async () => {
      mockedAudio.probe.mockRejectedValue(Object.assign(new Error('x'), { code: 'unsupported_format' }));

      await expect(
        importAudioFile({ uri: PICKER_URI, fileName: 'voice.opus', mimeType: 'audio/opus', entry: 'picker' }),
      ).resolves.toMatchObject({ code: 'unsupported_format', message: AUDIO_IMPORT_OGG_IOS_COPY });
      await expect(
        importAudioFile({ uri: PICKER_URI, fileName: 'voice.opus', mimeType: 'audio/opus', entry: 'share' }),
      ).resolves.toMatchObject({ message: AUDIO_IMPORT_ERROR_COPY.unsupported_format });

      (Platform as { OS: string }).OS = 'android';
      await expect(
        importAudioFile({ uri: PICKER_URI, fileName: 'voice.opus', mimeType: 'audio/opus', entry: 'picker' }),
      ).resolves.toMatchObject({ message: AUDIO_IMPORT_ERROR_COPY.unsupported_format });
    });

    it('discards the claimed copy and the source when analysis fails', async () => {
      mockedAudio.analyze.mockRejectedValue(Object.assign(new Error('x'), { code: 'decode_failed' }));
      const claimed: string[] = [];
      mockedFs.copyAsync.mockImplementation(async ({ to }) => {
        claimed.push(to);
      });

      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'a.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
      });

      expect(result).toMatchObject({ kind: 'error', code: 'decode_failed' });
      expect(deleted()).toEqual(expect.arrayContaining([PICKER_URI, claimed[0]]));
    });

    it('discards the claimed copy and the failed render output when the final render fails', async () => {
      mockedAudio.probe.mockResolvedValue(probeResult({ sizeBytes: 5_000_000 }));
      mockedAudio.render.mockRejectedValue(Object.assign(new Error('x'), { code: 'io_failed' }));
      const claimed: string[] = [];
      mockedFs.copyAsync.mockImplementation(async ({ to }) => {
        claimed.push(to);
      });

      const result = await importAudioFile({
        uri: PICKER_URI,
        fileName: 'a.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
      });

      expect(result).toMatchObject({ kind: 'error', code: 'io_failed' });
      const removed = deleted();
      expect(removed).toContain(claimed[0]);
      expect(removed.filter((target) => CLAIM_RE.test(target))).toHaveLength(2);
    });
  });

  describe('date suggestion', () => {
    it('prefers the file-name date over container creation time', async () => {
      mockedAudio.probe.mockResolvedValue(probeResult({ creationDate: '2026-10-11T08:50:00.000Z' }));

      const result = (await importAudioFile({
        uri: PICKER_URI,
        fileName: 'AUDIO-2026-10-02-08-00-00.m4a',
        mimeType: 'audio/mp4',
        entry: 'share',
        now: NOW,
      })) as ImportedClip;

      expect(result.suggestedDateIso).toBe('2026-10-02');
    });

    it('uses an older container creation date and ignores an export-time stamp', async () => {
      mockedAudio.probe.mockResolvedValue(probeResult({ creationDate: new Date(2026, 8, 20, 12, 0, 0).toISOString() }));
      const old = (await importAudioFile({
        uri: PICKER_URI,
        fileName: 'Voice Memo.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
        now: NOW,
      })) as ImportedClip;
      expect(old.suggestedDateIso).toBe('2026-09-20');

      mockedAudio.probe.mockResolvedValue(probeResult({ creationDate: new Date(NOW.getTime() - 60_000).toISOString() }));
      const fresh = (await importAudioFile({
        uri: PICKER_URI,
        fileName: 'Voice Memo.m4a',
        mimeType: 'audio/mp4',
        entry: 'picker',
        now: NOW,
      })) as ImportedClip;
      expect(fresh.suggestedDateIso).toBeNull();
    });
  });
});
