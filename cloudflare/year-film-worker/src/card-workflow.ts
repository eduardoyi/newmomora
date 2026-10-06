// HolidayCardWorkflow (docs/plans/holiday-cards-p1.md Step 4b): one instance
// per card generation attempt (instance id = attempt id). Front picks first
// (the film closes on them), then the card's film (floors -> create film row
// -> claim -> start YearFilmWorkflow directly), then the letters from the pool
// digest (no wait for the film), then `ready`. Rules (same as YearFilmWorkflow):
// - step outputs are ids / numbers / states only (no memory text, no keys,
//   no model text);
// - every step is idempotent and heartbeats the card lease through the
//   bridge; a deleted or superseded attempt stops quietly (NonRetryableError
//   `stopped:<state>`), it never marks the card failed;
// - every paid call records its usage through the bridge with a deterministic
//   ai_call_id, so a replayed step never double-records;
// - logs and persisted errors carry ids and closed codes only.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import imageSize from 'image-size';
import { FRONT_JUDGE_BATCH, type FrontVerdict } from '../../../supabase/functions/_shared/holiday-card-photos.ts';
import { chunk, type ImageSizeParser } from '../../../supabase/functions/_shared/holiday-card-generate-ports.ts';
import { AttemptStopped, createCardBridge } from './bridge';
import {
  cardFailed,
  cardInit,
  cardReady,
  type CardStageDeps,
  filmClaim,
  filmSetup,
  filmStart,
  FILM_CLOSE_PICKS,
  frontJudge,
  frontPlan,
  frontProbe,
  frontSelect,
  frontStore,
  LETTER_ATTEMPTS,
  lettersPrepare,
  lettersWrite,
  PROBE_STEP_PHOTOS,
} from './card-stages';
import { createChat } from './openai';
import { createImageReader, createStorage } from './storage';
import type { CardFailureCode, CardGeneratePayload, Env } from './types';
import { startFilmWorkflow } from './util';
import { guard } from './workflow';

const STEP = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '10 minutes' } as const;
const PAID_STEP = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '20 minutes' } as const;

class StageFailure extends Error {
  constructor(readonly code: CardFailureCode) {
    super(code);
  }
}

/** image-size (header parser) as the ImageSizeParser port; a truncated header throws or yields no size. */
const parseImageSize: ImageSizeParser = (bytes) => {
  const { width, height, orientation } = imageSize(bytes);
  return { width, height, orientation };
};

export type CardOutcome =
  | { outcome: 'ready'; film: 'none' | 'started' | 'queued' | 'claimed_elsewhere' }
  | { outcome: 'stopped' }
  | { outcome: 'failed'; code: CardFailureCode };

/** The whole generation, over injectable deps and a `step` (the class below
 * passes the real ones; tests pass fakes). */
