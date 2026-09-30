// YearFilmWorkflow (docs/plans/year-film-p1.md Step 5): thumbs → quote →
// claims → build → prepare → voice/frame checks → film.json → render slot →
// render → publish. Rules:
// - step outputs are ids/states/counts only (no memory text, no keys);
// - deadlines are poll counts, never Date.now() at run-body level;
// - every paid call persists its verdict before the step returns;
// - any stop (superseded / epoch changed / disabled) or failure destroys
//   the machines this attempt created and ends the cycle with a closed code.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { AttemptStopped, createBridge } from './bridge';
import { createFly, FlyCapacityError } from './fly';
import { dispatchJitterSeconds } from './jitter';
import { createChat } from './openai';
import { mintMachineCredentials } from './r2creds';
import {
  buildAndSave,
  claimRenderSlot,
  pickQuote,
  type PollState,
  pollFailureCode,
  pollMachine,
  publish,
  runClaimChecks,
  runFrameChecks,
  runVoiceChecks,
  type StageDeps,
  startPrepare,
  startRender,
  startThumbs,
  writeFilmJson,
} from './stages';
import { createStorage } from './storage';
import type { DispatchPayload, Env, FailureCode } from './types';

const POLL_SECONDS = 20;
const POLLS: Record<'thumbs' | 'prepare' | 'render', number> = { thumbs: 30, prepare: 60, render: 90 }; // 10 / 20 / 30 min
const SLOT_WAITS = 72; // × 5 min = 6 h
const STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '10 minutes' } as const;
const PAID_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '15 minutes' } as const;

/** A stop (superseded / epoch changed / disabled) must not be retried: it
 * surfaces as a non-retryable `stopped:<state>` error (instanceof doesn't
 * survive a step's serialization). */
function guard<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AttemptStopped) throw new NonRetryableError(`stopped:${error.state}`);
      throw error;
    }
  };
}

class StageFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}

export class YearFilmWorkflow extends WorkflowEntrypoint<Env, DispatchPayload> {
  private deps(filmId: string, attemptId: string): StageDeps {
    return {
      filmId,
      attemptId,
      bridge: createBridge(this.env, filmId, attemptId),
      storage: createStorage(this.env.FILM_BUCKET),
      chat: createChat(this.env.OPENAI_API_KEY),
      fly: createFly({
        token: this.env.FLY_API_TOKEN,
        app: this.env.FLY_APP,
        image: this.env.FILM_RENDERER_IMAGE,
        regions: this.env.FLY_REGIONS.split(',').map((r) => r.trim()).filter(Boolean),
      }),
      mintCredentials: (input) => mintMachineCredentials(this.env, input),
    };
  }

  private async poll(
    step: WorkflowStep,
    deps: StageDeps,
    mode: 'thumbs' | 'prepare' | 'render',
    statusKey: string,
    machineId: string,
  ): Promise<void> {
    for (let i = 0; i < POLLS[mode]; i += 1) {
      const state: PollState = await step.do(`${mode}:poll:${i}`, STEP, guard(() => pollMachine(deps, statusKey, machineId, null)));
      if (state === 'done') return;
      const failure = pollFailureCode(state);
      if (failure) throw new StageFailure(failure);
      await step.sleep(`${mode}:wait:${i}`, `${POLL_SECONDS} seconds`);
    }
    throw new StageFailure('MACHINE_TIMEOUT');
  }

  /** Durable, deterministic 0-45 s pause before a machine is created, so a
   * batch of films doesn't start a burst of machines in the same second. */
  private async jitter(step: WorkflowStep, attemptId: string, mode: 'thumbs' | 'prepare' | 'render'): Promise<void> {
    const seconds = dispatchJitterSeconds(attemptId, mode);
    if (seconds > 0) await step.sleep(`${mode}:jitter`, `${seconds} seconds`);
  }

