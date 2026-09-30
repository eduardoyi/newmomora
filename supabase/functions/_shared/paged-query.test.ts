import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { byMemoryIds, fetchAll, PagedQueryError } from './paged-query.ts';

type Row = { id: string };
const ok = (data: Row[]) => Promise.resolve({ data, error: null });

Deno.test('fetchAll pages until a short page and returns every row', async () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}` }));
  const ranges: Array<[number, number]> = [];
  const out = await fetchAll<Row>((from, to) => {
    ranges.push([from, to]);
    return ok(all.slice(from, to + 1));
  });
  assertEquals(out.length, 2500);
  assertEquals(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});

Deno.test('fetchAll asks for one more page when the last page is exactly full', async () => {
  const all = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
  let calls = 0;
  const out = await fetchAll<Row>((from, to) => {
    calls += 1;
    return ok(all.slice(from, to + 1));
  });
  assertEquals(out.length, 1000);
  assertEquals(calls, 2);
});

Deno.test('fetchAll honours a custom page size', async () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` }));
  const out = await fetchAll<Row>((from, to) => ok(all.slice(from, to + 1)), { pageSize: 3 });
  assertEquals(out.length, 7);
});

Deno.test('fetchAll throws on a page error instead of returning a partial/empty result', async () => {
  const error = await assertRejects(
    () => fetchAll<Row>((from) => Promise.resolve(from === 0 ? { data: [{ id: 'a' }], error: null } : { data: null, error: { message: 'secret detail', code: '57014' } }), { pageSize: 1 }),
    PagedQueryError,
    'page_failed',
  );
  assertEquals(error.code, '57014');
  // The underlying message (which could echo row content) is not carried.
  assertEquals(error.message.includes('secret'), false);
});

Deno.test('fetchAll dedupes a row repeated across a page boundary (and still terminates on raw page length)', async () => {
  const pages: Row[][] = [[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }], [{ id: 'c' }]];
  const out = await fetchAll<Row>((from) => ok(pages[from / 2] ?? []), { pageSize: 2, dedupeKey: (row) => row.id });
  assertEquals(out.map((row) => row.id), ['a', 'b', 'c']);
});

Deno.test('fetchAll without dedupeKey keeps duplicates', async () => {
  const out = await fetchAll<Row>(() => ok([{ id: 'a' }, { id: 'a' }]));
  assertEquals(out.length, 2);
});

Deno.test('byMemoryIds chunks ids sequentially, pages within each chunk, and never exceeds chunkSize', async () => {
  const ids = Array.from({ length: 401 }, (_, i) => `m${i}`);
  const chunkLengths: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const out = await byMemoryIds<Row>(
    ids,
    async (chunk, from, to) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (from === 0) chunkLengths.push(chunk.length);
      await Promise.resolve();
      inFlight -= 1;
      // Two rows per id so each chunk needs paging at pageSize 100.
      const rows = chunk.flatMap((id) => [{ id: `${id}-1` }, { id: `${id}-2` }]);
      return { data: rows.slice(from, to + 1), error: null };
    },
    { chunkSize: 150, pageSize: 100 },
  );
  assertEquals(chunkLengths, [150, 150, 101]);
  assertEquals(maxInFlight, 1);
  assertEquals(out.length, 802);
});

Deno.test('byMemoryIds makes no query for an empty id list', async () => {
  let calls = 0;
  const out = await byMemoryIds<Row>([], () => {
    calls += 1;
    return ok([]);
  }, { chunkSize: 150 });
  assertEquals(out, []);
  assertEquals(calls, 0);
});

Deno.test('byMemoryIds throws when any chunk errors', async () => {
  let call = 0;
  await assertRejects(
    () => byMemoryIds<Row>(['a', 'b'], () => {
      call += 1;
      return Promise.resolve(call === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null });
    }, { chunkSize: 1 }),
    PagedQueryError,
  );
});

Deno.test('byMemoryIds dedupes across chunks and rejects a non-positive chunk size', async () => {
  const out = await byMemoryIds<Row>(['a', 'b'], () => ok([{ id: 'same' }]), { chunkSize: 1, dedupeKey: (row) => row.id });
  assertEquals(out.length, 1);
  await assertRejects(() => byMemoryIds<Row>(['a'], () => ok([]), { chunkSize: 0 }), RangeError);
});
