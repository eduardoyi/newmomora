// Holiday Card illustrated front (docs/plans/holiday-cards.md §6 C1): a cozy
// holiday scene of the core family, built from their illustrated portraits.
// Pure prompt builder on top of the memory-illustration prompt
// (`buildIllustrationPrompt`), so the house storybook style, the "only these
// human characters" rule and the no-text constraints stay the single shared
// source. The caller owns references (`prepareIllustrationReferences`), the
// style description (`getStyleDescription`) and the image call.
import {
  buildIllustrationPrompt,
  EMOTION_PALETTES,
  type IllustrationCharacterReferenceInput,
} from './prompts.ts';

export type HolidayScenePlacement = 'tree' | 'winter-walk' | 'window-light';

export interface HolidaySceneVariant {
  id: HolidayScenePlacement;
  /** Output size requested from the image model. */
  size: '1536x1024' | '1024x1536' | '1024x1024';
  orientation: 'landscape' | 'portrait' | 'square';
  scene: string;
  /** Quiet variants: the family is the subject and seasonal cues are one or
   * two small touches (owner C1 round 2: the first scenes were "too
   * over-the-top holiday-y"; only `tree` was kept as is). */
  quiet: boolean;
  /** Overrides the default festive palette. */
  palette?: string;
}

/** Secular-ish "holiday": lights, winter, calm -- no religious symbols. */
export const HOLIDAY_SCENE_VARIANTS: readonly HolidaySceneVariant[] = [
  {
    id: 'tree',
    size: '1536x1024',
    orientation: 'landscape',
    quiet: false,
    scene:
      'A cozy winter-holiday evening in the family living room: the whole family gathered close together on a soft rug in front of a warmly lit, decorated evergreen tree, string lights glowing, knitted stockings on the mantel, gifts wrapped in paper and twine, a lamp casting golden light.',
  },
  {
    id: 'winter-walk',
    size: '1024x1536',
    orientation: 'portrait',
    quiet: true,
    palette: 'soft dove grey, muted blue, warm oatmeal and a touch of dusty rose, gentle pale winter light',
    scene:
      'A quiet winter afternoon walk: the whole family walking or standing close together on a path in soft, low winter light, wearing simple coats and scarves, a few bare trees and a light dusting of snow around them, a soft hazy sky. Nothing else: no house, no string lights, no decorations.',
  },
  {
    id: 'window-light',
    size: '1536x1024',
    orientation: 'landscape',
    quiet: true,
    palette: 'creamy white, warm honey, soft sage and pale winter-blue light from the window',
    scene:
      'A calm winter afternoon at home: the whole family snuggled together on a sofa with a soft blanket beside a large window with gentle daylight, a single small sprig of evergreen on the windowsill or a mug in hand as the only seasonal touch. A simple, uncluttered room.',
  },
];

function compositionSection(variant: HolidaySceneVariant): string {
  const frame = variant.orientation === 'portrait'
    ? 'tall portrait frame (2:3)'
    : variant.orientation === 'landscape'
    ? 'wide landscape frame (3:2)'
    : 'square frame';
  if (variant.quiet) {
    return [
      'Composition (this image becomes the front of a printed family holiday greeting card):',
      `Draw it for a ${frame}. The FAMILY is the subject: group everyone together, every person fully in frame with their face clearly visible and unobstructed, looking happy and relaxed; nobody cut off at the edges.`,
      'Keep it calm, warm and understated. Seasonal cues are subtle: at most one or two small touches, nothing festive piled on. No Christmas tree, no ornaments, no stockings, no gift piles, no string lights, no wreaths, no Santa, no religious symbols, no extra human characters.',
      'Leave a bit of quiet space around the group (soft sky, wall or ground) and keep everything important inside the central area, with a generous margin because the print is trimmed. Do NOT draw any text, letters, numbers or banners.',
    ].join('\n');
  }
  return [
    'Composition (this image becomes the front of a printed family holiday greeting card):',
    `Draw it for a ${frame}. Group the family together as the clear focus, every person fully in frame with their face clearly visible and unobstructed, looking happy and warm; nobody cut off at the edges.`,
    'Leave calm, uncluttered space in the scene (soft sky, wall, snow or table) where a greeting could be placed later, but do NOT draw any text, letters, numbers or banners.',
    'Keep everything important inside the central area: leave a generous margin around the edges because the print is trimmed.',
    'A secular, cheerful winter-holiday mood: lights, snow, evergreens, cocoa and gifts are welcome; no religious symbols, no Santa Claus figure, no extra human characters.',
  ].join('\n');
}

/** Prompt for one holiday scene. `characterReferences` come from
 * `prepareIllustrationReferences` (one reference image per core member). */
export function buildHolidaySceneIllustrationPrompt(input: {
  variant: HolidaySceneVariant;
  characterReferences: IllustrationCharacterReferenceInput[];
  styleDescription: string;
  /** Used only for season and clothing cues (the prompt forbids rendering it). */
  cardYear: number;
}): string {
  return [
    buildIllustrationPrompt({
      safeSceneDescription: input.variant.scene,
      characterReferences: input.characterReferences,
      colorPalette: input.variant.palette ??
        `${EMOTION_PALETTES.joy}; warm candlelight and string-light glow with deep winter blues`,
      memoryDate: `${input.cardYear}-12-20`,
      styleDescription: input.styleDescription,
      emotion: 'joy',
    }),
    compositionSection(input.variant),
  ].join('\n');
}
