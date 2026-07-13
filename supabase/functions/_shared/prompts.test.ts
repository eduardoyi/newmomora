import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildCharacterSheetAbstractionAddon,
  buildEmotionVisionUserPrompt,
  buildIllustrationPrompt,
  buildLegacyStyleTransferPortraitPrompt,
  buildMediaEmotionSystemPrompt,
  buildPortraitPrompt,
  buildSafetySystemPrompt,
  normalizeEmotion,
} from './prompts.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getIllustrationStyle,
  getStyleDescription,
  getStyleReferencePath,
} from './styles.ts';

const DEFAULT_STYLE_DESCRIPTION = getStyleDescription(DEFAULT_ILLUSTRATION_STYLE_TOKEN);

Deno.test('buildPortraitPrompt uses child identity guidance for children', () => {
  const prompt = buildPortraitPrompt({
    name: 'Enzo',
    ageDescription: '3 years and 7 months old',
    isAdult: false,
    gender: 'Male',
    styleToken: 'default',
    additionalInfo: 'He has curly brown hair.',
  });

  assertEquals(prompt.includes('Keep broad cues from the photo'), true);
  assertEquals(prompt.includes('loose inspiration for broad identity cues only'), true);
  assertEquals(prompt.includes('Do not preserve the exact facial structure from the photo'), true);
  assertEquals(prompt.includes('warm open smiling mouth'), true);
  assertEquals(prompt.includes('Additional guidance: He has curly brown hair.'), true);
});

Deno.test('buildPortraitPrompt preserves adult identity in style-reference language', () => {
  const prompt = buildPortraitPrompt({
    name: 'Adriana',
    ageDescription: '36 years old',
    isAdult: true,
    gender: 'Female',
    styleToken: 'default',
  });

  assertEquals(prompt.includes('Adult likeness guidance:'), true);
  assertEquals(prompt.includes('Match the style reference sheet first'), true);
  assertEquals(prompt.includes('style-reference language'), true);
  assertEquals(prompt.includes('recognizable as this specific adult'), true);
  assertEquals(prompt.includes('Do not preserve the exact facial structure from the photo'), false);
  assertEquals(prompt.includes('Do not replace the person\'s face with a default pretty storybook face.'), true);
  assertEquals(prompt.includes('No realistic watercolor portrait'), true);
  assertEquals(prompt.includes('stiff closed-mouth'), true);
  assertEquals(prompt.includes('generic eye template'), true);
});

Deno.test('buildCharacterSheetAbstractionAddon differs for adults and children', () => {
  const adult = buildCharacterSheetAbstractionAddon(true);
  const child = buildCharacterSheetAbstractionAddon(false);

  assertEquals(adult.includes('style-reference language'), true);
  assertEquals(child.includes('cute hand-drawn character proportions'), true);
});

Deno.test('buildLegacyStyleTransferPortraitPrompt keeps old template', () => {
  const prompt = buildLegacyStyleTransferPortraitPrompt({
    ageDescription: '3 years and 7 months old',
    gender: 'Male',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
  });

  assertEquals(prompt.includes('Create a portrait illustration of the 3 years and 7 months old male'), true);
});

