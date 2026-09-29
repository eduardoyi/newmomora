import { describe, expect, it } from 'vitest';
import { AttemptStopped, type BridgeClient } from '../src/bridge';
import type { FlyClient } from '../src/fly';
import type { ChatFn } from '../src/openai';
import { pollMachine, publish, runFrameChecks, runVoiceChecks, type StageDeps, startThumbs } from '../src/stages';
import type { Storage } from '../src/storage';
import { assetId, type PrepareManifest } from '../../../supabase/functions/_shared/year-film-assets.ts';

const FILM = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const PREFIX = `owner/year-films/${FILM}/${ATTEMPT}/`;

function memoryStorage(initial: Record<string, unknown> = {}) {
  const objects = new Map<string, unknown>(Object.entries(initial));
  const storage: Storage & { objects: Map<string, unknown> } = {
    objects,
    async putJson(key, value) { objects.set(key, JSON.parse(JSON.stringify(value))); },
    async getJson(key) { return (objects.get(key) as never) ?? null; },
    async getBase64(key) { return objects.has(key) ? 'QUJD' : null; },
    async deleteKeys(keys) { for (const k of keys) objects.delete(k); },
    async deletePrefix(prefix) {
      let n = 0;
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) { objects.delete(k); n += 1; }
      return n;
    },
  };
  return storage;
}

function fakeBridge(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { op: string; body: Record<string, unknown> }[] = [];
  const bridge: BridgeClient = {
    async call<T>(op: string, body: Record<string, unknown> = {}) {
      calls.push({ op, body });
      const handler = handlers[op];
      if (!handler) return {} as T;
      return handler(body) as T;
    },
  };
  return { bridge, calls };
}

const noFly: FlyClient = { create: async () => ({ id: 'm1', state: 'created' }), get: async () => ({ id: 'm1', state: 'started' }), destroy: async () => {} };

function deps(overrides: Partial<StageDeps>): StageDeps {
  return {
    filmId: FILM,
    attemptId: ATTEMPT,
    bridge: fakeBridge({}).bridge,
    storage: memoryStorage(),
    chat: async () => ({ content: null, usage: null, ok: false }),
    fly: noFly,
    mintCredentials: async () => null,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    film: {
      id: FILM, kind: 'family_month', familyId: 'fam', ownerId: 'owner', familyMemberId: null, ageYear: null,
      scopeStart: '2026-09-01', scopeEndExclusive: '2026-10-01', language: null, musicBedId: null, quoteCandidates: null,
      edits: {}, editsVersion: 0, poolCutoffAt: null, contentEpoch: 0, aiChecks: {}, ...overrides,
    },
    rows: { family: { id: 'fam', name: 'F', gallery_caption_language: 'en' }, members: [], memories: [], media: [], tags: [], milestones: [], portraits: [], reports: [] },
  };
}

describe('startThumbs', () => {
  it('ends the cycle as skipped before any paid call when there is nothing to film', async () => {
    const { bridge, calls } = fakeBridge({ load_film_context: () => context() });
    const result = await startThumbs(deps({ bridge }));
    expect(result).toEqual({ skipped: true, reason: 'NO_OWN_CHILDREN' });
    expect(calls.map((c) => c.op)).toEqual(['load_film_context', 'end_cycle']);
    expect(calls[1].body).toEqual({ outcome: 'skipped', code: 'NO_OWN_CHILDREN' });
  });
});

describe('pollMachine', () => {
  it('stops when the attempt is superseded', async () => {
    const { bridge } = fakeBridge({ heartbeat: () => ({ state: 'epoch_changed' }) });
    await expect(pollMachine(deps({ bridge }), `${PREFIX}status.json`, 'm1', null)).rejects.toBeInstanceOf(AttemptStopped);
  });

  it('reads the status, and treats a machine that vanished without one as a crash', async () => {
    const { bridge } = fakeBridge({ heartbeat: () => ({ state: 'ok' }) });
    const storage = memoryStorage({ [`${PREFIX}status.json`]: { state: 'done' } });
    expect(await pollMachine(deps({ bridge, storage }), `${PREFIX}status.json`, 'm1', null)).toBe('done');
    const gone: FlyClient = { ...noFly, get: async () => null };
    expect(await pollMachine(deps({ bridge, fly: gone }), `${PREFIX}status.json`, 'm1', null)).toBe('crashed');
    expect(await pollMachine(deps({ bridge }), `${PREFIX}status.json`, 'm1', null)).toBe('running');
  });
});

