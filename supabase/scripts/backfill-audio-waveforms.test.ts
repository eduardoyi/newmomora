import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1';

import {
  AUDIO_CONTENT_TYPES,
  type AudioMediaRow,
  BackfillError,
  type BackfillDeps,
  type BackfillOptions,
  buildFfmpegDecodeArgs,
  createSupabaseStore,
  f32leToFloat32Array,
  parseArgs,
  runBackfill,
  type WaveformStore,
  waveformFromPcmBytes,
} from './backfill-audio-waveforms.ts';
import {
  type PcmRecipe,
  synthesizeFromRecipe,
  WAVEFORM_BUCKETS,
} from '../../src/utils/audio-waveform.ts';

interface GoldenCase {
  maxBuckets: number;
  minBucketMs: number;
  waveform64: number[];
}
const golden = JSON.parse(
  Deno.readTextFileSync(
    new URL('../../src/utils/__fixtures__/waveform-golden.json', import.meta.url),
  ),
) as { recipe: PcmRecipe; cases: GoldenCase[] };

// The case that uses the backfill's analysis parameters (4000 / 20 ms).
const backfillCase = golden.cases.find(
  (testCase) => testCase.maxBuckets === 4000 && testCase.minBucketMs === 20,
)!;

function goldenPcmBytes(): Uint8Array {
  const samples = synthesizeFromRecipe(golden.recipe);
  return new Uint8Array(samples.buffer.slice(0, samples.byteLength));
}

const MEMORY_ID = '33333333-3333-4333-8333-333333333333';
function row(n: number, objectKey = `user/memories/${MEMORY_ID}/media/${n}.m4a`): AudioMediaRow {
  return { id: `row-${n}`, memory_id: MEMORY_ID, object_key: objectKey };
}

interface Harness {
  deps: BackfillDeps;
  logs: string[];
  errors: string[];
  writes: { id: string; waveform: number[] }[];
  tempWritten: string[];
  tempRemoved: string[];
  ffmpegCalls: string[];
  downloads: string[];
  listCalls: { offset: number; size: number; memoryId?: string }[];
}

