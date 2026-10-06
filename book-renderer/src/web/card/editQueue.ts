import type { CardEdits } from '../../card/edits';

/**
 * The ONE save queue per card (docs/plans/holiday-cards-p2.md Step 3): pure,
 * framework-free, with the network injected so it tests with fake timers.
 *
 * Local edits = the last server-confirmed edits with every PENDING change
 * (an updater function, not a value) replayed on top. Keeping changes as
 * updaters is what makes a conflict cheap: when someone else saved first, the
 * queue refetches, swaps in the server's edits and the same updaters rebase onto
 * them, so both people's changes survive. Saves are serialized (one in flight),
 * debounced, and sent with the version they were based on; the server's
 * compare-and-set (`expectedVersion`) is the arbiter.
 */

export type EditUpdater = (edits: CardEdits) => CardEdits;

export interface PendingChange {
  fn: EditUpdater;
  /** `'front'` marks a front-photo pick: if the server rejects the photo only these changes are dropped. */
  tag?: string;
}

export interface ServerEdits {
  edits: CardEdits;
  version: number;
}

/** A fresh server read, with the flags the view carries (so a 423 / ordered state clears when the server says so). */
export interface ServerRead extends ServerEdits {
  checkoutOpen?: boolean;
  locked?: boolean;
}

export interface QueueDeps {
  /** One `save_edits` call. Throws an error with `status` / `code` (a `CardApiError`); a hang must throw `code: 'timeout'`. */
  save(expectedVersion: number, edits: CardEdits): Promise<{ version: number; edits: CardEdits }>;
  /** A fresh `get`; null when it could not be read. */
  refetch(): Promise<ServerRead | null>;
  /** Called after each confirmed save with the edits before and after (the screen refetches when the QR or front changed). */
  onSaved?(previous: CardEdits, saved: CardEdits): void;
}

export type QueueErrorKind = 'save_failed' | 'subscription';
export interface QueueError {
  kind: QueueErrorKind;
  message: string;
}

export interface QueueSnapshot {
  /** What the editor shows: confirmed edits + every pending change. */
  edits: CardEdits;
  /** Nothing pending, nothing in flight, no failed save. The Order button waits for this. */
  idle: boolean;
  saving: boolean;
  error: QueueError | null;
  /** 423: a checkout is open for the card. */
  checkoutOpen: boolean;
  /** 409 `card_ordered`: the content is frozen. */
  locked: boolean;
  /** A second version conflict: pending changes were dropped and the server's edits loaded ("edited elsewhere — reloaded"). */
  reloaded: boolean;
  /** The last rejected front photo (`id` increments per rejection so a consumer can react once). */
  rejection: { id: number; code: string } | null;
  serverVersion: number;
}

export const DEBOUNCE_MS = 600;
const MAX_TIMEOUT_RETRIES = 3;
const MAX_TRANSIENT_AUTO_RETRIES = 3;
const TRANSIENT_RETRY_MS = 5_000;

/** Server codes that mean "that front photo cannot be printed". */
export const FRONT_REJECTION_CODES: readonly string[] = [
  'front_low_resolution',
  'front_unreadable',
  'MEDIA_NOT_PRINTABLE',
  'MEDIA_NOT_FOUND',
  'MEDIA_NOT_PHOTO',
];

export type SaveFailureClass =
  | 'timeout'
  | 'version'
  | 'checkout_open'
  | 'ordered'
  | 'front_rejected'
  | 'subscription'
  | 'transient'
  | 'fatal';

interface ErrorLike {
  status?: unknown;
  code?: unknown;
}

/** Maps a `save_edits` failure to what the queue does about it. */
export function classifySaveError(err: unknown): SaveFailureClass {
  const e = (err ?? {}) as ErrorLike;
  const status = typeof e.status === 'number' ? e.status : 0;
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'timeout') return 'timeout';
  if (status === 409 && code === 'edits_version_mismatch') return 'version';
  if (status === 423 || code === 'holiday_card_checkout_open') return 'checkout_open';
  if (status === 409 && code === 'card_ordered') return 'ordered';
  if (FRONT_REJECTION_CODES.includes(code)) return 'front_rejected';
  if (status === 403 && code === 'SUBSCRIPTION_REQUIRED') return 'subscription';
  if (status === 0 || status >= 500 || status === 429) return 'transient';
  return 'fatal';
}

