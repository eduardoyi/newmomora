import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFailureLines, isHeic, jobKey, missingPaths, parseManifest, posterTime, scenesFromTimeline, statusKey, verifyImage } from '../src/job.mjs';

const prefix = 'owner/year-films/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/';

test('job and status keys per mode (the Worker polls these paths)', () => {
  assert.equal(jobKey(prefix, 'thumbs'), `${prefix}thumbs/job.json`);
  assert.equal(statusKey(prefix, 'thumbs'), `${prefix}thumbs/status.json`);
  assert.equal(jobKey(prefix, 'prepare'), `${prefix}prep/job.json`);
  assert.equal(statusKey(prefix, 'prepare'), `${prefix}prep/status.json`);
  assert.equal(jobKey(prefix, 'render'), `${prefix}job.json`);
  assert.equal(statusKey(prefix, 'render'), `${prefix}status.json`);
});

test('scenes.json and the poster frame come from the assembler timeline', () => {
  const timeline = {
    total: 61.017,
    scenes: [
      { id: 's0', type: 'cold_open', role: null, start: 0, duration: 4.068 },
      { id: 's1', type: 'close', role: null, start: 50, duration: 6 },
      { id: 's2', type: 'end_card', role: null, start: 56, duration: 5.017 },
    ],
  };
  assert.deepEqual(scenesFromTimeline(timeline).scenes[1], { id: 's1', type: 'close', role: null, startMs: 50000, durationMs: 6000 });
  assert.equal(scenesFromTimeline(timeline).durationMs, 61017);
  assert.equal(posterTime(timeline), 3.458);
});

test('posterTime: the first scene, settled (cold open, title, very short first scene)', () => {
  // Birthday: the first scene is the cold open, not the close.
  const birthday = {
    total: 61.017,
    scenes: [
      { id: 's0', type: 'cold_open', role: null, start: 0, duration: 4.068 },
      { id: 's1', type: 'close', role: null, start: 50, duration: 6 },
      { id: 's2', type: 'end_card', role: null, start: 56, duration: 5.017 },
    ],
  };
  assert.equal(posterTime(birthday), 3.458); // 0.85 * 4.068
  // Monthly/family: the first scene is the title card. Scene order in the
  // array must not matter, only the smallest start.
  const monthly = {
    total: 22.241,
    scenes: [
      { id: 'e', type: 'end_card', role: null, start: 19.138, duration: 3.103 },
      { id: 't', type: 'title', role: null, start: 0, duration: 4.138 },
      { id: 'p', type: 'photos', role: null, start: 4.138, duration: 6 },
    ],
  };
  assert.equal(posterTime(monthly), 3.517); // 0.85 * 4.138
  // A first scene that does not start at 0 is offset by its start.
  assert.equal(posterTime({ total: 20, scenes: [{ id: 't', type: 'title', role: null, start: 1, duration: 4 }] }), 4.4);
  // Very short first scenes: never earlier than the midpoint, never past the end.
  assert.equal(posterTime({ total: 10, scenes: [{ id: 't', type: 'title', role: null, start: 0, duration: 1 }] }), 0.65);
  assert.equal(posterTime({ total: 10, scenes: [{ id: 't', type: 'title', role: null, start: 0, duration: 0.5 }] }), 0.25);
  // No scenes at all: 80% in.
  assert.equal(posterTime({ total: 10, scenes: [] }), 8);
});

test('HEIC detection', () => {
  assert.equal(isHeic('u/memories/a/IMG_1.HEIC'), true);
  assert.equal(isHeic('u/memories/a/IMG_1.jpg'), false);
});

test('checkFailureLines keeps only the failing rule lines, ANSI-free and capped', () => {
  const report = ['\x1b[36mLint\x1b[39m', '  \x1b[31m✗\x1b[39m missing_local_asset: assets/film/025.mp4', '    Fix: add the file', '  ◇ 0 errors', 'TimeoutError: render-ready after 3000ms', ...Array.from({ length: 20 }, (_, i) => `✗ rule ${i}`)].join('\n');
  const lines = checkFailureLines(report);
  assert.equal(lines[0], '✗ missing_local_asset: assets/film/025.mp4');
  assert.equal(lines[1], 'TimeoutError: render-ready after 3000ms');
  assert.equal(lines.length, 12);
  assert.ok(lines.every((l) => !l.includes('Fix:')));
});

test('parseManifest and missingPaths: paths in manifest order, blanks ignored', () => {
  const paths = parseManifest('/a/one\n\n/a/two \n/a/three\n');
  assert.deepEqual(paths, ['/a/one', '/a/two', '/a/three']);
  const present = new Set(['/a/two']);
  assert.deepEqual(missingPaths(paths, (p) => present.has(p)), ['/a/one', '/a/three']);
  assert.deepEqual(missingPaths(paths, () => true), []);
  assert.deepEqual(missingPaths([], () => false), []);
});

function guardHarness({ manifest = '/a\n/b\n', existsAt }) {
  let t = 0;
  const logs = [];
  const sleeps = [];
  return {
    logs,
    sleeps,
    options: {
      manifestPath: '/app/image-manifest.txt',
      readFile: () => {
        if (manifest === null) throw new Error('ENOENT');
        return manifest;
      },
      existsFn: (p) => existsAt(p, t),
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
      log: (line) => logs.push(line),
    },
  };
}

test('verifyImage: no manifest (local dev/tests) skips the guard', async () => {
  const h = guardHarness({ manifest: null, existsAt: () => false });
  assert.deepEqual(await verifyImage(h.options), { ok: true, skipped: true });
  assert.deepEqual(h.logs, []);
});

test('verifyImage: a complete image passes without waiting or logging a miss', async () => {
  const h = guardHarness({ existsAt: () => true });
  const r = await verifyImage(h.options);
  assert.equal(r.ok, true);
  assert.equal(r.files, 2);
  assert.equal(r.recovered, false);
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual(h.logs, []);
});

test('verifyImage: files that appear during the wait continue, logging the recovery', async () => {
  const h = guardHarness({ existsAt: (p, t) => p !== '/b' || t >= 10000 });
  const r = await verifyImage(h.options);
  assert.equal(r.ok, true);
  assert.equal(r.recovered, true);
  assert.deepEqual(h.sleeps, [5000, 5000]);
  assert.deepEqual(h.logs, ['image: 1 missing (first: /b)', 'image: 1 missing (first: /b)', 'image: complete after 10.0s']);
});

test('verifyImage: still missing after ~60 s fails (paths and counts only)', async () => {
  const h = guardHarness({ existsAt: (p) => p === '/a' });
  const r = await verifyImage(h.options);
  assert.deepEqual({ ok: r.ok, missing: r.missing, first: r.first }, { ok: false, missing: 1, first: '/b' });
  assert.equal(r.waitedMs, 60000);
  assert.equal(h.sleeps.length, 12);
  assert.ok(h.logs.every((l) => l === 'image: 1 missing (first: /b)'));
});
