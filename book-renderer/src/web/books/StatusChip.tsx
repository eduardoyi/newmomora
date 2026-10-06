import type { MemoryBookStatus } from '../types';

export const BOOK_STATUS_LABELS: Record<MemoryBookStatus, string> = {
  queued: 'Queued',
  generating: 'Generating…',
  ready: 'Ready',
  failed: 'Failed',
};

/** The chip's text for a book status (also used for the tile's aria-label). */
export function bookStatusLabel(status: MemoryBookStatus): string {
  return BOOK_STATUS_LABELS[status];
}

export function StatusChip({ status }: { status: MemoryBookStatus }) {
  return <span className={`status-chip status-chip--${status}`}>{BOOK_STATUS_LABELS[status]}</span>;
}
