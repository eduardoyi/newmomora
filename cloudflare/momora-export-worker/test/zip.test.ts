import { describe, expect, it } from 'vitest';

import { createStreamingZip, zipJson } from '../src/zip';

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    length += next.value.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

describe('streaming ZIP writer', () => {
  it('emits a valid descriptor-based archive without buffering entries', async () => {
    const output = await readStream(createStreamingZip([
      { name: 'manifest.json', getBody: async () => zipJson({ ok: true }) },
      { name: 'assets/one.txt', getBody: async () => new TextEncoder().encode('hello') },
    ], new Date('2026-08-01T12:00:00.000Z')));

    const signatures = [0x50, 0x4b, 0x03, 0x04];
    expect([...output.slice(0, 4)]).toEqual(signatures);
    expect([...output.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(new TextDecoder().decode(output)).toContain('manifest.json');
    expect(new TextDecoder().decode(output)).toContain('assets/one.txt');
  });
});
