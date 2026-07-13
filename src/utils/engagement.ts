export function formatEngagementTimestamp(
  timestamp: string,
  now = new Date(),
): string {
  const date = new Date(timestamp);
  const elapsedMs = Math.max(0, now.getTime() - date.getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (elapsedMs < minute) return 'now';
  if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}m`;
  if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}h`;
  if (elapsedMs < 7 * day) return `${Math.floor(elapsedMs / day)}d`;

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  }).format(date);
}
