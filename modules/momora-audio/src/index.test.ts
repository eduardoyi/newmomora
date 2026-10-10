import { requireOptionalNativeModule } from 'expo-modules-core';

import { analyze, isAvailable, MomoraAudioError, probe, render } from './index';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<typeof import('expo-modules-core')>('expo-modules-core'),
  requireOptionalNativeModule: jest.fn(),
}));

const mockedRequire = requireOptionalNativeModule as jest.MockedFunction<
  typeof requireOptionalNativeModule
>;

const native = {
  probe: jest.fn(),
  analyze: jest.fn(),
  render: jest.fn(),
};

describe('momora-audio wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('when the native module is absent (old binary, Expo Go, web)', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(null);
    });

    it('reports unavailable and looks up the module by its Expo name', () => {
      expect(isAvailable()).toBe(false);
      expect(mockedRequire).toHaveBeenCalledWith('MomoraAudio');
    });

    it.each([
      ['probe', () => probe('file:///a.m4a')],
      ['analyze', () => analyze('file:///a.m4a', { maxBuckets: 100, minBucketMs: 20 })],
      [
        'render',
        () =>
          render('file:///a.m4a', {
            startMs: 0,
            endMs: 1000,
            outputUri: 'file:///b.m4a',
            bitrate: 96000,
          }),
      ],
    ])('%s rejects with code "unavailable"', async (_name, run) => {
      await expect(run()).rejects.toMatchObject({ code: 'unavailable' });
      await expect(run()).rejects.toBeInstanceOf(MomoraAudioError);
    });

    it('treats a throwing lookup as unavailable', () => {
      mockedRequire.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(isAvailable()).toBe(false);
    });
  });

  describe('when the native module is present', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(native as never);
    });

    it('reports available', () => {
      expect(isAvailable()).toBe(true);
    });

    it('probe passes the uri through and normalises a missing creationDate to null', async () => {
      native.probe.mockResolvedValue({
        durationMs: 1000,
        container: 'mp4',
        codec: 'aac',
        sampleRate: 48000,
        channels: 1,
        creationDate: undefined,
        sizeBytes: 123,
      });

      await expect(probe('file:///a.m4a')).resolves.toMatchObject({
        durationMs: 1000,
        creationDate: null,
      });
      expect(native.probe).toHaveBeenCalledWith('file:///a.m4a');
    });

    it('analyze rounds and clamps its options', async () => {
      const energies = { durationMs: 2000, bucketMs: 20, energies: [0.1, 0.2] };
      native.analyze.mockResolvedValue(energies);

      await expect(analyze('file:///a.m4a', { maxBuckets: 4000.4, minBucketMs: 0 })).resolves.toBe(
        energies,
      );
      expect(native.analyze).toHaveBeenCalledWith('file:///a.m4a', {
        maxBuckets: 4000,
        minBucketMs: 1,
      });
    });

    it('render forwards the window, output and bitrate', async () => {
      const result = { uri: 'file:///b.m4a', durationMs: 2500, sizeBytes: 9000 };
      native.render.mockResolvedValue(result);

      await expect(
        render('file:///a.m4a', {
          startMs: 1000.2,
          endMs: 3500,
          outputUri: 'file:///b.m4a',
          bitrate: 96000,
        }),
      ).resolves.toBe(result);
      expect(native.render).toHaveBeenCalledWith('file:///a.m4a', {
        startMs: 1000,
        endMs: 3500,
        outputUri: 'file:///b.m4a',
        bitrate: 96000,
      });
    });

    it.each(['unsupported_format', 'decode_failed', 'too_long', 'io_failed'])(
      'surfaces native error code %s as error.code',
      async (code) => {
        native.probe.mockRejectedValue(Object.assign(new Error('native failure'), { code }));

        const error = await probe('file:///a.m4a').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MomoraAudioError);
        expect(error).toMatchObject({ code, message: 'native failure' });
      },
    );

    it('maps an unrecognised native failure to decode_failed', async () => {
      native.analyze.mockRejectedValue(Object.assign(new Error('weird'), { code: 'ERR_OTHER' }));

      await expect(
        analyze('file:///a.m4a', { maxBuckets: 10, minBucketMs: 20 }),
      ).rejects.toMatchObject({ code: 'decode_failed' });
    });

    it('maps a non-Error rejection to decode_failed', async () => {
      native.render.mockRejectedValue('nope');

      await expect(
        render('file:///a.m4a', { startMs: 0, endMs: 10, outputUri: 'file:///b.m4a', bitrate: 96000 }),
      ).rejects.toMatchObject({ code: 'decode_failed' });
    });
  });
});
