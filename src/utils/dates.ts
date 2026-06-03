const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseIsoDate(isoDate: string): Date | null {
  const trimmed = isoDate.trim();

  if (!ISO_DATE_PATTERN.test(trimmed)) {
    return null;
  }

  const parsed = new Date(`${trimmed}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export function formatIsoDateForDisplay(isoDate: string): string {
  const parsed = parseIsoDate(isoDate);

  if (!parsed) {
    return isoDate;
  }

  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function todayIsoDate(): string {
  return toIsoDate(new Date());
}
