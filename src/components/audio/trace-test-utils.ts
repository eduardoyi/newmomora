// Test-only helpers for asserting which envelope a rendered SoundTrace drew.
// A silence-only waveform draws the thin 0.06 floor line (|y - 50| <= ~3
// viewBox units), which a seeded moEnv trace essentially never does, so
// "a floor-line trace is on screen" proves the real waveform reached the
// trace from whatever surface is under test.
export const SILENT_WAVEFORM: number[] = new Array<number>(64).fill(0);

function collectPathData(node: any, out: string[]): string[] {
  if (!node) return out;
  if (node.type === 'RNSVGPath' && typeof node.props?.d === 'string') {
    out.push(node.props.d);
  }
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) collectPathData(child, out);
  return out;
}

function isFloorLine(d: string): boolean {
  const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
  return ys.length >= 5 && ys.every((y) => Math.abs(y - 50) <= 3.2);
}

/** True when any SoundTrace in the rendered tree drew the silence floor line. */
export function hasFloorTrace(json: unknown): boolean {
  const trees = Array.isArray(json) ? json : [json];
  return trees.some((tree) => collectPathData(tree, []).some(isFloorLine));
}
