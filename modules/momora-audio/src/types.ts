export interface AudioProbe {
  durationMs: number;
  container: 'mp4' | 'ogg' | 'caf' | 'wav' | 'aiff' | 'mp3' | 'amr' | 'other';
  codec: 'aac' | 'opus' | 'pcm' | 'mp3' | 'amr' | 'other';
  sampleRate: number;
  channels: number;
  /** Container metadata, ISO 8601; may be the export time (WhatsApp), not the recording time. */
  creationDate: string | null;
  sizeBytes: number;
}

export interface AudioEnergies {
  /** Decoded length, `round(samples * 1000 / sampleRate)`. */
  durationMs: number;
  /** >= minBucketMs, chosen so the bucket count is <= maxBuckets. */
  bucketMs: number;
  /** Mean-square of the mono-downmixed float PCM per bucket. */
  energies: number[];
}

export interface RenderResult {
  /** `file://` URI of the written AAC-LC .m4a (mono, 48 kHz). */
  uri: string;
  /** Duration of the output file. */
  durationMs: number;
  sizeBytes: number;
}

export interface AnalyzeOptions {
  maxBuckets: number;
  minBucketMs: number;
}

export interface RenderOptions {
  startMs: number;
  endMs: number;
  outputUri: string;
  /** Bits per second, e.g. 96000. */
  bitrate: number;
}

/**
 * Stable error codes. The four native ones are produced identically by the iOS and
 * Android modules; `unavailable` is produced here when the native module is missing
 * (Expo Go, web, or a store binary built before this module existed).
 */
export type AudioErrorCode =
  | 'unsupported_format'
  | 'decode_failed'
  | 'too_long'
  | 'io_failed'
  | 'unavailable';

/** Native surface as exposed by the Expo module (before error normalisation). */
export interface MomoraAudioNativeModule {
  probe: (uri: string) => Promise<AudioProbe>;
  analyze: (uri: string, options: AnalyzeOptions) => Promise<AudioEnergies>;
  render: (uri: string, options: RenderOptions) => Promise<RenderResult>;
}
