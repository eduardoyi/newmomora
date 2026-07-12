// Extracts a memory-date suggestion from a photo's EXIF capture date.
//
// Platform contract (installed expo-image-picker@56.0.20): `asset.exif` is a
// flat top-level object on both iOS and Android -- iOS merges TIFF fields
// into the EXIF dictionary, Android emits flat `ExifInterface` tag names.
// There is no nested `{ Exif }` / `{ TIFF }` shape in this SDK version. Keep
// the input typed as `unknown` and fail closed (return null) if the runtime
// shape does not match what we expect; do not add speculative nested-object
// handling. Re-verify this assumption when upgrading Expo SDK or
// expo-image-picker.

/** Priority order: DateTimeOriginal (shutter press) > DateTimeDigitized
 * (scan/import) > DateTime (last-modified -- a lower-confidence fallback
 * because photo editors may rewrite it, but it remains useful for camera
 * files that omit the stronger tags). */
const CAPTURE_DATE_KEYS = ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime'] as const;

// Standard EXIF date/time form: "YYYY:MM:DD HH:MM:SS". Deliberately strict --
// this is matched manually, never handed to `new Date(...)`, which parses
// this string inconsistently (and sometimes not at all) across engines.
const EXIF_DATE_TIME_PATTERN = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MIN_EXIF_YEAR = 1900;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface DateTuple {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/** Full Gregorian calendar validation: rejects zero fields, out-of-range
 * months/days, non-leap Feb 29, and years before 1900. */
function isValidGregorianDate(year: number, month: number, day: number): boolean {
  if (year < MIN_EXIF_YEAR) {
    return false;
  }
  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  return true;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateTuple(tuple: DateTuple): string {
  return `${String(tuple.year).padStart(4, '0')}-${pad2(tuple.month)}-${pad2(tuple.day)}`;
}

function compareDateTuples(a: DateTuple, b: DateTuple): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/** Adds one calendar day, rolling over month/year boundaries (including leap
 * years) without going through `Date` arithmetic. */
function addOneDay(tuple: DateTuple): DateTuple {
  const lastDayOfMonth = daysInMonth(tuple.year, tuple.month);
  if (tuple.day < lastDayOfMonth) {
    return { year: tuple.year, month: tuple.month, day: tuple.day + 1 };
  }
  if (tuple.month < 12) {
    return { year: tuple.year, month: tuple.month + 1, day: 1 };
  }
  return { year: tuple.year + 1, month: 1, day: 1 };
}

/** Strict `YYYY-MM-DD` parse + Gregorian validation. Used both for the
 * injected/default `today` boundary and for re-validating stored
 * `capturedAtIso` values. */
function parseIsoDateStrict(value: string): DateTuple | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidGregorianDate(year, month, day)) {
    return null;
  }
  return { year, month, day };
}

function defaultTodayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return formatDateTuple({ year, month, day });
}

/** Resolves the inclusive upper bound (`today + 1 calendar day`) that a
 * capture date must not exceed. Returns null if the injected `todayIso` is
 * itself invalid -- the caller fails closed (rejects every candidate) rather
 * than weakening the future-date check. */
function resolveUpperBoundDate(todayIso: string | undefined): DateTuple | null {
  const baseIso = todayIso ?? defaultTodayIso();
  const base = parseIsoDateStrict(baseIso);
  if (!base) {
    return null;
  }
  return addOneDay(base);
}

/** Strictly parses the EXIF `YYYY:MM:DD HH:MM:SS` form (never `new
 * Date(...)`) and validates the date portion as a real Gregorian calendar
 * date. Whitespace and NUL padding (fixed-length EXIF ASCII fields are
 * frequently NUL-padded) are trimmed first. The time-of-day portion is not
 * interpreted or timezone-adjusted -- EXIF offset tags are intentionally out
 * of scope, and only the calendar date is returned. */
function parseExifDateTime(rawValue: string): DateTuple | null {
  const cleaned = rawValue.replace(/\0+/g, '').trim();
  const match = EXIF_DATE_TIME_PATTERN.exec(cleaned);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidGregorianDate(year, month, day)) {
    return null;
  }
  return { year, month, day };
}

/**
 * Extracts a `YYYY-MM-DD` capture date from a photo's EXIF object, or null
 * when metadata is absent, malformed, or implausible. Missing/bad metadata
 * is always a no-op -- this never throws.
 *
 * `todayIso` is an injected `YYYY-MM-DD` "today" for deterministic tests; it
 * defaults to the device's local calendar date. Dates later than
 * `todayIso + 1 calendar day` are rejected (camera/device timezone
 * tolerance) without being clamped -- the literal camera-local date is
 * preserved.
 */
export function extractCaptureDateIso(exif: unknown, todayIso?: string): string | null {
  if (exif === null || typeof exif !== 'object' || Array.isArray(exif)) {
    return null;
  }

  const upperBound = resolveUpperBoundDate(todayIso);
  if (!upperBound) {
    return null;
  }

  const record = exif as Record<string, unknown>;

  for (const key of CAPTURE_DATE_KEYS) {
    const rawValue = record[key];
    if (typeof rawValue !== 'string') {
      continue;
    }

    const parsed = parseExifDateTime(rawValue);
    if (!parsed) {
      // Higher-priority key present but invalid -- fall through to the next
      // candidate instead of returning early.
      continue;
    }

    if (compareDateTuples(parsed, upperBound) > 0) {
      continue;
    }

    return formatDateTuple(parsed);
  }

  return null;
}

/**
 * Returns the earliest valid `capturedAtIso` across the given attachments,
 * or null when the list is empty or none has a valid date. Only values that
 * themselves pass strict Gregorian ISO validation are considered -- ISO date
 * strings are safe to compare lexicographically only after that validation.
 */
export function deriveSuggestedMemoryDate(
  attachments: readonly { capturedAtIso?: string }[],
): string | null {
  let earliest: string | null = null;

  for (const attachment of attachments) {
    const iso = attachment.capturedAtIso;
    if (!iso || !parseIsoDateStrict(iso)) {
      continue;
    }
    if (earliest === null || iso < earliest) {
      earliest = iso;
    }
  }

  return earliest;
}
