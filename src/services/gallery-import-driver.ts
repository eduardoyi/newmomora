// The single app-root driver for the continuous gallery import sweep
// (docs/plans/gallery-import-continuous.md's Internal model, S10). Screens
// never call `resumeGalleryImportRunner` themselves anymore -- they only
// observe this module's state (`subscribeGalleryImportDriver`) and the
// existing live-progress bus, and ask for an out-of-cycle attempt via
// `kickGalleryImportDriver`. A single module-level singleton is deliberate:
// only one `useGalleryImportDriver()` mount exists (app/(app)/_layout.tsx),
// so there is exactly one owner of "am I currently resuming this family's
// run" -- the single-flight guard below is what makes overlapping kicks
// (an AppState 'active' event landing mid-tick, say) safe.
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import { GALLERY_IMPORT_DRIVER_TICK_MS } from '@/constants/gallery-import';
import type { GalleryImportRunnerProgress } from '@/services/gallery-import-runner';
import { loadLatestGalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import {
  loadGalleryImportFrontier,
  saveGalleryImportFrontier,
} from '@/utils/gallery-import-frontier';
import {
  isGalleryImportRunnerActive,
  markGalleryImportRunnerActive,
  markGalleryImportRunnerInactive,
  publishGalleryImportLiveProgress,
  subscribeGalleryImportLiveProgress,
} from '@/utils/gallery-import-live-progress';

// The runner and the native media-library scanner are loaded lazily, inside
// runKick, rather than imported at module scope: this driver is reached from
// the app-root layout and from useGalleryImportEntryStatus (Timeline,
// Settings), and a static import would pull expo-media-library into every
// bundle -- including web, where that native module does not exist and the
// import itself throws at the root layout (observed on the web preview).
// Lazy `require` (not `import()`): Metro evaluates a module only when it is
// first required, which is exactly the deferral needed, and Jest's VM has no
// native dynamic-import support.
type RunnerModule = typeof import('@/services/gallery-import-runner');
type ScannerModule = typeof import('@/utils/gallery-import-scanner');
function loadRunner(): RunnerModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load, see above.
  return require('@/services/gallery-import-runner') as RunnerModule;
}
type GalleryServiceModule = typeof import('@/services/gallery-import');
function loadGalleryService(): GalleryServiceModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load, see above.
  return require('@/services/gallery-import') as GalleryServiceModule;
}
function loadScanner(): ScannerModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load, see above.
  return require('@/utils/gallery-import-scanner') as ScannerModule;
}

export type GalleryImportDriverPhase =
  | 'idle'
  | 'scanning'
  | 'preparing'
  | 'uploading'
  | 'dispatching'
  | 'waiting_wifi'
  | 'paused_fair_use'
  | 'error'
  | 'done';

export interface GalleryImportDriverState {
  phase: GalleryImportDriverPhase;
  runId: string | null;
  pausedUntil: string | null;
  /** Content-free (see galleryImportRunnerErrorMessage) -- never memory content. */
  lastError: string | null;
  isActive: boolean;
}

const IDLE_STATE: GalleryImportDriverState = { phase: 'idle', runId: null, pausedUntil: null, lastError: null, isActive: false };
const BACKOFF_INITIAL_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

let state: GalleryImportDriverState = IDLE_STATE;
const listeners = new Set<(next: GalleryImportDriverState) => void>();

let contextUserId: string | null = null;
let contextFamilyId: string | null = null;

let isKicking = false;
let pendingKickReason: string | null = null;
let pendingKickOpts: { allowCellular?: boolean } = {};

let backoffMs = BACKOFF_INITIAL_MS;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let listenersStarted = false;

