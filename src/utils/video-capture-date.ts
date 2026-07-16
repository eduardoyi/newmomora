// Extracts a memory-date suggestion from a video file's MP4/MOV container
// metadata. Sibling to src/utils/media-capture-date.ts (the photo EXIF
// extractor) -- same fail-closed philosophy: missing/malformed/implausible
// metadata is always a no-op (null), never a thrown error.
//
// Pure JS, no new native modules. Positioned reads (`expo-file-system`
// `readAsStringAsync` with `{ position, length, encoding: Base64 }`) let us
// walk the box ("atom") tree without loading the whole file -- important
// because a camera-recorded MP4/MOV typically stores `moov` (the metadata
// box) AFTER the multi-hundred-MB `mdat` (media data) box, and we must never
// read `mdat`'s payload, only skip over it by its declared size.
//
// The parser is split into a byte-access layer (`ByteReader`) and parsing
// logic that only calls `reader.read(position, length)` -- this is what
// makes it unit-testable against in-memory fixtures (`createInMemoryByteReader`)
// without touching the filesystem. `extractVideoCaptureDateIso` is the only
// export that talks to `expo-file-system`.
//
// Privacy: only the derived YYYY-MM-DD date scalar is ever returned. No
// other atom/box content (track metadata, GPS location atoms, device info)
// is retained past the function call, logged, or exposed to callers.

import * as FileSystem from 'expo-file-system/legacy';

// ---------------------------------------------------------------------------
// Byte reader: separates "positioned byte access" from atom parsing so the
// parsing logic can be tested against an in-memory buffer.
// ---------------------------------------------------------------------------

export interface ByteReader {
  /** Total size of the underlying file/buffer in bytes. */
  readonly size: number;
  /** Reads up to `length` bytes starting at `position`. May return fewer
   * bytes than requested near EOF; never throws for an out-of-range read. */
  read(position: number, length: number): Promise<Uint8Array>;
}

/** In-memory `ByteReader` over a pre-built buffer -- used by tests to
 * exercise the parser against synthesized atom trees without touching the
 * filesystem. */
export function createInMemoryByteReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.length,
    async read(position, length) {
      if (position >= bytes.length || length <= 0) {
        return new Uint8Array(0);
      }
      const end = Math.min(bytes.length, position + length);
      return bytes.subarray(position, end);
    },
  };
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP: Record<number, number> = {};
for (let index = 0; index < BASE64_CHARS.length; index += 1) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(index)] = index;
}

/** Minimal, dependency-free base64 -> bytes decoder. Native RN/Hermes does
 * not reliably expose `atob`/`Buffer` outside the web platform branch (see
 * `src/utils/local-files.ts`), so positioned reads -- which come back from
 * `expo-file-system` as base64 -- are decoded manually here rather than
 * assuming a global decoder exists. */
function base64ToBytes(base64: string): Uint8Array {
  const withoutPadding = base64.replace(/[\r\n]/g, '').replace(/=+$/, '');
  const outputLength = Math.floor((withoutPadding.length * 6) / 8);
  const bytes = new Uint8Array(outputLength);

  let byteIndex = 0;
  let buffer = 0;
  let bitsInBuffer = 0;

  for (let index = 0; index < withoutPadding.length; index += 1) {
    const charIndex = BASE64_LOOKUP[withoutPadding.charCodeAt(index)];
    if (charIndex === undefined) {
      continue; // skip stray whitespace/invalid characters defensively
    }
    buffer = (buffer << 6) | charIndex;
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      bytes[byteIndex] = (buffer >> bitsInBuffer) & 0xff;
      byteIndex += 1;
    }
  }

  return byteIndex === outputLength ? bytes : bytes.subarray(0, byteIndex);
}

/** `expo-file-system`-backed reader for production use. Returns null when
 * the file can't be stat'd (missing, unsupported info shape) -- callers
 * treat that as "no capture date available," matching the rest of this
 * feature's fail-open behavior. */
async function createFileByteReader(fileUri: string): Promise<ByteReader | null> {
  const info = await FileSystem.getInfoAsync(fileUri);
  if (!info.exists || !('size' in info) || typeof info.size !== 'number' || info.size <= 0) {
    return null;
  }
  const size = info.size;

  return {
    size,
    async read(position, length) {
      const clampedLength = Math.max(0, Math.min(length, size - position));
      if (clampedLength <= 0) {
        return new Uint8Array(0);
      }
      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        position,
        length: clampedLength,
      });
      return base64ToBytes(base64);
    },
  };
}

