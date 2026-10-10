import { toIsoDate } from '@/utils/dates';

// Memory-date suggestions for imported voice notes
// (docs/plans/audio-trim-import.md, Import pipeline step 6).
//
// WhatsApp encodes the SEND time in the file name (owner-confirmed); the
// container's own creation_time is the export time for WhatsApp files, so the
// file name always wins. Both helpers return a local calendar `YYYY-MM-DD`
// like the rest of the app's memory dates, and never throw.

// iOS: AUDIO-2026-10-10-15-31-04.m4a
const WHATSAPP_IOS_PATTERN = /^AUDIO-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}-\d{2}\.[A-Za-z0-9]+$/i;
// Android: PTT-20261010-WA0007.opus (voice note) / AUD-20261010-WA0007.m4a (audio file)
const WHATSAPP_ANDROID_PATTERN = /^(?:PTT|AUD)-(\d{4})(\d{2})(\d{2})-WA\d+\.[A-Za-z0-9]+$/i;

/** An export-time stamp lands within minutes of "now"; only older stamps are trusted as a recording date. */
const MIN_CREATION_AGE_MS = 15 * 60 * 1000;

function toValidIsoDate(year: number, month: number, day: number): string | null {
  // Round-trip through Date so Feb 30 / month 13 are rejected instead of rolled over.
  const candidate = new Date(year, month - 1, day);
  if (
    year < 1900 ||
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return toIsoDate(candidate);
}

/** Local calendar date encoded in a WhatsApp voice-note file name, or null. */
export function parseVoiceNoteDate(fileName: string): string | null {
  const match = WHATSAPP_IOS_PATTERN.exec(fileName) ?? WHATSAPP_ANDROID_PATTERN.exec(fileName);
  if (!match) {
    return null;
  }
  return toValidIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/**
 * Suggested memory date for an imported clip: the file-name date first, else
 * the container `creationDate` (ISO) only when it is more than 15 minutes
 * before `now`. A date after today is never suggested (a file-name date in the
 * future is ignored and falls through to the container date). Null means "no
 * suggestion"; the caller keeps the default date.
 */
export function pickImportedMemoryDate({
  fileName,
  creationDate,
  now,
}: {
  fileName: string;
  creationDate: string | null;
  now: Date;
}): string | null {
  const today = toIsoDate(now);

  const fromFileName = parseVoiceNoteDate(fileName);
  // Zero-padded ISO dates compare correctly as strings.
  if (fromFileName && fromFileName <= today) {
    return fromFileName;
  }

  if (!creationDate) {
    return null;
  }
  const created = new Date(creationDate);
  if (Number.isNaN(created.getTime()) || now.getTime() - created.getTime() <= MIN_CREATION_AGE_MS) {
    return null;
  }
  return toIsoDate(created);
}
