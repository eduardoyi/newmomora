import { createInMemoryByteReader } from './byte-reader';
import { extractImageCaptureDateFromReader } from './image-exif-capture-date';

const TODAY = '2024-06-15';

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function be16(value: number): number[] { return [(value >>> 8) & 0xff, value & 0xff]; }
function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function le16(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff]; }
function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
function box(type: string, body: number[]): number[] { return [...be32(8 + body.length), ...ascii(type), ...body]; }
function bytes(...parts: number[][]): Uint8Array { return Uint8Array.from(parts.flat()); }
function findFourcc(source: Uint8Array, value: string): number {
  const needle = ascii(value);
  for (let offset = 0; offset <= source.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => source[offset + index] === byte)) return offset;
  }
  return -1;
}

function tiffDate(date: string, littleEndian = false): number[] {
  const write16 = littleEndian ? le16 : be16;
  const write32 = littleEndian ? le32 : be32;
  const value = [...ascii(date), 0];
  // Header + IFD0 (one DateTime entry) end at offset 26, where the string starts.
  return [
    ...(littleEndian ? ascii('II') : ascii('MM')),
    ...write16(42),
    ...write32(8),
    ...write16(1),
    ...write16(0x0132), ...write16(2), ...write32(value.length), ...write32(26),
    ...write32(0),
    ...value,
  ];
}

function jpegWithAppSegments(segments: { marker: number; payload: number[] }[], includeSos = true): Uint8Array {
  const body = segments.flatMap(({ marker, payload }) => [0xff, marker, ...be16(payload.length + 2), ...payload]);
  // One-component, baseline SOS header: length 8 plus six header bytes.
  return Uint8Array.from([0xff, 0xd8, ...body, ...(includeSos ? [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0] : [])]);
}

function jpegWithExif(date: string, littleEndian = false): Uint8Array {
  return jpegWithAppSegments([
    { marker: 0xe0, payload: [...ascii('JFIF\0'), 1, 2] },
    { marker: 0xe1, payload: [...ascii('Exif\0\0'), ...tiffDate(date, littleEndian)] },
  ]);
}

function tiffDateWithGps(date: string, gpsIfdOffset = 1200): number[] {
  const value = [...ascii(date), 0];
  const result = [
    ...ascii('MM'), ...be16(42), ...be32(8), ...be16(2),
    ...be16(0x0132), ...be16(2), ...be32(value.length), ...be32(38),
    ...be16(0x8825), ...be16(4), ...be32(1), ...be32(gpsIfdOffset),
    ...be32(0), ...value,
  ];
  while (result.length < gpsIfdOffset) result.push(0);
  // A real GPS IFD with a sentinel value range. The image parser must never
  // dereference either this IFD or its value range.
  result.push(...be16(1), ...be16(0x0002), ...be16(5), ...be32(3), ...be32(gpsIfdOffset + 18), ...be32(0));
  result.push(...new Array(24).fill(0xa5));
  return result;
}

function tiffWithPriorityDates(options: {
  original?: string;
  digitized?: string;
  dateTime?: string;
  firstIfdOffset?: number;
  duplicateDateTime?: boolean;
  duplicateExifPointer?: boolean;
  invalidExifPointer?: boolean;
  inlineDateTime?: boolean;
}): number[] {
  const firstIfdOffset = options.firstIfdOffset ?? 16;
  const entries: { tag: number; type: number; count: number; value: number; inline?: number[] }[] = [];
  const dateTime = options.dateTime ?? '2024:03:01 10:00:00';
  if (options.inlineDateTime) {
    entries.push({ tag: 0x0132, type: 2, count: 4, value: 0, inline: ascii('bad\0') });
  } else {
    entries.push({ tag: 0x0132, type: 2, count: dateTime.length + 1, value: 0 });
    if (options.duplicateDateTime) entries.push({ tag: 0x0132, type: 2, count: dateTime.length + 1, value: 0 });
  }
  entries.push({ tag: 0x8769, type: options.invalidExifPointer ? 3 : 4, count: options.invalidExifPointer ? 2 : 1, value: 0 });
  if (options.duplicateExifPointer) entries.push({ tag: 0x8769, type: 4, count: 1, value: 0 });
  const ifdEnd = firstIfdOffset + 2 + entries.length * 12 + 4;
  const exifIfdOffset = ifdEnd;
  const exifEntries = [
    ...(options.original ? [{ tag: 0x9003, date: options.original }] : []),
    ...(options.digitized ? [{ tag: 0x9004, date: options.digitized }] : []),
  ];
  const valuesStart = exifIfdOffset + 2 + exifEntries.length * 12 + 4;
  const result = new Array(valuesStart).fill(0);
  const put = (offset: number, value: number[]) => result.splice(offset, value.length, ...value);
  put(0, [...ascii('MM'), ...be16(42), ...be32(firstIfdOffset)]);
  put(firstIfdOffset, be16(entries.length));
  let valueOffset = valuesStart;
  entries.forEach((entry, index) => {
    const offset = firstIfdOffset + 2 + index * 12;
    let value = entry.value;
    if (entry.tag === 0x8769) value = exifIfdOffset;
    if (entry.tag === 0x0132 && !entry.inline) {
      value = valueOffset;
      const raw = [...ascii(dateTime), 0];
      put(valueOffset, raw);
      valueOffset += raw.length;
    }
    put(offset, [...be16(entry.tag), ...be16(entry.type), ...be32(entry.count), ...(entry.inline ?? be32(value))]);
  });
  put(exifIfdOffset, be16(exifEntries.length));
  exifEntries.forEach((entry, index) => {
    const raw = [...ascii(entry.date), 0];
    const offset = exifIfdOffset + 2 + index * 12;
    put(offset, [...be16(entry.tag), ...be16(2), ...be32(raw.length), ...be32(valueOffset)]);
    put(valueOffset, raw);
    valueOffset += raw.length;
  });
  return result.slice(0, valueOffset);
}

