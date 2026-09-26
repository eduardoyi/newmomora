import { concatChunks } from './zip-reader';

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('unsupported body in fake bucket');
}

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Deliver in a few chunks, like R2 does.
  return new ReadableStream({
    start(controller) {
      const step = Math.max(1, Math.ceil(bytes.length / 3));
      for (let offset = 0; offset < bytes.length; offset += step) controller.enqueue(bytes.slice(offset, offset + step));
      controller.close();
    },
  });
}

/** In-memory R2 bucket covering the calls the export Worker makes. */
export class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads: Array<{ key: string; parts: Uint8Array[]; completed: boolean; aborted: boolean }> = [];
  failGetFor = new Set<string>();

  seed(key: string, value: string | Uint8Array): void {
    this.objects.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : value });
  }

  text(key: string): string {
    const object = this.objects.get(key);
    if (!object) throw new Error(`no object ${key}`);
    return new TextDecoder().decode(object.bytes);
  }

  async get(key: string, options?: { range?: Headers }) {
    if (this.failGetFor.has(key)) throw new Error('simulated R2 failure');
    const object = this.objects.get(key);
    if (!object) return null;
    let bytes = object.bytes;
    let range: { offset: number; length: number } | undefined;
    const header = options?.range?.get('range');
    const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
    if (match) {
      const offset = Number(match[1]);
      const end = match[2] ? Number(match[2]) : bytes.length - 1;
      range = { offset, length: end - offset + 1 };
      bytes = bytes.slice(offset, end + 1);
    }
    return {
      size: object.bytes.length,
      range,
      httpEtag: '"etag"',
      body: bodyOf(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(object.bytes)),
    };
  }

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: await toBytes(value), contentType: options?.httpMetadata?.contentType });
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? '')).sort();
    return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
  }

  async createMultipartUpload(key: string) {
    const record = { key, parts: [] as Uint8Array[], completed: false, aborted: false };
    this.uploads.push(record);
    return {
      uploadPart: async (partNumber: number, value: Uint8Array) => {
        record.parts[partNumber - 1] = value.slice();
        return { partNumber, etag: `etag-${partNumber}` };
      },
      complete: async () => {
        record.completed = true;
        this.objects.set(key, { bytes: concatChunks(record.parts), contentType: 'application/zip' });
      },
      abort: async () => {
        record.aborted = true;
      },
    };
  }
}
