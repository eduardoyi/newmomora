// Pure helpers for the Year Film player's scene progress (docs/plans/
// year-film-p2.md Step 6). scenes.json (signed via `scenesUrl`) is
// `{ version: 1, durationMs, scenes: [{ id, type, role, startMs, durationMs }] }`.
// No React, no I/O -- unit-tested in year-film-scenes.test.ts.

export interface FilmScene {
  id: string;
  startMs: number;
  durationMs: number;
}

/** Fallback scene when scenes.json is missing/malformed: one segment for the whole film. */
export const SINGLE_SCENE_ID = 'film';

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validates a parsed scenes.json. Returns the scenes sorted by `startMs` and
 * clamped to be non-overlapping, or null when the shape is unusable (the
 * caller then shows a single segment).
 */
export function parseFilmScenes(json: unknown): FilmScene[] | null {
  if (!json || typeof json !== 'object') return null;
  const raw = (json as { scenes?: unknown }).scenes;
  if (!Array.isArray(raw)) return null;

  const scenes: FilmScene[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const { id, startMs, durationMs } = entry as Record<string, unknown>;
    if (!isFiniteNonNegative(startMs) || !isFiniteNonNegative(durationMs) || durationMs <= 0) return;
    scenes.push({ id: typeof id === 'string' && id ? id : `scene-${index}`, startMs, durationMs });
  });

  if (scenes.length === 0) return null;
  scenes.sort((a, b) => a.startMs - b.startMs);
  return scenes;
}

/** One segment covering the whole film (scenes.json missing or malformed). */
export function singleFilmScene(durationMs: number | null | undefined): FilmScene[] {
  return [{ id: SINGLE_SCENE_ID, startMs: 0, durationMs: durationMs && durationMs > 0 ? durationMs : 1 }];
}

/** Index of the scene containing `positionMs` (the last scene whose start is <= position). */
export function sceneIndexAt(scenes: readonly FilmScene[], positionMs: number): number {
  let index = 0;
  for (let i = 0; i < scenes.length; i += 1) {
    if (scenes[i]!.startMs <= positionMs) index = i;
    else break;
  }
  return index;
}

/** 0..1 fill of segment `index` at `positionMs`. */
export function sceneFill(scenes: readonly FilmScene[], index: number, positionMs: number): number {
  const scene = scenes[index];
  if (!scene) return 0;
  return Math.min(1, Math.max(0, (positionMs - scene.startMs) / scene.durationMs));
}

/** A left tap inside this much of a scene's start goes to the PREVIOUS scene;
 * later than that it restarts the current one (the stories convention). */
export const RESTART_SCENE_AFTER_MS = 1000;

export type SceneSeekTarget = { kind: 'seek'; ms: number } | { kind: 'end' };

/** Where a right tap goes: the next scene's start, or the end after the last scene. */
export function nextSceneTarget(scenes: readonly FilmScene[], positionMs: number): SceneSeekTarget {
  const index = sceneIndexAt(scenes, positionMs);
  const next = scenes[index + 1];
  return next ? { kind: 'seek', ms: next.startMs } : { kind: 'end' };
}

/** Where a left tap goes: the previous scene's start, or a restart of the current scene. */
export function previousSceneTarget(scenes: readonly FilmScene[], positionMs: number): SceneSeekTarget {
  const index = sceneIndexAt(scenes, positionMs);
  const current = scenes[index];
  if (!current) return { kind: 'seek', ms: 0 };
  if (index === 0 || positionMs - current.startMs > RESTART_SCENE_AFTER_MS) {
    return { kind: 'seek', ms: current.startMs };
  }
  return { kind: 'seek', ms: scenes[index - 1]!.startMs };
}
