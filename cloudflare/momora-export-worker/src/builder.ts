import { utf8, ZIP_END_OVERHEAD, ZIP_MAX_ENTRIES, zipEntryOverhead, ZipWriter } from './zip';
import type { GroupBuildResult, PlannedEntry } from './types';

/**
 * Split point per archive. ZIP32 allows 4 GiB, but several common unzip
 * tools (and some phones' Files apps) still choke past 2 GiB, and a smaller
 * file is friendlier to download on a flaky connection.
 */
export const MAX_ARCHIVE_BYTES = 1.8 * 1024 * 1024 * 1024;
/** Leave headroom under the 65,535-entry ZIP32 limit. */
export const MAX_ARCHIVE_ENTRIES = Math.min(60_000, ZIP_MAX_ENTRIES);
/** R2 multipart: every part but the last must be the same size (>= 5 MiB). */
export const PART_SIZE = 16 * 1024 * 1024;

export interface ArchiveBucket {
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<ArchiveUpload>;
}

export interface ArchiveUpload {
  uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}

/** Buffers ZIP bytes into equal PART_SIZE parts for an R2 multipart upload. */
class MultipartSink {
  private readonly parts: R2UploadedPart[] = [];
  private buffer: Uint8Array;
  private filled = 0;

  constructor(private readonly upload: ArchiveUpload, private readonly partSize: number) {
    this.buffer = new Uint8Array(partSize);
  }

  readonly write = async (bytes: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(this.partSize - this.filled, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.partSize) await this.flush();
    }
  };

  private async flush(): Promise<void> {
    if (this.filled === 0) return;
    const part = this.filled === this.partSize ? this.buffer : this.buffer.slice(0, this.filled);
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, part));
    this.buffer = new Uint8Array(this.partSize);
    this.filled = 0;
  }

  async complete(): Promise<void> {
    await this.flush();
    await this.upload.complete(this.parts);
  }
}

interface OpenArchive {
  key: string;
  writer: ZipWriter;
  sink: MultipartSink;
  upload: ArchiveUpload;
}

export interface BuildGroupOptions {
  groupId: string;
  baseName: string;
  /** Returns the R2 key for the n-th (1-based) archive of this group. */
  keyFor: (part: number) => string;
  entries: PlannedEntry[];
  /**
   * Text entries appended after `entries`, generated once every object has
   * been read -- receives the paths found missing so far (the family
   * archive's manifest.json uses this to list missing files exactly).
   */
  trailingEntries?: (missing: string[]) => Array<Extract<PlannedEntry, { type: 'text' }>>;
  /** Overridable for tests; production uses the constants above. */
  limits?: { maxArchiveBytes?: number; maxArchiveEntries?: number; partSize?: number };
}

/**
 * Writes a group's entries into one or more stored ZIPs in R2. The size of
 * each R2 object is known from `get()` before its bytes are read, so a new
 * archive is started whenever the next entry would push the current one
 * past MAX_ARCHIVE_BYTES -- no separate sizing pass. Objects that vanished
 * since planning are recorded in `missing` rather than failing the export.
 * On any error every upload started here is aborted.
 */
export async function buildGroupArchives(bucket: ArchiveBucket, options: BuildGroupOptions): Promise<GroupBuildResult> {
  const finished: Array<{ key: string; bytes: number; entryCount: number }> = [];
  const missing: string[] = [];
  let current: OpenArchive | null = null;
  const started: ArchiveUpload[] = [];
  const maxArchiveBytes = options.limits?.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const maxArchiveEntries = options.limits?.maxArchiveEntries ?? MAX_ARCHIVE_ENTRIES;
  const partSize = options.limits?.partSize ?? PART_SIZE;

  const open = async (): Promise<OpenArchive> => {
    const key = options.keyFor(finished.length + 1);
    const upload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: 'application/zip' },
    });
    started.push(upload);
    const sink = new MultipartSink(upload, partSize);
    return { key, upload, sink, writer: new ZipWriter(sink.write) };
  };

  const close = async (archive: OpenArchive): Promise<void> => {
    await archive.writer.finish();
    await archive.sink.complete();
    finished.push({
      key: archive.key,
      bytes: archive.writer.bytesWritten,
      entryCount: archive.writer.entryCount,
    });
  };

  try {
    const entries = async function* (): AsyncGenerator<PlannedEntry> {
      yield* options.entries;
      if (options.trailingEntries) yield* options.trailingEntries([...missing]);
    };
    for await (const entry of entries()) {
      let body: ReadableStream<Uint8Array> | Uint8Array;
      let size: number;
      if (entry.type === 'text') {
        body = utf8(entry.text);
        size = body.length;
      } else {
        const object = await bucket.get(entry.objectKey);
        if (!object) {
          missing.push(entry.path);
          continue;
        }
        body = object.body;
        size = object.size;
      }

      const needed = size + zipEntryOverhead(entry.path);
      if (current && current.writer.entryCount > 0 && (
        current.writer.bytesWritten + needed + ZIP_END_OVERHEAD > maxArchiveBytes
        || current.writer.entryCount >= maxArchiveEntries
      )) {
        await close(current);
        current = null;
      }
      current ??= await open();
      await current.writer.addEntry(entry.path, body, new Date(entry.modifiedAt));
    }
    // A group always yields at least one archive, even if every object in
    // it went missing, so the download list matches what the email promised.
    current ??= await open();
    await close(current);
  } catch (error) {
    await Promise.all(started.map((upload) => upload.abort().catch(() => undefined)));
    throw error;
  }

  const total = finished.length;
  const archives = finished.map((archive, index) => ({
    key: archive.key,
    fileName: total === 1 ? `${options.baseName}.zip` : `${options.baseName} (part ${index + 1} of ${total}).zip`,
    bytes: archive.bytes,
    entryCount: archive.entryCount,
  }));
  return { groupId: options.groupId, archives, missing };
}
