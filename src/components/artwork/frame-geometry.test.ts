import {
  artWidthForFrameWidth,
  edgePeriods,
  frameMetrics,
  framePaths,
  framePathsCacheSize,
  type FrameKind,
} from '@/components/artwork/frame-geometry';
import { FRAME_KINDS } from '@/components/artwork/frame-style';

// Endpoints (and the x/y extremes) of an SVG path built from M L H V A C Z.
// Arc bulges and curve controls are not included: the silhouette extremes
// the tests care about sit on endpoints or on the corner circles.
function pathEndpoints(d: string): [number, number][] {
  const tokens = d.match(/[MLHVACZ]|-?\d*\.?\d+/g) ?? [];
  const points: [number, number][] = [];
  let i = 0;
  let x = 0;
  let y = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') {
      x = num();
      y = num();
    } else if (cmd === 'H') {
      x = num();
    } else if (cmd === 'V') {
      y = num();
    } else if (cmd === 'A') {
      i += 5; // rx ry rotation large sweep
      x = num();
      y = num();
    } else if (cmd === 'C') {
      i += 4; // two control points
      x = num();
      y = num();
    } else if (cmd === 'Z') {
      continue;
    }
    points.push([x, y]);
  }
  return points;
}

function silhouetteBounds(kind: FrameKind, artW: number, artH: number) {
  const paths = framePaths(kind, frameMetrics(artW, artH));
  const pts = pathEndpoints(paths.outerPath);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  for (const c of paths.corners) {
    xs.push(c.x - c.r, c.x + c.r);
    ys.push(c.y - c.r, c.y + c.r);
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

const SIZES: [number, number][] = [
  [196, 296],
  [250, 188],
  [120, 120],
  [64, 90],
  [310, 207],
];

describe('frameMetrics', () => {
  it('uses the canvas formulas', () => {
    expect(frameMetrics(220, 332)).toEqual({
      band: 26, // round(220 * 0.12)
      mat: 19, // round(220 * 0.085)
      amp: 11, // round(26 * 0.42)
      artW: 220,
      artH: 332,
      inset: 45,
      w: 310,
      h: 422,
    });
  });

  it('floors the band and mat on small art', () => {
    const m = frameMetrics(40, 60);
    expect(m.band).toBe(16);
    expect(m.mat).toBe(10);
    expect(m.amp).toBe(7);
  });

  it('measures from the shorter side', () => {
    expect(frameMetrics(300, 100).band).toBe(16);
    expect(frameMetrics(100, 300).band).toBe(16);
    expect(frameMetrics(300, 300).band).toBe(36);
  });
});

describe('framePaths', () => {
  it.each(FRAME_KINDS)('%s returns closed paths', (kind) => {
    for (const [artW, artH] of SIZES) {
      const paths = framePaths(kind, frameMetrics(artW, artH));
      for (const d of [paths.outerPath, paths.bodyPath, paths.matPath, paths.lipPath]) {
        expect(d.startsWith('M')).toBe(true);
        expect(d.trim().endsWith('Z')).toBe(true);
        expect(d).not.toMatch(/NaN|undefined|Infinity/);
      }
      if (paths.outlinePath) {
        expect(paths.outlinePath.trim().endsWith('Z')).toBe(true);
      }
    }
  });

  it.each(FRAME_KINDS)('%s outer box equals the frame box', (kind) => {
    for (const [artW, artH] of SIZES) {
      const { w, h } = frameMetrics(artW, artH);
      const b = silhouetteBounds(kind, artW, artH);
      expect(b.minX).toBeCloseTo(0, 0);
      expect(b.minY).toBeCloseTo(0, 0);
      expect(b.maxX).toBeCloseTo(w, 0);
      expect(b.maxY).toBeCloseTo(h, 0);
    }
  });

  it('opens the mat exactly where the art goes (rect kinds)', () => {
    const m = frameMetrics(196, 296);
    const paths = framePaths('scallop', m);
    expect(paths.matPath).toBe(`M${m.band} ${m.band} H${m.w - m.band} V${m.h - m.band} H${m.band} Z`);
  });

  it('only scallop and wavy get corner circles; the rest have none', () => {
    const m = frameMetrics(196, 296);
    expect(framePaths('scallop', m).corners).toHaveLength(4);
    expect(framePaths('wavy', m).corners).toHaveLength(4);
    for (const kind of ['gingham', 'ricrac', 'bobble', 'chunky'] as const) {
      expect(framePaths(kind, m).corners).toHaveLength(0);
    }
    for (const c of framePaths('scallop', m).corners) {
      expect(c.r).toBe(m.amp);
    }
  });

  it('merges the corner circles into the body path as extra closed subpaths', () => {
    const m = frameMetrics(196, 296);
    const scallop = framePaths('scallop', m);
    expect((scallop.bodyPath.match(/Z/g) ?? []).length).toBe(1 + scallop.corners.length);
    const gingham = framePaths('gingham', m);
    expect(gingham.bodyPath).toBe(gingham.outerPath);
  });

  it('scallop and wavy periods divide each side evenly', () => {
    for (const [artW, artH] of SIZES) {
      const m = frameMetrics(artW, artH);
      const sides = [m.w - 2 * m.amp, m.h - 2 * m.amp];
      for (const period of [m.amp * 2, m.amp * 4.4, m.amp * 2.2]) {
        for (const length of sides) {
          const { n, per } = edgePeriods(length, period);
          expect(n).toBeGreaterThanOrEqual(1);
          expect(n * per).toBeCloseTo(length, 6);
          // Stretched, not wildly: within one period of the target.
          expect(Math.abs(per - period)).toBeLessThanOrEqual(period);
        }
      }
    }
  });

  it('emits one arc per scallop bump and the bump count follows the side length', () => {
    const m = frameMetrics(196, 296);
    const arcs = (framePaths('scallop', m).outerPath.match(/A/g) ?? []).length;
    const expected =
      2 * edgePeriods(m.w - 2 * m.amp, m.amp * 2).n + 2 * edgePeriods(m.h - 2 * m.amp, m.amp * 2).n;
    expect(arcs).toBe(expected);
  });

  it('bobble beads: sane counts, evenly inside the band, with highlights', () => {
    const m = frameMetrics(196, 296);
    const { beads, beadsPath, beadHighlightsPath } = framePaths('bobble', m);
    const perimeter = 2 * (m.w - m.band) + 2 * (m.h - m.band);
    const spacing = m.band * 0.31 * 2.3;
    expect(beads.length).toBeGreaterThan(perimeter / spacing - 4);
    expect(beads.length).toBeLessThan(perimeter / spacing + 4);
    for (const b of beads) {
      expect(b.x).toBeGreaterThanOrEqual(m.band / 2 - 0.1);
      expect(b.x).toBeLessThanOrEqual(m.w - m.band / 2 + 0.1);
      expect(b.y).toBeGreaterThanOrEqual(m.band / 2 - 0.1);
      expect(b.y).toBeLessThanOrEqual(m.h - m.band / 2 + 0.1);
      expect(b.r).toBeLessThan(m.band / 2);
      expect(b.hr).toBeLessThan(b.r);
    }
    expect((beadsPath.match(/Z/g) ?? []).length).toBe(beads.length);
    expect((beadHighlightsPath.match(/Z/g) ?? []).length).toBe(beads.length);
    expect(framePaths('scallop', m).beads).toHaveLength(0);
  });

  it('gingham gets a check pattern; other kinds do not', () => {
    const m = frameMetrics(220, 332);
    expect(framePaths('gingham', m).checkSize).toBe(Math.max(8, Math.round(m.band / 2.2)));
    expect(framePaths('gingham', m).bodyFill).toBe('gingham');
    expect(framePaths('scallop', m).checkSize).toBe(0);
  });

  it('chunky has a wavy inner mat edge and no lip; bobble sits on a cream band', () => {
    const m = frameMetrics(196, 296);
    const chunky = framePaths('chunky', m);
    expect(chunky.matPath).toContain('C');
    expect(chunky.lipTone).toBe('none');
    expect(framePaths('bobble', m).bodyFill).toBe('cream');
  });

  it('memoizes by (kind, artW, artH)', () => {
    const a = framePaths('wavy', frameMetrics(321, 123));
    const b = framePaths('wavy', frameMetrics(321, 123));
    expect(b).toBe(a);
    expect(framePaths('ricrac', frameMetrics(321, 123))).not.toBe(a);
    expect(framePaths('wavy', frameMetrics(322, 123))).not.toBe(a);
  });

  it('keeps the memo cache bounded', () => {
    for (let i = 0; i < 400; i += 1) {
      framePaths('scallop', frameMetrics(100 + i, 150));
    }
    expect(framePathsCacheSize()).toBeLessThanOrEqual(128);
  });

  it('keeps path data compact (no per-pixel sampling)', () => {
    const m = frameMetrics(250, 380);
    for (const kind of FRAME_KINDS) {
      expect(framePaths(kind, m).bodyPath.length).toBeLessThan(2500);
    }
  });
});

describe('artWidthForFrameWidth', () => {
  it('fits the frame within the requested width, within a few px of it', () => {
    for (const width of [200, 258, 310, 358, 420]) {
      for (const ratio of [0.5, 0.75, 1, 4 / 3, 1.78]) {
        const artW = artWidthForFrameWidth(width, ratio);
        const m = frameMetrics(artW, Math.round(artW / ratio));
        expect(m.w).toBeLessThanOrEqual(width);
        expect(m.w).toBeGreaterThan(width - 6);
      }
    }
  });
});
