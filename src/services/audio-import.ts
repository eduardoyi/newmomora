// Brings an outside sound (WhatsApp / Voice Memos / Files voice note) into the
// composer as an audio-memory clip (docs/plans/audio-trim-import.md, "Import
// pipeline"). Pure service: it never opens UI. A source longer than 5:00
// comes back as `needsTrim` and the composer opens the trim sheet once the
// picker / previous Modal has fully dismissed.
//
// Privacy: this handles a family's voice recordings. Never log file names,
// paths, or durations finer than the caller buckets; failures surface as a
// stable `code` only.
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import {
  claimAudioClip,
  discardAudioClip,
  newAudioRecordingUri,
} from '@/utils/audio-clip-custody';
import {
  sanitizeWaveform,
  suggestTrim,
  waveformFromEnergies,
} from '@/utils/audio-waveform';
import { pickImportedMemoryDate } from '@/utils/voice-note-date';

import * as MomoraAudio from '../../modules/momora-audio';
import type { AudioEnergies, AudioProbe } from '../../modules/momora-audio';

export type AudioImportEntry = 'share' | 'picker';

export type AudioImportErrorCode =
  | 'unsupported_format'
  | 'too_long'
  | 'decode_failed'
  | 'io_failed'
  | 'unavailable';

/** Sources above this are refused before anything is copied. */
export const IMPORT_MAX_SOURCE_BYTES = 200 * 1024 * 1024;
/** Sources longer than this are refused outright ("longer than 30 minutes"). */
export const IMPORT_MAX_SOURCE_DURATION_MS = 30 * 60 * 1000;
/** Imports up to this length are saved as-is; longer ones must be trimmed first. */
export const IMPORT_MAX_CLIP_DURATION_MS = 5 * 60 * 1000;
/** AAC passthrough is only safe while the file stays under the 5 MB upload cap with headroom. */
export const IMPORT_PASSTHROUGH_MAX_BYTES = 4.5 * 1024 * 1024;
export const IMPORT_RENDER_BITRATE = 96_000;
const ANALYZE_OPTIONS = { maxBuckets: 4000, minBucketMs: 20 } as const;

export const AUDIO_IMPORT_ERROR_COPY: Record<AudioImportErrorCode, string> = {
  unsupported_format: "Momora can't open this kind of sound file yet.",
  too_long: 'That recording is longer than 30 minutes.',
  decode_failed: "Couldn't open that sound. Try again.",
  io_failed: "Couldn't open that sound. Try again.",
  unavailable: 'Update Momora to bring in voice notes.',
};

/** iOS cannot decode Ogg yet; WhatsApp's own share route hands us AAC instead. */
export const AUDIO_IMPORT_OGG_IOS_COPY =
  "Momora can't open this kind of sound file yet. In WhatsApp, use Forward → Share → Momora instead.";

export interface ImportedAudioOriginal {
  /** The pre-trim source the trim sheet edits relative to (claimed, in audio-recordings/). */
  localUri: string;
  durationMs: number;
  sizeBytes: number;
  energies: AudioEnergies;
  /** True when this exact file can be uploaded as the memory's clip (AAC/MP4, <= 5:00, <= 4.5 MB). */
  uploadable: boolean;
  /** Imports are transcribed by the composer; nothing to restore yet. */
  transcription: null;
}

export interface ImportedClip {
  kind: 'clip';
  clip: {
    /** The file that will be saved. Equals `original.localUri` for a passthrough import. */
    localUri: string;
    durationMs: number;
    sizeBytes: number;
    waveform: number[] | null;
    source: 'imported';
  };
  original: ImportedAudioOriginal;
  /** Local `YYYY-MM-DD` for `useSuggestedMemoryDate`, or null for "no suggestion". */
  suggestedDateIso: string | null;
}

export interface NeedsTrim {
  kind: 'needsTrim';
  /** Longer than 5:00: `uploadable` is always false. */
  original: ImportedAudioOriginal;
  /** `suggestTrim` over the whole source (may itself exceed 5:00); null when nothing worth cutting. */
  suggested: { startMs: number; endMs: number } | null;
  suggestedDateIso: string | null;
}

export interface ImportError {
  kind: 'error';
  code: AudioImportErrorCode;
  /** Friendly composer copy for `code` (see AUDIO_IMPORT_ERROR_COPY). */
  message: string;
}

export type AudioImportResult = ImportedClip | NeedsTrim | ImportError;

