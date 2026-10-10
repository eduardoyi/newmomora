import { processVoiceMemory, type VoiceFamilyMemberPayload } from '@/services/ai';
import { discardAudioClip, newAudioRecordingUri } from '@/utils/audio-clip-custody';
import { getLocalFileSizeBytes, readLocalFileAsBase64 } from '@/utils/local-files';

import * as MomoraAudio from '../../modules/momora-audio';

export interface VoiceProcessingResult {
  cleanedText: string;
  /** Short AI-generated caption for a kept clip. Empty string when speech was unusable -- never an error. */
  description: string;
  mentionedMemberIds: string[];
}

export interface TranscribeClipOptions {
  /**
   * `'unknown'` marks an imported voice note (someone else may be speaking):
   * the server then skips mapping first-person mentions to the caller's own
   * member. Omit for the caller's own recordings.
   */
  speaker?: 'unknown';
  /** Decoded/recorded length when known; lets long clips take the excerpt path. */
  durationMs?: number;
  /** File size when known; looked up (native module available only) when omitted. */
  sizeBytes?: number;
}

// process-voice-memory rejects anything whose byte size implies > 120 s at an
// assumed 128 kbps (`bytes / 16000 > 120`, ~1.92 MB). Clips that could trip
// that, or that run past ~2 minutes, are cut to a 64 kbps excerpt first
// (docs/plans/audio-trim-import.md, "Transcription for any clip"). 115 s at
// 64 kbps is ~0.92 MB.
export const TRANSCRIPTION_EXCERPT_MS = 115_000;
export const TRANSCRIPTION_EXCERPT_BITRATE = 64_000;
const EXCERPT_TRIGGER_BYTES = 1_750_000;

function isAudioModuleAvailable(): boolean {
  try {
    return MomoraAudio.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Renders the first <= 115 s of `uri` into `audio-recordings/` (so a
 * force-quit leaves it to the 48 h sweep). Returns null when no excerpt is
 * needed or the render fails; the caller then sends the whole file, which is
 * today's behavior.
 */
async function renderExcerptIfNeeded(
  uri: string,
  options: TranscribeClipOptions,
): Promise<string | null> {
  if (!isAudioModuleAvailable()) {
    return null;
  }

  const isLong = options.durationMs !== undefined && options.durationMs > TRANSCRIPTION_EXCERPT_MS;
  if (!isLong) {
    const sizeBytes = options.sizeBytes ?? (await getLocalFileSizeBytes(uri)) ?? undefined;
    if (sizeBytes === undefined || sizeBytes <= EXCERPT_TRIGGER_BYTES) {
      return null;
    }
  }

  let outputUri: string | null = null;
  try {
    outputUri = await newAudioRecordingUri('m4a');
    const endMs = Math.min(options.durationMs ?? TRANSCRIPTION_EXCERPT_MS, TRANSCRIPTION_EXCERPT_MS);
    const rendered = await MomoraAudio.render(uri, {
      startMs: 0,
      endMs,
      outputUri,
      bitrate: TRANSCRIPTION_EXCERPT_BITRATE,
    });
    return rendered.uri;
  } catch {
    if (outputUri) {
      await discardAudioClip(outputUri);
    }
    return null;
  }
}

/**
 * Transcribes one clip via `process-voice-memory`. Pure (no React state): the
 * body of what `useVoiceInput` used to do inline, shared with the trim and
 * import flows. Resolves null on every failure (no family, unreadable file,
 * service error) -- a transcription failure never blocks keeping the sound.
 *
 * Never log the clip, its path, or the transcript: this is a child's voice.
 */
export async function transcribeClip(
  uri: string,
  familyMembers: VoiceFamilyMemberPayload[],
  familyId: string | null,
  options: TranscribeClipOptions = {},
): Promise<VoiceProcessingResult | null> {
  if (!familyId) {
    return null;
  }

  let excerptUri: string | null = null;
  try {
    excerptUri = await renderExcerptIfNeeded(uri, options);
    const base64 = await readLocalFileAsBase64(excerptUri ?? uri);
    const { data, error } = options.speaker
      ? await processVoiceMemory(base64, familyMembers, familyId, { speaker: options.speaker })
      : await processVoiceMemory(base64, familyMembers, familyId);

    if (error || !data) {
      return null;
    }

    return {
      cleanedText: data.cleanedText,
      // `description` is additive to today's process-voice-memory contract
      // (docs/plans/audio-memories-v1.md P1.2) -- guarded here so callers
      // still degrade gracefully against an edge function that hasn't
      // deployed the field yet.
      description: (data as { description?: string }).description ?? '',
      mentionedMemberIds: data.mentionedMemberIds,
    };
  } catch {
    return null;
  } finally {
    if (excerptUri) {
      await discardAudioClip(excerptUri);
    }
  }
}
