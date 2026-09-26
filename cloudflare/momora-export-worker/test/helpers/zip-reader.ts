import { crc32Update } from '../../src/zip';

export interface ReadZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  modified: { year: number; month: number; day: number };
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Minimal stored-ZIP reader for tests: walks the central directory like a
 * real unzip tool does, and checks each entry's CRC against its bytes.
 */
export function readZip(bytes: Uint8Array): ReadZipEntry[] {
  const eocd = bytes.length - 22;
  if (u32(bytes, eocd) !== 0x06054b50) throw new Error('missing end of central directory');
  const count = u16(bytes, eocd + 10);
  let cursor = u32(bytes, eocd + 16);
  const decoder = new TextDecoder();
  const entries: ReadZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) throw new Error('bad central record');
    const flags = u16(bytes, cursor + 8);
    if (!(flags & 0x800)) throw new Error('entry name not flagged UTF-8');
    const date = u16(bytes, cursor + 14);
    const crc = u32(bytes, cursor + 16);
    const size = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (u32(bytes, localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);
    const actualCrc = (crc32Update(0xffffffff, data) ^ 0xffffffff) >>> 0;
    if (actualCrc !== crc) throw new Error(`crc mismatch for ${name}`);
    entries.push({
      name,
      data,
      crc,
      modified: { year: (date >> 9) + 1980, month: (date >> 5) & 0xf, day: date & 0x1f },
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