// ---------------------------------------------------------------------------
// Byte-level primitives
// ---------------------------------------------------------------------------

/** Big-endian uint32 read via multiplication (not `<<`) -- `<<` treats its
 * operands as signed 32-bit, which corrupts values with the high bit set. */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  return b0 * 16777216 + b1 * 65536 + b2 * 256 + b3;
}

/** Big-endian uint64 read as a JS number. Safe (no precision loss) for any
 * realistic file size or mac-epoch timestamp -- both are far below
 * `Number.MAX_SAFE_INTEGER`. */
function readUint64BE(bytes: Uint8Array, offset: number): number {
  const high = readUint32BE(bytes, offset);
  const low = readUint32BE(bytes, offset + 4);
  return high * 4294967296 + low;
}

function bytesToAscii(bytes: Uint8Array, offset: number, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return result;
}

/** Encodes a 1-based `ilst` item index as the same 4-byte-derived string
 * `bytesToAscii` would produce for that item's raw atom type -- `ilst`
 * children are keyed by a binary index, not an ASCII fourCC, but comparing
 * via the same String.fromCharCode representation lets `findAtom` match
 * both cases uniformly. */
function indexToAtomType(index: number): string {
  return String.fromCharCode(
    (index >>> 24) & 0xff,
    (index >>> 16) & 0xff,
    (index >>> 8) & 0xff,
    index & 0xff,
  );
}

/** Minimal UTF-8 decoder. Written manually rather than relying on a global
 * `TextDecoder` -- not guaranteed present under Hermes -- since the only
 * text this module ever decodes (Apple metadata keys, ISO 8601 date
 * strings) is short and ASCII in practice, but multi-byte sequences are
 * still handled correctly. */