interface HeicOptions {
  avif?: boolean;
  mif1Only?: boolean;
  compatibleHevc?: boolean;
  associatePrimary?: boolean;
  selectedProtection?: boolean;
  selectedUnterminated?: boolean;
  extraAssociatedExif?: 'protected' | 'unterminated';
  duplicateIinfId?: boolean;
  duplicateCdscTarget?: boolean;
  tiffSkip?: number;
  pitmVersion?: 0 | 1;
  infeVersion?: 2 | 3;
  irefVersion?: 0 | 1;
  ilocVersion?: 0 | 1 | 2;
  iinfCountDelta?: number;
  iinfVersion?: 0 | 1;
  cdscTarget?: number;
  dataReference?: number;
  construction?: number;
  fieldWidths?: [number, number, number, number];
  extentCount?: number;
  extentLength?: number;
  extentOffsetDelta?: number;
  duplicateIlocId?: boolean;
  ilocItemId?: number;
}

/** Compact, structurally valid HEIC fixture whose relevant full-box versions
 * can vary independently. */
function heicWithExif(date: string, options: HeicOptions = {}): Uint8Array {
  const pitmVersion = options.pitmVersion ?? 0;
  const infeVersion = options.infeVersion ?? 2;
  const irefVersion = options.irefVersion ?? 0;
  const ilocVersion = options.ilocVersion ?? 0;
  const iinfVersion = options.iinfVersion ?? 0;
  const idBytes = (value: number, wide: boolean) => wide ? be32(value) : be16(value);
  const ftyp = box('ftyp', [
    ...ascii(options.avif ? 'avif' : options.mif1Only || options.compatibleHevc ? 'mif1' : 'heic'), 0, 0, 0, 0,
    ...ascii('mif1'), ...(options.avif || options.compatibleHevc ? ascii('heic') : options.mif1Only ? [] : ascii('heic')),
  ]);
  const pitm = box('pitm', [pitmVersion, 0, 0, 0, ...idBytes(1, pitmVersion === 1)]);
  const infe = (id: number, type: string, name: string, protection = 0) => box('infe', [
    infeVersion, 0, 0, 0, ...idBytes(id, infeVersion === 3), ...be16(protection), ...ascii(type), ...ascii(name),
    ...(name.endsWith('\0') ? [] : [0]),
  ]);
  const entries = [infe(1, 'hvc1', 'primary'), infe(2, 'Exif', options.selectedUnterminated ? 'unterminated\0' : 'exif', options.selectedProtection ? 1 : 0)];
  if (options.selectedUnterminated) entries[1] = box('infe', [
    infeVersion, 0, 0, 0, ...idBytes(2, infeVersion === 3), 0, 0, ...ascii('Exif'), ...ascii('unterminated'),
  ]);
  if (options.duplicateIinfId) entries.push(infe(2, 'Exif', 'duplicate'));
  if (options.extraAssociatedExif) {
    entries.push(infe(3, 'Exif', options.extraAssociatedExif === 'unterminated' ? 'bad\0' : 'other', options.extraAssociatedExif === 'protected' ? 1 : 0));
    if (options.extraAssociatedExif === 'unterminated') entries[2] = box('infe', [
      infeVersion, 0, 0, 0, ...idBytes(3, infeVersion === 3), 0, 0, ...ascii('Exif'), ...ascii('unterminated'),
    ]);
  }
  const declaredCount = entries.length + (options.iinfCountDelta ?? 0);
  const iinf = box('iinf', [iinfVersion, 0, 0, 0, ...(iinfVersion === 1 ? be32(declaredCount) : be16(declaredCount)), ...entries.flat()]);
  const refWide = irefVersion === 1;
  const targets = options.duplicateCdscTarget ? [1, 1] : [options.cdscTarget ?? (options.associatePrimary === false ? 2 : 1)];
  const ref = (from: number, to: number[]) => box('cdsc', [
    ...idBytes(from, refWide), ...be16(to.length), ...to.flatMap((item) => idBytes(item, refWide)),
  ]);
  const refs = [ref(2, targets)];
  if (options.extraAssociatedExif) refs.push(ref(3, [1]));
  const iref = box('iref', [irefVersion, 0, 0, 0, ...refs.flat()]);
  const tiff = tiffDate(date);
  const exif = [...be32(options.tiffSkip ?? 0), ...new Array(options.tiffSkip ?? 0).fill(0), ...tiff];
  const widths = options.fieldWidths ?? [4, 4, 4, 0];
  const writeWidth = (value: number, width: number): number[] => width === 0 ? [] : width === 4 ? be32(value) : new Array(width).fill(0);
  const ilocBody = (extentOffset: number) => {
    const idWide = ilocVersion === 2;
    const recordFor = (itemId: number) => [
      ...idBytes(itemId, idWide),
      ...(ilocVersion > 0 ? be16(options.construction ?? 0) : []),
      ...be16(options.dataReference ?? 0), ...writeWidth(0, widths[2]), ...be16(options.extentCount ?? 1),
      ...(ilocVersion > 0 ? writeWidth(0, widths[3]) : []), ...writeWidth(extentOffset + (options.extentOffsetDelta ?? 0), widths[0]),
      ...writeWidth(options.extentLength ?? exif.length, widths[1]),
    ];
    const record = recordFor(options.ilocItemId ?? 2);
    const records = options.duplicateIlocId ? [...record, ...recordFor(options.ilocItemId ?? 2)] : record;
    return [ilocVersion, 0, 0, 0, (widths[0] << 4) | widths[1], (widths[2] << 4) | widths[3],
      ...(ilocVersion === 2 ? be32(options.duplicateIlocId ? 2 : 1) : be16(options.duplicateIlocId ? 2 : 1)), ...records];
  };
  const initialIloc = box('iloc', ilocBody(0));
  const initialMeta = box('meta', [0, 0, 0, 0, ...pitm, ...iinf, ...iref, ...initialIloc]);
  const extentOffset = ftyp.length + initialMeta.length + 8;
  const iloc = box('iloc', ilocBody(extentOffset));
  const meta = box('meta', [0, 0, 0, 0, ...pitm, ...iinf, ...iref, ...iloc]);
  return bytes(ftyp, meta, box('mdat', exif));
}