Deno.test('buildIllustrationPrompt maps each reference image to a tagged character', () => {
  const prompt = buildIllustrationPrompt({
    safeSceneDescription: 'Two children sit at the breakfast table refusing oatmeal.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
      { referenceIndex: 2, description: 'Mara (1 year and 6 months old, Female)' },
    ],
    colorPalette: 'playful violet, soft purple, whimsical lilac pops',
    memoryDate: '2026-05-26',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
  });

  assertEquals(
    prompt.includes('Reference image 1: Enzo (3 years and 7 months old, Male)'),
    true,
  );
  assertEquals(
    prompt.includes('Reference image 2: Mara (1 year and 6 months old, Female)'),
    true,
  );
  assertEquals(
    prompt.includes('Match each tagged human character in the scene to their corresponding portrait reference.'),
    true,
  );
  assertEquals(
    prompt.includes('only the 2 human characters'),
    true,
  );
  assertEquals(
    prompt.includes('Do not draw any other human characters'),
    true,
  );
  assertEquals(prompt.includes('Non-human subjects from the scene'), true);
  assertEquals(prompt.includes('stylized storybook figure'), true);
  assertEquals(prompt.includes('Favor stylization over realism'), true);
  assertEquals(prompt.includes('Do not render realistic painted likenesses'), true);
  assertEquals(
    prompt.includes('Use this only for mood, season, clothing, or setting cues when relevant'),
    true,
  );
  assertEquals(prompt.includes('no captions, no speech bubbles'), true);
});

Deno.test('buildIllustrationPrompt limits a single tagged human in the scene', () => {
  const prompt = buildIllustrationPrompt({
    safeSceneDescription: 'A boy feeds a goat on a school trip to an educational farm.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'lilac, dawn pink, soft cyan',
    memoryDate: '2026-05-28',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
  });

  assertEquals(prompt.includes('exactly one human figure'), true);
  assertEquals(prompt.includes('matching reference image 1'), true);
  assertEquals(prompt.includes('classmates'), true);
  assertEquals(prompt.includes('animals'), true);
});

Deno.test('buildIllustrationPrompt preserve/adapt split keeps identity cues but frees expression', () => {
  const prompt = buildIllustrationPrompt({
    safeSceneDescription: 'A child naps on the couch after a long day at the park.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'soft warm greys, dusty taupe, muted oatmeal',
    memoryDate: '2026-05-28',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
  });

  assertEquals(prompt.includes('PRESERVE from each portrait reference'), true);
  assertEquals(prompt.includes('hairstyle, hair color, skin tone, face shape, approximate age'), true);
  assertEquals(prompt.includes('ADAPT to the scene'), true);
  assertEquals(
    prompt.includes('The smile in each portrait reference is an identity sample only, not the required expression'),
    true,
  );
});

Deno.test('buildIllustrationPrompt emits no-smile guidance for worry', () => {
  const prompt = buildIllustrationPrompt({
    safeSceneDescription: 'A child feels unwell with a fever on the couch.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'soft slate blue, muted grey, pale overcast light',
    memoryDate: '2026-05-28',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
    emotion: 'worry',
  });

  assertEquals(prompt.includes('Emotional tone:'), true);
  assertEquals(prompt.includes('worry.'), true);
  assertEquals(prompt.includes('no cheerful smiles'), true);
  assertEquals(
    prompt.includes('Expressions must match the emotional tone of the memory, not default to smiling.'),
    true,
  );
});

Deno.test('buildIllustrationPrompt falls back to generic mood guidance when emotion is missing', () => {
  const prompt = buildIllustrationPrompt({
    safeSceneDescription: 'A quiet afternoon at home.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'sage green, pale blue, warm sand',
    memoryDate: '2026-05-28',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
  });

  assertEquals(prompt.includes('Expressions should match the mood of the scene.'), true);
});

Deno.test('buildIllustrationPrompt includes comedic exaggeration only for whitelisted emotion + comedic style', () => {
  const comedicPrompt = buildIllustrationPrompt({
    safeSceneDescription: 'A toddler dramatically refuses to eat broccoli.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'playful violet, soft purple, whimsical lilac pops',
    memoryDate: '2026-05-28',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
    emotion: 'mischief',
    expressionStyle: 'comedic',
  });

  assertEquals(comedicPrompt.includes('Playful exaggerated storybook expressions are welcome'), true);

  const worryComedicPrompt = buildIllustrationPrompt({
    safeSceneDescription: 'A child feels unwell with a fever on the couch.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'soft slate blue, muted grey, pale overcast light',
    memoryDate: '2026-05-28',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
    emotion: 'worry',
    expressionStyle: 'comedic',
  });

  assertEquals(worryComedicPrompt.includes('Playful exaggerated storybook expressions are welcome'), false);

  const joyNeutralPrompt = buildIllustrationPrompt({
    safeSceneDescription: 'A birthday party in the backyard.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'warm golden yellows, soft peach, light sky blue accents',
    memoryDate: '2026-05-28',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
    emotion: 'joy',
    expressionStyle: 'neutral',
  });

  assertEquals(joyNeutralPrompt.includes('Playful exaggerated storybook expressions are welcome'), false);
});

