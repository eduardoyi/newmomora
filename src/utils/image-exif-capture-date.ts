// Bounded EXIF capture-date extraction for incoming shared images. This file
// deliberately recognizes only JPEG and HEVC-backed HEIF, reads no GPS IFD,
// and returns only the validated YYYY-MM-DD scalar.

import { createFileByteReader } from './byte-reader';
import type { ByteReader } from './byte-reader';
import { extractCaptureDateIso } from './media-capture-date';

const HEAD_BYTES = 64 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_NATIVE_READS = 16;
const MAX_JPEG_SEGMENTS = 64;
const MAX_BOXES = 128;
const MAX_IFD_ENTRIES = 64;
const MAX_TOTAL_IFD_ENTRIES = 128;
const MAX_ASCII_LENGTH = 32;
const MAX_STRUCTURE_BYTES = 128 * 1024;
const HEVC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function isSafeRange(start: number, length: number, end: number): boolean {
  return Number.isSafeInteger(start)
    && Number.isSafeInteger(length)
    && Number.isSafeInteger(end)
    && start >= 0
    && length >= 0
    && start <= end
    && length <= end - start;
}

function addSafe(left: number, right: number): number | null {
  const value = left + right;
  return Number.isSafeInteger(value) ? value : null;
}

function multiplySafe(left: number, right: number): number | null {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : null;
}