function setState(patch: Partial<GalleryImportDriverState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/** Subscribes to driver state. Immediately replays the current state so a
 * newly-mounted screen never waits for the next transition to render
 * something. Returns an unsubscribe function. */
export function subscribeGalleryImportDriver(listener: (state: GalleryImportDriverState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => { listeners.delete(listener); };
}

export function getGalleryImportDriverState(): GalleryImportDriverState {
  return state;
}

/** Registers which user/family this device's driver is currently tracking.
 * `useGalleryImportDriver()` calls this on mount and whenever the active
 * family changes; every other export below reads this context rather than
 * taking user/family parameters directly (S10's `kickGalleryImportDriver`
 * signature is deliberately just `(reason, opts?)`). */
export function setGalleryImportDriverContext(userId: string | null, familyId: string | null): void {
  contextUserId = userId;
  contextFamilyId = familyId;
}

function clearBackoffTimer(): void {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

function scheduleAutomaticRetry(): void {
  clearBackoffTimer();
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    kickGalleryImportDriver('automatic-retry');
  }, delay);
}

function stageToPhase(stage: GalleryImportRunnerProgress['stage']): GalleryImportDriverPhase {
  return stage;
}

function manageTick(shouldTick: boolean): void {
  if (shouldTick && !tickTimer) {
    tickTimer = setInterval(() => kickGalleryImportDriver('tick'), GALLERY_IMPORT_DRIVER_TICK_MS);
  } else if (!shouldTick && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function isWifiAvailable(network: NetInfoState): boolean {
  return network.isConnected === true
    && network.isInternetReachable !== false
    && network.type === 'wifi'
    && network.details?.isConnectionExpensive !== true;
}

/**
 * Single-flight per the current (userId, familyId) context. Loads the
 * latest local checkpoint, decides whether there is anything to do without
 * making a network call when possible (fair-use pause, Wi-Fi wait), and
 * otherwise calls `resumeGalleryImportRunner` once. Never throws -- every
 * outcome (including an unexpected error) becomes a state transition instead.
 */
export function kickGalleryImportDriver(reason: string, opts: { allowCellular?: boolean } = {}): void {
  if (!contextUserId || !contextFamilyId) return;
  if (isKicking) {
    // Coalesce: only the most recent pending reason/opts survive -- a burst
    // of AppState/NetInfo/tick events while a kick is in flight should
    // result in exactly one follow-up attempt, not a queue of them.
    pendingKickReason = reason;
    pendingKickOpts = opts;
    return;
  }
  void runKick(contextUserId, contextFamilyId, opts);
}

async function runKick(userId: string, familyId: string, opts: { allowCellular?: boolean }): Promise<void> {
  isKicking = true;
  try {
    const checkpoint = await loadLatestGalleryImportCheckpoint(userId, familyId);
    if (!checkpoint) {
      setState(IDLE_STATE);
      manageTick(false);
      return;
    }

    // Double-processing race guard: the entry screen's start pipeline
    // (beginGalleryImportPipeline -> startGalleryImportRunner) may already
    // be running for this exact run -- it marks the run active the moment
    // its checkpoint exists (see gallery-import-pipeline.ts), well before
    // this driver would otherwise learn about it from AppState/NetInfo/the
    // tick/the mount kick. Without this check, both loops would prepare/
    // upload the same chunks concurrently. Keep ticking so a later kick
    // re-checks once the other caller finishes.
    if (isGalleryImportRunnerActive(checkpoint.runId)) {
      setState({ isActive: true, runId: checkpoint.runId });
      manageTick(true);
      return;
    }

    setState({ runId: checkpoint.runId, lastError: null });

    if (checkpoint.pausedUntil && new Date(checkpoint.pausedUntil).getTime() > Date.now()) {
      // The local pausedUntil is an estimate from the refusal's hint. The
      // window can free earlier than estimated (reviewing frees nothing, but
      // the rolling 24 h window drains as older clusters age out, and an
      // admin can raise the cap), so ask the server before trusting it.
      const runner = loadRunner();
      const gallery = loadGalleryService();
      const remote = await gallery.getGalleryImportRun({ runId: checkpoint.runId, runCapability: checkpoint.runCapability });
      const serverPause = remote.data?.fairUse?.pausedUntil ?? null;
      if (!remote.error && remote.data && !serverPause) {
        // Server says the window is open again -- clear the local pause and
        // fall through to a normal resume pass.
        await runner.clearGalleryImportCheckpointPause(checkpoint.userId, checkpoint.familyId, checkpoint.runId);
      } else {
        setState({ phase: 'paused_fair_use', pausedUntil: serverPause ?? checkpoint.pausedUntil, isActive: false });
        manageTick(true);
        return;
      }
    }

    // Re-check NetInfo on every kick (rather than trusting a stale
    // checkpoint status) so Wi-Fi regain resumes automatically the next
    // time anything kicks the driver (a NetInfo event, the tick, or a
    // foreground transition) without the user having to act.
    const allowCellular = opts.allowCellular === true || checkpoint.allowCellular === true;
    if (checkpoint.status === 'paused' && !allowCellular) {
      const network = await NetInfo.fetch();
      if (!isWifiAvailable(network)) {
        setState({ phase: 'waiting_wifi', pausedUntil: null, isActive: false });
        manageTick(true);
        return;
      }
    }

    setState({ isActive: true, pausedUntil: null });
    const unsubscribeLive = subscribeGalleryImportLiveProgress(checkpoint.runId, (progress) => {
      setState({ phase: stageToPhase(progress.stage), runId: checkpoint.runId, isActive: true });
    });
    // Mark active for the whole resume call -- not just this driver's own
    // single-flight guard above -- so the start pipeline (or any other
    // future caller) sees the exact same one source of truth via
    // isGalleryImportRunnerActive/gallery-import-live-progress.ts.
    markGalleryImportRunnerActive(checkpoint.runId);
    let result: Awaited<ReturnType<RunnerModule['resumeGalleryImportRunner']>>;
    try {
      const runner = loadRunner();
      const adapter = getGalleryImportE2eAdapter() ?? loadScanner().createExpoGalleryMediaLibraryAdapter();
      result = await runner.resumeGalleryImportRunner({
        userId,
        familyId,
        runId: checkpoint.runId,
        adapter,
        allowCellular,
        // Publish to the shared live-progress bus (not a direct setState
        // here) so any other mounted consumer of that bus (e.g. a progress
        // screen) also sees these counts -- our own driver state above
        // reacts to the very same publish via the subscription just above.
        onProgress: (progress) => publishGalleryImportLiveProgress(checkpoint.runId, progress),
      });
    } finally {
      unsubscribeLive();
      markGalleryImportRunnerInactive(checkpoint.runId);
    }

    // A successful pass (however far it got) proves the driver itself is
    // healthy -- reset backoff so a later unrelated failure starts its own
    // fresh 30s->5min schedule rather than continuing a stale one.
    backoffMs = BACKOFF_INITIAL_MS;
    clearBackoffTimer();

    const settled = await loadLatestGalleryImportCheckpoint(userId, familyId);
    if (!settled) {
      setState(IDLE_STATE);
      manageTick(false);
      return;
    }
    const frontier = await loadGalleryImportFrontier(userId, familyId);
    const allChunksSettled = settled.chunks.every((chunk) => chunk.status === 'dispatched' || chunk.status === 'abandoned');
    const moreHistory = !frontier?.completedLibrary && frontier?.autoContinue !== false;
    if (allChunksSettled && !moreHistory) {
      setState({ phase: 'done', isActive: false, pausedUntil: null });
      manageTick(false);
    } else {
      // Either genuinely unsettled work remains (should be rare -- a normal
      // pass processes to completion or a defined pause), or more history is
      // still there to sweep on a later window -- keep ticking.
      setState({ phase: 'idle', isActive: false, pausedUntil: null });
      manageTick(true);
      // A pass_deadline result (the 5-minute preparation budget ran out with
      // real chunk work still unsettled) means there is more to do RIGHT
      // NOW, not merely "check back on the next 60s tick" -- queue an
      // immediate follow-up kick. Coalesces naturally with the pending-kick
      // drain in the outer finally below since isKicking is still true here.
      if (result?.reason === 'pass_deadline' && !allChunksSettled) {
        kickGalleryImportDriver('pass-continue');
      }
    }
  } catch (error) {
    const runner = loadRunner();
    if (error instanceof runner.GalleryImportWaitingForWifiError) {
      setState({ phase: 'waiting_wifi', isActive: false });
      manageTick(true);
    } else if (error instanceof runner.GalleryImportFairUsePausedError) {
      setState({ phase: 'paused_fair_use', pausedUntil: error.pausedUntil, isActive: false });
      manageTick(true);
    } else {
      // Content-free per CLAUDE.md -- galleryImportRunnerErrorMessage never
      // surfaces memory content, only a static or content-free message.
      setState({ phase: 'error', lastError: runner.galleryImportRunnerErrorMessage(error), isActive: false });
      scheduleAutomaticRetry();
      manageTick(true);
    }
  } finally {
    isKicking = false;
    if (pendingKickReason) {
      const reason = pendingKickReason;
      const nextOpts = pendingKickOpts;
      pendingKickReason = null;
      pendingKickOpts = {};
      kickGalleryImportDriver(reason, nextOpts);
    }
  }
}

/**
 * Persists the progress screen's "Stop looking for more" choice onto the
 * per-user+family frontier (S8's `autoContinue`). A no-op when no frontier
 * exists yet (nothing has registered a first window for this family) --
 * there is nothing to stop extending.
 */
export async function setGalleryImportAutoContinue(userId: string, familyId: string, value: boolean): Promise<void> {
  const existing = await loadGalleryImportFrontier(userId, familyId);
  if (!existing) return;
  await saveGalleryImportFrontier(userId, familyId, { ...existing, autoContinue: value });
}

/**
 * Wires the driver to real app-lifecycle signals. Idempotent and safe to
 * call from multiple hook mounts (a real app only ever mounts
 * `useGalleryImportDriver()` once, at the root layout, but tests and any
 * future second mount must not double-subscribe). Never torn down: the root
 * layout lives for the whole authenticated session.
 */
export function startGalleryImportDriverListeners(): void {
  if (listenersStarted) return;
  listenersStarted = true;
  AppState.addEventListener('change', (nextState: AppStateStatus) => {
    if (nextState === 'active') kickGalleryImportDriver('app-active');
  });
  NetInfo.addEventListener(() => kickGalleryImportDriver('netinfo-change'));
}

/** Test-only: resets every module-level singleton to its initial state.
 * Never called from production code -- the driver is a real long-lived
 * singleton there. */
export function resetGalleryImportDriverForTests(): void {
  state = IDLE_STATE;
  listeners.clear();
  contextUserId = null;
  contextFamilyId = null;
  isKicking = false;
  pendingKickReason = null;
  pendingKickOpts = {};
  backoffMs = BACKOFF_INITIAL_MS;
  clearBackoffTimer();
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  listenersStarted = false;
}
