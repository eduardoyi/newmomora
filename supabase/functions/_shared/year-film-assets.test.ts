import { assertEquals } from 'jsr:@std/assert@1';
import {
  applyPrepared,
  assetId,
  frameRef,
  planPrepare,
  type PrepareManifest,
  type PreparedAsset,
  resolveFrames,
  resolveSound,
  voiceRef,
} from './year-film-assets.ts';
import type { FilmScript, FrameRef } from './year-film-script.ts';
import type { FrameCheck } from './year-film-vision.ts';
import type { VoiceCheck } from './year-film-voice.ts';

// Synthetic fixture (no family data): a birthday film for child "c1" with a
// sibling "c2", one sound scene (audio primary + video alternate), a burst of
// two clips and a photo, title cards and an end card.

function frame(key: string, kind: FrameRef['kind'], extra: Partial<FrameRef> = {}): FrameRef {
  return {
    memoryId: `m-${key}`,
    date: '2026-05-01',
    kind,
    key,
    previewKey: kind === 'video' ? `${key}.poster.jpg` : null,
    durationMs: kind === 'video' ? 12000 : null,
    aspectRatio: 1,
    emotion: 'joy',
    why: 'test',
    ...extra,
  };
}

function film(soundSource: 'audio' | 'video' = 'audio'): FilmScript {
  return {
    version: 1,
    kind: 'birthday',
    language: 'en',
    title: 'Year Four',
    scope: { start: '2025-10-23', endExclusive: '2026-10-26' },
    subjects: [{ id: 'c1', name: 'Enzo', referenceKey: 'ref/c1.jpg' }],
    references: [{ id: 'c1', name: 'Enzo', referenceKey: 'ref/c1.jpg' }, { id: 'c2', name: 'Mara', referenceKey: 'ref/c2.jpg' }],
    scenes: [
      { type: 'title', title: 'Year Four', subtitle: '', cards: [frame('photo/t1.jpg', 'photo'), frame('draw/t2.webp', 'illustration')] },
      { type: 'sound', source: soundSource, frame: frame('audio/a1.m4a', 'audio'), alternates: [frame('video/v9.mp4', 'video')] },
      { type: 'burst', role: 'first_half', frames: [frame('video/v1.mp4', 'video', { tags: ['c2'] }), frame('video/v2.mp4', 'video'), frame('photo/p1.jpg', 'photo')] },
      { type: 'end_card', grid: [frame('video/v1.mp4', 'video'), frame('photo/p2.jpg', 'photo')] },
    ],
  } as unknown as FilmScript;
}

function asset(id: string, key: string, mode: PreparedAsset['mode'], windows: PreparedAsset['windows'] = [], file: string | null = null): PreparedAsset {
  return {
    id, key, mode, file, checkImage: mode === 'still' || mode === 'reference' ? `prep/${key}.check.jpg` : null,
    source: { width: 1920, height: 1080, duration: 12, hasVideo: mode !== 'still' },
    windows, warnings: [],
  };
}

const win = (i: number, extra = {}) => ({ start: i, end: i + 2.5, file: `prep/w${i}.mp4`, checkImage: `prep/w${i}.jpg`, wav: `prep/w${i}.wav`, ...extra });

function manifest(): PrepareManifest {
  const assets: PreparedAsset[] = [
    asset(assetId('still', 'photo/t1.jpg'), 'photo/t1.jpg', 'still', [], 'prep/t1.jpg'),
    asset(assetId('still', 'draw/t2.webp'), 'draw/t2.webp', 'still', [], 'prep/t2.jpg'),
    asset(assetId('voice', 'audio/a1.m4a'), 'audio/a1.m4a', 'voice', [win(0), win(10)]),
    asset(assetId('voice', 'video/v9.mp4'), 'video/v9.mp4', 'voice', [win(20)]),
    asset(assetId('burst', 'video/v1.mp4'), 'video/v1.mp4', 'clip', [win(1), win(5), win(8)]),
    asset(assetId('burst', 'video/v2.mp4'), 'video/v2.mp4', 'clip', [win(2), win(6)]),
    asset(assetId('still', 'photo/p1.jpg'), 'photo/p1.jpg', 'still', [], 'prep/p1.jpg'),
    asset(assetId('still', 'video/v1.mp4.poster.jpg'), 'video/v1.mp4.poster.jpg', 'still', [], 'prep/v1poster.jpg'),
    asset(assetId('still', 'photo/p2.jpg'), 'photo/p2.jpg', 'still', [], 'prep/p2.jpg'),
    asset(assetId('reference', 'ref/c1.jpg'), 'ref/c1.jpg', 'reference'),
    asset(assetId('reference', 'ref/c2.jpg'), 'ref/c2.jpg', 'reference'),
  ];
  return { version: 1, assets: Object.fromEntries(assets.map((a) => [a.id, a])) };
}