function u16(bytes: Uint8Array, offset: number, littleEndian = false): number {
  if (littleEndian) {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  }
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32(bytes: Uint8Array, offset: number, littleEndian = false): number {
  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  const third = bytes[offset + 2] ?? 0;
  const fourth = bytes[offset + 3] ?? 0;
  if (littleEndian) {
    return fourth * 16777216 + third * 65536 + second * 256 + first;
  }
  return first * 16777216 + second * 65536 + third * 256 + fourth;
}

function u64(bytes: Uint8Array, offset: number, littleEndian = false): number | null {
  const high = littleEndian ? u32(bytes, offset + 4, true) : u32(bytes, offset);
  const low = littleEndian ? u32(bytes, offset, true) : u32(bytes, offset + 4);
  const value = high * 4294967296 + low;
  return Number.isSafeInteger(value) ? value : null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

/** Exact, budgeted reads with a 64 KiB read-through head cache. */
class BoundedReader {
  private head: Uint8Array | null = null;
  private readBytes = 0;
  private nativeReads = 0;

  constructor(private readonly source: ByteReader) {}

  get size(): number {
    return this.source.size;
  }

  async initialize(): Promise<boolean> {
    const length = Math.min(HEAD_BYTES, this.size);
    if (length <= 0) return false;
    const bytes = await this.source.read(0, length);
    if (bytes.length !== length) return false;
    this.head = bytes;
    this.readBytes = length;
    this.nativeReads = 1;
    return true;
  }

  async exact(start: number, length: number, limitStart = 0, limitEnd = this.size): Promise<Uint8Array | null> {
    if (!isSafeRange(start, length, this.size) || !isSafeRange(start, length, limitEnd)
      || start < limitStart || limitStart < 0 || limitEnd > this.size) {
      return null;
    }
    const end = start + length;
    if (this.head && end <= this.head.length) {
      return this.head.subarray(start, end);
    }
    if (this.nativeReads >= MAX_NATIVE_READS || this.readBytes + length > MAX_READ_BYTES) {
      return null;
    }
    const bytes = await this.source.read(start, length);
    this.nativeReads += 1;
    this.readBytes += length;
    return bytes.length === length ? bytes : null;
  }
}

interface Box {
  type: string;
  bodyStart: number;
  bodyEnd: number;
}

interface BoxBudget { remaining: number }

async function readBox(
  reader: BoundedReader,
  position: number,
  parentEnd: number,
  budget: BoxBudget,
): Promise<Box | null> {
  if (budget.remaining <= 0 || !isSafeRange(position, 8, parentEnd)) return null;
  budget.remaining -= 1;
  const header = await reader.exact(position, 8, position, parentEnd);
  if (!header) return null;
  const size32 = u32(header, 0);
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    const extended = await reader.exact(position + 8, 8, position, parentEnd);
    if (!extended) return null;
    const parsed = u64(extended, 0);
    if (parsed === null) return null;
    size = parsed;
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - position;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || size > parentEnd - position) return null;
  return { type: ascii(header, 4, 4), bodyStart: position + headerSize, bodyEnd: position + size };
}

async function childBoxes(
  reader: BoundedReader,
  start: number,
  end: number,
  budget: BoxBudget,
): Promise<Box[] | null> {
  const boxes: Box[] = [];
  let position = start;
  while (position < end) {
    const box = await readBox(reader, position, end, budget);
    if (!box) return null;
    boxes.push(box);
    position = box.bodyEnd;
  }
  return position === end ? boxes : null;
}

interface TiffRange { start: number; end: number }
interface TiffDates { DateTimeOriginal?: string; DateTimeDigitized?: string; DateTime?: string }

async function parseTiff(reader: BoundedReader, range: TiffRange): Promise<TiffDates | null> {
  if (!isSafeRange(range.start, 8, range.end)) return null;
  const header = await reader.exact(range.start, 8, range.start, range.end);
  if (!header) return null;
  const littleEndian = header[0] === 0x49 && header[1] === 0x49;
  const bigEndian = header[0] === 0x4d && header[1] === 0x4d;
  if (!littleEndian && !bigEndian || u16(header, 2, littleEndian) !== 42) return null;
  const firstIfdOffset = u32(header, 4, littleEndian);
  const firstIfdStart = addSafe(range.start, firstIfdOffset);
  if (firstIfdStart === null) return null;

  let totalEntries = 0;
  const dates: TiffDates = {};
  let exifIfdOffset: number | null = null;

  const readAscii = async (entry: Uint8Array, type: number, count: number): Promise<string | null> => {
    if (type !== 2 || count <= 0 || count > MAX_ASCII_LENGTH) return null;
    if (count <= 4) return ascii(entry, 8, count);
    const offset = u32(entry, 8, littleEndian);
    const valueStart = addSafe(range.start, offset);
    if (valueStart === null) return null;
    const value = await reader.exact(valueStart, count, range.start, range.end);
    return value ? ascii(value, 0, count) : null;
  };

  const parseIfd = async (ifdStart: number, isExifIfd: boolean): Promise<boolean> => {
    if (!isSafeRange(ifdStart, 2, range.end) || ifdStart < range.start) return false;
    const countBytes = await reader.exact(ifdStart, 2, range.start, range.end);
    if (!countBytes) return false;
    const count = u16(countBytes, 0, littleEndian);
    if (count > MAX_IFD_ENTRIES || totalEntries + count > MAX_TOTAL_IFD_ENTRIES) return false;
    const entriesLength = multiplySafe(count, 12);
    const tableLength = entriesLength === null ? null : addSafe(entriesLength, 4);
    if (tableLength === null || !isSafeRange(ifdStart + 2, tableLength, range.end)) return false;
    const table = await reader.exact(ifdStart + 2, tableLength, range.start, range.end);
    if (!table) return false;
    totalEntries += count;
    const seenTargetTags = new Set<number>();

    for (let index = 0; index < count; index += 1) {
      const entry = table.subarray(index * 12, index * 12 + 12);
      const tag = u16(entry, 0, littleEndian);
      const type = u16(entry, 2, littleEndian);
      const valueCount = u32(entry, 4, littleEndian);
      const isTargetTag = (!isExifIfd && (tag === 0x8769 || tag === 0x0132))
        || (isExifIfd && (tag === 0x9003 || tag === 0x9004));
      if (isTargetTag) {
        if (seenTargetTags.has(tag)) return false;
        seenTargetTags.add(tag);
      }
      if (!isExifIfd && tag === 0x8769) {
        if (type !== 4 || valueCount !== 1) return false;
        exifIfdOffset = u32(entry, 8, littleEndian);
      } else if (!isExifIfd && tag === 0x0132) {
        const value = await readAscii(entry, type, valueCount);
        if (value !== null) dates.DateTime = value;
      } else if (isExifIfd && tag === 0x9003) {
        const value = await readAscii(entry, type, valueCount);
        if (value !== null) dates.DateTimeOriginal = value;
      } else if (isExifIfd && tag === 0x9004) {
        const value = await readAscii(entry, type, valueCount);
        if (value !== null) dates.DateTimeDigitized = value;
      }
    }
    return true;
  };

  if (!(await parseIfd(firstIfdStart, false))) return null;
  if (exifIfdOffset !== null) {
    const exifStart = addSafe(range.start, exifIfdOffset);
    if (exifStart === null || !(await parseIfd(exifStart, true))) return null;
  }
  return dates;
}

async function parseJpeg(reader: BoundedReader): Promise<TiffDates | null> {
  let position = 2;
  let scanUnits = 0;
  let exifRange: TiffRange | null = null;
  let exifCount = 0;
  let reachedSos = false;

  while (position < reader.size) {
    if (scanUnits >= MAX_JPEG_SEGMENTS || position > MAX_READ_BYTES) return null;
    const markerStart = await reader.exact(position, 2);
    if (!markerStart || markerStart[0] !== 0xff) return null;
    let markerOffset = position + 1;
    let marker = markerStart[1] ?? 0;
    scanUnits += 1;
    while (marker === 0xff) {
      if (scanUnits >= MAX_JPEG_SEGMENTS) return null;
      scanUnits += 1;
      markerOffset += 1;
      if (markerOffset > MAX_READ_BYTES) return null;
      const byte = await reader.exact(markerOffset, 1);
      if (!byte) return null;
      marker = byte[0] ?? 0;
    }
    position = markerOffset + 1;
    if (marker === 0xda) {
      // SOS is length-bearing. Its header must be complete and contained even
      // though entropy-coded image data after it is deliberately not scanned.
      const sosLengthBytes = await reader.exact(position, 2);
      if (!sosLengthBytes) return null;
      const sosLength = u16(sosLengthBytes, 0);
      if (sosLength < 2) return null;
      const sosEnd = addSafe(position, sosLength);
      if (sosEnd === null || sosEnd > reader.size || sosEnd > MAX_READ_BYTES) return null;
      reachedSos = true;
      break; // SOS: image data follows, never metadata segments.
    }
    // EOI terminates the JPEG stream. Do not scan arbitrary trailing bytes
    // for a synthetic SOS after it.
    if (marker === 0xd9) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0x00) return null;
    const lengthBytes = await reader.exact(position, 2);
    if (!lengthBytes) return null;
    const length = u16(lengthBytes, 0);
    if (length < 2) return null;
    const payloadStart = position + 2;
    const payloadLength = length - 2;
    const payloadEnd = addSafe(payloadStart, payloadLength);
    if (payloadEnd === null || payloadEnd > reader.size || payloadEnd > MAX_READ_BYTES) return null;
    if (marker === 0xe1 && payloadLength >= 6) {
      const signature = await reader.exact(payloadStart, 6);
      if (!signature) return null;
      if (ascii(signature, 0, 6) === 'Exif\0\0') {
        exifCount += 1;
        if (exifCount > 1) return null;
        exifRange = { start: payloadStart + 6, end: payloadEnd };
      }
    }
    position = payloadEnd;
  }
  return reachedSos && exifCount === 1 && exifRange ? parseTiff(reader, exifRange) : null;
}

