// Keep keys in sync with emotionColors in src/constants/theme.ts — the key set
// here defines the classifier's allowed emotion labels; that map defines UI color.
export const EMOTION_PALETTES: Record<string, string> = {
  // Warm / positive
  joy:         'warm golden yellows, soft peach, light sky blue accents',
  funny:       'bright tangerine, warm coral, sunny pops of turquoise',
  tender:      'soft rose, cream, gentle lavender',
  calm:        'sage green, pale blue, warm sand',
  wonder:      'lilac, dawn pink, soft cyan',
  mischief:    'playful violet, soft purple, whimsical lilac pops',
  pride:       'radiant coral, warm terracotta, glowing amber highlights',
  // Wistful / mixed
  bittersweet: 'muted dusty rose, faded sepia, soft mauve twilight',
  // Harder moments
  worry:       'soft slate blue, muted grey, pale overcast light',
  weary:       'soft warm greys, dusty taupe, muted oatmeal',
  sad:         'gentle indigo, soft blue-grey, dusky periwinkle',
};

// Keep keys in sync with EMOTION_PALETTES — concrete facial/body expression
// guidance so the image model stops defaulting every character to a smile.
export const EMOTION_EXPRESSIONS: Record<string, string> = {
  // Warm / positive
  joy:         'bright genuine smiles, wide eyes, open joyful body language',
  funny:       'big laughs and giggles, wide comic grins, crinkled eyes, playful exaggerated expressions',
  tender:      'soft warm smiles, gentle affectionate expressions, relaxed calm posture',
  calm:        'peaceful contented faces, soft easy smiles or neutral relaxed expressions',
  wonder:      'wide curious eyes, mouths slightly open in amazement, awe-struck expressions',
  mischief:    'sly grins, raised eyebrows, playful glinting eyes',
  pride:       'beaming confident smiles, chin up, proud open posture',
  // Wistful / mixed
  bittersweet: 'small wistful half-smiles, soft eyes that mix warmth and longing, gentle nostalgia — not full grins',
  // Harder moments
  worry:       'no cheerful smiles; the unwell or troubled child looks tired, flushed, or uncomfortable; caregivers show gentle concern and comfort; no smiling faces on objects or props',
  weary:       'no smiles; heavy-lidded tired eyes, slumped relaxed shoulders, soft exhausted expressions; no smiling faces on objects or props',
  sad:         'no smiles; downturned mouths, glassy or downcast eyes, comforting gentle body language; no smiling faces on objects or props',
};

// Labels written by earlier classifier vocabularies that still exist on old
// memory rows; map them into the current emotion set.
const EMOTION_ALIASES: Record<string, string> = {
  joyful: 'joy',
};

export function normalizeEmotion(emotion?: string | null): string | null {
  const trimmed = emotion?.trim().toLowerCase();

  if (!trimmed) {
    return null;
  }

  return EMOTION_ALIASES[trimmed] ?? trimmed;
}

const IMAGE_STYLE_NEGATIVES =
  'Do not make the image photorealistic, 3D, CGI, or Pixar-like.';

/** Emotions where comedic exaggeration is tonally appropriate. */
export const COMEDIC_ELIGIBLE_EMOTIONS = new Set(['joy', 'funny', 'mischief', 'pride']);

const PORTRAIT_STYLE_BLOCK = [
  'The output should look like one of the characters from the provided style reference sheet.',
  'Reference image 1: style reference sheet — source of truth for art style, proportions, facial simplification, eye design, nose design, mouth design, linework, texture, and level of detail.',
  'Create a 2D hand-drawn storybook character portrait.',
  'Soft gouache and watercolor texture, gentle ink outlines, warm muted colors, rounded simplified shapes, subtle magical charm.',
  'No realistic watercolor portrait, no photographic likeness rendering, no hyper-detailed anatomy, no 3D, no CGI, no Pixar-like style.',
];

const ANTI_REALISM_BLOCK = [
  'Avoid realistic eyelids, hyper-detailed teeth, detailed lips, skin pores, complex shadows, photographic lighting, and detailed facial anatomy.',
];

