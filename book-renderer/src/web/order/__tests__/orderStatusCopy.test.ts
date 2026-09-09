import { describe, expect, it } from 'vitest';
import { isTerminalOrderStatus, orderStatusCopy, TERMINAL_ORDER_STATUSES } from '../orderStatusCopy';
import type { MemoryBookOrderStatus } from '../../types';

const ALL_STATUSES: MemoryBookOrderStatus[] = [
  'draft',
  'quoted',
  'paid',
  'rendering',
  'submitted',
  'in_production',
  'shipped',
  'delivered',
  'failed',
  'cancelled',
];

describe('orderStatusCopy', () => {
  it('has copy for every status in the state machine', () => {
    for (const status of ALL_STATUSES) {
      const copy = orderStatusCopy(status);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.message.length).toBeGreaterThan(0);
      expect(['positive', 'neutral', 'negative']).toContain(copy.tone);
    }
  });

  it('uses the task-required exact failed copy', () => {
    expect(orderStatusCopy('failed').message).toBe(
      "Something went wrong on our side — we're fixing it or refunding you.",
    );
    expect(orderStatusCopy('failed').tone).toBe('negative');
  });

  it('never mentions tracking inline for shipped -- tracking is its own dedicated CTA on OrderStatusScreen, not baked into this sentence', () => {
    expect(orderStatusCopy('shipped').message.toLowerCase()).not.toContain('tracking');
  });
});

describe('isTerminalOrderStatus', () => {
  it('is terminal only for delivered/failed/cancelled', () => {
    expect(TERMINAL_ORDER_STATUSES.size).toBe(3);
    for (const status of ALL_STATUSES) {
      const expected = status === 'delivered' || status === 'failed' || status === 'cancelled';
      expect(isTerminalOrderStatus(status)).toBe(expected);
    }
  });

  it('treats refunded_at as independent of status (not modeled here at all)', () => {
    // orderStatusCopy/isTerminalOrderStatus take only `status` -- refunded_at
    // is rendered separately by OrderStatusScreen, exactly because the docs
    // define it as independent of the state machine.
    expect(isTerminalOrderStatus('shipped')).toBe(false);
  });
});