// A minimal script + prepared manifest: one audio sound candidate with two
// windows, one burst clip, and a reference portrait.
const frame = (key: string, kind: string) => ({ memoryId: `m-${key}`, date: '2026-09-02', kind, key, previewKey: null, durationMs: 9000, aspectRatio: 1, emotion: 'joy', why: '' });
const script = {
  version: 1, kind: 'family_month', language: 'en', title: 'September', scope: { start: '2026-09-01', endExclusive: '2026-10-01' },
  span: { from: '2026-09-01', to: '2026-09-30' },
  subjects: [{ id: 'kid', name: 'Enzo', referenceKey: 'ref.jpg' }],
  references: [{ id: 'kid', name: 'Enzo', referenceKey: 'ref.jpg' }],
  scenes: [
    { type: 'sound', source: 'audio', frame: frame('a.m4a', 'audio'), caption: null, needsVoiceCheck: false, alternates: [] },
    { type: 'burst', role: 'month', titles: [], frames: [frame('v.mp4', 'video')], secondsPerFrame: 0.5 },
  ],
};
const w = (i: number) => ({ start: i, end: i + 2.5, file: `prep/w${i}.mp4`, checkImage: `prep/w${i}.jpg`, wav: `prep/w${i}.wav` });
const prep: PrepareManifest = {
  version: 1,
  assets: {
    [assetId('voice', 'a.m4a')]: { id: assetId('voice', 'a.m4a'), key: 'a.m4a', mode: 'voice', file: null, checkImage: null, source: { width: null, height: null, duration: 9, hasVideo: false }, windows: [w(0), w(3)], warnings: [] },
    [assetId('burst', 'v.mp4')]: { id: assetId('burst', 'v.mp4'), key: 'v.mp4', mode: 'clip', file: null, checkImage: null, source: { width: 1, height: 1, duration: 9, hasVideo: true }, windows: [w(1)], warnings: [] },
    [assetId('reference', 'ref.jpg')]: { id: assetId('reference', 'ref.jpg'), key: 'ref.jpg', mode: 'reference', file: null, checkImage: 'prep/ref.jpg', source: { width: 1, height: 1, duration: null, hasVideo: false }, windows: [], warnings: [] },
  },
};
const prepared = () => memoryStorage({
  [`${PREFIX}script.json`]: { bed: 'bright-pop', editsVersion: 0, script },
  [`${PREFIX}prep/prep.json`]: prep,
  [`${PREFIX}prep/w0.wav`]: 1, [`${PREFIX}prep/w3.wav`]: 1, [`${PREFIX}prep/w1.jpg`]: 1, [`${PREFIX}prep/ref.jpg`]: 1,
});

describe('voice checks', () => {
  it('persists each verdict and never repays on replay', async () => {
    let saved: Record<string, unknown> = {};
    const { bridge, calls } = fakeBridge({
      load_film_context: () => context({ aiChecks: saved }),
      save_checks: (body) => { saved = { ...saved, ...(body.checks as object) }; return { state: 'ok' }; },
    });
    let chats = 0;
    const faint = JSON.stringify({ child_voice: 'faint', adult_dominant: false, starts_cleanly: true, heard: '' });
    const clear = JSON.stringify({ child_voice: 'clear', adult_dominant: false, starts_cleanly: true, heard: '' });
    const chat: ChatFn = async () => ({ content: chats++ === 0 ? faint : clear, usage: { prompt_tokens: 1 }, ok: true });
    const storage = prepared();
    expect(await runVoiceChecks(deps({ bridge, chat, storage }), PREFIX)).toEqual({ done: true });
    expect(chats).toBe(2); // window 0 faint → window 1 clear
    expect(calls.filter((c) => c.op === 'record_usage').length).toBe(2);
    // Replay (e.g. the step retried): everything is cached.
    expect(await runVoiceChecks(deps({ bridge, chat, storage }), PREFIX)).toEqual({ done: true });
    expect(chats).toBe(2);
  });
});

describe('frame checks', () => {
  it('batches the needs and saves them before resolving', async () => {
    let saved: Record<string, unknown> = {};
    const { bridge } = fakeBridge({
      load_film_context: () => context({ aiChecks: saved }),
      save_checks: (body) => { saved = { ...saved, ...(body.checks as object) }; return { state: 'ok' }; },
    });
    let chats = 0;
    const chat: ChatFn = async () => {
      chats += 1;
      return { content: JSON.stringify({ frames: [{ index: 0, main_subject: 'Enzo', children_visible: ['Enzo'], face_visible: true, expression: 'smile', quality: 'good', unsafe: false, screen_capture: false }] }), usage: null, ok: true };
    };
    expect(await runFrameChecks(deps({ bridge, chat, storage: prepared() }), PREFIX)).toEqual({ done: true });
    expect(chats).toBe(1);
    expect(Object.keys(saved).length).toBe(1);
  });
});

describe('publish', () => {
  const ready = () => memoryStorage({
    [`${PREFIX}status.json`]: { state: 'done', durationMs: 61000 },
    [`${PREFIX}script.json`]: { bed: 'bright-pop', editsVersion: 2, script },
    [`${PREFIX}film.mp4`]: 1, [`${PREFIX}prep/x.mp4`]: 1, 'owner/year-films/old/a0/film.mp4': 1,
  });

  it('deletes the previous attempt and prep after a successful CAS', async () => {
    const storage = ready();
    const { bridge, calls } = fakeBridge({ publish: () => ({ ok: true, delete_keys: ['owner/year-films/old/a0/film.mp4'] }) });
    expect(await publish(deps({ bridge, storage }), PREFIX)).toEqual({ ok: true });
    expect(calls[0].body.editsVersion).toBe(2);
    expect(storage.objects.has('owner/year-films/old/a0/film.mp4')).toBe(false);
    expect(storage.objects.has(`${PREFIX}prep/x.mp4`)).toBe(false);
    expect(storage.objects.has(`${PREFIX}film.mp4`)).toBe(true);
  });

  it('deletes its own output when the CAS is lost', async () => {
    const storage = ready();
    const { bridge } = fakeBridge({ publish: () => ({ ok: false, reason: 'content_changed', delete_keys: [] }) });
    expect(await publish(deps({ bridge, storage }), PREFIX)).toEqual({ ok: false, reason: 'content_changed' });
    expect([...storage.objects.keys()].some((k) => k.startsWith(PREFIX))).toBe(false);
  });
});
