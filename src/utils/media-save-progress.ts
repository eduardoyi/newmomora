// Edit-memory save progress + error copy (docs/features/media-memories.md,
// "Editing"). Edit blocks its screen while newly added photos/videos are
// compressed and uploaded -- unlike new-memory, which hands media to the
// background queue -- so the screen narrates that work instead of showing a
// bare spinner, and names the item that failed when one does.
import type { MediaAssetUploadPhase } from '@/services/memory-posting';
import { isVideoContentType } from '@/utils/media-validation';
import { isNetworkFailure } from '@/utils/network-errors';

export interface MediaSaveProgressEntry {
  isVideo: boolean;
  phase: MediaAssetUploadPhase | 'waiting';
  /** 0..1 within the phase. */
  fraction: number;
}

export interface MediaSaveProgressSummary {
  label: string;
  /** 0..1 across every new asset. */
  fraction: number;
}

// Share of an asset's bar spent preparing vs uploading. Video transcodes take
// real time (seconds per clip); photo metadata stripping is near-instant.
const VIDEO_PREPARE_WEIGHT = 0.4;
const PHOTO_PREPARE_WEIGHT = 0.1;

function entryFraction(entry: MediaSaveProgressEntry): number {
  const prepareWeight = entry.isVideo ? VIDEO_PREPARE_WEIGHT : PHOTO_PREPARE_WEIGHT;
  const fraction = Math.min(Math.max(entry.fraction, 0), 1);
  switch (entry.phase) {
    case 'waiting':
      return 0;
    case 'preparing':
      return prepareWeight * fraction;
    case 'uploading':
      return prepareWeight + (1 - prepareWeight) * fraction;
    case 'done':
      return 1;
  }
}

export function summarizeMediaSaveProgress(
  entries: MediaSaveProgressEntry[],
): MediaSaveProgressSummary | null {
  if (entries.length === 0) {
    return null;
  }

  const fraction = entries.reduce((sum, entry) => sum + entryFraction(entry), 0) / entries.length;
  const doneCount = entries.filter((entry) => entry.phase === 'done').length;
  if (doneCount === entries.length) {
    return { label: 'Saving…', fraction: 1 };
  }

  const percent = `${Math.round(fraction * 100)}%`;
  const position = entries.length > 1 ? ` ${doneCount + 1} of ${entries.length}` : '';
  const compressing = entries.some((entry) => entry.isVideo && entry.phase === 'preparing');
  if (compressing) {
    return { label: `Compressing video${position}… ${percent}`, fraction };
  }

  const noun = entries.length > 1 ? '' : entries[0].isVideo ? ' video' : ' photo';
  return { label: `Uploading${noun}${position}… ${percent}`, fraction };
}

const CONNECTION_HINT = 'Check your connection and try again.';

function withPeriod(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * User-facing copy for a failed edit save. `failedAsset` is set when a
 * specific photo/video failed to upload (MediaAssetUploadError.assetIndex);
 * its `position` is 1-based to match the numbered badges in the media grid.
 */
export function describeEditSaveError(
  error: unknown,
  failedAsset?: { position: number; contentType: string },
): string {
  const reason = isNetworkFailure(error)
    ? CONNECTION_HINT
    : error instanceof Error && error.message
      ? withPeriod(error.message)
      : 'Please try again.';

  if (failedAsset) {
    const noun = isVideoContentType(failedAsset.contentType) ? 'video' : 'photo';
    return `Couldn't upload ${noun} ${failedAsset.position}. ${reason}`;
  }

  return isNetworkFailure(error) ? `Couldn't save your changes. ${reason}` : reason;
}