const ADULT_IDENTITY_BLOCK = [
  'Adult likeness guidance:',
  'Match the style reference sheet first. The final image should look like it belongs in that sheet.',
  'Reference image 2: person photo — identify this specific person\'s identity anchors, then redraw them in style-reference language.',
  'Use the photo to identify the person\'s key identity anchors, then redraw those anchors in the simplified style-reference language.',
  'Preserve simplified versions of the person\'s most recognizable adult cues: hair part and hair length, face shape, eye shape and spacing, eyebrow shape, nose impression, smile width, cheek shape, and jaw/chin impression.',
  'The character must remain recognizable as this specific adult — not a generic storybook face with the correct hair and eye color.',
  'Do not copy realistic facial detail from the photo: no hyper-realistic teeth, detailed lips, realistic eyelids, skin texture, facial lines, or photographic shading.',
  'Use a natural gentle smile with simplified mouth — not a stiff closed-mouth line smile.',
  'Eye shape and spacing should come from the person\'s photo, simplified into storybook form — not one generic eye template shared by every character.',
  'Do not make the adult look younger, more generic, more doll-like, or more conventionally cute than the source person.',
  'Do not replace the person\'s face with a default pretty storybook face.',
  'Keep adult proportions and identity cues, but simplify the rendering style only.',
  'The person should be recognizable as a character inspired by the photo, but the level of detail must stay as simple as the style reference sheet.',
];

const CHILD_IDENTITY_BLOCK = [
  'Child likeness guidance:',
  'Reference image 2: child photo — loose inspiration for broad identity cues only.',
  'Use the child photo only as loose inspiration for broad identity cues.',
  'Keep broad cues from the photo: approximate age, hairstyle, hair color, eye color, skin tone family, cheerful smile, and general personality.',
  'Do not preserve the exact facial structure from the photo.',
  'Do not create a realistic likeness, realistic watercolor portrait, or painted copy of the photo.',
  'Translate the person into a charming hand-drawn children\'s-book character with simplified rounded shapes.',
  'Use simple expressive eyes, a small simplified nose, a warm open smiling mouth appropriate for the child\'s age (small simplified teeth are fine), soft rounded cheeks, and minimal facial detail.',
  'Avoid stiff closed-mouth smiles, cookie-cutter identical eye shapes, and creepy or unsettling expressions.',
  ...ANTI_REALISM_BLOCK,
];

export function buildPortraitPrompt(input: {
  name: string;
  ageDescription: string;
  isAdult: boolean;
  gender?: string | null;
  styleToken: string;
  additionalInfo?: string | null;
}): string {
  const genderHint = input.gender ? ` Gender presentation: ${input.gender}.` : '';
  const additionalInfoString = formatPortraitAdditionalInfo(input.additionalInfo);
  const recognitionCheck = input.isAdult
    ? 'Before finalizing, compare to the style reference sheet: if the rendering looks more realistic or detailed than the reference characters, simplify the rendering only — do not remove identity anchors. Compare to the photo: the character must still be recognizable as that specific adult through simplified face shape, eye shape, smile width, hair part, and jaw/chin impression.'
    : 'Before finalizing, compare the result to the style reference sheet: it should match the reference characters in simplification, proportions, eye shape, nose detail, mouth detail, line softness, and overall cuteness. If it looks more realistic than the reference characters, simplify it further.';

  const photoColorRules = input.isAdult
    ? [
      'Eye color, hair color, skin tone, and hairstyle must match the person photo, not the style reference characters.',
      'Do not borrow or invent eye color, hair color, skin tone, or facial features from the style reference sheet.',
    ]
    : [];

  return [
    'Create a simplified 2D storybook character design for a family memory journal.',
    `Character name: ${input.name}. Age: ${input.ageDescription}.${genderHint}`,
    ...PORTRAIT_STYLE_BLOCK,
    ...photoColorRules,
    ...(input.isAdult ? ADULT_IDENTITY_BLOCK : CHILD_IDENTITY_BLOCK),
    `Head-and-shoulders character design, centered, clean simple background.${additionalInfoString}`,
    'Expressive, but not chibi, not anime, not 3D, not Pixar-like.',
    recognitionCheck,
    'Final result must feel like a reusable illustrated character asset, not a realistic portrait.',
    'No text, no logos, no extra people, no busy background.',
    `Style token: ${input.styleToken}.`,
  ].join(' ');
}

