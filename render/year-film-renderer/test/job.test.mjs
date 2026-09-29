import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHeic, jobKey, posterTime, scenesFromTimeline, statusKey } from '../src/job.mjs';

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
  assert.equal(posterTime(timeline), 53);
  assert.equal(posterTime({ total: 10, scenes: [] }), 8);
  assert.equal(posterTime({ total: 22.241, scenes: [{ id: 't', type: 'title', role: null, start: 0, duration: 4.138 }, { id: 'e', type: 'end_card', role: null, start: 19.138, duration: 3.103 }] }), 2.69);
});

test('HEIC detection', () => {
  assert.equal(isHeic('u/memories/a/IMG_1.HEIC'), true);
  assert.equal(isHeic('u/memories/a/IMG_1.jpg'), false);
});
