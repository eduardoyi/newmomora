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
