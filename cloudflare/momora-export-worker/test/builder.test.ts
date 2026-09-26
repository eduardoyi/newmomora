import { describe, expect, it } from 'vitest';

import { buildGroupArchives } from '../src/builder';
import type { PlannedEntry } from '../src/types';
import { FakeBucket } from './helpers/fake-bucket';
import { readZip } from './helpers/zip-reader';

function objectEntry(path: string, objectKey: string): PlannedEntry {
  return { type: 'object', path, objectKey, kind: 'memory_photo', modifiedAt: '2026-01-02T12:00:00.000Z' };
}

function textEntry(path: string, text: string): PlannedEntry {
  return { type: 'text', path, text, modifiedAt: '2026-01-02T12:00:00.000Z' };
}

function zipAt(bucket: FakeBucket, key: string) {
  const object = bucket.objects.get(key);
  if (!object) throw new Error(`missing archive ${key}`);
  return readZip(object.bytes);
}

describe('buildGroupArchives', () => {
  it('writes every entry into one archive named after the group', async () => {
    const bucket = new FakeBucket();
    bucket.seed('media/a.jpg', 'photo-a');
    const result = await buildGroupArchives(bucket as never, {
      groupId: 'g',
      baseName: 'Momora - Los Yi - 2026',
      keyFor: (part) => `exports/job/archives/0-${part}.zip`,
      entries: [textEntry('root/2026/memo/memory.txt', 'hello'), objectEntry('root/2026/memo/photo.jpg', 'media/a.jpg')],
    });

    expect(result.archives).toEqual([
      expect.objectContaining({ key: 'exports/job/archives/0-1.zip', fileName: 'Momora - Los Yi - 2026.zip', entryCount: 2 }),
    ]);
    expect(result.missing).toEqual([]);
    const entries = zipAt(bucket, 'exports/job/archives/0-1.zip');
    expect(entries.map((entry) => entry.name)).toEqual(['root/2026/memo/memory.txt', 'root/2026/memo/photo.jpg']);
    expect(new TextDecoder().decode(entries[1].data)).toBe('photo-a');
  });

  it('starts a new archive before one would pass the size cap and names the parts', async () => {
    const bucket = new FakeBucket();
    for (const name of ['a', 'b', 'c']) bucket.seed(`media/${name}`, new Uint8Array(400).fill(1));
    const result = await buildGroupArchives(bucket as never, {
      groupId: 'g',
      baseName: 'Momora - Los Yi - 2025',
      keyFor: (part) => `k-${part}.zip`,
      entries: ['a', 'b', 'c'].map((name) => objectEntry(`root/2025/${name}.jpg`, `media/${name}`)),
      limits: { maxArchiveBytes: 1100 },
    });

    expect(result.archives.map((archive) => archive.fileName)).toEqual([
      'Momora - Los Yi - 2025 (part 1 of 2).zip',
      'Momora - Los Yi - 2025 (part 2 of 2).zip',
    ]);
    expect(zipAt(bucket, 'k-1.zip').map((entry) => entry.name)).toEqual(['root/2025/a.jpg', 'root/2025/b.jpg']);
    expect(zipAt(bucket, 'k-2.zip').map((entry) => entry.name)).toEqual(['root/2025/c.jpg']);
    for (const archive of result.archives) expect(archive.bytes).toBeLessThanOrEqual(1100);
  });

  it('uploads equal-size multipart parts with a shorter last part', async () => {
    const bucket = new FakeBucket();
    bucket.seed('media/big', new Uint8Array(2500).fill(7));
    await buildGroupArchives(bucket as never, {
      groupId: 'g',
      baseName: 'x',
      keyFor: () => 'big.zip',
      entries: [objectEntry('big.bin', 'media/big')],
      limits: { partSize: 1024 },
    });
    const sizes = bucket.uploads[0].parts.map((part) => part.length);
    expect(sizes.slice(0, -1).every((size) => size === 1024)).toBe(true);
    expect(sizes.at(-1)).toBeLessThanOrEqual(1024);
    expect(readZip(bucket.objects.get('big.zip')!.bytes)[0].data.length).toBe(2500);
  });

  it('records objects deleted since planning as missing and hands them to trailing entries', async () => {
    const bucket = new FakeBucket();
    bucket.seed('media/here', 'here');
    let seenMissing: string[] = [];
    const result = await buildGroupArchives(bucket as never, {
      groupId: 'g',
      baseName: 'x',
      keyFor: () => 'x.zip',
      entries: [objectEntry('root/gone.jpg', 'media/gone'), objectEntry('root/here.jpg', 'media/here')],
      trailingEntries: (missing) => {
        seenMissing = missing;
        return [{ type: 'text', path: 'root/manifest.json', text: JSON.stringify({ missing }), modifiedAt: '2026-01-01T00:00:00Z' }];
      },
    });
    expect(result.missing).toEqual(['root/gone.jpg']);
    expect(seenMissing).toEqual(['root/gone.jpg']);
    expect(zipAt(bucket, 'x.zip').map((entry) => entry.name)).toEqual(['root/here.jpg', 'root/manifest.json']);
  });

  it('aborts its uploads when reading an object fails', async () => {
    const bucket = new FakeBucket();
    bucket.seed('media/ok', 'ok');
    bucket.failGetFor.add('media/broken');
    await expect(buildGroupArchives(bucket as never, {
      groupId: 'g',
      baseName: 'x',
      keyFor: () => 'x.zip',
      entries: [objectEntry('ok.jpg', 'media/ok'), objectEntry('broken.jpg', 'media/broken')],
    })).rejects.toThrow('simulated R2 failure');
    expect(bucket.uploads.every((upload) => upload.aborted)).toBe(true);
    expect(bucket.objects.has('x.zip')).toBe(false);
  });
});
