import { requireOptionalNativeModule } from 'expo-modules-core';

import type {
  AnalyzeOptions,
  AudioEnergies,
  AudioErrorCode,
  AudioProbe,
  MomoraAudioNativeModule,
  RenderOptions,
  RenderResult,
} from './types';

export type {
  AnalyzeOptions,
  AudioEnergies,
  AudioErrorCode,
  AudioProbe,
  RenderOptions,
  RenderResult,
} from './types';

const NATIVE_ERROR_CODES: readonly AudioErrorCode[] = [
  'unsupported_format',
  'decode_failed',
  'too_long',
  'io_failed',
];

/** Callers branch on `error.code`; messages never contain file names or paths. */
export class MomoraAudioError extends Error {
  readonly code: AudioErrorCode;

  constructor(code: AudioErrorCode, message: string) {
    super(message);
    this.name = 'MomoraAudioError';
    this.code = code;
  }
}

/**
 * Resolved per call rather than at import: `requireOptionalNativeModule` caches, and a
 * lazy lookup keeps every caller (and test) honest about the module being optional.
 * Expo modules register through expo-modules-core (JSI), not React Native's
 * `NativeModules`, so this is the only reliable presence check. Older store binaries
 * receive new JS by OTA and do not contain this module.
 */
function getNativeModule(): MomoraAudioNativeModule | null {
  return requireOptionalNativeModule<MomoraAudioNativeModule>('MomoraAudio');
}

export function isAvailable(): boolean {
  try {
    return getNativeModule() != null;
  } catch {
    return false;
  }
}

function requireNative(): MomoraAudioNativeModule {
  const native = getNativeModule();
  if (!native) {
    throw new MomoraAudioError('unavailable', 'The native audio module is not available');
  }
  return native;
}

function toAudioError(error: unknown): MomoraAudioError {
  if (error instanceof MomoraAudioError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const known = NATIVE_ERROR_CODES.find((c) => c === code);
  // An unrecognised native failure is still a failed decode from the caller's view;
  // keep the original message out of band (it is the native, path-free description).
  const message = error instanceof Error ? error.message : 'Audio operation failed';
  return new MomoraAudioError(known ?? 'decode_failed', message);
}

async function call<T>(operation: (native: MomoraAudioNativeModule) => Promise<T>): Promise<T> {
  const native = requireNative();
  try {
    return await operation(native);
  } catch (error) {
    throw toAudioError(error);
  }
}

/** Cheap metadata read (no decode). Does not enforce the 30 minute ceiling. */
export function probe(uri: string): Promise<AudioProbe> {
  return call(async (native) => {
    const result = await native.probe(uri);
    return { ...result, creationDate: result.creationDate ?? null };
  });
}

/**
 * Mean-square energy per time bucket (see the plan's "Energy bucket spec"), streamed
 * natively so a long file never sits in memory. Rejects with `too_long` above 30 minutes.
 */
export function analyze(uri: string, options: AnalyzeOptions): Promise<AudioEnergies> {
  return call((native) =>
    native.analyze(uri, {
      maxBuckets: Math.max(1, Math.round(options.maxBuckets)),
      minBucketMs: Math.max(1, Math.round(options.minBucketMs)),
    }),
  );
}

/**
 * Decodes only [startMs, endMs) and writes AAC-LC mono 48 kHz .m4a to `outputUri`.
 * Partial output is deleted on failure.
 */
export function render(uri: string, options: RenderOptions): Promise<RenderResult> {
  return call((native) =>
    native.render(uri, {
      startMs: Math.max(0, Math.round(options.startMs)),
      endMs: Math.round(options.endMs),
      outputUri: options.outputUri,
      bitrate: Math.round(options.bitrate),
    }),
  );
}
