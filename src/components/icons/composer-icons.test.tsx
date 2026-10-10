import { render } from '@testing-library/react-native';

import { PhotosIcon, ScanArtIcon, SoundIcon } from '@/components/icons/composer-icons';
import { colors } from '@/constants/theme';

function findAll(node: any, predicate: (n: any) => boolean): any[] {
  if (!node || typeof node === 'string') return [];
  const out: any[] = predicate(node) ? [node] : [];
  for (const child of node.children ?? []) out.push(...findAll(child, predicate));
  return out;
}

// react-native-svg hands colors to the renderer pre-parsed as ARGB ints.
function argb(hex: string): number {
  const c = hex.replace('#', '');
  return (
    ((0xff << 24) | (parseInt(c.slice(0, 2), 16) << 16) | (parseInt(c.slice(2, 4), 16) << 8) | parseInt(c.slice(4, 6), 16)) >>>
    0
  );
}

function paintedColors(root: any): { strokes: number[]; fills: number[] } {
  const nodes = findAll(root, (n) => typeof n.type === 'string' && n.type.startsWith('RNSVG') && n.type !== 'RNSVGSvgView' && n.type !== 'RNSVGGroup');
  const strokes: number[] = [];
  const fills: number[] = [];
  for (const n of nodes) {
    if (n.props.stroke && typeof n.props.stroke.payload === 'number') strokes.push(n.props.stroke.payload);
    if (n.props.fill && typeof n.props.fill.payload === 'number') fills.push(n.props.fill.payload);
  }
  return { strokes, fills };
}

const ICONS = [
  ['SoundIcon', SoundIcon],
  ['PhotosIcon', PhotosIcon],
  ['ScanArtIcon', ScanArtIcon],
] as const;

describe.each(ICONS)('%s', (_name, Icon) => {
  it('draws a 48-unit viewBox at the requested size (default 28)', () => {
    const def = render(<Icon />).toJSON() as any;
    expect(def.props.width).toBe(28);
    expect(def.props.height).toBe(28);
    expect(def.props.vbWidth).toBe(48);
    expect(def.props.vbHeight).toBe(48);

    const big = render(<Icon size={40} />).toJSON() as any;
    expect(big.props.width).toBe(40);
  });

  it('is ink outline plus color when enabled', () => {
    const { strokes, fills } = paintedColors(render(<Icon />).toJSON());
    expect(strokes).toContain(argb(colors.ink));
    // Ink plus at least one color (stroke or fill) that is not ink.
    expect(new Set([...strokes, ...fills]).size).toBeGreaterThan(2);
  });

  it('goes entirely grey when disabled', () => {
    const { strokes, fills } = paintedColors(render(<Icon disabled />).toJSON());
    expect(strokes.length).toBeGreaterThan(0);
    const allowedStrokes = new Set([argb(colors.ink3)]);
    const allowedFills = new Set([argb('#E6E1DD'), argb('#CFC8BF')]);
    for (const s of strokes) expect(allowedStrokes.has(s)).toBe(true);
    for (const f of fills) expect(allowedFills.has(f)).toBe(true);
  });
});

describe('composer icon colors', () => {
  it('SoundIcon uses sea for the waves; ScanArtIcon uses primary for the squiggle', () => {
    expect(paintedColors(render(<SoundIcon />).toJSON()).strokes).toContain(argb(colors.sea));
    expect(paintedColors(render(<ScanArtIcon />).toJSON()).strokes).toContain(argb(colors.primary));
  });

  it('PhotosIcon puts a sunny sun on the top photo', () => {
    expect(paintedColors(render(<PhotosIcon />).toJSON()).fills).toContain(argb(colors.sun));
  });

  it('ScanArtIcon draws a little sun beside the squiggle, grey when disabled', () => {
    expect(paintedColors(render(<ScanArtIcon />).toJSON()).fills).toContain(argb(colors.sun));
    expect(paintedColors(render(<ScanArtIcon disabled />).toJSON()).fills).not.toContain(argb(colors.sun));
  });
});