export function buildCharacterSheetAbstractionAddon(isAdult: boolean): string {
  const identityRequirement = isAdult
    ? 'Identity requirement: redraw the adult\'s identity anchors in style-reference language — hair part, face shape, eye shape and spacing, eyebrows, nose impression, smile width, jaw/chin — without realistic facial detail.'
    : 'Identity requirement: preserve hair, eye color, skin tone, and face impression from the photo, not from the style sheet.';

  return [
    'Critical style requirement: the output must match the abstraction level of the style reference sheet.',
    'It should look like it belongs inside that reference sheet.',
    'If the face looks like a realistic watercolor portrait, it is wrong.',
    'Simplify the rendering, reduce realistic shading, and use the same hand-drawn storybook line and texture language as the reference sheet.',
    isAdult
      ? 'Do not oversimplify the adult into a generic cute character, and do not render realistic portrait anatomy. If simplification reduces resemblance to the photo person, restore identity anchors rather than trading likeness for extra abstraction.'
      : 'Simplify the facial anatomy, reduce realistic shading, simplify the eyes, nose, mouth, and teeth, and use the same cute hand-drawn character proportions as the reference sheet.',
    isAdult
      ? 'Do not give every character the same eye shape and stiff closed-mouth smile.'
      : 'Do not flatten every child into the same eye shape and stiff closed-mouth smile.',
    identityRequirement,
  ].join(' ');
}

export function buildLegacyStyleTransferPortraitPrompt(input: {
  ageDescription: string;
  gender?: string | null;
  styleDescription: string;
  additionalInfo?: string | null;
}): string {
  const genderString = formatPortraitGender(input.gender);
  const additionalInfoString = formatPortraitAdditionalInfo(input.additionalInfo);

  return `Create a portrait illustration of the ${input.ageDescription} ${genderString} shown in the first image. Render it in the style of the second image, which has a ${input.styleDescription} style. The person should be smiling and looking directly at the camera.${additionalInfoString} The background should be simple white background. Ensure no text or numbers appear in the image.`;
}

function formatPortraitGender(gender?: string | null): string {
  const trimmed = gender?.trim();

  if (!trimmed || trimmed === 'Prefer not to say') {
    return 'person';
  }

  return trimmed.toLowerCase();
}

function formatPortraitAdditionalInfo(additionalInfo?: string | null): string {
  const normalized = normalizeAdditionalInfo(additionalInfo);

  if (!normalized) {
    return '';
  }

  return ` Additional guidance: ${normalized}`;
}

