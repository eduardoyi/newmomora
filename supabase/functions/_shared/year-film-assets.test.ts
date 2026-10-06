import { assertEquals } from 'jsr:@std/assert@1';
import {
  applyPrepared,
  assetId,
  blockedSoundWindows,
  frameRef,
  frameTargets,
  planPrepare,
  type PrepareManifest,
  type PreparedAsset,
  pruneUnpreparedScenes,
  resolveFrames,
  resolveSound,
  soundFrameNeeds,
  uses,
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
    scope: { start: '2025-10-17', endExclusive: '2026-10-20' },
    subjects: [{ id: 'c1', name: 'Tomás', referenceKey: 'ref/c1.jpg' }],
    references: [{ id: 'c1', name: 'Tomás', referenceKey: 'ref/c1.jpg' }, { id: 'c2', name: 'Lucía', referenceKey: 'ref/c2.jpg' }],
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

Deno.test('resolveFrames: the holiday card film fails closed (no verdict, no check image, upset face, anything the strict prompt flags)', () => {
  const holiday = { ...film(), kind: 'family_holiday' } as FilmScript;
  const m = manifest();
  const v1 = assetId('burst', 'video/v1.mp4');
  const v2 = assetId('burst', 'video/v2.mp4');
  const p1 = assetId('still', 'photo/p1.jpg');
  const strictOk = (extra: Partial<FrameCheck> = {}) => check('c1', { underdressed: false, ...extra });
  // Answers every check the resolver asks for with `answer`, round by round.
  const settle = (script: FilmScript, manifestIn: PrepareManifest, answer: (ref: string) => FrameCheck | null) => {
    const verdicts: Record<string, FrameCheck | null> = {};
    for (let round = 0; round < 6; round += 1) {
      const r = resolveFrames(script, manifestIn, verdicts, ctx);
      if ('done' in r) return r.done;
      for (const n of r.needs) verdicts[n.ref] = answer(n.ref);
    }
    throw new Error('did not settle');
  };
  // Every check failed (null): the year film keeps them, the holiday film drops them all.
  const failed = settle(holiday, m, () => null);
  assertEquals([...failed.removed].sort(), [
    assetId('still', 'photo/p2.jpg'), assetId('still', 'photo/t1.jpg'), assetId('still', 'video/v1.mp4.poster.jpg'), p1, v1, v2,
  ].sort());
  assertEquals(settle(film(), m, () => null).removed, []);
  // An upset face goes (the year film keeps it).
  const upset = (ref: string) => strictOk(ref === frameRef(p1, null) ? { expression: 'upset' } : {});
  assertEquals(settle(holiday, m, upset).removed, [p1]);
  assertEquals(settle(film(), m, upset).removed, []);

  // The strict prompt's flag (bare torso, diaper, bath…) removes a frame — a still and a clip — that the normal rules keep.
  const underdressed = (ref: string) => strictOk(ref === frameRef(p1, null) || ref === frameRef(v2, 0) ? { underdressed: true } : {});
  const flagged = settle(holiday, m, underdressed);
  assertEquals(flagged.removed, [p1]);
  assertEquals(flagged.windows[v2], 1); // v2's first window was flagged; its next window is clean
  assertEquals(settle(holiday, m, (ref) => strictOk(ref.startsWith(v2) ? { underdressed: true } : {})).removed, [v2]); // every window flagged
  assertEquals(settle(film(), m, () => check('c1', { underdressed: true })).removed, []); // normal films ignore the field

  // A verdict from the NORMAL prompt (no `underdressed` answer) never passes a public film.
  assertEquals(settle(holiday, m, () => check('c1')).removed.length, 6);

  // A frame with no check image cannot be verified: the holiday film drops it.
  const noImage = manifest();
  noImage.assets[p1].checkImage = null;
  noImage.assets[v2].windows.forEach((w) => { w.checkImage = null; });
  assertEquals([...settle(holiday, noImage, () => strictOk()).removed].sort(), [p1, v2].sort());
  assertEquals(settle(film(), noImage, () => check('c1')).removed, []);

  // No references: nothing can be checked at all (the film wouldn't be built).
  assertEquals(resolveFrames(holiday, m, {}, { ...ctx, hasReferences: false }), { done: { windows: {}, removed: [] } });
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

// ── Public audience (the holiday card film) ──────────────────────────────

/** Synthetic holiday film: every scene type that shows frames, so the strict
 * check can be shown to reach all of them (the first holiday render's
 * mosaic leaked a bath photo through chapters that weren't checked). */
function holidayFilm(): FilmScript {
  const portrait = frame('draw/portrait1.webp', 'portrait', { memoryId: null, pairKey: 'pair/c1.jpg' });
  return {
    version: 1,
    kind: 'family_holiday',
    theme: 'holiday',
    language: 'es',
    title: 'Un año en familia',
    scope: { start: '2026-01-01', endExclusive: '2026-10-06' },
    subjects: [{ id: 'c1', name: 'Tomás', referenceKey: 'ref/c1.jpg' }],
    references: [{ id: 'c1', name: 'Tomás', referenceKey: 'ref/c1.jpg' }],
    scenes: [
      { type: 'title', title: '2026', subtitle: '', cards: [frame('photo/t1.jpg', 'photo')] },
      { type: 'chapter', childId: 'c1', name: 'Tomás', portrait, frames: [frame('photo/ch1.jpg', 'photo'), frame('draw/ch2.webp', 'illustration')], line: null },
      { type: 'sound', source: 'video', frame: frame('video/s1.mp4', 'video'), alternates: [frame('video/s2.mp4', 'video')], caption: null, needsVoiceCheck: true },
      { type: 'firsts', items: [{ milestoneId: 'first-steps', label: 'Dio sus primeros pasos', date: '2026-04-01', memoryId: 'm1', frame: frame('photo/f1.jpg', 'photo') }] },
      { type: 'close', line: '', source: 'family', celebrationDate: null, frames: [frame('photo/cl1.jpg', 'photo')] },
      { type: 'end_card', grid: [frame('photo/e1.jpg', 'photo')], greeting: 'Felices fiestas', from: 'de parte de la familia' },
    ],
  } as unknown as FilmScript;
}

function holidayManifest(): PrepareManifest {
  const still = (key: string) => asset(assetId('still', key), key, 'still', [], `prep/${key.replace(/\W/g, '_')}.jpg`);
  const assets: PreparedAsset[] = [
    still('photo/t1.jpg'), still('photo/ch1.jpg'), still('photo/f1.jpg'), still('photo/cl1.jpg'), still('photo/e1.jpg'),
    asset(assetId('still', 'draw/portrait1.webp'), 'draw/portrait1.webp', 'still', [], 'prep/portrait1.jpg'),
    asset(assetId('still', 'draw/ch2.webp'), 'draw/ch2.webp', 'still', [], 'prep/ch2.jpg'),
    { ...asset(assetId('pair', 'pair/c1.jpg'), 'pair/c1.jpg', 'pair', [], 'prep/pair1.jpg'), checkImage: 'prep/pair1.check.jpg' },
    asset(assetId('voice', 'video/s1.mp4'), 'video/s1.mp4', 'voice', [win(0), win(10)]),
    asset(assetId('voice', 'video/s2.mp4'), 'video/s2.mp4', 'voice', [win(20)]),
    asset(assetId('reference', 'ref/c1.jpg'), 'ref/c1.jpg', 'reference'),
  ];
  return { version: 1, assets: Object.fromEntries(assets.map((a) => [a.id, a])) };
}

const strictOk = (extra: Partial<FrameCheck> = {}) => check('c1', { underdressed: false, ...extra });
const answerAll = (script: FilmScript, m: PrepareManifest, answer: (ref: string) => FrameCheck | null) => {
  const verdicts: Record<string, FrameCheck | null> = {};
  for (let round = 0; round < 6; round += 1) {
    const r = resolveFrames(script, m, verdicts, ctx);
    if ('done' in r) return { done: r.done, verdicts };
    for (const n of r.needs) verdicts[n.ref] = answer(n.ref);
  }
  throw new Error('did not settle');
};

Deno.test('uses: a public film checks every frame (chapters, firsts, close), a normal film only the dense parts', () => {
  const f = holidayFilm();
  const checked = (script: FilmScript, publicAudience: boolean) =>
    script.scenes.flatMap((scene) => uses(scene, publicAudience).filter((u) => u.checked).map((u) => u.frame.key)).sort();
  assertEquals(checked(f, false), ['photo/e1.jpg', 'photo/t1.jpg']);
  assertEquals(checked(f, true), [
    'draw/ch2.webp', 'draw/portrait1.webp', 'photo/cl1.jpg', 'photo/ch1.jpg', 'photo/e1.jpg', 'photo/f1.jpg', 'photo/t1.jpg',
  ].sort());
  // Drawings (illustrations, portraits) are never sent to the vision check.
  const targets = frameTargets(f, holidayManifest()).map((t) => t.assetId);
  assertEquals(targets.some((id) => id.includes('draw/')), false);
  assertEquals(targets.includes(assetId('still', 'photo/ch1.jpg')), true);
  assertEquals(targets.includes(assetId('still', 'photo/f1.jpg')), true);
  assertEquals(targets.includes(assetId('still', 'photo/cl1.jpg')), true);
  // The real photo behind a portrait's reveal is checked too.
  assertEquals(targets.includes(assetId('pair', 'pair/c1.jpg')), true);
});

Deno.test('planPrepare: a public film asks for check images of every photo, pair photo and video sound window', () => {
  const byId = Object.fromEntries(planPrepare(holidayFilm()).map((i) => [i.id, i]));
  assertEquals(byId[assetId('still', 'photo/ch1.jpg')].checkImage, true);
  assertEquals(byId[assetId('still', 'photo/cl1.jpg')].checkImage, true);
  assertEquals(byId[assetId('still', 'draw/ch2.webp')].checkImage, false);
  assertEquals(byId[assetId('still', 'draw/portrait1.webp')].checkImage, false);
  assertEquals(byId[assetId('pair', 'pair/c1.jpg')].checkImage, true);
  assertEquals(byId[assetId('voice', 'video/s1.mp4')].checkImage, true);
  assertEquals(byId[assetId('voice', 'video/s2.mp4')].checkImage, true);
  // A normal film: none of that.
  const normal = Object.fromEntries(planPrepare(film()).map((i) => [i.id, i]));
  assertEquals(normal[assetId('voice', 'video/v9.mp4')].checkImage, false);
});

Deno.test('resolveFrames: the strict check removes a flagged photo wherever the holiday film uses it', () => {
  const f = holidayFilm();
  const m = holidayManifest();
  const ch1 = assetId('still', 'photo/ch1.jpg');
  const f1 = assetId('still', 'photo/f1.jpg');
  const cl1 = assetId('still', 'photo/cl1.jpg');
  const pair = assetId('pair', 'pair/c1.jpg');
  const { done } = answerAll(f, m, (ref) => strictOk(ref === ch1 || ref === f1 || ref === cl1 || ref === pair ? { underdressed: true } : {}));
  assertEquals([...done.removed].sort(), [ch1, cl1, f1, pair].sort());

  const out = applyPrepared(f, m, null, done, 'winter-bells');
  const type = <T extends FilmScript['scenes'][number]['type']>(t: T) => out.scenes.find((s) => s.type === t) as Extract<FilmScript['scenes'][number], { type: T }> | undefined;
  // Chapter: the flagged photo is gone, the drawing stays; the portrait loses its real-photo pair.
  assertEquals(type('chapter')!.frames.map((x) => x.key), ['draw/ch2.webp']);
  assertEquals((type('chapter')!.portrait as { pairFile?: string | null }).pairFile, null);
  // Firsts keeps the milestone, without its card; the close (nothing left) is dropped, the sound scene too (no candidate chosen).
  assertEquals(type('firsts')!.items[0].frame, undefined);
  assertEquals(type('close'), undefined);
  assertEquals(type('sound'), undefined);
  assertEquals(out.dropped.some((d) => d.scene === 'close'), true);

  // The same removals leave a NORMAL film's other uses alone (live films unchanged).
  const normal = film();
  const normalRemoved = assetId('still', 'photo/p1.jpg');
  const kept = applyPrepared(normal, manifest(), null, { windows: {}, removed: [normalRemoved] }, 'bright-pop');
  assertEquals((kept.scenes.find((s) => s.type === 'burst') as { frames: FrameRef[] }).frames.map((x) => x.key), ['video/v1.mp4', 'video/v2.mp4']);
});

Deno.test('sound frames (public film): a video sound window must pass the strict check, else the next window or candidate carries the scene', () => {
  const f = holidayFilm();
  const m = holidayManifest();
  const s1 = assetId('voice', 'video/s1.mp4');
  const s2 = assetId('voice', 'video/s2.mp4');
  // Nothing checked yet: every window needs its check; all are blocked until verdicts arrive (fail closed).
  assertEquals(soundFrameNeeds(f, m, {}).map((n) => n.ref).sort(), [frameRef(s1, 0), frameRef(s1, 1), frameRef(s2, 0)].sort());
  assertEquals([...blockedSoundWindows(f, m, {})].sort(), [voiceRef(s1, 0), voiceRef(s1, 1), voiceRef(s2, 0)].sort());
  // s1's windows are both underdressed; s2's is fine.
  const verdicts = { [frameRef(s1, 0)]: strictOk({ underdressed: true }), [frameRef(s1, 1)]: strictOk({ underdressed: true }), [frameRef(s2, 0)]: strictOk() };
  assertEquals(soundFrameNeeds(f, m, verdicts), []);
  const blocked = blockedSoundWindows(f, m, verdicts);
  assertEquals([...blocked].sort(), [voiceRef(s1, 0), voiceRef(s1, 1)].sort());
  // A normal verdict (no `underdressed`) is not enough; no verdict at all is a failure too.
  assertEquals(blockedSoundWindows(f, m, { ...verdicts, [frameRef(s2, 0)]: check('c1') }).has(voiceRef(s2, 0)), true);
  assertEquals(blockedSoundWindows(f, m, { ...verdicts, [frameRef(s2, 0)]: null }).has(voiceRef(s2, 0)), true);
  // The blocked windows are skipped without a voice check; the alternate wins.
  const r = resolveSound(f, m, { [voiceRef(s2, 0)]: clear }, blocked);
  assertEquals('done' in r && r.done?.frame?.key, 'video/s2.mp4');
  // Everything blocked: the scene drops.
  const none = resolveSound(f, m, {}, new Set([...blocked, voiceRef(s2, 0)]));
  assertEquals('done' in none && none.done?.frame, null);
  // Non-public films never ask (their sound is checked as before).
  assertEquals(soundFrameNeeds(film('video'), manifest(), {}), []);
  assertEquals(blockedSoundWindows(film('video'), manifest(), {}).size, 0);
});

Deno.test('pruneUnpreparedScenes drops frames without a file and the scenes that need them', () => {
  const script = film('video') as FilmScript;
  const s = JSON.parse(JSON.stringify(script)) as FilmScript;
  (s.scenes[0] as { cards: { file?: string }[] }).cards.forEach((c) => (c.file = 'a.jpg'));
  (s.scenes[1] as { frame: { file?: string | null } }).frame.file = null; // sound: no candidate
  const out = pruneUnpreparedScenes(s);
  assertEquals(out.scenes.map((x) => x.type), ['title', 'end_card']); // an end card with an empty wall still greets
  assertEquals(out.dropped.map((d) => d.scene).sort(), ['burst', 'sound']);
});

Deno.test('applyPrepared: a fallback sound candidate carries ITS OWN caption and date, never the primary\'s', () => {
  const withCaptions = (): FilmScript => {
    const script = film('video');
    const sound = script.scenes[1] as Extract<FilmScript['scenes'][number], { type: 'sound' }>;
    Object.assign(sound, { caption: 'Tomás leyéndole un libro a Lucía', alternateCaptions: ['Tomás cantando en el carro'] });
    sound.alternates[0].date = '2026-08-22';
    return script;
  };
  const a1 = assetId('voice', 'audio/a1.m4a');
  const v9 = assetId('voice', 'video/v9.mp4');
  const m = manifest();
  const pick = (script: FilmScript, verdicts: Parameters<typeof resolveSound>[2]) => {
    const r = resolveSound(script, m, verdicts);
    return applyPrepared(script, m, 'done' in r ? r.done : null, { windows: {}, removed: [] }, 'bright-pop').scenes[1] as Extract<FilmScript['scenes'][number], { type: 'sound' }>;
  };
  // The primary fails the voice check (both windows faint) → the alternate plays, with its caption and date.
  const fallback = pick(withCaptions(), { [voiceRef(a1, 0)]: faint, [voiceRef(a1, 1)]: faint, [voiceRef(v9, 0)]: clear });
  assertEquals(fallback.frame.key, 'video/v9.mp4');
  assertEquals(fallback.caption, 'Tomás cantando en el carro');
  assertEquals(fallback.frame.date, '2026-08-22');
  // The primary passing keeps its own caption.
  const primary = pick(withCaptions(), { [voiceRef(a1, 0)]: clear });
  assertEquals(primary.frame.key, 'audio/a1.m4a');
  assertEquals(primary.caption, 'Tomás leyéndole un libro a Lucía');
  // A script stored before `alternateCaptions` existed: no caption beats the primary's wrong one.
  const old = withCaptions();
  delete (old.scenes[1] as { alternateCaptions?: unknown }).alternateCaptions;
  assertEquals(pick(old, { [voiceRef(a1, 0)]: faint, [voiceRef(a1, 1)]: faint, [voiceRef(v9, 0)]: clear }).caption, null);
});
