import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { buildHolidaySceneIllustrationPrompt, HOLIDAY_SCENE_VARIANTS } from './holiday-card-illustration.ts';

const REFERENCES = [
  { referenceIndex: 1, description: 'Ana (adult, female)' },
  { referenceIndex: 2, description: 'Leo (4 years old, male)' },
];

Deno.test('holiday scene variants: 1536 sizes for landscape, 1024x1536 for portrait', () => {
  assertEquals(HOLIDAY_SCENE_VARIANTS.length, 3);
  assertEquals(HOLIDAY_SCENE_VARIANTS[0].size, '1536x1024');
  assertEquals(HOLIDAY_SCENE_VARIANTS[1].size, '1024x1536');
  for (const variant of HOLIDAY_SCENE_VARIANTS) {
    const expected = variant.orientation === 'portrait' ? '1024x1536' : '1536x1024';
    assertEquals(variant.size, expected);
  }
});

Deno.test('holiday scene prompt reuses the storybook prompt and adds card composition rules', () => {
  const prompt = buildHolidaySceneIllustrationPrompt({
    variant: HOLIDAY_SCENE_VARIANTS[0],
    characterReferences: REFERENCES,
    styleDescription: 'gouache storybook',
    cardYear: 2026,
  });
  assertStringIncludes(prompt, 'Reference image 1: Ana');
  assertStringIncludes(prompt, 'Reference image 2: Leo');
  assertStringIncludes(prompt, 'only the 2 human characters');
  assertStringIncludes(prompt, 'Illustration style: gouache storybook');
  assertStringIncludes(prompt, 'No text, no logos');
  assertStringIncludes(prompt, 'greeting');
  assertStringIncludes(prompt, 'face clearly visible');
  assertStringIncludes(prompt, 'no religious symbols');
  assertStringIncludes(prompt, 'do not include written dates');
});

Deno.test('tree variant keeps its festive prompt unchanged in spirit', () => {
  const prompt = buildHolidaySceneIllustrationPrompt({
    variant: HOLIDAY_SCENE_VARIANTS[0],
    characterReferences: REFERENCES,
    styleDescription: 'x',
    cardYear: 2026,
  });
  assertStringIncludes(prompt, 'decorated evergreen tree');
  assertStringIncludes(prompt, 'lights, snow, evergreens, cocoa and gifts are welcome');
  assertStringIncludes(prompt, 'warm candlelight and string-light glow');
});

Deno.test('quiet variants: family is the subject, seasonal cues subtle, no festive pile-ups', () => {
  assertEquals(HOLIDAY_SCENE_VARIANTS.map((v) => v.id), ['tree', 'winter-walk', 'window-light']);
  for (const variant of HOLIDAY_SCENE_VARIANTS.filter((v) => v.quiet)) {
    const prompt = buildHolidaySceneIllustrationPrompt({
      variant,
      characterReferences: REFERENCES,
      styleDescription: 'gouache storybook',
      cardYear: 2026,
    });
    assertStringIncludes(prompt, 'The FAMILY is the subject');
    assertStringIncludes(prompt, 'at most one or two small touches');
    assertStringIncludes(prompt, 'No Christmas tree, no ornaments, no stockings, no gift piles');
    assertStringIncludes(prompt, 'quiet space around the group');
    assertStringIncludes(prompt, 'Do NOT draw any text');
    assertStringIncludes(prompt, 'Reference image 2: Leo');
    assertStringIncludes(prompt, 'Illustration style: gouache storybook');
    assert(!prompt.includes('cocoa and gifts are welcome'));
    assert(!prompt.includes('string-light glow'));
  }
});

Deno.test('portrait variant asks for a tall frame', () => {
  const prompt = buildHolidaySceneIllustrationPrompt({
    variant: HOLIDAY_SCENE_VARIANTS[1],
    characterReferences: REFERENCES,
    styleDescription: 'x',
    cardYear: 2026,
  });
  assertStringIncludes(prompt, 'tall portrait frame');
});