function bytesToUtf8(bytes: Uint8Array): string {
  let result = '';
  let index = 0;
  while (index < bytes.length) {
    const byte1 = bytes[index] ?? 0;
    if (byte1 < 0x80) {
      result += String.fromCharCode(byte1);
      index += 1;
    } else if ((byte1 & 0xe0) === 0xc0 && index + 1 < bytes.length) {
      const byte2 = bytes[index + 1] ?? 0;
      result += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f));
      index += 2;
    } else if ((byte1 & 0xf0) === 0xe0 && index + 2 < bytes.length) {
      const byte2 = bytes[index + 1] ?? 0;
      const byte3 = bytes[index + 2] ?? 0;
      result += String.fromCharCode(
        ((byte1 & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f),
      );
      index += 3;
    } else {
      result += String.fromCharCode(byte1);
      index += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Atom (box) walking
// ---------------------------------------------------------------------------

interface AtomHeader {
  type: string;
  /** Absolute offset of the first payload byte. */
  bodyStart: number;
  /** Absolute offset one past the last payload byte. */
  bodyEnd: number;
}

/** Caps the total number of atom headers read across one extraction call --
 * a malformed or adversarial file (e.g. thousands of fake 8-byte atoms
 * before ever reaching `moov`) must bail out rather than scanning
 * indefinitely. Real MP4/MOV top-level and `moov`-child atom counts are in
 * the single digits to low dozens, so this budget is generous for valid
 * files while still bounding worst-case work. */
const MAX_ATOMS_SCANNED = 512;

interface ScanBudget {
  remaining: number;
}

/** Reads one atom header at `position`. Handles the standard 8-byte
 * `size(4) + type(4)` header, the 64-bit `largesize` extension (used when
 * `size` reads as `1`), and `size === 0` ("extends to EOF", conventionally
 * used for a trailing `mdat`). Returns null on a truncated/corrupt header,
 * a body that would run past EOF, or when the scan budget is exhausted --
 * every case is treated as "stop walking," never a thrown error. */
async function readAtomHeader(
  reader: ByteReader,
  position: number,
  budget: ScanBudget,
): Promise<AtomHeader | null> {
  if (budget.remaining <= 0) {
    return null;
  }
  budget.remaining -= 1;

  if (position + 8 > reader.size) {
    return null;
  }
  const head = await reader.read(position, 8);
  if (head.length < 8) {
    return null;
  }

  const size32 = readUint32BE(head, 0);
  const type = bytesToAscii(head, 4, 4);

  let headerSize = 8;
  let size = size32;

  if (size32 === 1) {
    if (position + 16 > reader.size) {
      return null;
    }
    const extended = await reader.read(position + 8, 8);
    if (extended.length < 8) {
      return null;
    }
    size = readUint64BE(extended, 0);
    headerSize = 16;
  } else if (size32 === 0) {
    size = reader.size - position;
  }

  if (size < headerSize) {
    return null; // corrupt: declared size smaller than its own header
  }

  const bodyStart = position + headerSize;
  const bodyEnd = position + size;
  if (bodyEnd > reader.size) {
    return null; // truncated
  }

  return { type, bodyStart, bodyEnd };
}

/** Scans sibling atoms in `[rangeStart, rangeEnd)` for the first one whose
 * type matches `targetType`, skipping non-matching atoms by their declared
 * size (never reading their payload). Used both for the top-level walk
 * (`rangeStart/End` = the whole file, so a trailing `mdat` before `moov` is
 * skipped cheaply) and for walking a container atom's direct children. */
async function findAtom(
  reader: ByteReader,
  rangeStart: number,
  rangeEnd: number,
  targetType: string,
  budget: ScanBudget,
): Promise<AtomHeader | null> {
  let position = rangeStart;
  while (position < rangeEnd) {
    const header = await readAtomHeader(reader, position, budget);
    if (!header) {
      return null;
    }
    if (header.type === targetType) {
      return header;
    }
    // Advance past this whole atom (header + body) to the next sibling.
    const advance = header.bodyEnd - position;
    if (advance <= 0) {
      return null; // safety net against an infinite loop on corrupt input
    }
    position += advance;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gregorian calendar helpers (deliberately duplicated, not imported, from
// src/utils/media-capture-date.ts -- that module's helpers are private, and
// this feature must not touch the tested/shipped photo path to share them.
// Same validation rules: reject out-of-range months/days, non-leap Feb 29,
// and enforce a `today + 1 day` future-date tolerance.)
// ---------------------------------------------------------------------------

interface DateTuple {
  year: number;
  month: number;
  day: number;
}

const MIN_CAPTURE_YEAR = 1990;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

function isValidGregorianDate(year: number, month: number, day: number): boolean {
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
  return formatDateTuple({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

/** Resolves `today + 1 calendar day` as the inclusive upper bound a
 * candidate date must not exceed. Fails closed (returns null, which makes
 * every candidate get rejected) when the injected `todayIso` is itself
 * invalid, matching the photo extractor's contract. */
function resolveUpperBoundDate(todayIso: string | undefined): DateTuple | null {
  const baseIso = todayIso ?? defaultTodayIso();
  const base = parseIsoDateStrict(baseIso);
  if (!base) {
    return null;
  }
  return addOneDay(base);
}

/** Converts a UTC instant to the device's local calendar date and applies
 * the shared sanity guards (pre-1990, more than one day in the future).
 * Both metadata sources funnel through this -- the Apple `creationdate` key
 * carries an explicit UTC offset (converted to a precise UTC instant before
 * reaching here), and the `mvhd` `creation_time` fallback is UTC with no
 * offset at all. Interpreting `mvhd`'s value as local device time (there is
 * no other information available) is the same tradeoff class as the photo
 * extractor's "no EXIF offset tag" gap -- documented here and in the plan
 * doc rather than silently assumed. */
function finalizeCandidateUtcMillis(
  utcMillis: number,
  todayIso: string | undefined,
): string | null {
  if (!Number.isFinite(utcMillis)) {
    return null;
  }
  const date = new Date(utcMillis);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const tuple: DateTuple = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };

  if (tuple.year < MIN_CAPTURE_YEAR) {
    return null;
  }

  const upperBound = resolveUpperBoundDate(todayIso);
  if (!upperBound) {
    return null;
  }
  if (compareDateTuples(tuple, upperBound) > 0) {
    return null;
  }

  return formatDateTuple(tuple);
}

// ---------------------------------------------------------------------------
// mvhd (movie header) -- creation_time fallback
// ---------------------------------------------------------------------------

const MAC_EPOCH_OFFSET_SECONDS = 2082844800; // seconds between 1904-01-01 and 1970-01-01 UTC

/** Reads `mvhd`'s `creation_time` as UTC millis-since-epoch, or null for a
 * missing/unsupported-version/zero value. `mvhd` is a "full box": byte 0 is
 * `version` (0 = 32-bit fields, 1 = 64-bit), bytes 1-3 are flags, and
 * `creation_time` immediately follows. */
async function parseMvhdCreationTimeMillis(
  reader: ByteReader,
  mvhd: AtomHeader,
): Promise<number | null> {
  const bodyLength = mvhd.bodyEnd - mvhd.bodyStart;
  if (bodyLength < 8) {
    return null;
  }
  const bytes = await reader.read(mvhd.bodyStart, Math.min(bodyLength, 16));
  if (bytes.length < 8) {
    return null;
  }

  const version = bytes[0];
  let macSeconds: number;
  if (version === 0) {
    macSeconds = readUint32BE(bytes, 4);
  } else if (version === 1) {
    if (bytes.length < 16) {
      return null;
    }
    macSeconds = readUint64BE(bytes, 4);
  } else {
    return null;
  }

  if (macSeconds === 0) {
    return null; // explicit "unknown" sentinel per the QuickTime/ISO spec
  }

  return (macSeconds - MAC_EPOCH_OFFSET_SECONDS) * 1000;
}

// ---------------------------------------------------------------------------
// Apple `com.apple.quicktime.creationdate` (moov/meta keys+ilst structure)
// ---------------------------------------------------------------------------

const APPLE_CREATION_DATE_KEY = 'com.apple.quicktime.creationdate';

/** Strict `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM|±HHMM)` parser for Apple's
 * timezone-aware metadata value. Never handed to `new Date(...)` -- engines
 * disagree on non-`Z` extended-offset parsing, and the offset is computed
 * manually so the resulting UTC instant is exact. */
const APPLE_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function parseAppleCreationDateString(rawValue: string): number | null {
  const cleaned = rawValue.replace(/\0+/g, '').trim();
  const match = APPLE_DATE_PATTERN.exec(cleaned);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetRaw = match[7] as string;

  if (!isValidGregorianDate(year, month, day)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  let offsetMinutes = 0;
  if (offsetRaw !== 'Z') {
    const sign = offsetRaw.startsWith('-') ? -1 : 1;
    const digits = offsetRaw.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMins = Number(digits.slice(2, 4));
    if (offsetHours > 14 || offsetMins > 59) {
      return null; // no real-world UTC offset exceeds +/-14:00
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }

  const localAsUtcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  return localAsUtcMillis - offsetMinutes * 60000;
}

/** Reads the `keys` atom body and returns the 1-based `ilst` item index for
 * `com.apple.quicktime.creationdate`, or null if the key isn't present. */
async function findCreationDateKeyIndex(
  reader: ByteReader,
  keys: AtomHeader,
): Promise<number | null> {
  const bodyLength = keys.bodyEnd - keys.bodyStart;
  if (bodyLength < 8) {
    return null;
  }
  const bytes = await reader.read(keys.bodyStart, bodyLength);
  if (bytes.length < 8) {
    return null;
  }

  const entryCount = readUint32BE(bytes, 4);
  let offset = 8;

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (offset + 8 > bytes.length) {
      break; // truncated key table
    }
    const entrySize = readUint32BE(bytes, offset);
    if (entrySize < 8 || offset + entrySize > bytes.length) {
      break; // corrupt entry
    }
    const valueBytes = bytes.subarray(offset + 8, offset + entrySize);
    const value = bytesToUtf8(valueBytes).replace(/\0+$/, '');
    if (value === APPLE_CREATION_DATE_KEY) {
      return entryIndex + 1; // ilst items are 1-based
    }
    offset += entrySize;
  }

  return null;
}

/** Locates and parses `moov`'s Apple `meta` (keys+ilst) structure for
 * `com.apple.quicktime.creationdate`. Checks `moov/meta` first (the layout
 * this repo has observed on iPhone-recorded files), then falls back to
 * `moov/udta/meta` (the classic QuickTime user-data nesting some encoders
 * use) before giving up. Returns UTC millis, or null if the key/structure
 * isn't present or is malformed -- callers fall back to `mvhd`. */
async function tryReadAppleCreationDateMillis(
  reader: ByteReader,
  moov: AtomHeader,
  budget: ScanBudget,
): Promise<number | null> {
  let meta = await findAtom(reader, moov.bodyStart, moov.bodyEnd, 'meta', budget);
  if (!meta) {
    const udta = await findAtom(reader, moov.bodyStart, moov.bodyEnd, 'udta', budget);
    if (udta) {
      meta = await findAtom(reader, udta.bodyStart, udta.bodyEnd, 'meta', budget);
    }
  }
  if (!meta) {
    return null;
  }

  // The mdta `meta` box is a full box: a 4-byte version+flags prefix
  // precedes its children, unlike a plain container atom.
  const metaBodyStart = meta.bodyStart + 4;
  if (metaBodyStart > meta.bodyEnd) {
    return null;
  }

  const keys = await findAtom(reader, metaBodyStart, meta.bodyEnd, 'keys', budget);
  const ilst = await findAtom(reader, metaBodyStart, meta.bodyEnd, 'ilst', budget);
  if (!keys || !ilst) {
    return null;
  }

  const keyIndex = await findCreationDateKeyIndex(reader, keys);
  if (keyIndex === null) {
    return null;
  }

  const item = await findAtom(
    reader,
    ilst.bodyStart,
    ilst.bodyEnd,
    indexToAtomType(keyIndex),
    budget,
  );
  if (!item) {
    return null;
  }

  const data = await findAtom(reader, item.bodyStart, item.bodyEnd, 'data', budget);
  if (!data) {
    return null;
  }

  const dataBodyLength = data.bodyEnd - data.bodyStart;
  if (dataBodyLength <= 8) {
    return null;
  }
  const dataBytes = await reader.read(data.bodyStart, dataBodyLength);
  if (dataBytes.length <= 8) {
    return null;
  }

  // First 4 bytes: 1-byte reserved (0) + 3-byte well-known type code.
  // Type 1 is UTF-8 text -- the type Apple uses for `creationdate`. Any
  // other type (e.g. float32, used for location) is not a date string.
  const dataType = ((dataBytes[1] ?? 0) << 16) | ((dataBytes[2] ?? 0) << 8) | (dataBytes[3] ?? 0);
  if (dataType !== 1) {
    return null;
  }

  const text = bytesToUtf8(dataBytes.subarray(8));
  return parseAppleCreationDateString(text);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts a `YYYY-MM-DD` capture date from a local MP4/MOV file's
 * container metadata by walking its top-level atom tree, or null when the
 * file can't be parsed or carries no plausible capture date. Never throws
 * -- every failure mode (truncated file, unexpected atom shape, scan budget
 * exhausted, implausible date) is a no-op null, matching the photo
 * extractor's fail-open contract.
 *
 * Prefers Apple's timezone-aware `com.apple.quicktime.creationdate`
 * (`moov/meta` keys+ilst structure); falls back to `mvhd`'s `creation_time`
 * (seconds since 1904-01-01 UTC, interpreted as UTC with no offset
 * information available -- converted to the device's current local calendar
 * date, the same tradeoff class as the photo extractor's own "no EXIF
 * offset tag" gap).
 *
 * `todayIso` is an injected `YYYY-MM-DD` "today" for deterministic tests;
 * it defaults to the device's local calendar date.
 */
export async function extractVideoCaptureDateFromReader(
  reader: ByteReader,
  todayIso?: string,
): Promise<string | null> {
  try {
    const budget: ScanBudget = { remaining: MAX_ATOMS_SCANNED };

    const moov = await findAtom(reader, 0, reader.size, 'moov', budget);
    if (!moov) {
      return null;
    }

    const appleMillis = await tryReadAppleCreationDateMillis(reader, moov, budget);
    if (appleMillis !== null) {
      const iso = finalizeCandidateUtcMillis(appleMillis, todayIso);
      if (iso) {
        return iso;
      }
      // Present but implausible (e.g. future/pre-1990) -- fall through to
      // mvhd rather than returning early, mirroring the photo extractor's
      // "higher-priority key present but invalid -> try the next candidate"
      // rule.
    }

    const mvhd = await findAtom(reader, moov.bodyStart, moov.bodyEnd, 'mvhd', budget);
    if (!mvhd) {
      return null;
    }

    const mvhdMillis = await parseMvhdCreationTimeMillis(reader, mvhd);
    if (mvhdMillis === null) {
      return null;
    }

    return finalizeCandidateUtcMillis(mvhdMillis, todayIso);
  } catch {
    return null;
  }
}

/**
 * Production entry point: reads capture-date metadata from a local video
 * file URI via positioned `expo-file-system` reads. Fails closed to null on
 * any error (missing file, unreadable, malformed container) -- a parse
 * failure is always a silent no-op, never a thrown error, so it can be
 * awaited inline in the picker's per-asset loop.
 */
export async function extractVideoCaptureDateIso(
  fileUri: string,
  todayIso?: string,
): Promise<string | null> {
  try {
    const reader = await createFileByteReader(fileUri);
    if (!reader) {
      return null;
    }
    return await extractVideoCaptureDateFromReader(reader, todayIso);
  } catch {
    return null;
  }
}
