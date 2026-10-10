// Pure geometry for the artwork frames (no React Native imports, so it is
// trivially unit-testable and safe to memoize). Ported from the approved
// design canvas (`Frame.dc.html`: `edgePath`, `roundRect`, the bead layout and
// the gingham pattern) -- same shapes, same constants.
//
// The only intentional difference from the canvas is HOW the wavy / scalloped /
// zig-zag edges are expressed: the canvas sampled them as a ~1.5px polyline
// (hundreds of points per frame). Each of those edges is analytic (a half
// ellipse, a half cosine, two straight runs), so we emit exact arcs / cubic
// curves / vertices instead. Same silhouette, a fraction of the path data,
// no faceting. Frames render inside a virtualized Timeline, so path size
// matters.
//
// Everything is in the frame's own coordinate space: the frame box is
// `w x h` with its origin at the top-left, the art opening is inset by
// `band + mat` on every side.

export type FrameKind = 'scallop' | 'gingham' | 'ricrac' | 'wavy' | 'bobble' | 'chunky';

export interface FrameMetrics {
  /** Decorative band thickness. */
  band: number;
  /** Cream mat thickness between the band and the art. */
  mat: number;
  /** Edge amplitude for the scalloped / wavy / zig-zag silhouettes. */
  amp: number;
  /** Art opening size. */
  artW: number;
  artH: number;
  /** `band + mat`: distance from the frame edge to the art opening. */
  inset: number;
  /** Outer frame box. */
  w: number;
  h: number;
}

export interface FrameCircle {
  x: number;
  y: number;
  r: number;
}

export interface FrameBead extends FrameCircle {
  /** Highlight dot. */
  hx: number;
  hy: number;
  hr: number;
}

/** How the body is filled. `color` = the frame color, `cream` = the cream band
 * (bobble, whose beads carry the color), `gingham` = the checked pattern. */
export type FrameBodyFill = 'color' | 'cream' | 'gingham';
export type FrameLipTone = 'light' | 'warm' | 'white' | 'none';
export type FrameOutlineTone = 'none' | 'warm' | 'color';

export interface FramePaths {
  kind: FrameKind;
  metrics: FrameMetrics;
  /** Outer silhouette (closed). */
  outerPath: string;
  /** Corner circles that fill the notches of the scalloped / wavy edges. */
  corners: FrameCircle[];
  /** `outerPath` + the corner circles as ONE closed path, all wound the same
   * way (clockwise) so a non-zero fill never punches a hole. This is what is
   * painted and what the cast shadow copies. */
  bodyPath: string;
  bodyFill: FrameBodyFill;
  /** Bobble beads, plus their combined path (one node instead of ~120). */
  beads: FrameBead[];
  beadsPath: string;
  beadHighlightsPath: string;
  /** Cream mat (a plain rectangle, or the wavy inner edge for chunky). */
  matPath: string;
  /** Hairline where the band meets the mat. */
  lipPath: string;
  lipTone: FrameLipTone;
  outlinePath: string | null;
  outlineTone: FrameOutlineTone;
  /** Gingham check size (px), 0 for the other kinds. */
  checkSize: number;
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10);
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function frameMetrics(artW: number, artH: number): FrameMetrics {
  const base = Math.min(artW, artH);
  const band = Math.max(16, Math.round(base * 0.12));
  const mat = Math.max(10, Math.round(base * 0.085));
  const amp = Math.round(band * 0.42);
  const inset = band + mat;
  return { band, mat, amp, artW, artH, inset, w: artW + 2 * inset, h: artH + 2 * inset };
}

/** Art width that makes the whole frame exactly (or just under) `frameWidth`
 * wide. The band / mat steps depend on the art size, so iterate to a fixed
 * point, then back off a pixel at a time if rounding left us over. */
export function artWidthForFrameWidth(frameWidth: number, aspectRatio: number): number {
  const ratio = aspectRatio > 0 ? aspectRatio : 1;
  let artW = Math.max(1, Math.floor(frameWidth * 0.75));
  for (let i = 0; i < 6; i += 1) {
    const m = frameMetrics(artW, Math.round(artW / ratio));
    const next = Math.max(1, Math.floor(frameWidth - 2 * m.inset));
    if (next === artW) break;
    artW = next;
  }
  while (artW > 1 && frameMetrics(artW, Math.round(artW / ratio)).w > frameWidth) {
    artW -= 1;
  }
  return artW;
}

// ── Path building blocks ─────────────────────────────────────────────────────

function rectPath(x0: number, y0: number, x1: number, y1: number): string {
  return `M${fmt(x0)} ${fmt(y0)} H${fmt(x1)} V${fmt(y1)} H${fmt(x0)} Z`;
}