export function applyChanges(base: CardEdits, changes: readonly PendingChange[]): CardEdits {
  return changes.reduce((acc, change) => change.fn(acc), base);
}

export class EditQueue {
  private server: ServerEdits;
  private pending: PendingChange[] = [];
  private inflight: PendingChange[] | null = null;
  private error: QueueError | null = null;
  private checkoutOpen = false;
  private locked = false;
  private reloaded = false;
  private rejection: { id: number; code: string } | null = null;
  private rejectionCount = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private transientRetries = 0;
  private drainPromise: Promise<void> | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();
  private cached: QueueSnapshot | null = null;

  constructor(
    initial: ServerEdits,
    private readonly deps: QueueDeps,
    private readonly debounceMs: number = DEBOUNCE_MS,
  ) {
    this.server = initial;
  }

  // ── Reading ────────────────────────────────────────────────────────────

  getSnapshot = (): QueueSnapshot => {
    if (!this.cached) {
      this.cached = {
        edits: applyChanges(this.server.edits, this.pending),
        idle: this.pending.length === 0 && this.inflight === null && this.error === null,
        saving: this.inflight !== null,
        error: this.error,
        checkoutOpen: this.checkoutOpen,
        locked: this.locked,
        reloaded: this.reloaded,
        rejection: this.rejection,
        serverVersion: this.server.version,
      };
    }
    return this.cached;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    this.cached = null;
    for (const l of this.listeners) l();
  }

  // ── Writing ────────────────────────────────────────────────────────────

  /** Queues a change (an updater applied to whatever the edits are when it runs) and schedules a debounced save. */
  update = (fn: EditUpdater, opts: { tag?: string } = {}): void => {
    if (this.disposed || this.locked || this.checkoutOpen) return;
    this.pending.push({ fn, tag: opts.tag });
    // A new edit is a fresh chance: clear a failed-save state and its retry timer.
    this.error = null;
    this.transientRetries = 0;
    this.clearRetry();
    this.reloaded = false;
    this.armDebounce();
    this.notify();
  };

  /** Saves everything now; resolves when the queue settles (idle, or stopped on an error: check the snapshot). */
  flush = async (): Promise<void> => {
    this.clearDebounce();
    this.clearRetry();
    // Bounded: each pass either saves, stops on an error, or clears what cannot be saved.
    for (let pass = 0; pass < 20 && !this.disposed && (this.pending.length > 0 || this.drainPromise); pass += 1) {
      if (this.error && !this.drainPromise) return;
      await this.startDrain();
      if (this.error) return;
    }
  };

  /** Retry after a failed save (the "Try again" button). */
  retry = (): Promise<void> => {
    this.error = null;
    this.transientRetries = 0;
    this.notify();
    return this.flush();
  };

  /** Drops every unsaved change and shows the server's edits again. */
  discard = (): void => {
    this.pending = [];
    this.error = null;
    this.clearDebounce();
    this.clearRetry();
    this.notify();
  };

  dismissReloaded = (): void => {
    if (!this.reloaded) return;
    this.reloaded = false;
    this.notify();
  };

  /**
   * A fresh server read (poll, visibility, image-error refetch). Rebases: the
   * pending changes stay and replay on top. Ignored while a save is in flight
   * (its response is the newer truth) and when it is older than what we hold.
   */
  ingestServer = (read: ServerRead): void => {
    if (this.disposed || this.inflight) return;
    let changed = false;
    if (read.version >= this.server.version) {
      this.server = { edits: read.edits, version: read.version };
      changed = true;
    }
    if (read.checkoutOpen !== undefined && read.checkoutOpen !== this.checkoutOpen) {
      this.checkoutOpen = read.checkoutOpen;
      changed = true;
    }
    if (read.locked !== undefined && read.locked !== this.locked) {
      this.locked = read.locked;
      changed = true;
    }
    if (changed) this.notify();
  };

  /** Re-arms a queue a StrictMode simulated unmount disposed. */
  activate = (): void => {
    this.disposed = false;
  };

  dispose = (): void => {
    this.disposed = true;
    this.clearDebounce();
    this.clearRetry();
    this.listeners.clear();
  };

  // ── Timers ─────────────────────────────────────────────────────────────