Deno.test('normalizeEmotion maps legacy classifier labels into the current vocabulary', () => {
  assertEquals(normalizeEmotion('funny'), 'mischief');
  assertEquals(normalizeEmotion('joyful'), 'joy');
  assertEquals(normalizeEmotion(' Worry '), 'worry');
  assertEquals(normalizeEmotion('unknown-label'), 'unknown-label');
  assertEquals(normalizeEmotion(null), null);
  assertEquals(normalizeEmotion('  '), null);
});

Deno.test('buildIllustrationPrompt treats legacy funny label as mischief for comedic gating', () => {
  const prompt = buildIllustrationPrompt({
    safeSceneDescription: 'Two kids grimace at their oatmeal bowls.',
    characterReferences: [
      { referenceIndex: 1, description: 'Enzo (3 years and 7 months old, Male)' },
    ],
    colorPalette: 'playful violet, soft purple, whimsical lilac pops',
    memoryDate: '2026-05-27',
    styleDescription: DEFAULT_STYLE_DESCRIPTION,
    emotion: 'funny',
    expressionStyle: 'comedic',
  });

  assertEquals(prompt.includes('mischief.'), true);
  assertEquals(prompt.includes('sly grins'), true);
  assertEquals(prompt.includes('Playful exaggerated storybook expressions are welcome'), true);
});

Deno.test('buildSafetySystemPrompt forbids inventing cheerfulness the memory does not describe', () => {
  const prompt = buildSafetySystemPrompt([]);

  assertEquals(prompt.includes('do not invent smiles, cheerfulness, or comforting details'), true);
});

Deno.test('buildSafetySystemPrompt includes nickname-to-name mapping instructions when members provided', () => {
  const withMembers = buildSafetySystemPrompt([
    { name: 'Mara', nicknames: ['cheeky monkey'] },
    { name: 'Enzo', nicknames: null },
  ]);

  assertEquals(withMembers.includes('Nickname mapping: cheeky monkey → Mara.'), true);
  assertEquals(withMembers.includes('canonical name'), true);
  assertEquals(withMembers.includes('never introduce an animal'), true);
  assertEquals(withMembers.includes('expressionStyle'), true);

  const withoutMembers = buildSafetySystemPrompt([]);
  assertEquals(withoutMembers.includes('Nickname mapping:'), false);
});

Deno.test('getIllustrationStyle falls back to default token', () => {
  const style = getIllustrationStyle('unknown-style');

  assertEquals(style.token, 'default');
  assertEquals(getStyleReferencePath('unknown-style'), '_assets/styles/default.png');
});

Deno.test('buildMediaEmotionSystemPrompt targets photo memories', () => {
  const prompt = buildMediaEmotionSystemPrompt();
  assertEquals(prompt.includes('photos from a parenting memory journal'), true);
  assertEquals(prompt.includes('joy'), true);
});

Deno.test('buildEmotionVisionUserPrompt includes caption when provided', () => {
  const withCaption = buildEmotionVisionUserPrompt('First bike ride');
  assertEquals(withCaption.includes('First bike ride'), true);
  assertEquals(withCaption.includes('attached photo'), true);

  const withoutCaption = buildEmotionVisionUserPrompt(null);
  assertEquals(withoutCaption.includes('photo only'), true);
});
