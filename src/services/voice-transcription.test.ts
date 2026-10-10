import * as FileSystem from 'expo-file-system/legacy';

import { processVoiceMemory } from '@/services/ai';

import * as MomoraAudio from '../../modules/momora-audio';
import { transcribeClip } from './voice-transcription';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  processVoiceMemory: jest.fn(),
}));

jest.mock('../../modules/momora-audio', () => ({
  isAvailable: jest.fn(),
  render: jest.fn(),
  probe: jest.fn(),
  analyze: jest.fn(),
}));

const mockedFileSystem = FileSystem as jest.Mocked<typeof FileSystem>;
const mockedProcessVoiceMemory = processVoiceMemory as jest.MockedFunction<typeof processVoiceMemory>;
const mockedAudio = MomoraAudio as jest.Mocked<typeof MomoraAudio>;

const MEMBERS = [{ id: 'member-1', name: 'Lila' }];
const CLIP = 'file:///documents/audio-recordings/1760000000000-clip.m4a';

function setFileSize(sizeBytes: number | null) {
  mockedFileSystem.getInfoAsync.mockImplementation(async (uri: string) => {
    if (uri.endsWith('/audio-recordings/')) {
      return { exists: true, uri, isDirectory: true } as never;
    }
    return sizeBytes === null
      ? ({ exists: false, uri, isDirectory: false } as never)
      : ({ exists: true, uri, isDirectory: false, size: sizeBytes } as never);
  });
}

describe('transcribeClip', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedFileSystem.makeDirectoryAsync.mockResolvedValue(undefined);
    mockedFileSystem.deleteAsync.mockResolvedValue(undefined);
    mockedFileSystem.readAsStringAsync.mockImplementation(async (uri: string) =>
      uri === CLIP ? 'whole-file-b64' : 'excerpt-b64',
    );
    mockedProcessVoiceMemory.mockResolvedValue({
      data: { cleanedText: 'Lila laughed', description: 'Lila laughing', mentionedMemberIds: ['member-1'] },
      error: null,
    });
    mockedAudio.isAvailable.mockReturnValue(true);
    mockedAudio.render.mockImplementation(async (_uri, options) => ({
      uri: options.outputUri,
      durationMs: options.endMs,
      sizeBytes: 900_000,
    }));
    setFileSize(500_000);
  });

  it('returns null without calling the service when there is no family', async () => {
    const result = await transcribeClip(CLIP, MEMBERS, null);

    expect(result).toBeNull();
    expect(mockedProcessVoiceMemory).not.toHaveBeenCalled();
  });

  it('sends the whole file and maps the response for a short clip', async () => {
    const result = await transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 30_000, sizeBytes: 500_000 });

    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith('whole-file-b64', MEMBERS, 'family-1');
    expect(mockedAudio.render).not.toHaveBeenCalled();
    expect(result).toEqual({
      cleanedText: 'Lila laughed',
      description: 'Lila laughing',
      mentionedMemberIds: ['member-1'],
    });
  });

  it('defaults a missing description to an empty string', async () => {
    mockedProcessVoiceMemory.mockResolvedValue({
      data: { cleanedText: 'hi', mentionedMemberIds: [] } as never,
      error: null,
    });

    await expect(transcribeClip(CLIP, MEMBERS, 'family-1')).resolves.toEqual({
      cleanedText: 'hi',
      description: '',
      mentionedMemberIds: [],
    });
  });

  it('passes speaker: unknown through for imported clips', async () => {
    await transcribeClip(CLIP, MEMBERS, 'family-1', { speaker: 'unknown', durationMs: 10_000, sizeBytes: 100_000 });

    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith('whole-file-b64', MEMBERS, 'family-1', {
      speaker: 'unknown',
    });
  });

  it('returns null on a service error or a thrown read', async () => {
    mockedProcessVoiceMemory.mockResolvedValueOnce({
      data: null,
      error: { code: 'X', message: 'nope' } as never,
    });
    await expect(transcribeClip(CLIP, MEMBERS, 'family-1')).resolves.toBeNull();

    mockedFileSystem.readAsStringAsync.mockRejectedValueOnce(new Error('unreadable'));
    await expect(transcribeClip(CLIP, MEMBERS, 'family-1')).resolves.toBeNull();
  });

  it('renders and sends a 64 kbps excerpt for a clip longer than 115 s, then deletes it', async () => {
    await transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 240_000, sizeBytes: 3_000_000 });

    expect(mockedAudio.render).toHaveBeenCalledTimes(1);
    const [renderedFrom, renderOptions] = mockedAudio.render.mock.calls[0];
    expect(renderedFrom).toBe(CLIP);
    expect(renderOptions).toMatchObject({ startMs: 0, endMs: 115_000, bitrate: 64_000 });
    expect(renderOptions.outputUri).toMatch(/^file:\/\/\/documents\/audio-recordings\/\d{13}-[a-f0-9-]+\.m4a$/);
    expect(mockedFileSystem.readAsStringAsync).toHaveBeenCalledWith(
      renderOptions.outputUri,
      expect.anything(),
    );
    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith('excerpt-b64', MEMBERS, 'family-1');
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(renderOptions.outputUri, { idempotent: true });
    expect(mockedFileSystem.deleteAsync).not.toHaveBeenCalledWith(CLIP, expect.anything());
  });

  it('takes the excerpt path for a big file even when the duration is short', async () => {
    await transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 100_000, sizeBytes: 1_900_000 });

    expect(mockedAudio.render.mock.calls[0][1]).toMatchObject({ startMs: 0, endMs: 100_000 });
    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith('excerpt-b64', MEMBERS, 'family-1');
  });

  it('looks up the size itself when only the duration is known', async () => {
    setFileSize(1_900_000);

    await transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 110_000 });

    expect(mockedAudio.render).toHaveBeenCalledTimes(1);
  });

  it('does not render when a lookup says the file is small', async () => {
    setFileSize(900_000);

    await transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 60_000 });

    expect(mockedAudio.render).not.toHaveBeenCalled();
    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith('whole-file-b64', MEMBERS, 'family-1');
  });

  it('sends the whole file when the native module is unavailable (today behavior)', async () => {
    mockedAudio.isAvailable.mockReturnValue(false);

    await transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 240_000, sizeBytes: 3_000_000 });

    expect(mockedAudio.render).not.toHaveBeenCalled();
    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith('whole-file-b64', MEMBERS, 'family-1');
  });

  it('falls back to the whole file and cleans up when the excerpt render fails', async () => {
    mockedAudio.render.mockRejectedValue(Object.assign(new Error('io'), { code: 'io_failed' }));

    await transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 240_000, sizeBytes: 3_000_000 });

    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith('whole-file-b64', MEMBERS, 'family-1');
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      expect.stringMatching(/audio-recordings\/\d{13}-/),
      { idempotent: true },
    );
  });

  it('deletes the excerpt even when the transcription call throws', async () => {
    mockedProcessVoiceMemory.mockRejectedValue(new Error('network'));

    await expect(
      transcribeClip(CLIP, MEMBERS, 'family-1', { durationMs: 240_000, sizeBytes: 3_000_000 }),
    ).resolves.toBeNull();
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  });
});