  private armDebounce(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.startDrain();
    }, this.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // ── The drain loop (serialized: at most one running) ───────────────────

  private startDrain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
        this.inflight = null;
        this.notify();
      });
    }
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    let conflicts = 0;
    let timeouts = 0;
    if (this.locked || this.checkoutOpen) {
      // Editing is closed: whatever is still pending can never be saved.
      this.pending = [];
      this.notify();
      return;
    }
    while (!this.disposed && this.pending.length > 0 && !this.locked && !this.checkoutOpen) {
      const batch = this.pending.slice();
      this.inflight = batch;
      this.notify();
      try {
        const previous = this.server.edits;
        const saved = await this.deps.save(this.server.version, applyChanges(previous, batch));
        this.server = { edits: saved.edits, version: saved.version };
        this.pending = this.pending.filter((c) => !batch.includes(c));
        this.inflight = null;
        this.error = null;
        conflicts = 0;
        timeouts = 0;
        this.transientRetries = 0;
        this.notify();
        try {
          this.deps.onSaved?.(previous, saved.edits);
        } catch {
          // A listener's problem never fails a save.
        }
        continue;
      } catch (err) {
        this.inflight = null;
        const kind = classifySaveError(err);
        if (kind === 'timeout') {
          // Unknown whether it landed: read the truth, then resend what is still pending.
          timeouts += 1;
          const read = await this.deps.refetch();
          if (!read) return this.fail('save_failed', "We couldn't confirm your last change. Check your connection.", true);
          this.adopt(read);
          if (timeouts >= MAX_TIMEOUT_RETRIES) return this.fail('save_failed', 'Saving is taking too long. Try again in a moment.', false);
          continue;
        }
        if (kind === 'version') {
          conflicts += 1;
          const read = await this.deps.refetch();
          if (!read) return this.fail('save_failed', "We couldn't confirm your last change. Check your connection.", true);
          this.adopt(read);
          if (conflicts >= 2) {
            // Edited elsewhere twice in a row: stop fighting, show the server's version.
            this.pending = [];
            this.reloaded = true;
            this.notify();
            return;
          }
          continue;
        }
        if (kind === 'checkout_open' || kind === 'ordered') {
          if (kind === 'checkout_open') this.checkoutOpen = true;
          else this.locked = true;
          const read = await this.deps.refetch();
          // The server decides the flags once it answers (a closed checkout may already be gone).
          if (read) this.adopt({ ...read, checkoutOpen: kind === 'checkout_open' ? (read.checkoutOpen ?? true) : read.checkoutOpen, locked: kind === 'ordered' ? (read.locked ?? true) : read.locked });
          this.pending = [];
          this.notify();
          return;
        }
        if (kind === 'front_rejected') {
          const code = (err as ErrorLike).code as string;
          const hadFront = batch.some((c) => c.tag === 'front');
          this.rejectionCount += 1;
          this.rejection = { id: this.rejectionCount, code };
          // Drop only the front pick; the rest of the batch is retried. With no tagged change the whole batch was the problem.
          this.pending = this.pending.filter((c) => (hadFront ? c.tag !== 'front' : !batch.includes(c)));
          this.notify();
          continue;
        }
        if (kind === 'subscription') {
          return this.fail('subscription', 'A Momora subscription is needed to save changes to this card.', false);
        }
        if (kind === 'transient') return this.fail('save_failed', "Your last change couldn't be saved. We'll try again.", true);
        return this.fail('save_failed', "Your last change couldn't be saved.", false);
      }
    }
  }

  private adopt(read: ServerRead): void {
    this.server = { edits: read.edits, version: read.version };
    if (read.checkoutOpen !== undefined) this.checkoutOpen = read.checkoutOpen;
    if (read.locked !== undefined) this.locked = read.locked;
    this.notify();
  }

  private fail(kind: QueueErrorKind, message: string, autoRetry: boolean): void {
    this.error = { kind, message };
    this.notify();
    if (autoRetry && this.transientRetries < MAX_TRANSIENT_AUTO_RETRIES && !this.disposed) {
      this.transientRetries += 1;
      this.clearRetry();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.error = null;
        this.notify();
        void this.startDrain();
      }, TRANSIENT_RETRY_MS * this.transientRetries);
    }
  }
}