function makeHarness(
  rows: AudioMediaRow[],
  overrides: Partial<BackfillDeps> & { alreadyFilled?: Set<string> } = {},
): Harness {
  const h: Harness = {
    deps: undefined as unknown as BackfillDeps,
    logs: [],
    errors: [],
    writes: [],
    tempWritten: [],
    tempRemoved: [],
    ffmpegCalls: [],
    downloads: [],
    listCalls: [],
  };
  const store: WaveformStore = {
    listCandidates(page) {
      h.listCalls.push(page);
      return Promise.resolve(rows.slice(page.offset, page.offset + page.size));
    },
    setWaveformIfNull(id, waveform) {
      if (overrides.alreadyFilled?.has(id)) return Promise.resolve(false);
      h.writes.push({ id, waveform });
      return Promise.resolve(true);
    },
  };
  let tempCounter = 0;
  h.deps = {
    store,
    downloadObject: (key) => {
      h.downloads.push(key);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
    tempFiles: {
      write: () => {
        const path = `/tmp/fake-${tempCounter++}.m4a`;
        h.tempWritten.push(path);
        return Promise.resolve(path);
      },
      remove: (path) => {
        h.tempRemoved.push(path);
        return Promise.resolve();
      },
    },
    runFfmpeg: (path) => {
      h.ffmpegCalls.push(path);
      return Promise.resolve(goldenPcmBytes());
    },
    log: (message) => h.logs.push(message),
    logError: (message) => h.errors.push(message),
    ...overrides,
  };
  return h;
}

const DRY: BackfillOptions = { apply: false, concurrency: 2 };
const APPLY: BackfillOptions = { apply: true, concurrency: 2 };

// --- pure helpers -----------------------------------------------------------

Deno.test('waveformFromPcmBytes on the golden recipe equals the fixture waveform (4000 / 20 ms)', () => {
  const { waveform, durationMs } = waveformFromPcmBytes(goldenPcmBytes());
  assertEquals(waveform, backfillCase.waveform64);
  assertEquals(waveform.length, WAVEFORM_BUCKETS);
  assertEquals(durationMs, 5537);
});

Deno.test('waveformFromPcmBytes: silence buckets are 0 and all-silent audio is all zeros (valid, not an error)', () => {
  const silent = new Uint8Array(48000 * 4);
  const { waveform } = waveformFromPcmBytes(silent);
  assertEquals(waveform, new Array(WAVEFORM_BUCKETS).fill(0));
});

Deno.test('waveformFromPcmBytes rejects empty audio', () => {
  const error = assertThrows(() => waveformFromPcmBytes(new Uint8Array(0)), BackfillError);
  assertEquals(error.category, 'empty_audio');
});

Deno.test('f32leToFloat32Array ignores a trailing partial sample and unaligned views', () => {
  const source = new Float32Array([0.25, -0.5, 1]);
  const padded = new Uint8Array(source.byteLength + 3);
  padded.set(new Uint8Array(source.buffer), 1);
  const view = padded.subarray(1, 1 + source.byteLength + 2); // offset 1, 2 stray bytes
  assertEquals([...f32leToFloat32Array(view)], [0.25, -0.5, 1]);
});

Deno.test('buildFfmpegDecodeArgs decodes mono 48 kHz f32le to stdout', () => {
  assertEquals(buildFfmpegDecodeArgs('/tmp/in.m4a'), [
    '-nostdin',
    '-v',
    'error',
    '-i',
    '/tmp/in.m4a',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    '-',
  ]);
});

// --- arg parsing ------------------------------------------------------------

Deno.test('parseArgs defaults to dry-run with concurrency 4', () => {
  assertEquals(parseArgs([]), { apply: false, concurrency: 4 });
});

Deno.test('parseArgs reads --apply, --limit, --memory-id and --concurrency', () => {
  assertEquals(
    parseArgs(['--apply', '--limit', '10', '--memory-id', MEMORY_ID, '--concurrency', '2']),
    { apply: true, limit: 10, memoryId: MEMORY_ID, concurrency: 2 },
  );
});

Deno.test('parseArgs rejects unknown flags and bad numbers instead of running a full pass', () => {
  assertThrows(() => parseArgs(['--aply']), Error, 'Unknown argument');
  assertThrows(() => parseArgs(['--limit']), Error, '--limit');
  assertThrows(() => parseArgs(['--limit', '0']), Error, '--limit');
  assertThrows(() => parseArgs(['--concurrency', 'abc']), Error, '--concurrency');
  assertThrows(() => parseArgs(['--memory-id', '--apply']), Error, '--memory-id');
});

// --- candidate selection (query shape) ---------------------------------------

Deno.test('createSupabaseStore selects audio rows with a null waveform, optionally per memory', async () => {
  const calls: [string, ...unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'is', 'order', 'range', 'eq', 'update']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  // deno-lint-ignore no-explicit-any
  (builder as any).then = (resolve: (value: unknown) => void) =>
    resolve({ data: [{ id: 'a', memory_id: 'm', object_key: 'k' }], error: null });

  const tables: string[] = [];
  const store = createSupabaseStore({
    from(table: string) {
      tables.push(table);
      return builder;
    },
  });

  const result = await store.listCandidates({ offset: 500, size: 500, memoryId: MEMORY_ID });
  assertEquals(result, [{ id: 'a', memory_id: 'm', object_key: 'k' }]);
  assertEquals(tables, ['memory_media']);
  assertEquals(calls.find(([m]) => m === 'in'), ['in', 'content_type', [...AUDIO_CONTENT_TYPES]]);
  assertEquals([...AUDIO_CONTENT_TYPES].sort(), ['audio/m4a', 'audio/mp4', 'audio/x-m4a']);
  assertEquals(calls.find(([m]) => m === 'is'), ['is', 'waveform', null]);
  assertEquals(calls.find(([m]) => m === 'range'), ['range', 500, 999]);
  assertEquals(calls.find(([m]) => m === 'eq'), ['eq', 'memory_id', MEMORY_ID]);
});

Deno.test('createSupabaseStore.setWaveformIfNull issues the guarded update and reports whether a row changed', async () => {
  const calls: [string, ...unknown[]][] = [];
  let returned: unknown[] = [{ id: 'row-1' }];
  const builder: Record<string, unknown> = {};
  for (const method of ['update', 'eq', 'is', 'select']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  // deno-lint-ignore no-explicit-any
  (builder as any).then = (resolve: (value: unknown) => void) =>
    resolve({ data: returned, error: null });
  const store = createSupabaseStore({ from: () => builder });

  assertEquals(await store.setWaveformIfNull('row-1', [1, 2, 3]), true);
  assertEquals(calls.find(([m]) => m === 'update'), ['update', { waveform: [1, 2, 3] }]);
  assertEquals(calls.find(([m]) => m === 'eq'), ['eq', 'id', 'row-1']);
  assertEquals(calls.find(([m]) => m === 'is'), ['is', 'waveform', null]);

  returned = []; // guard matched nothing: someone filled it first
  assertEquals(await store.setWaveformIfNull('row-1', [1, 2, 3]), false);
});

Deno.test('createSupabaseStore surfaces db errors without leaking their message', async () => {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'is', 'order', 'range']) {
    builder[method] = () => builder;
  }
  // deno-lint-ignore no-explicit-any
  (builder as any).then = (resolve: (value: unknown) => void) =>
    resolve({ data: null, error: { message: 'secret row contents' } });
  const store = createSupabaseStore({ from: () => builder });
  const error = await assertRejects(() => store.listCandidates({ offset: 0, size: 10 }));
  assertEquals((error as Error).message.includes('secret'), false);
});

