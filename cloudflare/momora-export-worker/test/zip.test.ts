import { describe, expect, it } from 'vitest';

import { utf8, ZipWriter } from '../src/zip';
import { concatChunks, readZip } from './helpers/zip-reader';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(utf8(chunk));
      controller.close();
    },
  });
}

describe('ZipWriter', () => {
  it('writes a stored ZIP a standard reader can walk, with correct CRCs and UTF-8 names', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new ZipWriter(async (bytes) => { chunks.push(bytes.slice()); });
    await writer.addEntry('Momora - Los Yi/2026/2026-09-09 - Enzo le puso el parche/memory.txt', utf8('¡Hola!'), new Date('2026-09-09T12:00:00Z'));
    await writer.addEntry('Momora - Los Yi/2026/video.mp4', streamOf('chunk-1', 'chunk-2'), new Date('2026-09-10T12:00:00Z'));
    await writer.finish();

    const bytes = concatChunks(chunks);
    expect(writer.bytesWritten).toBe(bytes.length);
    expect(writer.entryCount).toBe(2);
    const entries = readZip(bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Momora - Los Yi/2026/2026-09-09 - Enzo le puso el parche/memory.txt',
      'Momora - Los Yi/2026/video.mp4',
    ]);
    expect(new TextDecoder().decode(entries[0].data)).toBe('¡Hola!');
    expect(new TextDecoder().decode(entries[1].data)).toBe('chunk-1chunk-2');
    expect(entries[0].modified).toEqual({ year: 2026, month: 9, day: 9 });
  });

  it('clamps pre-1980 dates DOS timestamps cannot represent', async () => {
    const chunks: Uint8Array[] = [];
    const writer = new ZipWriter(async (bytes) => { chunks.push(bytes.slice()); });
    await writer.addEntry('old.txt', utf8('x'), new Date('1975-06-01T00:00:00Z'));
    await writer.finish();
    expect(readZip(concatChunks(chunks))[0].modified.year).toBe(1980);
  });
});
