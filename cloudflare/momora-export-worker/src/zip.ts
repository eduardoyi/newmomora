const textEncoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** ZIP32 hard limits: 16-bit entry count, 32-bit offsets/sizes. */
export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_BYTES = 0xffff_ffff;

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function crc32Update(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function dosDateTime(when: Date): { date: number; time: number } {
  // DOS timestamps can't represent anything before 1980.
  const safe = when.getUTCFullYear() < 1980 ? new Date(Date.UTC(1980, 0, 1)) : when;
  const date = ((safe.getUTCFullYear() - 1980) << 9) | ((safe.getUTCMonth() + 1) << 5) | safe.getUTCDate();
  const time = (safe.getUTCHours() << 11) | (safe.getUTCMinutes() << 5) | Math.floor(safe.getUTCSeconds() / 2);
  return { date, time };
}

/** Bytes an entry adds beyond its data: local header + descriptor + central record. */
export function zipEntryOverhead(name: string): number {
  const nameLength = textEncoder.encode(name).length;
  return 30 + nameLength + 16 + 46 + nameLength;
}

/** Bytes the end-of-central-directory record adds. */
export const ZIP_END_OVERHEAD = 22;

interface CentralRecord {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  date: number;
  time: number;
}

/**
 * Writes a stored (uncompressed) ZIP incrementally to `sink`. Photos,
 * videos and audio are already compressed, so storing them keeps CPU
 * bounded. Entries use the data-descriptor form: the local header is
 * written before the body is read, CRC/size right after it, so R2 objects
 * are streamed through without buffering. Names are flagged UTF-8.
 */
export class ZipWriter {
  private readonly central: CentralRecord[] = [];
  private written = 0;

  constructor(private readonly sink: (bytes: Uint8Array) => Promise<void>) {}

  get bytesWritten(): number {
    return this.written;
  }

  get entryCount(): number {
    return this.central.length;
  }

  private async emit(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    this.written += bytes.length;
    if (this.written > ZIP_MAX_BYTES) throw new Error('zip_too_large');
    await this.sink(bytes);
  }

  async addEntry(
    entryName: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    modifiedAt: Date,
  ): Promise<void> {
    if (this.central.length >= ZIP_MAX_ENTRIES) throw new Error('zip_too_many_entries');
    const name = textEncoder.encode(entryName);
    const { date, time } = dosDateTime(modifiedAt);
    const offset = this.written;
    await this.emit(concat(
      u32(0x04034b50), u16(20), u16(0x808), u16(0), u16(time), u16(date),
      u32(0), u32(0), u32(0), u16(name.length), u16(0), name,
    ));

    let crc = 0xffffffff;
    let size = 0;
    if (body instanceof Uint8Array) {
      crc = crc32Update(crc, body);
      size = body.length;
      await this.emit(body);
    } else {
      const reader = body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        crc = crc32Update(crc, next.value);
        size += next.value.length;
        await this.emit(next.value);
      }
    }
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    await this.emit(concat(u32(0x08074b50), u32(finalCrc), u32(size), u32(size)));
    this.central.push({ name, crc: finalCrc, size, offset, date, time });
  }

  async finish(): Promise<void> {
    const centralOffset = this.written;
    for (const record of this.central) {
      await this.emit(concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x808), u16(0), u16(record.time),
        u16(record.date), u32(record.crc), u32(record.size), u32(record.size),
        u16(record.name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(record.offset), record.name,
      ));
    }
    await this.emit(concat(
      u32(0x06054b50), u16(0), u16(0), u16(this.central.length), u16(this.central.length),
      u32(this.written - centralOffset), u32(centralOffset), u16(0),
    ));
  }
}

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}