function roundRectPath(x0: number, y0: number, x1: number, y1: number, r: number): string {
  const rr = fmt(r);
  return (
    `M${fmt(x0 + r)} ${fmt(y0)} H${fmt(x1 - r)} A${rr} ${rr} 0 0 1 ${fmt(x1)} ${fmt(y0 + r)}` +
    ` V${fmt(y1 - r)} A${rr} ${rr} 0 0 1 ${fmt(x1 - r)} ${fmt(y1)}` +
    ` H${fmt(x0 + r)} A${rr} ${rr} 0 0 1 ${fmt(x0)} ${fmt(y1 - r)}` +
    ` V${fmt(y0 + r)} A${rr} ${rr} 0 0 1 ${fmt(x0 + r)} ${fmt(y0)} Z`
  );
}

/** A full circle as a closed path, wound clockwise (sweep 1) like every other
 * path here, so circles can share a path with the silhouette. */
function circleSubpath(x: number, y: number, r: number): string {
  const rr = fmt(r);
  return `M${fmt(x - r)} ${fmt(y)} A${rr} ${rr} 0 1 1 ${fmt(x + r)} ${fmt(y)} A${rr} ${rr} 0 1 1 ${fmt(x - r)} ${fmt(y)} Z`;
}

type EdgeShape = 'scallop' | 'wavy' | 'ricrac';

interface EdgeSide {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  /** Outward normal. */
  nx: number;
  ny: number;
  L: number;
  vertical: boolean;
}

/** How many whole periods fit a side, and the (slightly stretched) period that
 * makes them divide it evenly. Exposed for tests. */
export function edgePeriods(length: number, period: number): { n: number; per: number } {
  const n = Math.max(1, Math.round(length / period));
  return { n, per: length / n };
}

// Cubic-bezier control fraction for a half cosine (same curve as CSS
// easeInOutSine): visually indistinguishable from the sampled cosine.
const COS_K = 0.37;

/**
 * A closed, clockwise silhouette whose four edges bulge outward by up to `a`:
 *   scallop  semicircular bumps (f = sqrt(1 - (2u-1)^2)), zero at the joins
 *   wavy     cosine wave (f = .5 + .5 cos 2*pi*u), peak at the joins
 *   ricrac   zig-zag (f = |2u-1|), peak at the joins
 * `u` is the position inside one period. Mirrors the canvas `edgePath`.
 */
function edgePath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  a: number,
  shape: EdgeShape,
  period: number,
): string {
  const sides: EdgeSide[] = [
    { sx: x0, sy: y0, dx: 1, dy: 0, nx: 0, ny: -1, L: x1 - x0, vertical: false },
    { sx: x1, sy: y0, dx: 0, dy: 1, nx: 1, ny: 0, L: y1 - y0, vertical: true },
    { sx: x1, sy: y1, dx: -1, dy: 0, nx: 0, ny: 1, L: x1 - x0, vertical: false },
    { sx: x0, sy: y1, dx: 0, dy: -1, nx: -1, ny: 0, L: y1 - y0, vertical: true },
  ];
  const cmds: string[] = [];
  const peakAtJoin = shape !== 'scallop';
  for (let s = 0; s < sides.length; s += 1) {
    const side = sides[s];
    const { n, per } = edgePeriods(side.L, period);
    // point at `d` along the side, `off` outward
    const px = (d: number, off: number) => fmt(side.sx + side.dx * d + side.nx * off);
    const py = (d: number, off: number) => fmt(side.sy + side.dy * d + side.ny * off);
    const startOff = peakAtJoin ? a : 0;
    cmds.push(`${s === 0 ? 'M' : 'L'}${px(0, startOff)} ${py(0, startOff)}`);
    for (let i = 0; i < n; i += 1) {
      const d0 = i * per;
      if (shape === 'scallop') {
        const rx = side.vertical ? a : per / 2;
        const ry = side.vertical ? per / 2 : a;
        cmds.push(`A${fmt(rx)} ${fmt(ry)} 0 0 1 ${px(d0 + per, 0)} ${py(d0 + per, 0)}`);
      } else if (shape === 'ricrac') {
        cmds.push(`L${px(d0 + per / 2, 0)} ${py(d0 + per / 2, 0)}`);
        cmds.push(`L${px(d0 + per, a)} ${py(d0 + per, a)}`);
      } else {
        const h = per / 2;
        const k = COS_K * h;
        cmds.push(
          `C${px(d0 + k, a)} ${py(d0 + k, a)} ${px(d0 + h - k, 0)} ${py(d0 + h - k, 0)} ${px(d0 + h, 0)} ${py(d0 + h, 0)}`,
        );
        cmds.push(
          `C${px(d0 + h + k, 0)} ${py(d0 + h + k, 0)} ${px(d0 + per - k, a)} ${py(d0 + per - k, a)} ${px(d0 + per, a)} ${py(d0 + per, a)}`,
        );
      }
    }
  }
  return `${cmds.join(' ')} Z`;
}