const clear: VoiceCheck = { childVoice: 'clear', adultDominant: false, startsCleanly: true, heard: '' };
const faint: VoiceCheck = { childVoice: 'faint', adultDominant: false, startsCleanly: true, heard: '' };
const check = (mainSubject: string, extra: Partial<FrameCheck> = {}): FrameCheck => ({
  mainSubject, childrenVisible: mainSubject.startsWith('c') ? [mainSubject] : [], faceVisible: true,
  expression: 'smile', quality: 'good', unsafe: false, screenCapture: false, ...extra,
} as FrameCheck);
const ctx = { requiredChildId: 'c1', ownChildIds: new Set(['c1', 'c2']), hasReferences: true };

Deno.test('planPrepare lists each asset once with its mode; drawings and posters of tiles are stills', () => {
  const items = planPrepare(film());
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assertEquals(byId[assetId('burst', 'video/v1.mp4')].mode, 'clip');
  assertEquals(byId[assetId('still', 'video/v1.mp4.poster.jpg')].mode, 'still'); // end-card tile of a video
  assertEquals(byId[assetId('still', 'photo/p1.jpg')].mode, 'still'); // a photo in a burst is a still
  assertEquals(byId[assetId('voice', 'video/v9.mp4')].mode, 'voice');
  assertEquals(byId[assetId('still', 'draw/t2.webp')].checkImage, false); // drawings aren't frame-checked
  assertEquals(byId[assetId('still', 'photo/t1.jpg')].checkImage, true);
  assertEquals(byId[assetId('reference', 'ref/c2.jpg')].mode, 'reference');
  assertEquals(items.length, new Set(items.map((i) => i.id)).size);
});

Deno.test('resolveSound: one check at a time, first passing window wins', () => {
  const f = film('video');
  const m = manifest();
  const a1 = assetId('voice', 'audio/a1.m4a');
  let r = resolveSound(f, m, {});
  assertEquals('need' in r && r.need.ref, voiceRef(a1, 0));
  r = resolveSound(f, m, { [voiceRef(a1, 0)]: faint });
  assertEquals('need' in r && r.need.ref, voiceRef(a1, 1));
  r = resolveSound(f, m, { [voiceRef(a1, 0)]: faint, [voiceRef(a1, 1)]: clear });
  assertEquals('done' in r && r.done?.windowIndex, 1);
  assertEquals('done' in r && r.done?.frame?.key, 'audio/a1.m4a');
});

Deno.test('resolveSound: an unchecked audio memory passes; a video fallback must be verified', () => {
  const a1 = assetId('voice', 'audio/a1.m4a');
  const v9 = assetId('voice', 'video/v9.mp4');
  const audio = resolveSound(film('audio'), manifest(), { [voiceRef(a1, 0)]: null });
  assertEquals('done' in audio && audio.done?.frame?.key, 'audio/a1.m4a');

  const video = film('video');
  let r = resolveSound(video, manifest(), { [voiceRef(a1, 0)]: null });
  assertEquals('need' in r && r.need.ref, voiceRef(v9, 0)); // null stops a1's windows; alternate next
  r = resolveSound(video, manifest(), { [voiceRef(a1, 0)]: null, [voiceRef(v9, 0)]: faint });
  assertEquals('done' in r && r.done?.frame, null);
  r = resolveSound(video, manifest(), { [voiceRef(a1, 0)]: null, [voiceRef(v9, 0)]: clear });
  assertEquals('done' in r && r.done?.frame?.key, 'video/v9.mp4');
});

Deno.test('resolveFrames: batches the first round, rescues from other windows, removes siblings, keeps empty windows', () => {
  const f = film();
  const m = manifest();
  const v1 = assetId('burst', 'video/v1.mp4');
  const v2 = assetId('burst', 'video/v2.mp4');
  const first = resolveFrames(f, m, {}, ctx);
  const refs = 'needs' in first ? first.needs.map((n) => n.ref).sort() : [];
  assertEquals(refs, [
    frameRef(assetId('still', 'photo/p1.jpg'), null),
    frameRef(assetId('still', 'photo/p2.jpg'), null),
    frameRef(assetId('still', 'photo/t1.jpg'), null),
    frameRef(assetId('still', 'video/v1.mp4.poster.jpg'), null),
    frameRef(v1, 0),
    frameRef(v2, 0),
  ].sort());

  const base = Object.fromEntries(refs.map((ref) => [ref, check('c1')]));
  // v1 (tagged with the sibling): window 0 is the sibling alone → try window 1.
  const round2 = resolveFrames(f, m, { ...base, [frameRef(v1, 0)]: check('c2'), [frameRef(v2, 0)]: check('none') }, ctx);
  assertEquals('needs' in round2 && round2.needs.map((n) => n.ref).sort(), [frameRef(v1, 1), frameRef(v2, 1)].sort());

  const done = resolveFrames(f, m, {
    ...base,
    [frameRef(v1, 0)]: check('c2'), [frameRef(v1, 1)]: check('c2'), [frameRef(v1, 2)]: check('c2'),
    [frameRef(v2, 0)]: check('none'), [frameRef(v2, 1)]: check('none'),
  }, ctx);
  assertEquals('done' in done && done.done, { windows: { [v2]: 0 }, removed: [v1] });

  const rescued = resolveFrames(f, m, { ...base, [frameRef(v1, 0)]: check('c2'), [frameRef(v1, 1)]: check('c1') }, ctx);
  assertEquals('done' in rescued && rescued.done.windows[v1], 1);
});

