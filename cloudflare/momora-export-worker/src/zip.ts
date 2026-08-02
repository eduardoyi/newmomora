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

function crc32Update(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function dosDateTime(now = new Date()): { date: number; time: number } {
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  return { date, time };
}

export interface StreamZipEntry {
  name: string;
  getBody: () => Promise<ReadableStream<Uint8Array> | Uint8Array>;
}

interface CentralRecord {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  date: number;
  time: number;
}

/**
 * Creates a ZIP stream without buffering R2 objects. Entries use the ZIP data
 * descriptor form: the header is emitted before the object is read, and the
 * CRC/size are emitted immediately after it. This keeps exports bounded by
 * the device's disk, not the Worker memory limit.
 */
async function* generateZipChunks(entries: StreamZipEntry[], now: Date): AsyncGenerator<Uint8Array> {
  const central: CentralRecord[] = [];
  let offset = 0;
  const { date, time } = dosDateTime(now);

  const emit = async function* (bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    offset += bytes.length;
    yield bytes;
  };

  for (const entry of entries) {
    const name = textEncoder.encode(entry.name);
    const localOffset = offset;
    yield* emit(concat(
      u32(0x04034b50), u16(20), u16(0x808), u16(0), u16(time), u16(date),
      u32(0), u32(0), u32(0), u16(name.length), u16(0), name,
    ));

    let crc = 0xffffffff;
    let size = 0;
    const body = await entry.getBody();
    if (body instanceof Uint8Array) {
      crc = crc32Update(crc, body);
      size = body.length;
      yield* emit(body);
    } else {
      const reader = body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        crc = crc32Update(crc, chunk);
        size += chunk.length;
        yield* emit(chunk);
      }
    }
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    yield* emit(concat(u32(0x08074b50), u32(finalCrc), u32(size), u32(size)));
    central.push({ name, crc: finalCrc, size, offset: localOffset, date, time });
  }

  const centralOffset = offset;
  for (const record of central) {
    yield* emit(concat(
      u32(0x02014b50), u16(20), u16(20), u16(0x808), u16(0), u16(record.time),
      u16(record.date), u32(record.crc), u32(record.size), u32(record.size),
      u16(record.name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(record.offset), record.name,
    ));
  }
  yield* emit(concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(offset - centralOffset), u32(centralOffset), u16(0),
  ));
}

export function createStreamingZip(entries: StreamZipEntry[], now = new Date()): ReadableStream<Uint8Array> {
  const iterator = generateZipChunks(entries, now);
  let pulling = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pulling) return;
      pulling = true;
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      } finally {
        pulling = false;
      }
    },
    cancel() {
      void iterator.return(undefined);
    },
  });
}

export function zipJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value, null, 2));
}
