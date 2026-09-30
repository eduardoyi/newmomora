import {
  nextSceneTarget,
  parseFilmScenes,
  previousSceneTarget,
  sceneFill,
  sceneIndexAt,
  singleFilmScene,
} from '@/utils/year-film-scenes';

const scenes = [
  { id: 'a', startMs: 0, durationMs: 3000 },
  { id: 'b', startMs: 3000, durationMs: 4000 },
  { id: 'c', startMs: 7000, durationMs: 2000 },
];

describe('parseFilmScenes', () => {
  it('reads the scenes.json shape, sorted by start', () => {
    const parsed = parseFilmScenes({
      version: 1,
      durationMs: 9000,
      scenes: [
        { id: 'b', type: 'montage', role: 'body', startMs: 3000, durationMs: 4000 },
        { id: 'a', type: 'title', role: 'open', startMs: 0, durationMs: 3000 },
      ],
    });

    expect(parsed).toEqual([
      { id: 'a', startMs: 0, durationMs: 3000 },
      { id: 'b', startMs: 3000, durationMs: 4000 },
    ]);
  });

  it('drops malformed entries and returns null when nothing usable is left', () => {
    expect(parseFilmScenes({ scenes: [{ id: 'x', startMs: -1, durationMs: 10 }, { startMs: 0, durationMs: 0 }, null] })).toBeNull();
    expect(parseFilmScenes({ scenes: 'nope' })).toBeNull();
    expect(parseFilmScenes(null)).toBeNull();
    expect(parseFilmScenes({ scenes: [{ startMs: 0, durationMs: 100 }] })).toEqual([
      { id: 'scene-0', startMs: 0, durationMs: 100 },
    ]);
  });
});

describe('scene lookup', () => {
  it('finds the scene containing a position', () => {
    expect(sceneIndexAt(scenes, 0)).toBe(0);
    expect(sceneIndexAt(scenes, 2999)).toBe(0);
    expect(sceneIndexAt(scenes, 3000)).toBe(1);
    expect(sceneIndexAt(scenes, 99_000)).toBe(2);
  });

  it('computes a clamped 0..1 fill', () => {
    expect(sceneFill(scenes, 1, 3000)).toBe(0);
    expect(sceneFill(scenes, 1, 5000)).toBe(0.5);
    expect(sceneFill(scenes, 1, 8000)).toBe(1);
    expect(sceneFill(scenes, 9, 8000)).toBe(0);
  });

  it('falls back to one whole-film segment', () => {
    expect(singleFilmScene(60_000)).toEqual([{ id: 'film', startMs: 0, durationMs: 60_000 }]);
    expect(singleFilmScene(null)[0]?.durationMs).toBeGreaterThan(0);
  });
});

describe('tap targets', () => {
  it('next goes to the next scene start, then to the end', () => {
    expect(nextSceneTarget(scenes, 500)).toEqual({ kind: 'seek', ms: 3000 });
    expect(nextSceneTarget(scenes, 7500)).toEqual({ kind: 'end' });
  });

  it('previous restarts a scene that has played a while, else goes to the one before', () => {
    expect(previousSceneTarget(scenes, 5500)).toEqual({ kind: 'seek', ms: 3000 });
    expect(previousSceneTarget(scenes, 3400)).toEqual({ kind: 'seek', ms: 0 });
    expect(previousSceneTarget(scenes, 200)).toEqual({ kind: 'seek', ms: 0 });
  });
});