Deno.test('resolveFrames: no references → nothing checked; failed checks keep frames', () => {
  assertEquals(resolveFrames(film(), manifest(), {}, { ...ctx, hasReferences: false }), { done: { windows: {}, removed: [] } });
  const m = manifest();
  const all = resolveFrames(film(), m, {}, ctx);
  const nulls = Object.fromEntries(('needs' in all ? all.needs : []).map((n) => [n.ref, null]));
  const r = resolveFrames(film(), m, nulls, ctx);
  assertEquals('done' in r && r.done.removed, []);
});

Deno.test('resolveFrames: an unsafe still is removed', () => {
  const m = manifest();
  const all = resolveFrames(film(), m, {}, ctx);
  const verdicts = Object.fromEntries(('needs' in all ? all.needs : []).map((n) => [n.ref, check('c1')]));
  verdicts[frameRef(assetId('still', 'photo/p1.jpg'), null)] = check('c1', { unsafe: true });
  const r = resolveFrames(film(), m, verdicts, ctx);
  assertEquals('done' in r && r.done.removed, [assetId('still', 'photo/p1.jpg')]);
});

Deno.test('applyPrepared annotates files and windows, applies the sound choice and drops removed frames', () => {
  const script = film('video');
  const m = manifest();
  const v1 = assetId('burst', 'video/v1.mp4');
  const sound = resolveSound(script, m, {
    [voiceRef(assetId('voice', 'audio/a1.m4a'), 0)]: null,
    [voiceRef(assetId('voice', 'video/v9.mp4'), 0)]: clear,
  });
  const choice = 'done' in sound ? sound.done : null;
  const out = applyPrepared(script, m, choice, { windows: { [assetId('burst', 'video/v2.mp4')]: 1 }, removed: [v1] }, 'bright-pop');
  const burst = out.scenes[2] as Extract<FilmScript['scenes'][number], { type: 'burst' }>;
  const soundScene = out.scenes[1] as Extract<FilmScript['scenes'][number], { type: 'sound' }>;
  const endCard = out.scenes[3] as Extract<FilmScript['scenes'][number], { type: 'end_card' }>;
  assertEquals(out.bed, 'bright-pop');
  assertEquals(burst.frames.map((f) => f.key), ['video/v2.mp4', 'photo/p1.jpg']); // v1 removed
  assertEquals((burst.frames[0] as { file?: string }).file, 'prep/w6.mp4'); // v2 re-cut window
  assertEquals((burst.frames[1] as { file?: string }).file, 'prep/p1.jpg');
  assertEquals(soundScene.frame.key, 'video/v9.mp4');
  assertEquals((soundScene.frame as { file?: string }).file, 'prep/w20.mp4');
  // The end card shows v1's poster (a still), which wasn't removed.
  assertEquals(endCard.grid.map((f) => (f as { file?: string }).file), ['prep/v1poster.jpg', 'prep/p2.jpg']);
  // The input script is untouched.
  assertEquals((script.scenes[2] as { frames: FrameRef[] }).frames.length, 3);
});

Deno.test('applyPrepared drops a sound scene with no passing candidate and frames that could not be prepared', () => {
  const script = film('video');
  const m = manifest();
  // The burst photo failed to download: no prepared file.
  m.assets[assetId('still', 'photo/p1.jpg')] = { ...m.assets[assetId('still', 'photo/p1.jpg')], file: null };
  const out = applyPrepared(script, m, { frame: null, assetId: null, windowIndex: null, voice: null, verified: false, note: 'none' }, { windows: {}, removed: [] }, 'bright-pop');
  assertEquals(out.scenes.map((s) => s.type), ['title', 'burst', 'end_card']);
  const burst = out.scenes[1] as Extract<FilmScript['scenes'][number], { type: 'burst' }>;
  assertEquals(burst.frames.map((f) => f.key), ['video/v1.mp4', 'video/v2.mp4']);
  assertEquals(out.dropped.some((d) => d.scene === 'sound'), true);
});
