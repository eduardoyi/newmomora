import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import { AttemptStopped, BridgeError } from '../src/bridge';
import { runCardGeneration } from '../src/card-workflow';
import { filmSetup, frontPlan, frontProbe, lettersPrepare, MAX_PROBE_PHOTOS, PROBE_STEP_PHOTOS } from '../src/card-stages';
import { cardAttemptPrefix } from '../src/storage';
import { uuidV5 } from '../src/uuid';
import {
  ATTEMPT, CARD, FILM, FILM_ATTEMPT, familyRows, fakeChat, harness, OWNER, PREFIX, SECRET_TEXT, TODAY,
} from './card-fixtures';

/** A Workflow step that runs inline (no retries) and, like the real engine,
 * persists each result as JSON: a Map/Set/undefined-bearing result would not survive. */
function fakeStep() {
  const names: string[] = [];
  const outputs: Record<string, unknown> = {};
  const step = {
    async do(name: string, a: unknown, b?: unknown) {
      const fn = (typeof a === 'function' ? a : b) as (ctx: unknown) => Promise<unknown>;
      const result = await fn({ attempt: 1 });
      names.push(name);
      outputs[name] = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      return outputs[name];
    },
    async sleep() {},
  } as unknown as WorkflowStep;
  return { step, names, outputs };
}

const ops = (h: ReturnType<typeof harness>) => h.db.calls.map((c) => c.op);

