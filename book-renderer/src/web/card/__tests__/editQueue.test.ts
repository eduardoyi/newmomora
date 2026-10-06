import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyEdits, setChoices, setFrontImage, setText, type CardEdits } from '../../../card/edits';
import { CardApiError } from '../cardTypes';
import { classifySaveError, DEBOUNCE_MS, EditQueue, type QueueDeps, type ServerRead } from '../editQueue';

// Fictional data only (the repo is public).
const base = (): CardEdits => emptyEdits();

function harness(opts: { version?: number; edits?: CardEdits } = {}) {
  let serverEdits = opts.edits ?? base();
  let serverVersion = opts.version ?? 1;
  const saves: { expectedVersion: number; edits: CardEdits }[] = [];
  const impl = {
    save: vi.fn(async (expectedVersion: number, edits: CardEdits) => {
      saves.push({ expectedVersion, edits });
      if (expectedVersion !== serverVersion) throw new CardApiError(409, 'edits_version_mismatch', 'changed', serverVersion);
      serverEdits = edits;
      serverVersion += 1;
      return { version: serverVersion, edits };
    }),
    refetch: vi.fn(async (): Promise<ServerRead | null> => ({ edits: serverEdits, version: serverVersion })),
  };
  const deps: QueueDeps = impl;
  const queue = new EditQueue({ edits: serverEdits, version: serverVersion }, deps);
  return {
    queue,
    saves,
    impl,
    /** Records a save attempt and applies it on the server (for hand-written mocks). */
    commit(expectedVersion: number, edits: CardEdits) {
      saves.push({ expectedVersion, edits });
      serverEdits = edits;
      serverVersion += 1;
      return serverVersion;
    },
    record(expectedVersion: number, edits: CardEdits) {
      saves.push({ expectedVersion, edits });
    },
    /** Someone else saves (bumps the server without the queue knowing). */
    elsewhere(fn: (e: CardEdits) => CardEdits) {
      serverEdits = fn(serverEdits);
      serverVersion += 1;
    },
    get serverEdits() {
      return serverEdits;
    },
    get serverVersion() {
      return serverVersion;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EditQueue', () => {
  it('debounces: several quick edits become one save', async () => {
    const h = harness();
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    h.queue.update((e) => setText(e, 'back.heading', 'Feliz'));
    expect(h.queue.getSnapshot().idle).toBe(false);
    expect(h.queue.getSnapshot().edits.text['front.greeting']).toBe('Hola');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(h.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0].expectedVersion).toBe(1);
    expect(h.saves[0].edits.text).toEqual({ 'front.greeting': 'Hola', 'back.heading': 'Feliz' });
    expect(h.queue.getSnapshot().idle).toBe(true);
    expect(h.queue.getSnapshot().serverVersion).toBe(2);
  });

  it('edit then an immediate flush saves now and is idle afterwards', async () => {
    const h = harness();
    h.queue.update((e) => setText(e, 'back.signature', 'Con cariño'));
    const flushed = h.queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    expect(h.saves).toHaveLength(1); // no debounce wait
    expect(h.queue.getSnapshot().idle).toBe(true);
    expect(h.serverEdits.text['back.signature']).toBe('Con cariño');
    // The debounce timer was cancelled: no second save.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.saves).toHaveLength(1);
  });

  it('serializes: an edit made while a save is in flight goes in the next save, with the new version', async () => {
    const h = harness();
    let release: () => void = () => {};
    h.impl.save.mockImplementationOnce(async (expectedVersion: number, edits: CardEdits) => {
      await new Promise<void>((r) => (release = r));
      return { version: h.commit(expectedVersion, edits), edits };
    });
    h.queue.update((e) => setText(e, 'front.greeting', 'A'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.queue.getSnapshot().saving).toBe(true);
    h.queue.update((e) => setText(e, 'front.greeting', 'AB'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(h.impl.save).toHaveBeenCalledTimes(1); // still only the first, in flight
    release();
    await vi.advanceTimersByTimeAsync(0);
    await h.queue.flush();
    expect(h.impl.save).toHaveBeenCalledTimes(2);
    expect(h.saves[1].expectedVersion).toBe(2);
    expect(h.saves[1].edits.text['front.greeting']).toBe('AB');
  });

  it('timeout path: refetches before retrying (the first save may have landed), and ends idle', async () => {
    const h = harness();
    // The first save lands on the server but the response never comes back.
    h.impl.save.mockImplementationOnce(async (v: number, edits: CardEdits) => {
      h.commit(v, edits); // applied server-side
      throw new CardApiError(0, 'timeout', 'slow');
    });
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    expect(h.impl.refetch).toHaveBeenCalledTimes(1);
    expect(h.impl.save).toHaveBeenCalledTimes(2);
    // The retry used the refetched version, not the stale one.
    expect(h.saves[1].expectedVersion).toBe(2);
    expect(h.queue.getSnapshot().idle).toBe(true);
    expect(h.queue.getSnapshot().error).toBeNull();
    expect(h.serverEdits.text['front.greeting']).toBe('Hola');
  });

  it('timeout with a failed refetch stops with a retryable error (not idle, so Order stays disabled)', async () => {
    const h = harness();
    h.impl.save.mockRejectedValue(new CardApiError(0, 'timeout', 'slow'));
    h.impl.refetch.mockResolvedValue(null);
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    const snap = h.queue.getSnapshot();
    expect(snap.error?.kind).toBe('save_failed');
    expect(snap.idle).toBe(false);
    expect(snap.edits.text['front.greeting']).toBe('Hola'); // the user's edit is still shown
  });

  it('a version conflict rebases: both changes survive', async () => {
    const h = harness();
    // Another manager changes the QR caption first.
    h.elsewhere((e) => setText(e, 'back.qrCaption', 'Mira nuestro año'));
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    expect(h.impl.save).toHaveBeenCalledTimes(2); // 409, then the rebased retry
    expect(h.saves[1].expectedVersion).toBe(2);
    expect(h.serverEdits.text).toEqual({ 'back.qrCaption': 'Mira nuestro año', 'front.greeting': 'Hola' });
    const snap = h.queue.getSnapshot();
    expect(snap.idle).toBe(true);
    expect(snap.reloaded).toBe(false);
  });

  it('a second conflict in a row reloads the server edits ("edited elsewhere")', async () => {
    const h = harness();
    h.elsewhere((e) => setText(e, 'back.qrCaption', 'first'));
    // Every refetch shows yet another elsewhere-edit landing before our retry.
    h.impl.refetch.mockImplementation(async () => {
      const read = { edits: h.serverEdits, version: h.serverVersion };
      h.elsewhere((e) => setText(e, 'back.heading', `later ${h.serverVersion}`));
      return read;
    });
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    const snap = h.queue.getSnapshot();
    expect(h.impl.save).toHaveBeenCalledTimes(2);
    expect(snap.reloaded).toBe(true);
    expect(snap.idle).toBe(true);
    // Our pending change was dropped; we show what the server has.
    expect(snap.edits.text['front.greeting']).toBeUndefined();
    expect(snap.edits.text['back.qrCaption']).toBe('first');
    h.queue.dismissReloaded();
    expect(h.queue.getSnapshot().reloaded).toBe(false);
  });

  it('423 sets checkoutOpen, drops what could not be saved and stops accepting edits', async () => {
    const h = harness();
    h.impl.save.mockRejectedValueOnce(new CardApiError(423, 'holiday_card_checkout_open', 'open'));
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    const snap = h.queue.getSnapshot();
    expect(snap.checkoutOpen).toBe(true);
    expect(snap.idle).toBe(true);
    expect(snap.edits.text['front.greeting']).toBeUndefined();
    h.queue.update((e) => setText(e, 'front.greeting', 'again'));
    expect(h.queue.getSnapshot().idle).toBe(true); // ignored while locked out
    // The server later says the checkout is gone.
    h.queue.ingestServer({ edits: h.serverEdits, version: h.serverVersion, checkoutOpen: false });
    expect(h.queue.getSnapshot().checkoutOpen).toBe(false);
  });

  it('409 card_ordered locks the queue', async () => {
    const h = harness();
    h.impl.save.mockRejectedValueOnce(new CardApiError(409, 'card_ordered', 'ordered'));
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    expect(h.queue.getSnapshot().locked).toBe(true);
    expect(h.queue.getSnapshot().idle).toBe(true);
  });

  it('a rejected front photo drops only the front pick and saves the rest', async () => {
    const h = harness();
    h.impl.save.mockRejectedValueOnce(new CardApiError(422, 'front_low_resolution', 'too small'));
    h.queue.update((e) => setFrontImage(e, 'media-small'), { tag: 'front' });
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    const snap = h.queue.getSnapshot();
    expect(snap.rejection).toEqual({ id: 1, code: 'front_low_resolution' });
    expect(snap.edits.frontImage).toBeNull();
    expect(snap.edits.text['front.greeting']).toBe('Hola');
    expect(h.serverEdits.frontImage).toBeNull();
    expect(snap.idle).toBe(true);
  });

  it('a subscription error stops saving without losing the edit', async () => {
    const h = harness();
    h.impl.save.mockRejectedValue(new CardApiError(403, 'SUBSCRIPTION_REQUIRED', 'sub'));
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    const snap = h.queue.getSnapshot();
    expect(snap.error?.kind).toBe('subscription');
    expect(snap.idle).toBe(false);
    expect(snap.edits.text['front.greeting']).toBe('Hola');
    h.queue.discard();
    expect(h.queue.getSnapshot().idle).toBe(true);
    expect(h.queue.getSnapshot().edits.text['front.greeting']).toBeUndefined();
  });

  it('a transient failure retries by itself after a pause', async () => {
    const h = harness();
    h.impl.save.mockRejectedValueOnce(new CardApiError(0, 'network_error', 'offline'));
    h.queue.update((e) => setText(e, 'front.greeting', 'Hola'));
    await h.queue.flush();
    expect(h.queue.getSnapshot().error).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await h.queue.flush();
    expect(h.queue.getSnapshot().idle).toBe(true);
    expect(h.serverEdits.text['front.greeting']).toBe('Hola');
  });

  it('ingestServer rebases pending changes onto a fresher server read and ignores stale ones', () => {
    const h = harness();
    h.queue.update((e) => setChoices(e, { tone: 'playful' }));
    h.queue.ingestServer({ edits: setText(base(), 'back.heading', 'Feliz'), version: 4 });
    let snap = h.queue.getSnapshot();
    expect(snap.edits.text['back.heading']).toBe('Feliz');
    expect(snap.edits.choices.tone).toBe('playful');
    expect(snap.serverVersion).toBe(4);
    h.queue.ingestServer({ edits: base(), version: 2 }); // stale
    snap = h.queue.getSnapshot();
    expect(snap.serverVersion).toBe(4);
    expect(snap.edits.text['back.heading']).toBe('Feliz');
  });
});

describe('classifySaveError', () => {
  it('maps the contract', () => {
    expect(classifySaveError(new CardApiError(0, 'timeout', ''))).toBe('timeout');
    expect(classifySaveError(new CardApiError(409, 'edits_version_mismatch', '', 3))).toBe('version');
    expect(classifySaveError(new CardApiError(423, 'holiday_card_checkout_open', ''))).toBe('checkout_open');
    expect(classifySaveError(new CardApiError(409, 'card_ordered', ''))).toBe('ordered');
    for (const code of ['front_low_resolution', 'front_unreadable', 'MEDIA_NOT_PRINTABLE', 'MEDIA_NOT_FOUND']) {
      expect(classifySaveError(new CardApiError(code === 'MEDIA_NOT_FOUND' ? 404 : 422, code, ''))).toBe('front_rejected');
    }
    expect(classifySaveError(new CardApiError(403, 'SUBSCRIPTION_REQUIRED', ''))).toBe('subscription');
    expect(classifySaveError(new CardApiError(0, 'network_error', ''))).toBe('transient');
    expect(classifySaveError(new CardApiError(500, 'internal_error', ''))).toBe('transient');
    expect(classifySaveError(new CardApiError(400, 'invalid_edits', ''))).toBe('fatal');
  });
});