interface ItemInfo { id: number; type: string; protection: number; hasName: boolean }
interface ItemLocation { baseOffset: number; extentOffset: number; extentLength: number; constructionMethod: number; dataReference: number }

function boundedBodyLength(box: Box): number | null {
  const length = box.bodyEnd - box.bodyStart;
  return length >= 0 && length <= MAX_STRUCTURE_BYTES ? length : null;
}

async function parsePitm(reader: BoundedReader, box: Box): Promise<number | null> {
  const length = boundedBodyLength(box);
  if (length === null || length < 6) return null;
  const bytes = await reader.exact(box.bodyStart, length);
  if (!bytes) return null;
  const version = bytes[0] ?? 0xff;
  if (version === 0 && bytes.length === 6) return u16(bytes, 4);
  if (version === 1 && bytes.length === 8) return u32(bytes, 4);
  return null;
}

async function parseIinf(reader: BoundedReader, box: Box, budget: BoxBudget): Promise<Map<number, ItemInfo> | null> {
  const length = boundedBodyLength(box);
  if (length === null || length < 6) return null;
  const prefix = await reader.exact(box.bodyStart, Math.min(length, 8));
  if (!prefix) return null;
  const version = prefix[0] ?? 0xff;
  const countBytes = version === 0 ? 2 : version === 1 ? 4 : 0;
  if (!countBytes || length < 4 + countBytes) return null;
  const count = countBytes === 2 ? u16(prefix, 4) : u32(prefix, 4);
  if (count > MAX_BOXES) return null;
  const children = await childBoxes(reader, box.bodyStart + 4 + countBytes, box.bodyEnd, budget);
  if (!children || children.length !== count || children.some((child) => child.type !== 'infe')) return null;
  const items = new Map<number, ItemInfo>();
  for (const child of children) {
    const childLength = boundedBodyLength(child);
    if (childLength === null || childLength < 13) return null;
    const bytes = await reader.exact(child.bodyStart, childLength);
    if (!bytes) return null;
    const infeVersion = bytes[0] ?? 0xff;
    const idLength = infeVersion === 2 ? 2 : infeVersion === 3 ? 4 : 0;
    if (!idLength || bytes.length < 4 + idLength + 2 + 4 + 1) return null;
    const id = idLength === 2 ? u16(bytes, 4) : u32(bytes, 4);
    const protection = u16(bytes, 4 + idLength);
    const type = ascii(bytes, 6 + idLength, 4);
    const nameStart = 10 + idLength;
    let nulFound = false;
    for (let index = nameStart; index < bytes.length; index += 1) {
      if (bytes[index] === 0) { nulFound = true; break; }
    }
    if (items.has(id)) return null;
    items.set(id, { id, type, protection, hasName: nulFound });
  }
  return items;
}