  async run(event: WorkflowEvent<DispatchPayload>, step: WorkflowStep): Promise<unknown> {
    const { filmId, attemptId } = event.payload;
    const deps = this.deps(filmId, attemptId);
    const machines: string[] = [];
    let prefix: string | null = null;

    try {
      await this.jitter(step, attemptId, 'thumbs');
      const thumbs = await step.do('curate:thumbs', STEP, guard(() => startThumbs(deps)));
      if (thumbs.skipped) return { outcome: 'skipped' };
      prefix = thumbs.prefix;
      if (thumbs.machineId) {
        machines.push(thumbs.machineId);
        await this.poll(step, deps, 'thumbs', `${prefix}thumbs/status.json`, thumbs.machineId);
      }

      await step.do('curate:quote', PAID_STEP, guard(() => pickQuote(deps)));
      await step.do('curate:claims', PAID_STEP, guard(() => runClaimChecks(deps)));
      const built = await step.do('curate:build', STEP, guard(() => buildAndSave(deps)));
      if (!built.saved) return { outcome: 'skipped' };

      await this.jitter(step, attemptId, 'prepare');
      const prepare = await step.do('prepare:start', STEP, guard(() => startPrepare(deps, prefix!)));
      machines.push(prepare.machineId);
      await this.poll(step, deps, 'prepare', `${prefix}prep/status.json`, prepare.machineId);

      for (let i = 0; i < 4; i += 1) {
        const voice = await step.do(`checks:voice:${i}`, PAID_STEP, guard(() => runVoiceChecks(deps, prefix!)));
        if (voice.done) break;
        if (i === 3) throw new StageFailure('CHECKS_FAILED');
      }
      for (let i = 0; i < 4; i += 1) {
        const frames = await step.do(`checks:frames:${i}`, PAID_STEP, guard(() => runFrameChecks(deps, prefix!)));
        if (frames.done) break;
        if (i === 3) throw new StageFailure('CHECKS_FAILED');
      }
      await step.do('checks:film-json', STEP, guard(() => writeFilmJson(deps, prefix!)));

      let slot = false;
      for (let i = 0; i < SLOT_WAITS && !slot; i += 1) {
        slot = (await step.do(`render:slot:${i}`, STEP, guard(() => claimRenderSlot(deps)))) === 'ok';
        if (!slot) await step.sleep(`render:slot-wait:${i}`, '5 minutes');
      }
      if (!slot) throw new StageFailure('RENDER_QUEUE_TIMEOUT');

      await this.jitter(step, attemptId, 'render');
      const render = await step.do('render:start', STEP, guard(() => startRender(deps, prefix!)));
      machines.push(render.machineId);
      await this.poll(step, deps, 'render', `${prefix}status.json`, render.machineId);

      const published = await step.do('publish', STEP, guard(async () => {
        try {
          return await publish(deps, prefix!);
        } catch (error) {
          if (error instanceof AttemptStopped) throw error;
          // Response lost or ambiguous: ask the database what happened.
          const reconciled = await deps.bridge.call<{ outcome: string }>('reconcile');
          if (reconciled.outcome === 'succeeded') return { ok: true };
          throw error;
        }
      }));
      return { outcome: published.ok ? 'ready' : published.reason ?? 'not_published' };
    } catch (error) {
      const stopped = error instanceof AttemptStopped ||
        (error instanceof Error && error.message.includes('stopped:'));
      const code: FailureCode = error instanceof StageFailure
        ? error.code
        : error instanceof FlyCapacityError
        ? 'MACHINE_FAILED'
        : 'UNKNOWN_ERROR';
      await step.do('abort:cleanup', STEP, async () => {
        for (const id of machines) await deps.fly.destroy(id);
        if (prefix) await deps.storage.deletePrefix(prefix);
        try {
          await deps.bridge.call('end_cycle', stopped ? { outcome: 'aborted', code: 'ATTEMPT_STOPPED' } : { outcome: 'failed', code });
        } catch (e) {
          if (!(e instanceof AttemptStopped)) throw e;
        }
        return { cleaned: true };
      });
      if (!stopped) console.error('year film attempt failed', { filmId, code });
      return { outcome: stopped ? 'stopped' : 'failed', code };
    }
  }
}