// --- runBackfill ------------------------------------------------------------

Deno.test('dry run decodes but writes nothing, and cleans up temp files', async () => {
  const h = makeHarness([row(1), row(2)]);
  const summary = await runBackfill(DRY, h.deps);

  assertEquals(h.writes, []);
  assertEquals(h.ffmpegCalls.length, 2);
  assertEquals(summary.candidates, 2);
  assertEquals(summary.updated, 2); // "would update"
  assertEquals(summary.failed, 0);
  assertEquals(h.tempRemoved.sort(), h.tempWritten.sort());
  assertEquals(h.logs.some((line) => line.includes('dry run')), true);
});

Deno.test('apply issues the guarded update with the golden waveform for every row', async () => {
  const h = makeHarness([row(1), row(2)]);
  const summary = await runBackfill(APPLY, h.deps);

  assertEquals(h.writes.map((w) => w.id).sort(), ['row-1', 'row-2']);
  for (const write of h.writes) {
    assertEquals(write.waveform, backfillCase.waveform64);
  }
  assertEquals(summary.updated, 2);
  assertEquals(summary.skipped, 0);
  assertEquals(h.tempRemoved.sort(), h.tempWritten.sort());
});

Deno.test('rows that already got a waveform (guard matched nothing) count as skipped, not updated', async () => {
  const h = makeHarness([row(1), row(2)], { alreadyFilled: new Set(['row-2']) });
  const summary = await runBackfill(APPLY, h.deps);
  assertEquals(summary.updated, 1);
  assertEquals(summary.skipped, 1);
  assertEquals(summary.failed, 0);
});

Deno.test('rows sharing an object key are downloaded and decoded once but each updated', async () => {
  const shared = 'user/memories/m/media/shared.m4a';
  const h = makeHarness([row(1, shared), row(2, shared)]);
  const summary = await runBackfill(APPLY, h.deps);
  assertEquals(h.downloads, [shared]);
  assertEquals(h.ffmpegCalls.length, 1);
  assertEquals(h.writes.map((w) => w.id).sort(), ['row-1', 'row-2']);
  assertEquals(summary.updated, 2);
});