export interface ImportAudioFileInput {
  uri: string;
  fileName: string;
  mimeType: string | null | undefined;
  /** Size the platform reported (picker `size`, share `contentSize`); checked before copying. */
  sizeBytes?: number | null;
  entry: AudioImportEntry;
  now?: Date;
}

const KNOWN_ERROR_CODES: readonly AudioImportErrorCode[] = [
  'unsupported_format',
  'too_long',
  'decode_failed',
  'io_failed',
  'unavailable',
];

const CONTAINER_EXTENSIONS: Partial<Record<AudioProbe['container'], string>> = {
  mp4: 'm4a',
  ogg: 'ogg',
  caf: 'caf',
  wav: 'wav',
  aiff: 'aiff',
  mp3: 'mp3',
  amr: 'amr',
};

const OGG_LIKE_EXTENSIONS = new Set(['ogg', 'oga', 'opus']);

function extensionOf(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(fileName);
  return match ? match[1].toLowerCase() : null;
}

function isOggLike(fileName: string, mimeType: string | null | undefined): boolean {
  const extension = extensionOf(fileName);
  if (extension && OGG_LIKE_EXTENSIONS.has(extension)) {
    return true;
  }
  const mime = (mimeType ?? '').toLowerCase();
  return mime === 'application/ogg' || mime === 'audio/ogg' || mime === 'audio/opus';
}

function errorResult(
  code: AudioImportErrorCode,
  input?: Pick<ImportAudioFileInput, 'fileName' | 'mimeType' | 'entry'>,
): ImportError {
  const isIosOggFromPicker =
    code === 'unsupported_format' &&
    input?.entry === 'picker' &&
    Platform.OS === 'ios' &&
    isOggLike(input.fileName, input.mimeType);
  return {
    kind: 'error',
    code,
    message: isIosOggFromPicker ? AUDIO_IMPORT_OGG_IOS_COPY : AUDIO_IMPORT_ERROR_COPY[code],
  };
}

function toErrorCode(error: unknown): AudioImportErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  const known = KNOWN_ERROR_CODES.find((candidate) => candidate === code);
  return known ?? 'decode_failed';
}

/**
 * The source copy is only ours to delete when it sits in the app cache (the
 * picker's `copyToCacheDirectory`, Android share payloads) or the iOS
 * app-group container (share extension payloads). Never a user's Files
 * location or the app's document directory.
 */
function isDisposableSourceUri(uri: string): boolean {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (cacheDirectory && uri.startsWith(cacheDirectory)) {
    return true;
  }
  return uri.includes('/Containers/Shared/AppGroup/');
}

/**
 * Whether expo-audio can play this file directly for the trim preview. AVPlayer
 * handles AAC/MP4 everywhere and MP3/WAV/CAF on iOS; anything else (Ogg,
 * AMR, ...) is first rendered once to a playable `.m4a`.
 */
function isPlayableOriginal(probe: AudioProbe): boolean {
  if (probe.codec === 'aac' && probe.container === 'mp4') {
    return true;
  }
  return (
    Platform.OS === 'ios' &&
    (probe.container === 'mp3' || probe.container === 'wav' || probe.container === 'caf') &&
    (probe.codec === 'mp3' || probe.codec === 'pcm' || probe.codec === 'aac')
  );
}

/**
 * Imports one outside sound. Resolves with a ready clip, a "must trim" hand-off
 * (longer than 5:00), or a typed error; never throws and never opens UI.
 *
 * Source cleanup: the picker cache copy / share payload copy is deleted once
 * the claimed copy exists (or immediately on a terminal failure), but only when
 * it lives in the app cache / app-group container. Every file this function
 * creates in `audio-recordings/` is discarded again if the import fails.
 */