describe('card generation Workflow', () => {
  it('happy path: front picks -> film (create, claim, start) -> letters -> ready', async () => {
    const h = harness();
    const { step, names, outputs } = fakeStep();
    const logs: unknown[][] = [];
    const spies = (['log', 'error', 'warn'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a)));
    let result;
    try {
      result = await runCardGeneration(h.deps, step);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(result).toEqual({ outcome: 'ready', film: 'started' });

    // Step order: probe/judge steps are numbered; the film steps follow the front picks, the letters follow the film.
    expect(names.filter((n) => !/^front:(probe|judge):/.test(n))).toEqual([
      'init', 'front:plan', 'front:select', 'front:store', 'film:setup', 'film:claim', 'film:start', 'letters:prepare', 'letters:write:0', 'finish',
    ]);
    expect(names.filter((n) => n.startsWith('front:probe:')).length).toBeGreaterThan(0);
    expect(names.indexOf('front:store')).toBeLessThan(names.indexOf('film:setup'));
    expect(names.indexOf('film:start')).toBeLessThan(names.indexOf('letters:prepare'));

    // Front candidates: stored with ids, numbers and enums only (no model text).
    const front = h.db.card.front as { candidates: { mediaId: string; rank: number; verdict: Record<string, unknown> }[]; counts: Record<string, number> };
    expect(front.candidates.length).toBeGreaterThan(0);
    expect(front.candidates.map((c) => c.rank)).toEqual(front.candidates.map((_, i) => i + 1));
    expect(front.candidates.every((c) => c.mediaId.startsWith('a-'))).toBe(true); // real memory_media ids, never legacy:
    expect(Object.keys(front.candidates[0].verdict).sort()).toEqual(['allFacesVisible', 'cardScore', 'cropRisk', 'eyesOpenMostly', 'light', 'lookingAtCamera', 'peopleVisible', 'sharp']);
    expect(front.counts.judged).toBeGreaterThan(0);

    // Film: scope Jan 1 -> today (+1 exclusive), the top picks as close media, then claim, then the Workflow start.
    const create = h.db.calls.find((c) => c.op === 'card_create_film')!;
    expect(create.body).toMatchObject({ scopeStart: '2026-01-01', scopeEnd: '2026-10-07' });
    expect(create.body.closeMedia).toEqual(front.candidates.slice(0, 6).map((c) => c.mediaId));
    expect(ops(h).indexOf('card_create_film')).toBeLessThan(ops(h).indexOf('card_claim_film'));
    expect(h.filmStarts).toEqual([{ filmId: FILM, attemptId: FILM_ATTEMPT }]);
    expect(ops(h)).not.toContain('card_end_film_cycle');

    // Letters: stored with the card renderer's tones, the QR caption (a film exists), signature, facts.
    const saved = h.db.card.saved as { letters: { tone: string; text: string; chars: number }[]; qrCaption: string | null; signature: string; editorFacts: { facts: unknown[] } };
    expect(saved.letters.map((l) => l.tone)).toEqual(['classic', 'reflective', 'playful']);
    expect(saved.letters.every((l) => l.chars === Array.from(l.text).length)).toBe(true);
    expect(saved.qrCaption).toBe('Escanea para ver nuestro año: parque y piscina.');
    expect(saved.signature).toBe('Con cariño, la familia Rivera Soto');
    expect(saved.editorFacts.facts.length).toBe(1);

    // Ready, the lease cleared, the attempt's R2 files gone.
    expect(h.db.card.status).toBe('ready');
    expect(ops(h).at(-1)).toBe('card_finish');
    expect([...h.storage.objects.keys()].filter((k) => k.startsWith(PREFIX))).toEqual([]);
    expect(PREFIX).toBe(cardAttemptPrefix(OWNER, CARD, ATTEMPT));

    // Usage: every paid call recorded under a card operation, ledger ids deterministic and unique.
    const usageOps = new Set(h.db.usage.map((u) => u.usageOperation));
    expect([...usageOps].sort()).toEqual(['holiday_card_details', 'holiday_card_editor', 'holiday_card_front_judge', 'holiday_card_quote_check', 'holiday_card_voice', 'holiday_card_writer']);
    const ids = h.db.usage.map((u) => u.aiCallId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(await uuidV5(`${ATTEMPT}:b0:front_judge:0:0`));
    expect(ids).toContain(await uuidV5(`${ATTEMPT}:quote_check`));
    expect(ids).toContain(await uuidV5(`${ATTEMPT}:w0:writer:es:warm`));

    // Privacy: no memory text, name, quote or model text in any step result or log.
    const everything = JSON.stringify(outputs) + JSON.stringify(logs);
    for (const secret of SECRET_TEXT) expect(everything).not.toContain(secret);
    expect(JSON.stringify(front)).not.toContain('FAKE-WHY-SECRET');
  });

  it('below the film floors: no film row, no claim, no QR caption; the card is still ready with letters', async () => {
    // 12 monthly memories + 2 extra = 14 moments (< 20): no film.
    const h = harness({ rows: familyRows({ monthly: 12 }) });
    const { step, names } = fakeStep();
    const result = await runCardGeneration(h.deps, step);
    expect(result).toEqual({ outcome: 'ready', film: 'none' });
    expect(ops(h)).not.toContain('card_create_film');
    expect(ops(h)).not.toContain('card_claim_film');
    expect(names).not.toContain('film:claim');
    expect(h.filmStarts).toEqual([]);
    expect((h.db.card.saved as { qrCaption: string | null }).qrCaption).toBeNull();
    expect(h.db.card.status).toBe('ready');
  });

  it('claim returns zero rows (the hourly cron got it): success, the Workflow is not started', async () => {
    const h = harness();
    h.db.claim = null;
    const { step, names } = fakeStep();
    expect(await runCardGeneration(h.deps, step)).toEqual({ outcome: 'ready', film: 'claimed_elsewhere' });
    expect(names).toContain('film:claim');
    expect(names).not.toContain('film:start');
    expect(h.filmStarts).toEqual([]);
    expect(h.db.card.status).toBe('ready');
    expect(h.db.card.letters).not.toBeNull();
  });

  it('film dispatch failure: the claimed cycle ends aborted/DISPATCH_FAILED (the cron retries it); the card still finishes', async () => {
    const h = harness();
    h.startFilmError.value = new Error('workflow create failed');
    const { step } = fakeStep();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let result;
    try {
      result = await runCardGeneration(h.deps, step);
    } finally {
      errors.mockRestore();
    }
    expect(result).toEqual({ outcome: 'ready', film: 'queued' });
    const end = h.db.calls.find((c) => c.op === 'card_end_film_cycle')!;
    expect(end.body).toEqual({ filmAttemptId: FILM_ATTEMPT });
    expect(h.db.card.status).toBe('ready');
    // The caption is still written: the film exists (it will be dispatched by the cron).
    expect((h.db.card.saved as { qrCaption: string | null }).qrCaption).not.toBeNull();
  });

  it('a superseded attempt stops quietly: no failure is written, the R2 files go, later steps never run', async () => {
    const h = harness();
    const { step, names } = fakeStep();
    // Another attempt takes the card right after the front picks are stored.
    const original = h.db.bridge.call.bind(h.db.bridge);
    h.db.bridge.call = (async (op: string, body?: Record<string, unknown>) => {
      const out = await original(op, body);
      if (op === 'card_save_front') h.db.card.attemptId = 'someone-else';
      return out;
    }) as typeof h.db.bridge.call;
    expect(await runCardGeneration(h.deps, step)).toEqual({ outcome: 'stopped' });
    expect(names).not.toContain('film:setup');
    expect(ops(h)).not.toContain('card_finish');
    expect(h.db.card.status).toBe('generating'); // not marked failed
    expect(h.db.card.failureCode).toBeNull();
    expect(h.filmStarts).toEqual([]);
    expect(names.at(-1)).toBe('abort:cleanup');
  });

  it('the first call claims the lease for the dispatched attempt; a card another attempt holds is left alone', async () => {
    const unleased = harness();
    unleased.db.card.attemptId = ''; // the callers dispatch only {cardId, attemptId}
    expect(await runCardGeneration(unleased.deps, fakeStep().step)).toMatchObject({ outcome: 'ready' });
    expect(unleased.db.calls[0].op).toBe('card_start');

    const held = harness();
    held.db.card.attemptId = 'another-attempt';
    const { step, names } = fakeStep();
    expect(await runCardGeneration(held.deps, step)).toEqual({ outcome: 'stopped' });
    expect(names).toEqual(['abort:cleanup']);
    expect(ops(held)).toEqual(['card_start']); // nothing else was asked of the bridge
    expect(held.db.card.status).toBe('generating');
  });

  it('a card deleted mid-generation stops quietly too (even with the failure path)', async () => {
    const h = harness();
    const { step } = fakeStep();
    const original = h.db.bridge.call.bind(h.db.bridge);
    h.db.bridge.call = (async (op: string, body?: Record<string, unknown>) => {
      if (op === 'card_create_film') h.db.card.deleted = true;
      return original(op, body);
    }) as typeof h.db.bridge.call;
    expect(await runCardGeneration(h.deps, step)).toEqual({ outcome: 'stopped' });
    expect(ops(h)).not.toContain('card_claim_film');
    expect(ops(h)).not.toContain('card_finish');
  });

  it('a failure ends the card failed with a closed code and never leaks the error text', async () => {
    // Infrastructure error in the film step -> FILM_SETUP_FAILED.
    const film = harness();
    film.db.failOn.card_create_film = new BridgeError(500, 'card_create_film');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runCardGeneration(film.deps, fakeStep().step)).toEqual({ outcome: 'failed', code: 'FILM_SETUP_FAILED' });
      expect(film.db.card.status).toBe('failed');
      expect(film.db.card.failureCode).toBe('FILM_SETUP_FAILED');
      expect(errors).toHaveBeenCalledWith('holiday card generation failed', { cardId: CARD, code: 'FILM_SETUP_FAILED' });

      // The first call failing -> CONTEXT_LOAD_FAILED; the front picks -> FRONT_PICK_FAILED.
      const init = harness();
      init.db.failOn.card_start = new Error('boom with secret text');
      expect(await runCardGeneration(init.deps, fakeStep().step)).toMatchObject({ outcome: 'failed', code: 'CONTEXT_LOAD_FAILED' });
      const front = harness();
      front.db.failOn.card_save_front = new Error('boom');
      expect(await runCardGeneration(front.deps, fakeStep().step)).toMatchObject({ outcome: 'failed', code: 'FRONT_PICK_FAILED' });
      expect(JSON.stringify(errors.mock.calls)).not.toContain('secret text');

      // The letters step failing -> LETTERS_FAILED, and the prepared letters are deleted.
      const letters = harness();
      letters.db.failOn.card_save_letters = new Error('boom');
      expect(await runCardGeneration(letters.deps, fakeStep().step)).toMatchObject({ outcome: 'failed', code: 'LETTERS_FAILED' });
      expect([...letters.storage.objects.keys()].filter((k) => k.startsWith(PREFIX))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('no usable letters (the editor keeps failing) -> failed NO_LETTERS after one more attempt; no deterministic dead end retried', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = harness({ chat: fakeChat({ failEditor: true }) });
      const { step, names } = fakeStep();
      expect(await runCardGeneration(h.deps, step)).toEqual({ outcome: 'failed', code: 'NO_LETTERS' });
      expect(names.filter((n) => n.startsWith('letters:write:'))).toEqual(['letters:write:0', 'letters:write:1']);
      expect(h.db.card.status).toBe('failed');
      expect(h.db.card.failureCode).toBe('NO_LETTERS');
      expect(h.db.card.letters).toBeNull();
      // The second attempt's paid calls get their own ledger ids.
      const editorIds = h.db.usage.filter((u) => u.usageOperation === 'holiday_card_editor').map((u) => u.aiCallId);
      expect(new Set(editorIds).size).toBe(2);

      // A pool with nothing to tell ("no_highlights") is deterministic: not retried.
      const rows = familyRows();
      rows.memories = rows.memories.map((m) => ({ ...m, content: null }));
      const bare = harness({ rows });
      const bareStep = fakeStep();
      expect(await runCardGeneration(bare.deps, bareStep.step)).toEqual({ outcome: 'failed', code: 'NO_LETTERS' });
      expect(bareStep.names.filter((n) => n.startsWith('letters:write:'))).toEqual(['letters:write:0']);
    } finally {
      errors.mockRestore();
    }
  });

  it('a replayed prepare step does not pay twice (the stored preparation is reused)', async () => {
    const h = harness();
    const first = await lettersPrepare(h.deps, { today: TODAY }, true);
    expect(first.prefix).toBe(PREFIX);
    const paid = h.chat.calls.length;
    expect(paid).toBeGreaterThan(0);
    expect(h.storage.objects.has(`${PREFIX}prepared.json`)).toBe(true);
    await lettersPrepare(h.deps, { today: TODAY }, true);
    expect(h.chat.calls.length).toBe(paid);
  });
});

describe('front picks: subrequest budget', () => {
  it('probes the pool in chunks of PROBE_STEP_PHOTOS: every step stays within 2 reads per photo and 300 in all', async () => {
    const rows = familyRows({ extraPhotos: 340 });
    const h = harness({ rows });
    const { step, names } = fakeStep();
    const probes: number[] = [];
    // Count the R2 reads each probe step makes.
    let marker = 0;
    const original = h.deps.images.readRange;
    h.deps.images.readRange = async (key, length) => original(key, length);
    const stepDo = step.do.bind(step);
    (step as unknown as { do: unknown }).do = async (name: string, a: unknown, b?: unknown) => {
      marker = h.rangeReads.length;
      const out = await (stepDo as (n: string, a: unknown, b?: unknown) => Promise<unknown>)(name, a, b);
      if (name.startsWith('front:probe:')) probes.push(h.rangeReads.length - marker);
      return out;
    };
    await runCardGeneration(h.deps, step);
    const probeSteps = names.filter((n) => n.startsWith('front:probe:'));
    expect(probeSteps.length).toBeGreaterThanOrEqual(3);
    expect(probes.every((reads) => reads <= PROBE_STEP_PHOTOS * 2)).toBe(true);
    expect(Math.max(...probes)).toBe(PROBE_STEP_PHOTOS); // full chunks: one 256 KB read per readable photo
    // No original is ever read in full (no downscaler in the Worker).
    expect(h.fullReads.some((k) => k.startsWith('orig/'))).toBe(false);
  });

  it('caps the probe at MAX_PROBE_PHOTOS, most family-complete and newest first, and bounds a probe step to <= 2 reads per photo', async () => {
    const rows = familyRows({ extraPhotos: 1000 });
    const h = harness({ rows });
    const plan = await frontPlan(h.deps, { today: TODAY });
    expect(plan.probeIds.length).toBe(MAX_PROBE_PHOTOS);
    expect(plan.poolPhotos).toBeGreaterThan(MAX_PROBE_PHOTOS);
    // Whole-core photos (Tomás + Lucía + Ana + Marco tagged) would sort first; the beach photos tag 3 of 4.
    const first = plan.probeIds[0];
    expect(first.startsWith('a-m-beach')).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('orig/'); // ids only, never object keys

    // Worst case: every header needs the 4 MB fallback -> 2 reads per photo, 300 per step.
    const objects = new Map<string, Uint8Array>();
    for (const m of rows.media) objects.set(m.object_key, new Uint8Array(300 * 1024)); // no parseable header in 256 KB
    const worst = harness({ rows, objects });
    const dims = await frontProbe(worst.deps, plan.probeIds.slice(0, PROBE_STEP_PHOTOS));
    expect(dims).toEqual({});
    expect(worst.rangeReads.length).toBe(PROBE_STEP_PHOTOS * 2);
    expect(worst.rangeReads.length).toBeLessThanOrEqual(300);
  });

  it('the vision judge runs one step per batch of 8 and keeps model text out of its result', async () => {
    const h = harness();
    const { step, names, outputs } = fakeStep();
    await runCardGeneration(h.deps, step);
    const judgeSteps = names.filter((n) => n.startsWith('front:judge:'));
    expect(judgeSteps.length).toBeGreaterThan(0);
    for (const name of judgeSteps) {
      const out = outputs[name] as { verdicts: [string, { why: string; setting: string }][] };
      expect(out.verdicts.length).toBeLessThanOrEqual(8);
      expect(out.verdicts.every(([, v]) => v.why === '' && v.setting === '')).toBe(true);
    }
    expect(h.chat.calls.filter((c) => c === 'judge').length).toBe(judgeSteps.length);
  });
});

describe('stop classification', () => {
  it('AttemptStopped from any op is a non-retryable stop, not a failure', async () => {
    const h = harness();
    h.db.failOn.card_start = new AttemptStopped('deleted');
    expect(await runCardGeneration(h.deps, fakeStep().step)).toEqual({ outcome: 'stopped' });
    expect(h.db.card.status).toBe('generating');
  });
});

describe('fixtures', () => {
  it('the happy-path family really clears the card film floors (sanity for the tests above)', async () => {
    const h = harness();
    expect(await filmSetup(h.deps, { today: TODAY }, [])).toEqual({ filmId: FILM, reason: null });
    const small = harness({ rows: familyRows({ monthly: 12 }) });
    expect(await filmSetup(small.deps, { today: TODAY }, [])).toEqual({ filmId: null, reason: 'BELOW_FLOORS' });
    // A card that already has a film keeps it whatever the pool says now.
    small.db.card.filmId = FILM;
    expect(await filmSetup(small.deps, { today: TODAY }, [])).toEqual({ filmId: FILM, reason: null });
  });
});
