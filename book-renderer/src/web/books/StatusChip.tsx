import type { MemoryBookStatus } from '../types';

const LABELS: Record<MemoryBookStatus, string> = {
  queued: 'Queued',
  generating: 'Generating…',
  ready: 'Ready',
  failed: 'Failed',
};

export function StatusChip({ status }: { status: MemoryBookStatus }) {
  return <span className={`status-chip status-chip--${status}`}>{LABELS[status]}</span>;
}
