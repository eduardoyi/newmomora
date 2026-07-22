export const ILLUSTRATION_GENERATION_STALE_MS = 3 * 60 * 1000;

export function isIllustrationGenerationStale(
  status: string,
  updatedAtIso: string,
  generationStartedAtIsoOrNow?: string | null | number,
  now = Date.now(),
): boolean {
  if (status !== 'generating') {
    return false;
  }

  // Preserve the historic three-argument test/helper form where the third
  // argument was `now`, while allowing the dedicated generation clock.
  if (typeof generationStartedAtIsoOrNow === 'number') now = generationStartedAtIsoOrNow;
  const generationStartedAt = typeof generationStartedAtIsoOrNow === 'string'
    ? new Date(generationStartedAtIsoOrNow).getTime()
    : Number.NaN;
  const updatedAt = new Date(updatedAtIso).getTime();
  const clock = Number.isNaN(generationStartedAt) ? updatedAt : generationStartedAt;
  if (Number.isNaN(clock)) {
    return false;
  }

  return now - clock >= ILLUSTRATION_GENERATION_STALE_MS;
}
