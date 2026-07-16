import {
  createInMemoryByteReader,
  extractVideoCaptureDateFromReader,
} from './video-capture-date';

// ---------------------------------------------------------------------------
// Fixture builders: assemble minimal, valid MP4/MOV atom trees byte-by-byte
// so the parser can be exercised without a real video file. Mirrors the
// spirit of media-capture-date.test.ts's plain-object EXIF fixtures, just
// one layer lower (raw bytes instead of a JS object) because the video
// format is a binary box tree, not a flat key/value structure.
// ---------------------------------------------------------------------------

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u64be(value: number): number[] {
  const high = Math.floor(value / 4294967296);
  const low = value % 4294967296;
  return [...u32be(high), ...u32be(low)];
}

function asciiBytes(text: string): number[] {
  return Array.from(text).map((char) => char.charCodeAt(0));
}

/** Standard 8-byte-header atom: `size(4) + type(4) + body`. */
function atom(type: string, body: number[]): number[] {
  const size = 8 + body.length;
  return [...u32be(size), ...asciiBytes(type), ...body];
}

/** `largesize` atom: `1(4) + type(4) + largesize(8) + body`. */
function largesizeAtom(type: string, body: number[]): number[] {
  const totalSize = 16 + body.length;
  return [...u32be(1), ...asciiBytes(type), ...u64be(totalSize), ...body];
}

