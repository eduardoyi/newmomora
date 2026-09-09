import { describe, expect, it } from 'vitest';
import {
  PROGRESS_STEPS,
  currentProgressStepIndex,
  progressStepState,
  showsProgressStepper,
} from '../orderProgressSteps';
import type { MemoryBookOrderStatus } from '../../types';

const STEP_STATUSES: MemoryBookOrderStatus[] = ['paid', 'rendering', 'submitted', 'in_production', 'shipped', 'delivered'];
const NON_STEP_STATUSES: MemoryBookOrderStatus[] = ['draft', 'quoted', 'failed', 'cancelled'];

describe('showsProgressStepper', () => {
  it('is true for every paid-through-delivered status when not refunded', () => {
    for (const status of STEP_STATUSES) {
      expect(showsProgressStepper(status, null)).toBe(true);
    }
  });

  it('is false for draft/quoted/failed/cancelled regardless of refund state', () => {
    for (const status of NON_STEP_STATUSES) {
      expect(showsProgressStepper(status, null)).toBe(false);
      expect(showsProgressStepper(status, '2026-09-09T00:00:00Z')).toBe(false);
    }
  });

  it('is false once refunded_at is set, even for an otherwise in-flight status (task: refunded groups with failed/cancelled)', () => {
    for (const status of STEP_STATUSES) {
      expect(showsProgressStepper(status, '2026-09-09T00:00:00Z')).toBe(false);
    }
  });
});

describe('PROGRESS_STEPS', () => {
  it('has exactly the six steps the task specifies, in order, with the task-exact time hints', () => {
    expect(PROGRESS_STEPS.map((s) => s.key)).toEqual([
      'paid',
      'rendering',
      'submitted',
      'in_production',
      'shipped',
      'delivered',
    ]);
    expect(PROGRESS_STEPS.find((s) => s.key === 'rendering')?.hint).toBe('about 10 minutes');
    expect(PROGRESS_STEPS.find((s) => s.key === 'in_production')?.hint).toBe('4–6 days');
  });
});

describe('currentProgressStepIndex', () => {
  it('maps each stepper status to its position', () => {
    STEP_STATUSES.forEach((status, i) => {
      expect(currentProgressStepIndex(status)).toBe(i);
    });
  });

  it('returns -1 for a non-stepper status', () => {
    expect(currentProgressStepIndex('draft')).toBe(-1);
    expect(currentProgressStepIndex('failed')).toBe(-1);
  });
});

describe('progressStepState', () => {
  it('marks steps before the current index done, the current index current, and later ones upcoming', () => {
    const currentIndex = currentProgressStepIndex('in_production');
    expect(progressStepState(0, currentIndex, 'in_production')).toBe('done'); // paid
    expect(progressStepState(1, currentIndex, 'in_production')).toBe('done'); // rendering
    expect(progressStepState(2, currentIndex, 'in_production')).toBe('done'); // submitted
    expect(progressStepState(3, currentIndex, 'in_production')).toBe('current'); // in_production
    expect(progressStepState(4, currentIndex, 'in_production')).toBe('upcoming'); // shipped
    expect(progressStepState(5, currentIndex, 'in_production')).toBe('upcoming'); // delivered
  });

  it('treats delivered as fully done -- nothing pulses once the book has arrived', () => {
    const currentIndex = currentProgressStepIndex('delivered');
    for (let i = 0; i < PROGRESS_STEPS.length; i++) {
      expect(progressStepState(i, currentIndex, 'delivered')).toBe('done');
    }
  });
});