async function parseIref(
  reader: BoundedReader,
  box: Box,
  itemIds: ReadonlySet<number>,
  budget: BoxBudget,
): Promise<Map<number, number[]> | null> {
  const length = boundedBodyLength(box);
  if (length === null || length < 4) return null;
  const header = await reader.exact(box.bodyStart, 4);
  if (!header) return null;
  const version = header[0] ?? 0xff;
  if (version !== 0 && version !== 1) return null;
  const idLength = version === 0 ? 2 : 4;
  const children = await childBoxes(reader, box.bodyStart + 4, box.bodyEnd, budget);
  if (!children) return null;
  const references = new Map<number, number[]>();
  const seen = new Set<string>();
  for (const child of children) {
    const childLength = boundedBodyLength(child);
    if (childLength === null || childLength < idLength + 2) return null;
    const bytes = await reader.exact(child.bodyStart, childLength);
    if (!bytes) return null;
    const from = idLength === 2 ? u16(bytes, 0) : u32(bytes, 0);
    const count = u16(bytes, idLength);
    const expected = idLength + 2 + count * idLength;
    if (count === 0 || expected !== bytes.length || !itemIds.has(from)) return null;
    const key = `${child.type}:${from}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const targets: number[] = [];
    const targetIds = new Set<number>();
    for (let index = 0; index < count; index += 1) {
      const offset = idLength + 2 + index * idLength;
      const target = idLength === 2 ? u16(bytes, offset) : u32(bytes, offset);
      if (!itemIds.has(target) || targetIds.has(target)) return null;
      targetIds.add(target);
      targets.push(target);
    }
    if (child.type === 'cdsc') references.set(from, targets);
  }
  return references;
}

function readSizedInteger(bytes: Uint8Array, offset: number, width: number): number | null {
  if (width === 0) return 0;
  if (width !== 4 && width !== 8 || offset + width > bytes.length) return null;
  return width === 4 ? u32(bytes, offset) : u64(bytes, offset);
}

async function parseIloc(reader: BoundedReader, box: Box): Promise<Map<number, ItemLocation> | null> {
  const length = boundedBodyLength(box);
  if (length === null || length < 8) return null;
  const bytes = await reader.exact(box.bodyStart, length);
  if (!bytes) return null;
  const version = bytes[0] ?? 0xff;
  if (version !== 0 && version !== 1 && version !== 2) return null;
  const offsetSize = (bytes[4] ?? 0) >> 4;
  const lengthSize = (bytes[4] ?? 0) & 0x0f;
  const baseOffsetSize = (bytes[5] ?? 0) >> 4;
  const indexSize = (bytes[5] ?? 0) & 0x0f;
  if (![0, 4, 8].includes(offsetSize) || ![0, 4, 8].includes(lengthSize)
    || ![0, 4, 8].includes(baseOffsetSize) || ![0, 4, 8].includes(indexSize)
    || (version === 0 && indexSize !== 0)) return null;
  let offset = 6;
  const countLength = version < 2 ? 2 : 4;
  if (offset + countLength > bytes.length) return null;
  const itemCount = countLength === 2 ? u16(bytes, offset) : u32(bytes, offset);
  offset += countLength;
  if (itemCount > MAX_BOXES) return null;
  const locations = new Map<number, ItemLocation>();
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const idLength = version < 2 ? 2 : 4;
    if (offset + idLength + (version === 0 ? 0 : 2) + 2 + baseOffsetSize + 2 > bytes.length) return null;
    const id = idLength === 2 ? u16(bytes, offset) : u32(bytes, offset);
    offset += idLength;
    let constructionMethod = 0;
    if (version > 0) {
      const construction = u16(bytes, offset);
      offset += 2;
      if ((construction & 0xfff0) !== 0) return null;
      constructionMethod = construction & 0x0f;
    }
    const dataReference = u16(bytes, offset);
    offset += 2;
    const baseOffset = readSizedInteger(bytes, offset, baseOffsetSize);
    if (baseOffset === null) return null;
    offset += baseOffsetSize;
    const extentCount = u16(bytes, offset);
    offset += 2;
    if (locations.has(id)) return null;
    if (extentCount > 1) return null;
    let extentOffset = 0;
    let extentLength = 0;
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex += 1) {
      if (version > 0) {
        const extentIndexValue = readSizedInteger(bytes, offset, indexSize);
        if (extentIndexValue === null) return null;
        offset += indexSize;
      }
      const parsedOffset = readSizedInteger(bytes, offset, offsetSize);
      if (parsedOffset === null) return null;
      offset += offsetSize;
      const parsedLength = readSizedInteger(bytes, offset, lengthSize);
      if (parsedLength === null) return null;
      offset += lengthSize;
      extentOffset = parsedOffset;
      extentLength = parsedLength;
    }
    locations.set(id, { baseOffset, extentOffset, extentLength, constructionMethod, dataReference });
  }
  return offset === bytes.length ? locations : null;
}

async function parseHeif(reader: BoundedReader): Promise<TiffDates | null> {
  const budget: BoxBudget = { remaining: MAX_BOXES };
  const topLevel = await childBoxes(reader, 0, reader.size, budget);
  if (!topLevel) return null;
  const ftypBoxes = topLevel.filter((box) => box.type === 'ftyp');
  const metaBoxes = topLevel.filter((box) => box.type === 'meta');
  if (ftypBoxes.length !== 1 || metaBoxes.length !== 1) return null;
  const ftypLength = boundedBodyLength(ftypBoxes[0]!);
  if (ftypLength === null || ftypLength < 8 || (ftypLength - 8) % 4 !== 0) return null;
  const ftyp = await reader.exact(ftypBoxes[0]!.bodyStart, ftypLength);
  if (!ftyp) return null;
  const brands = new Set<string>();
  for (let offset = 0; offset < ftyp.length; offset += 4) {
    if (offset === 4) continue; // minor version is not a brand.
    brands.add(ascii(ftyp, offset, 4));
  }
  if (![...brands].some((brand) => HEVC_BRANDS.has(brand)) || [...brands].some((brand) => AVIF_BRANDS.has(brand))) {
    return null;
  }

  const meta = metaBoxes[0]!;
  const metaPrefix = await reader.exact(meta.bodyStart, 4, meta.bodyStart, meta.bodyEnd);
  if (!metaPrefix || metaPrefix[0] !== 0) return null;
  const children = await childBoxes(reader, meta.bodyStart + 4, meta.bodyEnd, budget);
  if (!children) return null;
  const one = (type: string): Box | null => {
    const matches = children.filter((child) => child.type === type);
    return matches.length === 1 ? matches[0]! : null;
  };
  const pitm = one('pitm');
  const iinf = one('iinf');
  const iref = one('iref');
  const iloc = one('iloc');
  if (!pitm || !iinf || !iref || !iloc) return null;
  const primaryId = await parsePitm(reader, pitm);
  if (primaryId === null) return null;
  const items = await parseIinf(reader, iinf, budget);
  if (!items || !items.has(primaryId)) return null;
  const references = await parseIref(reader, iref, new Set(items.keys()), budget);
  if (!references) return null;
  // Prove ownership before validating the selected item's local shape. If a
  // second associated Exif item is malformed/protected, it still makes the
  // file ambiguous rather than granting the well-formed one authority.
  const associated = [...items.values()]
    .filter((item) => item.type === 'Exif' && references.get(item.id)?.includes(primaryId));
  if (associated.length !== 1) return null;
  const selected = associated[0]!;
  if (selected.protection !== 0 || !selected.hasName) return null;
  const locations = await parseIloc(reader, iloc);
  if (!locations) return null;
  const location = locations.get(selected.id);
  if (!location || location.constructionMethod !== 0 || location.dataReference !== 0
    || location.extentLength <= 0) return null;
  const payloadStart = addSafe(location.baseOffset, location.extentOffset);
  if (payloadStart === null || !isSafeRange(payloadStart, location.extentLength, reader.size)) return null;
  const offsetBytes = await reader.exact(payloadStart, 4, payloadStart, payloadStart + location.extentLength);
  if (!offsetBytes) return null;
  const tiffSkip = u32(offsetBytes, 0);
  const tiffStart = addSafe(payloadStart + 4, tiffSkip);
  const payloadEnd = payloadStart + location.extentLength;
  if (tiffStart === null || !isSafeRange(tiffStart, 8, payloadEnd)) return null;
  return parseTiff(reader, { start: tiffStart, end: payloadEnd });
}

export async function extractImageCaptureDateFromReader(
  source: ByteReader,
  todayIso?: string,
): Promise<string | null> {
  try {
    if (!Number.isSafeInteger(source.size) || source.size <= 0) return null;
    const reader = new BoundedReader(source);
    if (!(await reader.initialize())) return null;
    const magic = await reader.exact(0, Math.min(2, reader.size));
    if (!magic) return null;
    const dates = magic.length === 2 && magic[0] === 0xff && magic[1] === 0xd8
      ? await parseJpeg(reader)
      : await parseHeif(reader);
    return dates ? extractCaptureDateIso(dates, todayIso) : null;
  } catch {
    return null;
  }
}

/** Production entry point. Metadata failures are always a silent no-op. */
export async function extractImageCaptureDateIso(fileUri: string, todayIso?: string): Promise<string | null> {
  try {
    const reader = await createFileByteReader(fileUri);
    return reader ? await extractImageCaptureDateFromReader(reader, todayIso) : null;
  } catch {
    return null;
  }
}
