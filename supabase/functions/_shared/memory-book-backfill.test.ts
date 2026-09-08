import { assertEquals } from 'jsr:@std/assert@1';
import { backfillOriginalFilesForBook, buildOriginalFileMapForFamily } from './memory-book-backfill.ts';

const FAMILY_ID = '22222222-2222-4222-8222-222222222222';

interface StubRow {
  object_key: string;
  preview_object_key: string | null;
}

// Same "filter-blind chain stub" convention as memory-book-edits/index.test.ts:
// the query builder is awaited directly after the final `.eq()` (this
// module's own select never paginates), so `.eq()` just resolves the stub
// rows -- these tests exercise this file's own map-building/error handling,
// not PostgREST's actual filter semantics.
function stubClient(options: { rows?: StubRow[]; error?: { message: string } | null; calls?: string[] }) {
  return {
    from(table: string) {
      options.calls?.push(table);
      if (table !== 'memory_media') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: async () => ({ data: options.rows ?? [], error: options.error ?? null }),
        }),
      };
    },
  } as never;
}

Deno.test('buildOriginalFileMapForFamily keys by both preview_object_key and object_key', async () => {
  const supabase = stubClient({
    rows: [
      { object_key: 'raw-a.jpg', preview_object_key: 'a-preview.jpg' },
      { object_key: 'raw-only.jpg', preview_object_key: null },
    ],
  });

  const map = await buildOriginalFileMapForFamily(supabase, FAMILY_ID);
  assertEquals(map, {
    'raw-a.jpg': 'raw-a.jpg',
    'a-preview.jpg': 'raw-a.jpg',
    'raw-only.jpg': 'raw-only.jpg',
  });
});

Deno.test('buildOriginalFileMapForFamily throws loudly on a DB error rather than silently returning an empty map', async () => {
  const supabase = stubClient({ error: { message: 'connection reset' } });
  let threw = false;
  try {
    await buildOriginalFileMapForFamily(supabase, FAMILY_ID);
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message.includes('connection reset'), true);
  }
  assertEquals(threw, true);
});

Deno.test('backfillOriginalFilesForBook scopes the memory_media read to the given family and patches the document', async () => {
  const calls: string[] = [];
  const supabase = stubClient({
    calls,
    rows: [{ object_key: 'a.jpg', preview_object_key: 'a-preview.jpg' }],
  });

  const bookDocument = {
    outline: { runId: 'run-1' },
    manifest: {
      child: { id: 'child-1', name: 'Test' },
      scope: { kind: 'age-year', label: 'Year One', start: '2024-01-01', end: '2024-12-31' },
      generatedAt: '2026-01-01T00:00:00.000Z',
      outlineRun: 'run-1',
      memories: {
        'mem-1': {
          date: '2024-06-01',
          type: 'photo',
          text: null,
          emotion: null,
          topics: [],
          milestones: [],
          engagement: 0,
          taggedMembers: [],
          assets: [
            { file: 'a-preview.jpg', width: 1280, height: 960, aspectRatio: 1.33, kind: 'photo', durationMs: null },
          ],
          illustration: null,
          shareToken: null,
        },
      },
      portraits: [],
      language: 'en',
      downloadFailures: [],
      assetMode: 'preview',
    },
  };

  const result = await backfillOriginalFilesForBook(supabase, FAMILY_ID, bookDocument);

  assertEquals(calls, ['memory_media']);
  assertEquals(result.patchedCount, 1);
  assertEquals(result.unresolved, []);
  assertEquals(result.bookDocument.manifest.memories['mem-1'].assets[0].originalFile, 'a.jpg');
  // The caller's own book_document object is never mutated in place.
  assertEquals(
    'originalFile' in (bookDocument.manifest.memories['mem-1'].assets[0] as Record<string, unknown>),
    false,
  );
});
