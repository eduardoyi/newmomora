import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { cachedFrame, cachedVoice, checkCacheKey, splitBatch } from './year-film-checks.ts';
import { yearFilmTextHash } from './year-film-context.ts';
import type { FrameCheck } from './year-film-vision.ts';

Deno.test('cache keys change with anything that could change the verdict', async () => {
  const base = { kind: 'frame' as const, model: 'gpt-6-luna', assetKey: 'u/memories/a.mp4', window: { start: 1, end: 3.5 }, referenceKeys: ['r1', 'r2'] };
  const k = await checkCacheKey(base);
  assertEquals(k, await checkCacheKey({ ...base, referenceKeys: ['r2', 'r1'] })); // order-insensitive
  assertNotEquals(k, await checkCacheKey({ ...base, model: 'gpt-6-sol' }));
  assertNotEquals(k, await checkCacheKey({ ...base, window: { start: 5, end: 7.5 } }));
  assertNotEquals(k, await checkCacheKey({ ...base, referenceKeys: ['r1'] }));
  assertNotEquals(k, await checkCacheKey({ ...base, kind: 'claim' }));
  assertEquals(k.startsWith('frame:'), true);
});

Deno.test('the strict public variant has its own cache key; normal keys are unchanged', async () => {
  const base = { kind: 'frame' as const, model: 'gpt-6-luna', assetKey: 'u/memories/a.mp4', window: { start: 1, end: 3.5 }, referenceKeys: ['r1'] };
  const normal = await checkCacheKey(base);
  const strict = await checkCacheKey({ ...base, variant: 'public-v2' });
  assertNotEquals(normal, strict); // a cached normal verdict is never reused as a strict one
  // …nor one from the retired v1 public prompt (no beach exception): its keys are never produced again.
  assertNotEquals(strict, await checkCacheKey({ ...base, variant: 'public' as never }));
  assertEquals(strict, await checkCacheKey({ ...base, variant: 'public-v2' }));
  assertNotEquals(await checkCacheKey({ ...base, kind: 'claim' }), await checkCacheKey({ ...base, kind: 'claim', variant: 'public-v2' }));
  // Keys of every other film are byte-for-byte what they were before the variant existed.
  assertEquals(normal, 'frame:c1b31cbae87fd2ea8522f318e46d69a9'); // computed with the pre-variant formula
  assertEquals(normal, await checkCacheKey({ ...base, variant: undefined }));
});

Deno.test('splitBatch keeps positional results per item and records misses as null', () => {
  const check = { mainSubject: 'c1' } as FrameCheck;
  const cache = splitBatch('frame', ['a', 'b', 'c'], new Map([[0, check], [2, check]]));
  assertEquals(cachedFrame(cache, 'a'), check);
  assertEquals(cachedFrame(cache, 'b'), null); // asked, no answer → fail-open later
  assertEquals(cachedFrame(cache, 'zzz'), undefined); // never asked
  assertEquals(cachedVoice(cache, 'a'), undefined); // wrong kind
});

Deno.test('yearFilmTextHash matches the SQL twin (same fixture as supabase/tests/year_films.sql)', async () => {
  assertEquals(await yearFilmTextHash('Hola', null, 'desc'), 'ce3e78aedcf937fb1e8a454c7e65c09bff23dbcd5abfe7ce58e3ece86d12008d');
});