export function normalizeAdditionalInfo(additionalInfo?: string | null): string | null {
  const trimmed = additionalInfo?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

export interface IllustrationCharacterReferenceInput {
  referenceIndex: number;
  description: string;
}

function buildTaggedHumansConstraint(referenceCount: number): string {
  if (referenceCount <= 0) {
    return '';
  }

  const countLabel = referenceCount === 1 ? 'exactly one human figure' : `only the ${referenceCount} human characters`;
  const referenceLabel = referenceCount === 1
    ? 'reference image 1'
    : 'the character reference images listed above';

  return [
    `Human cast: include ${countLabel} in the scene, each matching ${referenceLabel}.`,
    'Do not draw any other human characters — no extra children, siblings, parents, teachers, classmates, or bystanders — even if the scene text describes a group, party, classroom, or outing.',
    'Non-human subjects from the scene (animals, toys, food, scenery, props) are welcome when they fit the memory.',
  ].join(' ');
}

function buildSceneSection(safeSceneDescription: string): string {
  return [
    'Create a storybook scene illustration for a parenting memory journal.',
    `Scene: ${safeSceneDescription}`,
  ].join('\n');
}

function buildCharactersSection(characterReferences: IllustrationCharacterReferenceInput[]): string {
  const referenceLines = characterReferences.map(
    (reference) => `Reference image ${reference.referenceIndex}: ${reference.description}`,
  );
  const taggedHumansConstraint = buildTaggedHumansConstraint(characterReferences.length);

  return [
    'Characters:',
    'Character reference images:',
    referenceLines.join('\n'),
    taggedHumansConstraint,
    'Match each tagged human character in the scene to their corresponding portrait reference.',
    'PRESERVE from each portrait reference: hairstyle, hair color, skin tone, face shape, approximate age, and a few distinctive features.',
    'ADAPT to the scene: pose, clothing, lighting, and facial expression. The smile in each portrait reference is an identity sample only, not the required expression — expressions follow the Emotional tone section below.',
    'Favor stylization over realism: draw each tagged human as a stylized storybook figure consistent with their portrait reference, simplifying facial structure and interpreting rather than replicating literally.',
  ].join('\n');
}

function buildEmotionalToneSection(emotion?: string | null, expressionStyle?: string): string {
  const normalizedEmotion = normalizeEmotion(emotion);
  const expressionGuidance = normalizedEmotion ? EMOTION_EXPRESSIONS[normalizedEmotion] : undefined;
  const lines = ['Emotional tone:'];

  if (normalizedEmotion && expressionGuidance) {
    lines.push(`${normalizedEmotion}. ${expressionGuidance}.`);
  } else {
    lines.push('Expressions should match the mood of the scene.');
  }

  lines.push('Expressions must match the emotional tone of the memory, not default to smiling.');

  if (
    expressionStyle === 'comedic' &&
    normalizedEmotion &&
    COMEDIC_ELIGIBLE_EMOTIONS.has(normalizedEmotion)
  ) {
    lines.push(
      'Playful exaggerated storybook expressions are welcome: dramatic pouts, scrunched noses, wide comic grimaces, theatrical dismay — in the tradition of humorous children\'s picture books.',
    );
  }

  return lines.join('\n');
}

function buildStyleSection(styleDescription: string, colorPalette: string, memoryDate: string): string {
  return [
    `Illustration style: ${styleDescription}`,
    `Color palette: ${colorPalette}`,
    `Memory date context: ${memoryDate}. Use this only for mood, season, clothing, or setting cues when relevant; do not include written dates or text in the image.`,
  ].join('\n');
}

function buildConstraintsSection(): string {
  return [
    'Constraints:',
    'Do not render realistic painted likenesses or watercolorized photo-style faces.',
    'Do not draw animals, objects, or costumes suggested by character names or nicknames — depict each character only as a human figure per their portrait reference.',
    'No text, no logos, no captions, no speech bubbles, no watermark.',
    IMAGE_STYLE_NEGATIVES,
  ].join('\n');
}

export function buildIllustrationPrompt(input: {
  safeSceneDescription: string;
  characterReferences: IllustrationCharacterReferenceInput[];
  colorPalette: string;
  memoryDate: string;
  styleDescription: string;
  emotion?: string | null;
  expressionStyle?: string;
}): string {
  return [
    buildSceneSection(input.safeSceneDescription),
    buildCharactersSection(input.characterReferences),
    buildEmotionalToneSection(input.emotion, input.expressionStyle),
    buildStyleSection(input.styleDescription, input.colorPalette, input.memoryDate),
    buildConstraintsSection(),
  ].join('\n');
}

export function buildEmotionSystemPrompt(): string {
  const emotionList = Object.keys(EMOTION_PALETTES).join(', ');

  return [
    'You analyze short parenting journal entries and classify the dominant emotion.',
    `Choose exactly one emotion from: ${emotionList}.`,
    'Parenting is not always joyful. When the entry is genuinely about a hard moment, name it honestly with worry, weary, sad, or bittersweet rather than rounding up to a positive emotion.',
    'Respond with JSON only: {"emotion":"...","colorPalette":"..."}',
    'colorPalette should be a short descriptive phrase of 5-12 words matching the mood.',
  ].join(' ');
}

export function buildMediaEmotionSystemPrompt(): string {
  const emotionList = Object.keys(EMOTION_PALETTES).join(', ');

  return [
    'You analyze photos from a parenting memory journal and classify the dominant emotional mood.',
    'When a caption is provided, weigh it together with the image. When no caption is provided, infer mood from the image only.',
    `Choose exactly one emotion from: ${emotionList}.`,
    'Parenting is not always joyful. When the moment is genuinely tender-sad or hard, name it honestly with worry, weary, sad, or bittersweet rather than rounding up to a positive emotion.',
    'Respond with JSON only: {"emotion":"...","colorPalette":"..."}',
    'colorPalette should be a short descriptive phrase of 5-12 words matching the mood.',
  ].join(' ');
}

export function buildEmotionVisionUserPrompt(caption?: string | null): string {
  const trimmed = caption?.trim();

  if (trimmed) {
    return [
      'Classify the dominant emotion for this parenting memory.',
      `Caption: ${trimmed}`,
      'Use both the caption and the attached photo.',
    ].join(' ');
  }

  return 'Classify the dominant emotion for this parenting memory using the attached photo only.';
}

export interface SafetyPromptMember {
  name: string;
  nicknames?: string[] | null;
}

function formatNicknameMappingLine(members: Array<SafetyPromptMember>): string | null {
  const mappings = members
    .map((member) => {
      const nicknames = (member.nicknames ?? []).filter((nickname) => nickname.trim().length > 0);
      return nicknames.length > 0 ? `${nicknames.join('/')} → ${member.name}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));

  return mappings.length > 0 ? `Nickname mapping: ${mappings.join(', ')}.` : null;
}

export function buildSafetySystemPrompt(members: Array<SafetyPromptMember> = []): string {
  const nicknameMappingLine = formatNicknameMappingLine(members);

  return [
    'Rewrite parenting journal content into a child-safe illustrated scene description.',
    'Remove unsafe, violent, sexual, or disturbing details while preserving emotional truth.',
    'Preserve the memory\'s actual emotional tone: if the child is sick, upset, or struggling, keep that in the scene — do not invent smiles, cheerfulness, or comforting details the memory does not describe.',
    'Keep it concise (1-3 sentences). No names of real brands.',
    nicknameMappingLine,
    nicknameMappingLine
      ? 'Replace every nickname or alias mention in the safeDescription with that family member\'s canonical name from the mapping above.'
      : null,
    'Never treat a nickname or pet name as a literal visual element — a nickname like "cheeky monkey" or "tiger" must never introduce an animal, object, or costume into the scene description.',
    'Also judge whether the memory is genuinely funny or mischievous (a dramatic toddler meltdown, a kid theatrically refusing food, a silly mishap) versus a warm/tender moment or anything harder or more neutral.',
    'expressionStyle must be exactly one of: "comedic" (genuinely funny or mischievous moments only), "tender" (warm, gentle, heartfelt moments), or "neutral" (everything else, including hard or difficult moments).',
    'JSON only: {"safeDescription":"...","expressionStyle":"comedic"|"tender"|"neutral"}',
  ].filter((line): line is string => Boolean(line)).join(' ');
}

export function buildVoiceCleanupSystemPrompt(): string {
  return [
    'Clean up a voice transcript for a parenting journal entry.',
    'Fix grammar lightly, remove filler words, preserve meaning and names.',
    'Detect if the speaker refers to themselves as parent (I, me, my) → set mentionedUserSelf true.',
    'JSON only: {"cleanedText":"...","mentionedUserSelf":false}',
  ].join(' ');
}

export function buildTranscriptionPrompt(
  members: Array<{ name: string; nicknames?: string[] }>,
): string {
  const names = members.flatMap((member) => [member.name, ...(member.nicknames ?? [])]);
  const uniqueNames = [...new Set(names.filter(Boolean))];

  if (uniqueNames.length === 0) {
    return 'Transcribe this parenting journal voice memo accurately.';
  }

  return `Transcribe this parenting journal voice memo. Family names that may appear: ${uniqueNames.join(', ')}.`;
}