// ── Per-kind construction ────────────────────────────────────────────────────

function buildFramePaths(kind: FrameKind, metrics: FrameMetrics): FramePaths {
  const { band, amp, w, h } = metrics;

  let outerPath = rectPath(0, 0, w, h);
  let corners: FrameCircle[] = [];
  const beads: FrameBead[] = [];
  let bodyFill: FrameBodyFill = 'color';
  let matPath = rectPath(band, band, w - band, h - band);
  let lipTone: FrameLipTone = 'light';
  let outlinePath: string | null = null;
  let outlineTone: FrameOutlineTone = 'none';
  let checkSize = 0;

  if (kind === 'scallop' || kind === 'wavy' || kind === 'ricrac') {
    const period = kind === 'scallop' ? amp * 2 : kind === 'wavy' ? amp * 4.4 : amp * 2.2;
    outerPath = edgePath(amp, amp, w - amp, h - amp, amp, kind, period);
    if (kind !== 'ricrac') {
      corners = [
        { x: amp, y: amp, r: amp },
        { x: w - amp, y: amp, r: amp },
        { x: w - amp, y: h - amp, r: amp },
        { x: amp, y: h - amp, r: amp },
      ];
    }
  } else if (kind === 'bobble') {
    outerPath = roundRectPath(0, 0, w, h, 5);
    bodyFill = 'cream';
    lipTone = 'warm';
    outlinePath = roundRectPath(0.5, 0.5, w - 0.5, h - 0.5, 5);
    outlineTone = 'warm';
    const c = band / 2;
    const r = band * 0.31;
    const spacing = r * 2.3;
    const runs: [number, number, number, number][] = [
      [c, c, w - c, c],
      [w - c, c, w - c, h - c],
      [w - c, h - c, c, h - c],
      [c, h - c, c, c],
    ];
    for (const [ax, ay, bx, by] of runs) {
      const L = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(L / spacing));
      for (let i = 0; i < n; i += 1) {
        const t = i / n;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        beads.push({
          x: round1(x),
          y: round1(y),
          r: round1(r),
          hx: round1(x - r * 0.32),
          hy: round1(y - r * 0.36),
          hr: round1(r * 0.3),
        });
      }
    }
  } else if (kind === 'gingham') {
    outerPath = roundRectPath(0, 0, w, h, 3);
    bodyFill = 'gingham';
    lipTone = 'white';
    outlinePath = roundRectPath(0.5, 0.5, w - 0.5, h - 0.5, 3);
    outlineTone = 'color';
    checkSize = Math.max(8, Math.round(band / 2.2));
  } else {
    // chunky: a thick flat band with a wavy inner mat edge
    outerPath = roundRectPath(0, 0, w, h, Math.round(band * 0.5));
    const a2 = 4;
    matPath = edgePath(band + a2, band + a2, w - band - a2, h - band - a2, a2, 'wavy', 14);
    lipTone = 'none';
  }

  const bodyPath =
    corners.length > 0
      ? `${outerPath} ${corners.map((c) => circleSubpath(c.x, c.y, c.r)).join(' ')}`
      : outerPath;

  return {
    kind,
    metrics,
    outerPath,
    corners,
    bodyPath,
    bodyFill,
    beads,
    beadsPath: beads.map((b) => circleSubpath(b.x, b.y, b.r)).join(' '),
    beadHighlightsPath: beads.map((b) => circleSubpath(b.hx, b.hy, b.hr)).join(' '),
    matPath,
    lipPath: rectPath(band - 1.5, band - 1.5, w - band + 1.5, h - band + 1.5),
    lipTone,
    outlinePath,
    outlineTone,
    checkSize,
  };
}

// Memoized by (kind, artW, artH). A Timeline mostly repeats a handful of
// sizes, so this stays tiny; the cap just stops a pathological stream of
// sizes (window resizes, fold/unfold) from growing it without bound.
const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, FramePaths>();

export function framePaths(kind: FrameKind, metrics: FrameMetrics): FramePaths {
  const key = `${kind}|${metrics.artW}|${metrics.artH}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const built = buildFramePaths(kind, metrics);
  cache.set(key, built);
  return built;
}

/** Test hook: the memo cache's current size. */
export function framePathsCacheSize(): number {
  return cache.size;
}