Deno.test('--limit and --memory-id are respected', async () => {
  const rows = [row(1), row(2), row(3)];
  const h = makeHarness(rows);
  const summary = await runBackfill({ ...APPLY, limit: 2, memoryId: MEMORY_ID }, h.deps);
  assertEquals(summary.candidates, 2);
  assertEquals(h.writes.length, 2);
  assertEquals(h.listCalls[0].memoryId, MEMORY_ID);
});

Deno.test('pages through candidates beyond one database page', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => row(i, `k/${i}.m4a`));
  const h = makeHarness(rows);
  const summary = await runBackfill(DRY, h.deps);
  assertEquals(summary.candidates, 501);
  assertEquals(h.listCalls.map((c) => c.offset), [0, 500]);
});

Deno.test('no candidates: nothing runs', async () => {
  const h = makeHarness([]);
  const summary = await runBackfill(APPLY, h.deps);
  assertEquals(summary.candidates, 0);
  assertEquals(h.ffmpegCalls, []);
});

Deno.test('ffmpeg failure is counted as decode, other rows still succeed, temp file still removed', async () => {
  const h = makeHarness([row(1), row(2)], {
    runFfmpeg: (() => {
      let call = 0;
      return () => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error('Invalid data found when processing input'))
          : Promise.resolve(goldenPcmBytes());
      };
    })(),
  });
  const summary = await runBackfill({ ...APPLY, concurrency: 1 }, h.deps);

  assertEquals(summary.failed, 1);
  assertEquals(summary.failedByCategory, { decode: 1 });
  assertEquals(summary.updated, 1);
  assertEquals(h.writes.length, 1);
  assertEquals(h.tempRemoved.sort(), h.tempWritten.sort());
  assertEquals(h.tempWritten.length, 2);
  // Logs carry the category only, never the underlying message.
  assertEquals(h.errors.length, 1);
  assertEquals(h.errors[0].includes('Invalid data'), false);
  assertEquals(h.errors[0].includes('decode'), true);
});

Deno.test('empty decode output is categorised empty_audio and nothing is written', async () => {
  const h = makeHarness([row(1)], { runFfmpeg: () => Promise.resolve(new Uint8Array(0)) });
  const summary = await runBackfill(APPLY, h.deps);
  assertEquals(summary.failedByCategory, { empty_audio: 1 });
  assertEquals(h.writes, []);
  assertEquals(h.tempRemoved, h.tempWritten);
});

Deno.test('download failure is retried once; a second failure is categorised and no temp file is created', async () => {
  let attempts = 0;
  const h = makeHarness([row(1)], {
    downloadObject: () => {
      attempts += 1;
      return Promise.reject(new BackfillError('download'));
    },
  });
  const summary = await runBackfill(APPLY, h.deps);
  assertEquals(attempts, 2);
  assertEquals(summary.failedByCategory, { download: 1 });
  assertEquals(h.tempWritten, []);
  assertEquals(h.ffmpegCalls, []);
});

Deno.test('a transient download failure recovers on the retry', async () => {
  let attempts = 0;
  const h = makeHarness([row(1)], {
    downloadObject: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new BackfillError('download'))
        : Promise.resolve(new Uint8Array([1]));
    },
  });
  const summary = await runBackfill(APPLY, h.deps);
  assertEquals(summary.updated, 1);
  assertEquals(summary.failed, 0);
});

Deno.test('a failing database write is categorised db_update', async () => {
  const h = makeHarness([row(1)]);
  h.deps.store.setWaveformIfNull = () => Promise.reject(new Error('connection reset'));
  const summary = await runBackfill(APPLY, h.deps);
  assertEquals(summary.failedByCategory, { db_update: 1 });
  assertEquals(summary.updated, 0);
  assertEquals(h.tempRemoved, h.tempWritten);
});

Deno.test('logs contain row ids and counts but never object keys', async () => {
  const h = makeHarness([row(1, 'SECRET-USER/memories/SECRET-MEMORY/media/SECRET-ASSET.m4a')]);
  await runBackfill(APPLY, h.deps);
  const all = [...h.logs, ...h.errors].join('\n');
  assertEquals(all.includes('SECRET'), false);
  assertEquals(all.includes('row-1'), true);
});