describe('extractImageCaptureDateFromReader', () => {
  it('extracts a JPEG APP1 DateTime after non-EXIF APP segments', async () => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(jpegWithExif('2024:03:05 10:00:00')), TODAY))
      .resolves.toBe('2024-03-05');
  });

  it('supports little-endian TIFF', async () => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(jpegWithExif('2024:03:06 10:00:00', true)), TODAY))
      .resolves.toBe('2024-03-06');
  });

  it('honors TIFF first-IFD offsets and EXIF date priority, including NUL padding', async () => {
    const tiff = tiffWithPriorityDates({
      firstIfdOffset: 24,
      dateTime: '2024:03:01 10:00:00',
      digitized: '2024:03:02 10:00:00',
      original: '2024:03:03 10:00:00',
    });
    const file = jpegWithAppSegments([{ marker: 0xe1, payload: [...ascii('Exif\0\0'), ...tiff] }]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(file), TODAY)).resolves.toBe('2024-03-03');
  });

  it('handles inline ASCII by falling through to a valid EXIF date and rejects duplicate/malformed TIFF targets', async () => {
    const inline = tiffWithPriorityDates({ inlineDateTime: true, digitized: '2024:03:04 10:00:00' });
    const duplicate = tiffWithPriorityDates({ duplicateDateTime: true, original: '2024:03:04 10:00:00' });
    const duplicatePointer = tiffWithPriorityDates({ duplicateExifPointer: true, original: '2024:03:04 10:00:00' });
    const badPointer = tiffWithPriorityDates({ invalidExifPointer: true, original: '2024:03:04 10:00:00' });
    const toJpeg = (tiff: number[]) => createInMemoryByteReader(jpegWithAppSegments([
      { marker: 0xe1, payload: [...ascii('Exif\0\0'), ...tiff] },
    ]));
    await expect(extractImageCaptureDateFromReader(toJpeg(inline), TODAY)).resolves.toBe('2024-03-04');
    await expect(extractImageCaptureDateFromReader(toJpeg(duplicate), TODAY)).resolves.toBeNull();
    await expect(extractImageCaptureDateFromReader(toJpeg(duplicatePointer), TODAY)).resolves.toBeNull();
    await expect(extractImageCaptureDateFromReader(toJpeg(badPointer), TODAY)).resolves.toBeNull();
  });

  it('rejects oversized IFD entry counts before walking untrusted tables', async () => {
    const overBudgetTiff = [...ascii('MM'), ...be16(42), ...be32(8), ...be16(65)];
    const file = jpegWithAppSegments([{ marker: 0xe1, payload: [...ascii('Exif\0\0'), ...overBudgetTiff] }]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(file), TODAY)).resolves.toBeNull();
  });

  it('fails closed for two EXIF-signature APP1 segments', async () => {
    const first = [...ascii('Exif\0\0'), ...tiffDate('2024:03:05 10:00:00')];
    const second = [...ascii('Exif\0\0'), ...tiffDate('2024:03:04 10:00:00')];
    const file = jpegWithAppSegments([{ marker: 0xe1, payload: first }, { marker: 0xe1, payload: second }]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(file), TODAY)).resolves.toBeNull();
  });

  it('returns null for malformed, non-image, and implausibly future metadata', async () => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), TODAY)).resolves.toBeNull();
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), TODAY)).resolves.toBeNull();
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(new Uint8Array()), TODAY)).resolves.toBeNull();
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(jpegWithExif('2024:06:18 10:00:00')), TODAY)).resolves.toBeNull();
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 1])), TODAY)).resolves.toBeNull();
  });

  it('extracts HEIC Exif only when cdsc associates it with pitm primary item', async () => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:07 10:00:00')), TODAY))
      .resolves.toBe('2024-03-07');
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:07 10:00:00', { associatePrimary: false })), TODAY))
      .resolves.toBeNull();
  });

  it('uses the HEIF Exif TIFF-header skip count and excludes AVIF', async () => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:08 10:00:00', { tiffSkip: 4 })), TODAY))
      .resolves.toBe('2024-03-08');
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:08 10:00:00', { avif: true })), TODAY))
      .resolves.toBeNull();
  });

  it('does not follow GPS data ranges', async () => {
    // Place APP1 just beyond the 64 KiB head cache, then put a fake GPS IFD
    // deeper in that APP1. The only permitted post-head reads are TIFF's
    // header, IFD table, and selected date string -- never the GPS range.
    const exifPayload = [...ascii('Exif\0\0'), ...tiffDateWithGps('2024:03:05 10:00:00')];
    const base = jpegWithAppSegments([
      { marker: 0xe2, payload: new Array(65500).fill(0) },
      { marker: 0xe1, payload: exifPayload },
    ]);
    const reader = createInMemoryByteReader(base);
    const read = jest.fn(reader.read);
    await expect(extractImageCaptureDateFromReader({ size: reader.size, read }, TODAY)).resolves.toBe('2024-03-05');
    const tiffStart = 2 + 4 + 65500 + 4 + 6;
    const gpsIfdStart = tiffStart + 1200;
    const gpsValueStart = gpsIfdStart + 18;
    expect(read.mock.calls.some(([position, length]) => {
      const end = (position as number) + (length as number);
      return (position as number) < gpsValueStart + 24 && end > gpsIfdStart;
    })).toBe(false);
  });

  it('requires SOS after APP1 and rejects EOI before a synthetic trailing SOS', async () => {
    const app1 = { marker: 0xe1, payload: [...ascii('Exif\0\0'), ...tiffDate('2024:03:05 10:00:00')] };
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(jpegWithAppSegments([app1], false)), TODAY))
      .resolves.toBeNull();
    const withEoiThenSos = Uint8Array.from([...jpegWithAppSegments([app1], false), 0xff, 0xd9, 0xff, 0xda]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(withEoiThenSos), TODAY)).resolves.toBeNull();
    const truncatedSos = Uint8Array.from([...jpegWithAppSegments([app1], false), 0xff, 0xda, 0]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(truncatedSos), TODAY)).resolves.toBeNull();
    const oversizedSos = Uint8Array.from([...jpegWithAppSegments([app1], false), 0xff, 0xda, 0xff, 0xff]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(oversizedSos), TODAY)).resolves.toBeNull();
  });

  it('caps all JPEG marker work, including standalone markers and fill bytes', async () => {
    const prefix = [0xff, 0xd8];
    for (let index = 0; index < 70; index += 1) prefix.push(0xff, 0xff, 0xd0);
    const app1 = [...ascii('Exif\0\0'), ...tiffDate('2024:03:05 10:00:00')];
    const file = Uint8Array.from([...prefix, 0xff, 0xe1, ...be16(app1.length + 2), ...app1, 0xff, 0xda]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(file), TODAY)).resolves.toBeNull();
  });

  it.each([
    [{ pitmVersion: 1, infeVersion: 3, irefVersion: 1, ilocVersion: 1 }, 'iloc v1'],
    [{ pitmVersion: 1, infeVersion: 3, irefVersion: 1, ilocVersion: 2 }, 'iloc v2'],
    [{ iinfVersion: 1, compatibleHevc: true }, 'iinf v1 with compatible HEVC brand'],
  ] as const)('supports versioned HEIF metadata: %s', async (options) => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:09 10:00:00', options)), TODAY))
      .resolves.toBe('2024-03-09');
  });

  it('rejects ambiguous, protected, unterminated, and duplicate cdsc associations', async () => {
    const invalidOptions: HeicOptions[] = [
      { extraAssociatedExif: 'protected' },
      { extraAssociatedExif: 'unterminated' },
      { duplicateCdscTarget: true },
      { associatePrimary: false },
      { selectedProtection: true },
      { selectedUnterminated: true },
    ];
    for (const options of invalidOptions) {
      await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:09 10:00:00', options)), TODAY))
        .resolves.toBeNull();
    }
  });

  it('rejects unsupported HEIF brands and structural iloc/iinf violations', async () => {
    const invalidOptions: HeicOptions[] = [
      { mif1Only: true },
      { iinfCountDelta: 1 },
      { dataReference: 1 },
      { construction: 1, ilocVersion: 1 },
      { construction: 0x10, ilocVersion: 1 },
      { fieldWidths: [2, 4, 4, 0] },
      { extentCount: 2 },
      { extentLength: 0 },
      { extentOffsetDelta: 500000 },
      { fieldWidths: [4, 0, 4, 0] },
      { duplicateIinfId: true },
      { duplicateIlocId: true },
      { ilocItemId: 3 },
    ];
    for (const options of invalidOptions) {
      await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:09 10:00:00', options)), TODAY))
        .resolves.toBeNull();
    }
  });

  it('rejects dangling cdsc references and malformed top-level/meta shapes', async () => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:09 10:00:00', { cdscTarget: 99 })), TODAY))
      .resolves.toBeNull();
    const missingPitm = heicWithExif('2024:03:09 10:00:00');
    const pitmTypeOffset = findFourcc(missingPitm, 'pitm');
    missingPitm.set(ascii('junk'), pitmTypeOffset);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(missingPitm), TODAY)).resolves.toBeNull();
    const unsupportedMeta = heicWithExif('2024:03:09 10:00:00');
    const metaTypeOffset = findFourcc(unsupportedMeta, 'meta');
    unsupportedMeta[metaTypeOffset + 4] = 1;
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(unsupportedMeta), TODAY)).resolves.toBeNull();
  });

  it('rejects every unsupported HEIF full-box version', async () => {
    for (const type of ['pitm', 'iinf', 'infe', 'iref', 'iloc']) {
      const malformed = heicWithExif('2024:03:09 10:00:00');
      const typeOffset = findFourcc(malformed, type);
      malformed[typeOffset + 4] = 9;
      await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(malformed), TODAY)).resolves.toBeNull();
    }
  });

  it('consumes declared iloc extent_index fields and accepts an extended-size ftyp', async () => {
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(heicWithExif('2024:03:10 10:00:00', {
      ilocVersion: 1,
      fieldWidths: [4, 4, 4, 4],
    })), TODAY)).resolves.toBe('2024-03-10');

    const normal = heicWithExif('2024:03:10 10:00:00');
    const ftypSize = (normal[0] ?? 0) * 16777216 + (normal[1] ?? 0) * 65536 + (normal[2] ?? 0) * 256 + (normal[3] ?? 0);
    const extended = Uint8Array.from([
      ...be32(1), ...ascii('ftyp'), 0, 0, 0, 0, ...be32(ftypSize + 8), ...normal.slice(8, ftypSize), ...normal.slice(ftypSize),
    ]);
    const ilocBody = findFourcc(extended, 'iloc') + 4;
    const extentOffset = ilocBody + 18;
    const oldOffset = (extended[extentOffset] ?? 0) * 16777216 + (extended[extentOffset + 1] ?? 0) * 65536
      + (extended[extentOffset + 2] ?? 0) * 256 + (extended[extentOffset + 3] ?? 0);
    extended.set(be32(oldOffset + 8), extentOffset);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(extended), TODAY)).resolves.toBe('2024-03-10');
  });

  it('rejects duplicate top-level ftyp/meta boxes and caps post-head native reads', async () => {
    for (const duplicateType of ['ftyp', 'meta']) {
      const duplicate = heicWithExif('2024:03:09 10:00:00');
      duplicate.set(ascii(duplicateType), findFourcc(duplicate, 'mdat'));
      await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(duplicate), TODAY)).resolves.toBeNull();
    }
    const segments = [{ marker: 0xe2, payload: new Array(65500).fill(0) }];
    for (let index = 0; index < 20; index += 1) segments.push({ marker: 0xe2, payload: [] });
    const source = createInMemoryByteReader(jpegWithAppSegments(segments));
    const read = jest.fn(source.read);
    await expect(extractImageCaptureDateFromReader({ size: source.size, read }, TODAY)).resolves.toBeNull();
    expect(read.mock.calls).toHaveLength(16);
  });

  it('fails closed for HEIF child escape, nested size-zero, unsafe iloc values, and box budgets', async () => {
    const escapingChild = heicWithExif('2024:03:09 10:00:00');
    const pitmOffset = findFourcc(escapingChild, 'pitm');
    escapingChild.set(be32(0x00ffffff), pitmOffset - 4);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(escapingChild), TODAY)).resolves.toBeNull();

    const zeroSizedChild = heicWithExif('2024:03:09 10:00:00');
    zeroSizedChild.set([0, 0, 0, 0], findFourcc(zeroSizedChild, 'pitm') - 4);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(zeroSizedChild), TODAY)).resolves.toBeNull();

    const unsafeIloc = heicWithExif('2024:03:09 10:00:00', { fieldWidths: [8, 8, 8, 0] });
    const ilocBody = findFourcc(unsafeIloc, 'iloc') + 4;
    unsafeIloc.set(new Array(8).fill(0xff), ilocBody + 22);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(unsafeIloc), TODAY)).resolves.toBeNull();

    const boxBudgetExhausted = Uint8Array.from([
      ...Array.from({ length: 129 }, () => box('free', [])).flat(),
      ...heicWithExif('2024:03:09 10:00:00'),
    ]);
    await expect(extractImageCaptureDateFromReader(createInMemoryByteReader(boxBudgetExhausted), TODAY)).resolves.toBeNull();
  });

  it('fails closed when an exact positioned JPEG read truncates after the head cache', async () => {
    const app1 = [...ascii('Exif\0\0'), ...tiffDate('2024:03:05 10:00:00')];
    const file = jpegWithAppSegments([{ marker: 0xe2, payload: new Array(65500).fill(0) }, { marker: 0xe1, payload: app1 }]);
    const source = createInMemoryByteReader(file);
    const shortReader = {
      size: source.size,
      read: async (position: number, length: number) => position === 0
        ? source.read(position, length)
        : new Uint8Array(Math.max(0, length - 1)),
    };
    await expect(extractImageCaptureDateFromReader(shortReader, TODAY)).resolves.toBeNull();
  });

  it('fails closed for an invalid reader size and a short exact read', async () => {
    await expect(extractImageCaptureDateFromReader({ size: Number.MAX_SAFE_INTEGER + 1, read: async () => new Uint8Array() }, TODAY))
      .resolves.toBeNull();
    await expect(extractImageCaptureDateFromReader({ size: 32, read: async () => new Uint8Array(1) }, TODAY))
      .resolves.toBeNull();
  });
});
