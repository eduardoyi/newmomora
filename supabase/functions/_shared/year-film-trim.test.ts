import { assert, assertEquals } from 'jsr:@std/assert@1';
import { chooseClipWindow, chooseVoiceWindow, parseRmsLevels, parseSceneScores, rankClipWindows, rankVoiceWindows, voicedSegments } from './year-film-trim.ts';

Deno.test('parses ffmpeg scene scores and RMS levels', () => {
  const scene = 'frame:0    pts:0       pts_time:0\nlavfi.scene_score=0.000000\nframe:1    pts:1       pts_time:0.25\nlavfi.scene_score=0.041000\n';
  assertEquals(parseSceneScores(scene), [{ t: 0, scene: 0 }, { t: 0.25, scene: 0.041 }]);
  const rms = 'frame:0    pts:0  pts_time:0\nlavfi.astats.Overall.RMS_level=-inf\nframe:1 pts:4000 pts_time:0.25\nlavfi.astats.Overall.RMS_level=-21.5\n';
  assertEquals(parseRmsLevels(rms), [{ t: 0, rmsDb: -Infinity }, { t: 0.25, rmsDb: -21.5 }]);
});

/** 0.25s windows: `level(t)` gives the dB at each window start. */
function series(duration: number, level: (t: number) => number) {
  return Array.from({ length: Math.round(duration / 0.25) }, (_, i) => ({ t: i * 0.25, rmsDb: level(i * 0.25) }));
}

Deno.test('voicedSegments adapts to the clip\'s noise floor', () => {
  // Noisy park at -38 dB, a child talking at -24 dB between 3s and 5s.
  const park = series(10, (t) => (t >= 3 && t < 5 ? -24 : -38));
  assertEquals(voicedSegments(park, 0.25), [{ start: 3, end: 5 }]);
  // Silence everywhere: nothing voiced.
  assertEquals(voicedSegments(series(4, () => -70), 0.25), []);
});

Deno.test('chooseVoiceWindow takes the most voiced ≤6s, from just before an onset', () => {
  const voiced = [{ start: 1, end: 2 }, { start: 8, end: 13 }, { start: 13.5, end: 14 }];
  const w = chooseVoiceWindow(voiced, 20)!;
  assertEquals([w.start, w.end], [7.85, 13.85]);
  assert(w.voicedSeconds >= 5.3);
  assertEquals(chooseVoiceWindow([], 20), null);
  // Trailing silence is cut.
  assertEquals(chooseVoiceWindow([{ start: 0.5, end: 2 }], 20)!.end, 2.3);
});

Deno.test('chooseClipWindow finds the lively part and skips the first half-second', () => {
  const duration = 12;
  const motion = Array.from({ length: 48 }, (_, i) => ({ t: i * 0.25, scene: i * 0.25 >= 7 && i * 0.25 < 9.5 ? 0.08 : 0.005 }));
  const loud = series(duration, () => -30);
  const w = chooseClipWindow(motion, loud, duration);
  assert(w.start >= 6.5 && w.start <= 7.25, `start ${w.start}`);
  assertEquals(w.end - w.start, 2.5);
  // Short clips play whole.
  assertEquals(chooseClipWindow([], [], 2.2), { start: 0, end: 2.2, score: 0 });
  // Never starts before 0.5s on a long, uniform clip.
  assert(chooseClipWindow([], series(10, () => -30), 10).start >= 0.5);
});

Deno.test('ranked windows give distinct fallbacks', () => {
  const voiced = [{ start: 1, end: 2 }, { start: 8, end: 13 }, { start: 16, end: 18 }];
  const voice = rankVoiceWindows(voiced, 20);
  assertEquals(voice[0].start, 7.85);
  assert(voice.length >= 2 && voice.every((w, i) => voice.findIndex((o) => Math.abs(o.start - w.start) < 0.5) === i));
  const duration = 20;
  const motion = Array.from({ length: 80 }, (_, i) => ({ t: i * 0.25, scene: (i * 0.25 >= 4 && i * 0.25 < 6.5) || (i * 0.25 >= 14 && i * 0.25 < 16.5) ? 0.08 : 0.005 }));
  const clips = rankClipWindows(motion, series(duration, () => -30), duration);
  assert(clips.length >= 2);
  assert(clips.every((a, i) => clips.every((b, j) => i === j || a.end <= b.start || b.end <= a.start)), 'windows overlap');
});
