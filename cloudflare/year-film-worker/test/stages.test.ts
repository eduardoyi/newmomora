import { describe, expect, it } from 'vitest';
import { AttemptStopped, type BridgeClient } from '../src/bridge';
import type { FlyClient } from '../src/fly';
import type { ChatFn } from '../src/openai';
import { buildAndSave, pollFailureCode, pollMachine, publish, runFrameChecks, runVoiceChecks, type StageDeps, startThumbs } from '../src/stages';
import { familyRows, LUCIA, ANA, MARCO, TOMAS } from './card-fixtures';
import type { Storage } from '../src/storage';
import { assetId, type PrepareManifest } from '../../../supabase/functions/_shared/year-film-assets.ts';
import { checkCacheKey } from '../../../supabase/functions/_shared/year-film-checks.ts';

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

  it('surfaces the job\'s IMAGE_INCOMPLETE startup-guard code as its own state, other failures as failed', async () => {
    const { bridge } = fakeBridge({ heartbeat: () => ({ state: 'ok' }) });
    const key = `${PREFIX}status.json`;
    const incomplete = memoryStorage({ [key]: { state: 'failed', code: 'IMAGE_INCOMPLETE' } });
    expect(await pollMachine(deps({ bridge, storage: incomplete }), key, 'm1', null)).toBe('image_incomplete');
    const step = memoryStorage({ [key]: { state: 'failed', code: 'STEP_CHECK' } });
    expect(await pollMachine(deps({ bridge, storage: step }), key, 'm1', null)).toBe('failed');
    const bare = memoryStorage({ [key]: { state: 'failed' } });
    expect(await pollMachine(deps({ bridge, storage: bare }), key, 'm1', null)).toBe('failed');
  });

  it('maps terminal poll states to closed failure codes', () => {
    expect(pollFailureCode('image_incomplete')).toBe('IMAGE_INCOMPLETE');
    expect(pollFailureCode('failed')).toBe('MACHINE_FAILED');
    expect(pollFailureCode('crashed')).toBe('MACHINE_FAILED');
    expect(pollFailureCode('running')).toBeNull();
    expect(pollFailureCode('done')).toBeNull();
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

// The holiday card film is public: the strict prompt, its own cache keys, and
// a sound clip's frame checked before its voice (owner, 2026-10-05).
describe('public film (holiday card)', () => {
  const holidayScript = {
    ...script,
    kind: 'family_holiday',
    scenes: [
      { type: 'sound', source: 'video', frame: frame('s1.mp4', 'video'), caption: null, needsVoiceCheck: true, alternates: [frame('s2.mp4', 'video')] },
      { type: 'burst', role: 'finale', titles: [], frames: [frame('v.mp4', 'video')], secondsPerFrame: 0.5 },
    ],
  };
  const voiceAsset = (key: string, windows: ReturnType<typeof w>[]) => ({
    id: assetId('voice', key), key, mode: 'voice' as const, file: null, checkImage: null, source: { width: 1, height: 1, duration: 9, hasVideo: true }, windows, warnings: [],
  });
  const holidayPrep: PrepareManifest = {
    version: 1,
    assets: {
      ...prep.assets,
      [assetId('voice', 's1.mp4')]: voiceAsset('s1.mp4', [w(10)]),
      [assetId('voice', 's2.mp4')]: voiceAsset('s2.mp4', [w(20)]),
    },
  };
  const holidayStorage = () => memoryStorage({
    [`${PREFIX}script.json`]: { bed: 'winter-bells', editsVersion: 0, script: holidayScript },
    [`${PREFIX}prep/prep.json`]: holidayPrep,
    [`${PREFIX}prep/w1.jpg`]: 1, [`${PREFIX}prep/ref.jpg`]: 1, [`${PREFIX}prep/w10.jpg`]: 1, [`${PREFIX}prep/w20.jpg`]: 1,
    [`${PREFIX}prep/w10.wav`]: 1, [`${PREFIX}prep/w20.wav`]: 1,
  });
  const strictAnswer = (underdressed: boolean) => JSON.stringify({ frames: [{ index: 0, main_subject: 'Enzo', children_visible: ['Enzo'], face_visible: true, expression: 'smiling', quality: 'good', unsafe: false, underdressed, screen_capture: false }] });
  const clearVoice = JSON.stringify({ child_voice: 'clear', adult_dominant: false, starts_cleanly: true, heard: '' });

  it('asks the strict prompt and caches under the public key, never reusing a normal verdict', async () => {
    let saved: Record<string, unknown> = {};
    const { bridge } = fakeBridge({
      load_film_context: () => context({ kind: 'family_holiday', aiChecks: saved }),
      save_checks: (body) => { saved = { ...saved, ...(body.checks as object) }; return { state: 'ok' }; },
    });
    // A NORMAL verdict for the same clip window already sits in the cache.
    const normalKey = await checkCacheKey({ kind: 'frame', model: 'gpt-6-luna', assetKey: 'v.mp4', window: { start: 1, end: 3.5 }, referenceKeys: ['ref.jpg'] });
    const verdict = { kind: 'frame', value: { mainSubject: 'kid', childrenVisible: ['kid'], faceVisible: true, expression: 'smiling', quality: 'good', unsafe: false, underdressed: false, screenCapture: false } };
    // …and a verdict from the retired v1 public prompt (no beach exception) too.
    const v1Key = await checkCacheKey({ kind: 'frame', model: 'gpt-6-luna', assetKey: 'v.mp4', window: { start: 1, end: 3.5 }, referenceKeys: ['ref.jpg'], variant: 'public' as never });
    saved = { [normalKey]: verdict, [v1Key]: verdict };
    const prompts: string[] = [];
    const chat: ChatFn = async (body) => {
      prompts.push(JSON.stringify(body));
      return { content: strictAnswer(false), usage: null, ok: true };
    };
    const burstOnly = memoryStorage({
      [`${PREFIX}script.json`]: { bed: 'winter-bells', editsVersion: 0, script: { ...holidayScript, scenes: [holidayScript.scenes[1]] } },
      [`${PREFIX}prep/prep.json`]: holidayPrep,
      [`${PREFIX}prep/w1.jpg`]: 1, [`${PREFIX}prep/ref.jpg`]: 1,
    });
    expect(await runFrameChecks(deps({ bridge, chat, storage: burstOnly }), PREFIX)).toEqual({ done: true });
    expect(prompts.length).toBe(1); // neither the cached normal verdict nor the v1 public one stood in
    expect(prompts[0]).toContain('underdressed');
    const publicKey = await checkCacheKey({ kind: 'frame', model: 'gpt-6-luna', assetKey: 'v.mp4', window: { start: 1, end: 3.5 }, referenceKeys: ['ref.jpg'], variant: 'public-v2' });
    expect(Object.keys(saved)).toContain(publicKey);
    expect(publicKey).not.toBe(normalKey);
  });

  it('checks a video sound clip\'s frame before its voice; a flagged window falls through to the alternate', async () => {
    let saved: Record<string, unknown> = {};
    const { bridge } = fakeBridge({
      load_film_context: () => context({ kind: 'family_holiday', aiChecks: saved }),
      save_checks: (body) => { saved = { ...saved, ...(body.checks as object) }; return { state: 'ok' }; },
    });
    const calls: string[] = [];
    // The window check images are w10 (s1) then w20 (s2): frames are asked in need order, one batch.
    const chat: ChatFn = async (body) => {
      const text = JSON.stringify(body);
      if (text.includes('input_audio')) {
        calls.push('voice');
        return { content: clearVoice, usage: null, ok: true };
      }
      const candidates = (text.match(/CANDIDATE index/g) ?? []).length;
      calls.push(`frames:${candidates}`);
      // s1's window is underdressed, s2's is fine.
      return { content: JSON.stringify({ frames: [0, 1].slice(0, candidates).map((index) => ({ index, main_subject: 'Enzo', children_visible: ['Enzo'], face_visible: true, expression: 'smiling', quality: 'good', unsafe: false, underdressed: index === 0, screen_capture: false })) }), usage: null, ok: true };
    };
    expect(await runVoiceChecks(deps({ bridge, chat, storage: holidayStorage() }), PREFIX)).toEqual({ done: true });
    expect(calls).toEqual(['frames:2', 'voice']); // one batched frame check, then a single voice check (s2 only)
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

// The holiday card film's claim checks and quote pick run on GPT-6.1 Sol; live films keep GPT-6 Sol.
describe('holiday models', () => {
  it('names gpt-6.1-sol for the holiday film only', async () => {
    const { HOLIDAY_CLAIM_CHECK_MODEL, CLAIM_CHECK_MODEL } = await import('../../../supabase/functions/_shared/year-film-vision.ts');
    const { HOLIDAY_QUOTE_MODEL, QUOTE_MODEL } = await import('../../../supabase/functions/_shared/year-film-quotes.ts');
    expect([HOLIDAY_CLAIM_CHECK_MODEL, HOLIDAY_QUOTE_MODEL]).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
    expect([CLAIM_CHECK_MODEL, QUOTE_MODEL]).toEqual(['gpt-6-sol', 'gpt-6-sol']);
  });
});

// ── Card films (docs/plans/holiday-cards-p1.md Step 4b): greeting, close media, floor waiver ──

const OWNER_ID = 'owner';
function holidayContext(film: Record<string, unknown> = {}, rows = familyRows()) {
  return {
    film: {
      id: FILM, kind: 'family_holiday', familyId: 'fam', ownerId: OWNER_ID, familyMemberId: null, ageYear: null,
      scopeStart: '2026-01-01', scopeEndExclusive: '2026-10-07', language: 'es', musicBedId: null, quoteCandidates: null,
      edits: {}, editsVersion: 0, poolCutoffAt: null, contentEpoch: 0, aiChecks: {}, readyAt: null, ...film,
    },
    rows,
  };
}

/** The script a holiday film's build step saved. */
async function builtHolidayScript(ctx: ReturnType<typeof holidayContext>) {
  let script: { scenes: Record<string, unknown>[] } | null = null;
  const { bridge } = fakeBridge({
    load_film_context: () => ctx,
    save_curation: (body) => { script = (body.payload as { film_script: typeof script }).film_script; return { state: 'ok' }; },
  });
  expect(await buildAndSave(deps({ bridge }))).toEqual({ saved: true });
  return script!;
}

describe('card film (family_holiday) plumbing', () => {
  it('the film row\'s greeting reaches the end card; without one the default stays', async () => {
    const christmas = await builtHolidayScript(holidayContext({ edits: { greeting: 'christmas' } }));
    expect(christmas.scenes.find((s) => s.type === 'end_card')?.greeting).toBe('Feliz Navidad');
    const newYear = await builtHolidayScript(holidayContext({ edits: { greeting: 'new-year' } }));
    expect(newYear.scenes.find((s) => s.type === 'end_card')?.greeting).toBe('Feliz Año Nuevo');
    const none = await builtHolidayScript(holidayContext({ edits: {} }));
    expect(none.scenes.find((s) => s.type === 'end_card')?.greeting).toBe('Felices fiestas');
  });

  it('the card front\'s top picks (preferredCloseMedia) win the close', async () => {
    // Two photos of the whole core family together; the older one is the front's top pick.
    const rows = familyRows();
    const family = [TOMAS, LUCIA, ANA, MARCO];
    for (const [id, date] of [['m-fam-newer', '2026-09-25'], ['m-fam-older', '2026-09-05']] as const) {
      rows.memories.push({ id, content: 'Foto de toda la familia junta', memory_date: date, memory_type: 'media', emotion: 'joy', topics: [], illustration_status: 'none', illustration_key: null, media_key: null, media_content_type: null, onboarding_media_pending: false, created_at: `${date}T10:00:00Z` });
      rows.media.push({ id: `a-${id}`, memory_id: id, object_key: `orig/a-${id}`, preview_object_key: null, content_type: 'image/jpeg', duration_ms: null, aspect_ratio: 1.33, position: 0 });
      for (const t of family) rows.tags.push({ memory_id: id, family_member_id: t });
    }
    const closeOf = (script: { scenes: Record<string, unknown>[] }) =>
      (script.scenes.find((s) => s.type === 'close')?.frames as { memoryId: string }[]).map((f) => f.memoryId);
    expect(closeOf(await builtHolidayScript(holidayContext({}, rows)))[0]).toBe('m-fam-newer');
    expect(closeOf(await builtHolidayScript(holidayContext({ edits: { preferredCloseMedia: ['a-m-fam-older'] } }, rows)))[0]).toBe('m-fam-older');
  });

  it('floor waiver: a card film that has published keeps rendering below the floors; one that has not ends skipped', async () => {
    const small = familyRows({ monthly: 3 }); // 5 moments, far below the 20-moment floor
    const first = fakeBridge({ load_film_context: () => holidayContext({ readyAt: null }, small) });
    expect(await startThumbs(deps({ bridge: first.bridge }))).toEqual({ skipped: true, reason: 'BELOW_FLOORS' });
    expect(first.calls.find((c) => c.op === 'end_cycle')?.body).toEqual({ outcome: 'skipped', code: 'BELOW_FLOORS' });

    const published = fakeBridge({ load_film_context: () => holidayContext({ readyAt: '2026-10-06T12:00:00Z' }, small) });
    const result = await startThumbs(deps({ bridge: published.bridge }));
    expect(result.skipped).toBe(false);
    expect(published.calls.map((c) => c.op)).not.toContain('end_cycle');
  });

  it('floor waiver: an empty pool is still a hard skip', async () => {
    const empty = familyRows();
    empty.memories = [];
    empty.media = [];
    empty.tags = [];
    const { bridge, calls } = fakeBridge({ load_film_context: () => holidayContext({ readyAt: '2026-10-06T12:00:00Z' }, empty) });
    expect(await startThumbs(deps({ bridge }))).toEqual({ skipped: true, reason: 'EMPTY_POOL' });
    expect(calls.find((c) => c.op === 'end_cycle')?.body).toEqual({ outcome: 'skipped', code: 'EMPTY_POOL' });
  });

  it('birthday / month / year films behave as before: readyAt and edits never waive their floors', async () => {
    const small = familyRows({ monthly: 3 });
    for (const kind of ['family_month', 'family_year'] as const) {
      const scope = kind === 'family_month' ? { scopeStart: '2026-09-01', scopeEndExclusive: '2026-10-01' } : { scopeStart: '2026-01-01', scopeEndExclusive: '2027-01-01' };
      const { bridge, calls } = fakeBridge({
        load_film_context: () => holidayContext({ kind, ...scope, readyAt: '2026-10-06T12:00:00Z', edits: { greeting: 'christmas', preferredCloseMedia: ['a-m-swim'] } }, small),
      });
      expect(await startThumbs(deps({ bridge }))).toEqual({ skipped: true, reason: 'BELOW_FLOORS' });
      expect(calls.find((c) => c.op === 'end_cycle')?.body).toEqual({ outcome: 'skipped', code: 'BELOW_FLOORS' });
    }
  });
});
