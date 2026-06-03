export const ILLUSTRATION_GENERATION_STALE_MS = 3 * 60 * 1000;

export function isIllustrationGenerationStale(
  status: string,
  updatedAtIso: string,
  now = Date.now(),
): boolean {
  if (status !== 'generating') {
    return false;
  }

  const updatedAt = new Date(updatedAtIso).getTime();
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return now - updatedAt >= ILLUSTRATION_GENERATION_STALE_MS;
}