function toBytes(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

function ftypAtom(): number[] {
  return atom('ftyp', asciiBytes('isommp42'));
}

function mdatAtom(bodySize: number): number[] {
  return atom('mdat', new Array(bodySize).fill(0));
}

function mvhdBodyV0(creationTime: number): number[] {
  return [0, 0, 0, 0, ...u32be(creationTime), ...u32be(0)]; // version+flags, creation_time, modification_time
}

function mvhdBodyV1(creationTime: number): number[] {
  return [1, 0, 0, 0, ...u64be(creationTime), ...u64be(0)];
}

function mvhdAtom(body: number[]): number[] {
  return atom('mvhd', body);
}

function keysAtomBody(keyNames: string[]): number[] {
  const entries = keyNames.flatMap((name) => {
    const nameBytes = asciiBytes(name);
    const entrySize = 8 + nameBytes.length;
    return [...u32be(entrySize), ...asciiBytes('mdta'), ...nameBytes];
  });
  return [0, 0, 0, 0, ...u32be(keyNames.length), ...entries];
}

function dataAtomBody(text: string): number[] {
  return [0, 0, 0, 1, 0, 0, 0, 0, ...asciiBytes(text)]; // type=1 (UTF-8), locale=0
}

function ilstItemAtom(index: number, text: string): number[] {
  const dataBox = atom('data', dataAtomBody(text));
  const itemType = String.fromCharCode(
    (index >>> 24) & 0xff,
    (index >>> 16) & 0xff,
    (index >>> 8) & 0xff,
    index & 0xff,
  );
  return atom(itemType, dataBox);
}

/** Builds `moov/meta` (Apple mdta keys+ilst) with a single
 * `com.apple.quicktime.creationdate` entry at ilst index 1. */
function appleMetaAtom(creationDateValue: string): number[] {
  const keysBox = atom('keys', keysAtomBody(['com.apple.quicktime.creationdate']));
  const ilstBox = atom('ilst', ilstItemAtom(1, creationDateValue));
  const metaBody = [0, 0, 0, 0, ...keysBox, ...ilstBox]; // meta is a full box
  return atom('meta', metaBody);
}

function moovAtom(children: number[][]): number[] {
  return atom('moov', children.flat());
}

const TODAY = '2024-06-15';

describe('extractVideoCaptureDateFromReader', () => {
  it('reads mvhd v0 creation_time when moov appears after mdat (typical camera recording layout)', async () => {
    // creation_time for 2024-06-01 00:00:00 UTC = macSeconds since 1904-01-01
    const macSeconds = Math.floor(Date.UTC(2024, 5, 1) / 1000) + 2082844800;
    const bytes = toBytes(
      ftypAtom(),
      mdatAtom(64),
      moovAtom([mvhdAtom(mvhdBodyV0(macSeconds))]),
    );
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-01');
  });

  it('reads mvhd v1 (64-bit) creation_time', async () => {
    const macSeconds = Math.floor(Date.UTC(2024, 5, 2) / 1000) + 2082844800;
    const bytes = toBytes(
      ftypAtom(),
      moovAtom([mvhdAtom(mvhdBodyV1(macSeconds))]),
      mdatAtom(16),
    );
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-02');
  });

  it('prefers the Apple quicktime creationdate key over mvhd when both are present', async () => {
    const mvhdMacSeconds = Math.floor(Date.UTC(2024, 5, 10) / 1000) + 2082844800;
    const bytes = toBytes(
      ftypAtom(),
      moovAtom([
        mvhdAtom(mvhdBodyV0(mvhdMacSeconds)),
        appleMetaAtom('2024-06-01T10:00:00-0700'),
      ]),
    );
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    // 2024-06-01T10:00:00-07:00 -> 2024-06-01T17:00:00Z; local date depends
    // on the test runner's timezone via `new Date(...)`, but the important
    // assertion is that it's derived from the Apple key's date (June 1),
    // not mvhd's (June 10).
    expect(result?.startsWith('2024-06-0')).toBe(true);
    expect(result).not.toBe('2024-06-10');
  });

  it('parses a Z-suffixed Apple creationdate', async () => {
    const bytes = toBytes(moovAtom([appleMetaAtom('2024-06-01T12:00:00Z')]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-01');
  });

  it('parses a colon-delimited Apple creationdate offset', async () => {
    const bytes = toBytes(moovAtom([appleMetaAtom('2024-06-01T10:00:00-07:00')]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-01');
  });

  it('finds moov/meta via moov/udta/meta nesting', async () => {
    const udtaBody = appleMetaAtom('2024-06-03T09:00:00Z');
    const bytes = toBytes(moovAtom([atom('udta', udtaBody)]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-03');
  });

  it('falls back to mvhd when the Apple keys table has no creationdate entry', async () => {
    const macSeconds = Math.floor(Date.UTC(2024, 5, 4) / 1000) + 2082844800;
    const keysBox = atom('keys', keysAtomBody(['com.apple.quicktime.make']));
    const ilstBox = atom('ilst', ilstItemAtom(1, 'Apple'));
    const metaBody = [0, 0, 0, 0, ...keysBox, ...ilstBox];
    const bytes = toBytes(
      moovAtom([mvhdAtom(mvhdBodyV0(macSeconds)), atom('meta', metaBody)]),
    );
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-04');
  });

  it('falls back to mvhd when the Apple creationdate value is malformed', async () => {
    const macSeconds = Math.floor(Date.UTC(2024, 5, 5) / 1000) + 2082844800;
    const bytes = toBytes(
      moovAtom([mvhdAtom(mvhdBodyV0(macSeconds)), appleMetaAtom('not-a-date')]),
    );
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-05');
  });

  it('falls back to mvhd when the Apple creationdate is present but implausible (future)', async () => {
    const macSeconds = Math.floor(Date.UTC(2024, 5, 6) / 1000) + 2082844800;
    const bytes = toBytes(
      moovAtom([
        mvhdAtom(mvhdBodyV0(macSeconds)),
        appleMetaAtom('2099-01-01T00:00:00Z'),
      ]),
    );
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-06');
  });

  it('handles a largesize (64-bit) moov atom', async () => {
    const macSeconds = Math.floor(Date.UTC(2024, 5, 7) / 1000) + 2082844800;
    const moovBody = [...mvhdAtom(mvhdBodyV0(macSeconds))];
    const bytes = toBytes(ftypAtom(), largesizeAtom('moov', moovBody));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-07');
  });

  it('handles a largesize (64-bit) atom preceding moov (e.g. an oversized mdat)', async () => {
    const macSeconds = Math.floor(Date.UTC(2024, 5, 8) / 1000) + 2082844800;
    const bytes = toBytes(
      ftypAtom(),
      largesizeAtom('mdat', new Array(32).fill(0)),
      moovAtom([mvhdAtom(mvhdBodyV0(macSeconds))]),
    );
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-08');
  });

  it('returns null for an mvhd creation_time of 0 (explicit "unknown" sentinel)', async () => {
    const bytes = toBytes(moovAtom([mvhdAtom(mvhdBodyV0(0))]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('returns null for a pre-1990 mvhd creation_time', async () => {
    const macSeconds = Math.floor(Date.UTC(1985, 0, 1) / 1000) + 2082844800;
    const bytes = toBytes(moovAtom([mvhdAtom(mvhdBodyV0(macSeconds))]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('accepts an mvhd date at today via a UTC instant that lands on the local test-runner date', async () => {
    // Use a UTC noon instant so it lands on the same calendar day in any
    // reasonable test-runner timezone, avoiding a flaky boundary case.
    const macSeconds = Math.floor(Date.UTC(2024, 5, 15, 12, 0, 0) / 1000) + 2082844800;
    const bytes = toBytes(moovAtom([mvhdAtom(mvhdBodyV0(macSeconds))]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBe('2024-06-15');
  });

  it('rejects an mvhd date more than one day beyond the injected today', async () => {
    const macSeconds = Math.floor(Date.UTC(2024, 5, 18, 12, 0, 0) / 1000) + 2082844800;
    const bytes = toBytes(moovAtom([mvhdAtom(mvhdBodyV0(macSeconds))]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('returns null when there is no moov atom at all', async () => {
    const bytes = toBytes(ftypAtom(), mdatAtom(32));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('returns null when moov has neither mvhd nor an Apple meta structure', async () => {
    const bytes = toBytes(moovAtom([atom('trak', asciiBytes('stub'))]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('returns null for a truncated/garbage file (too short for even one atom header)', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('returns null for an empty file', async () => {
    const reader = createInMemoryByteReader(new Uint8Array(0));

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('returns null and never throws when an atom declares a body larger than the file', async () => {
    // size = 1000 but the file is much shorter than that -- a truncated
    // download or corrupt file.
    const bytes = toBytes(u32be(1000), asciiBytes('moov'), [0, 0, 0, 0]);
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader, TODAY);

    expect(result).toBeNull();
  });

  it('bails out after a bounded scan budget instead of scanning an unbounded run of fake top-level atoms', async () => {
    const fakeAtomCount = 2000;
    const fakeAtoms: number[][] = [];
    for (let index = 0; index < fakeAtomCount; index += 1) {
      fakeAtoms.push(atom('fake', []));
    }
    const bytes = toBytes(...fakeAtoms); // moov never appears
    const baseReader = createInMemoryByteReader(bytes);
    const readSpy = jest.fn(baseReader.read);
    const spiedReader = { size: baseReader.size, read: readSpy };

    const result = await extractVideoCaptureDateFromReader(spiedReader, TODAY);

    expect(result).toBeNull();
    // The parser must stop well short of reading every one of the 2000
    // fake atoms -- proving it bailed on a scan budget rather than reading
    // (or hanging on) the entire file.
    expect(readSpy.mock.calls.length).toBeLessThan(fakeAtomCount);
  });

  it('defaults todayIso to the current local date when omitted', async () => {
    const now = new Date();
    const macSeconds = Math.floor(now.getTime() / 1000) + 2082844800;
    const bytes = toBytes(moovAtom([mvhdAtom(mvhdBodyV0(macSeconds))]));
    const reader = createInMemoryByteReader(bytes);

    const result = await extractVideoCaptureDateFromReader(reader);

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    expect(result).toBe(`${year}-${month}-${day}`);
  });
});