export async function importAudioFile(input: ImportAudioFileInput): Promise<AudioImportResult> {
  const { uri, fileName, mimeType, entry } = input;
  const now = input.now ?? new Date();
  const errorContext = { fileName, mimeType, entry };
  const sourceIsOurs = isDisposableSourceUri(uri);
  const disposeSource = async () => {
    if (sourceIsOurs) {
      await discardAudioClip(uri);
    }
  };
  const created: string[] = [];
  const discardCreated = async () => {
    await Promise.all(created.map((createdUri) => discardAudioClip(createdUri)));
  };

  try {
    if (!MomoraAudio.isAvailable()) {
      await disposeSource();
      return errorResult('unavailable', errorContext);
    }

    // 1. Cheap guards before anything is copied.
    if (typeof input.sizeBytes === 'number' && input.sizeBytes > IMPORT_MAX_SOURCE_BYTES) {
      await disposeSource();
      return errorResult('too_long', errorContext);
    }

    const probe = await MomoraAudio.probe(uri);
    if (
      probe.durationMs > IMPORT_MAX_SOURCE_DURATION_MS ||
      probe.sizeBytes > IMPORT_MAX_SOURCE_BYTES
    ) {
      await disposeSource();
      return errorResult('too_long', errorContext);
    }

    // 2. Claim a copy into audio-recordings/ (custody + 48 h sweep), then drop
    // the cache / app-group copy so a child's voice note does not linger
    // outside our directory. Only after the claim succeeded.
    const extension =
      CONTAINER_EXTENSIONS[probe.container] ?? extensionOf(fileName) ?? 'm4a';
    const claimedUri = await claimAudioClip(uri, extension).catch(() => {
      // expo-file-system errors carry no stable code; a failed copy is io.
      throw Object.assign(new Error('Could not copy the sound'), { code: 'io_failed' });
    });
    created.push(claimedUri);
    await disposeSource();

    // 3. Playable original: a source the preview player cannot decode is
    // rendered once, whole, to AAC and that becomes the original.
    let originalUri = claimedUri;
    let originalSizeBytes = probe.sizeBytes;
    let originalIsAacMp4 = probe.codec === 'aac' && probe.container === 'mp4';
    if (!isPlayableOriginal(probe)) {
      const intermediateUri = await newAudioRecordingUri('m4a');
      created.push(intermediateUri);
      const rendered = await MomoraAudio.render(claimedUri, {
        startMs: 0,
        endMs: probe.durationMs,
        outputUri: intermediateUri,
        bitrate: IMPORT_RENDER_BITRATE,
      });
      await discardAudioClip(claimedUri);
      created.splice(created.indexOf(claimedUri), 1);
      originalUri = rendered.uri;
      originalSizeBytes = rendered.sizeBytes;
      originalIsAacMp4 = true;
    }

    // 4. Loudness energies (trim sheet + waveform). Durations come from the
    // decoded length, not container metadata.
    const energies = await MomoraAudio.analyze(originalUri, ANALYZE_OPTIONS);
    const durationMs = energies.durationMs;
    const suggestedDateIso = pickImportedMemoryDate({
      fileName,
      creationDate: probe.creationDate,
      now,
    });

    // 5. Longer than 5:00: the composer opens the trim sheet in must-trim mode.
    if (durationMs > IMPORT_MAX_CLIP_DURATION_MS) {
      return {
        kind: 'needsTrim',
        original: {
          localUri: originalUri,
          durationMs,
          sizeBytes: originalSizeBytes,
          energies,
          uploadable: false,
          transcription: null,
        },
        suggested: suggestTrim(energies.energies, energies.bucketMs),
        suggestedDateIso,
      };
    }

    const waveform = sanitizeWaveform(waveformFromEnergies(energies.energies));
    const isPassthrough = originalIsAacMp4 && originalSizeBytes <= IMPORT_PASSTHROUGH_MAX_BYTES;

    // 6. Passthrough avoids a generation loss for typical AAC voice notes;
    // everything else is re-encoded at 96 kbps (5 min ~ 3.6 MB < 5 MB cap).
    let clipUri = originalUri;
    let clipSizeBytes = originalSizeBytes;
    if (!isPassthrough) {
      const renderedUri = await newAudioRecordingUri('m4a');
      created.push(renderedUri);
      const rendered = await MomoraAudio.render(originalUri, {
        startMs: 0,
        endMs: durationMs,
        outputUri: renderedUri,
        bitrate: IMPORT_RENDER_BITRATE,
      });
      clipUri = rendered.uri;
      clipSizeBytes = rendered.sizeBytes;
    }

    return {
      kind: 'clip',
      clip: {
        localUri: clipUri,
        durationMs,
        sizeBytes: clipSizeBytes,
        waveform,
        source: 'imported',
      },
      original: {
        localUri: originalUri,
        durationMs,
        sizeBytes: originalSizeBytes,
        energies,
        uploadable: isPassthrough,
        transcription: null,
      },
      suggestedDateIso,
    };
  } catch (error) {
    await disposeSource();
    await discardCreated();
    return errorResult(toErrorCode(error), errorContext);
  }
}