export async function runCardGeneration(deps: CardStageDeps, step: WorkflowStep): Promise<CardOutcome> {
  let phase: CardFailureCode = 'CONTEXT_LOAD_FAILED';
  let prefix: string | null = null;
  try {
    const init = await step.do('init', STEP, guard(() => cardInit(deps)));

    // 1. Front picks. A ranged dimension probe in chunks of PROBE_STEP_PHOTOS,
    // then one vision-judge step per batch (numbers in card-stages.ts).
    phase = 'FRONT_PICK_FAILED';
    const plan = await step.do('front:plan', STEP, guard(() => frontPlan(deps, init)));
    const dims: Record<string, [number, number]> = {};
    for (let i = 0; i * PROBE_STEP_PHOTOS < plan.probeIds.length; i += 1) {
      const ids = plan.probeIds.slice(i * PROBE_STEP_PHOTOS, (i + 1) * PROBE_STEP_PHOTOS);
      Object.assign(dims, await step.do(`front:probe:${i}`, STEP, guard(() => frontProbe(deps, ids))));
    }
    const selection = await step.do('front:select', STEP, guard(() => frontSelect(deps, init, { count: plan.probeIds.length, dims })));
    const verdicts: [string, FrontVerdict][] = [];
    const batches = chunk(selection.candidates, FRONT_JUDGE_BATCH);
    for (let i = 0; i < batches.length; i += 1) {
      const judged = await step.do(`front:judge:${i}`, PAID_STEP, guard(() => frontJudge(deps, batches[i], i)));
      verdicts.push(...judged.verdicts);
    }
    const front = await step.do('front:store', STEP, guard(() => frontStore(deps, init, selection, verdicts)));

    // 2. The film: below the floors there is no film row (and no QR).
    phase = 'FILM_SETUP_FAILED';
    const film = await step.do('film:setup', STEP, guard(() => filmSetup(deps, init, front.pickIds.slice(0, FILM_CLOSE_PICKS))));
    let filmOutcome: 'none' | 'started' | 'queued' | 'claimed_elsewhere' = 'none';
    if (film.filmId) {
      const claim = await step.do('film:claim', STEP, guard(() => filmClaim(deps)));
      if (claim.filmAttemptId) {
        const claimedAttempt = claim.filmAttemptId;
        const started = await step.do('film:start', STEP, guard(() => filmStart(deps, claim.filmId, claimedAttempt)));
        filmOutcome = started.started ? 'started' : 'queued'; // queued: the hourly cron dispatches it
      } else {
        filmOutcome = 'claimed_elsewhere';
      }
    }

    // 3. Letters from the pool digest: `filmPresent` = the film exists.
    phase = 'LETTERS_FAILED';
    const filmPresent = film.filmId !== null;
    const prepared = await step.do('letters:prepare', PAID_STEP, guard(() => lettersPrepare(deps, init, filmPresent)));
    prefix = prepared.prefix;
    const storedPrefix = prepared.prefix;
    let saved = false;
    for (let attempt = 0; attempt < LETTER_ATTEMPTS && !saved; attempt += 1) {
      const written = await step.do(`letters:write:${attempt}`, PAID_STEP, guard(() => lettersWrite(deps, init, filmPresent, storedPrefix, attempt)));
      saved = written.saved;
      if (!saved && !written.retryable) break;
    }
    if (!saved) throw new StageFailure('NO_LETTERS');

    // 4. Ready (the film keeps rendering on its own).
    await step.do('finish', STEP, guard(() => cardReady(deps, storedPrefix)));
    return { outcome: 'ready', film: filmOutcome };
  } catch (error) {
    const stopped = error instanceof AttemptStopped || (error instanceof Error && error.message.includes('stopped:'));
    const code: CardFailureCode = error instanceof StageFailure ? error.code : phase;
    const cleanupPrefix = prefix;
    await step.do('abort:cleanup', STEP, async () => {
      // A stopped attempt no longer owns the card: only its files go.
      if (stopped) {
        if (cleanupPrefix) await deps.storage.deletePrefix(cleanupPrefix);
        return { cleaned: true };
      }
      return await cardFailed(deps, cleanupPrefix, code);
    });
    if (stopped) return { outcome: 'stopped' };
    console.error('holiday card generation failed', { cardId: deps.cardId, code });
    return { outcome: 'failed', code };
  }
}

export class HolidayCardWorkflow extends WorkflowEntrypoint<Env, CardGeneratePayload> {
  private deps(cardId: string, attemptId: string): CardStageDeps {
    return {
      cardId,
      attemptId,
      bridge: createCardBridge(this.env, cardId, attemptId),
      storage: createStorage(this.env.FILM_BUCKET),
      images: createImageReader(this.env.FILM_BUCKET),
      imageSize: parseImageSize,
      chat: createChat(this.env.OPENAI_API_KEY),
      // Directly through the binding (no HTTP), exactly like /dispatch.
      startFilm: (filmId, filmAttemptId) => startFilmWorkflow(this.env.YEAR_FILM_WORKFLOW, filmId, filmAttemptId),
      now: () => new Date(),
    };
  }

  async run(event: WorkflowEvent<CardGeneratePayload>, step: WorkflowStep): Promise<unknown> {
    const { cardId, attemptId } = event.payload;
    return runCardGeneration(this.deps(cardId, attemptId), step);
  }
}
