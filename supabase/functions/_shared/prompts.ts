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
    ...CAMERA_DIRECTION_INSTRUCTIONS,
    'JSON only: {"safeDescription":"...","expressionStyle":"comedic"|"tender"|"neutral","shotOptions":["bold ...","unusual ...","quiet ..."],"cameraDirection":"..."}',
  ].filter((line): line is string => Boolean(line)).join(' ');
}

/**
 * Camera director (docs/features/illustration-camera-direction.md). The same
 * safety-rewrite call also stages the picture: it drafts a bold, an unusual
 * and a quiet shot, then picks one by mood. Without it the image model
 * defaults to the same centered medium shot of smiling faces every time.
 * Rules here mirror failures seen in the 2026-11-06 evals: added people,
 * invented appearance, provider rejections of in-tub bath shots, kids in the
 * front seat.
 */
const CAMERA_DIRECTION_INSTRUCTIONS = [
  'Finally, act as the cinematographer and stage the scene as one still image. Draft three different shots in shotOptions: a bold one (the most surprising idea the memory can justify), an unusual but realistic angle, and a quiet observational frame. Then copy the text of the one that makes this memory land best into cameraDirection (the shot itself, without its label): funny or mischievous memories usually take the bold one; tender or wondrous ones the bold or unusual one; hard moments (sick, sad, tantrums, worry) the quiet one.',
  'Toolbox: worm\'s-eye from the floor looking up (a child towers like a giant), straight down from the ceiling (toys or laundry as a pattern), high angle from a doorway, child\'s eye level, extreme wide with tiny figures, extreme close-up of one telling detail, the point of view of an object in the story, a listed parent\'s own view with only their hands in frame, over-the-shoulder, a reflection in a mirror, framing through a doorway or under a table, a tilted frame for chaos.',
  'Make what the child imagines visible as if it were real (a hug the wind carried away floating in the sky as a little cloud, a cardboard box that is truly a bus on a road), and sounds or feelings visible without words (a burp as a little puff, a song as drifting ripples).',
  'Example of the boldness and literal detail wanted (not this memory): a toddler pretending to be a dinosaur by her block tower → "The camera lies flat on the kitchen floor among the wooden blocks, lens pointing steeply up like a monster movie; the tower looms in the foreground and the toddler TOWERS behind it, arms up like claws mid-roar, gleeful face near the top edge."',
  'Each shot is 1-3 sentences in English: where the camera physically is, what fills the foreground, how much of the frame each person takes, and the one staging idea.',
  'Shot rules: only people the memory mentions, never anyone else (no helper, bystander, or searcher). Never describe anyone\'s appearance (eyes, hair, glasses, skin, clothing colors); describe position, pose, action and expression only. Every person stays recognizable with a readable face. Keep the emotional tone honest. A child in a bath scene is out of the water, in pajamas or wrapped in a towel. Children in a car sit in their car seat in the back. Everything stays child-safe.',
];

const CAMERA_DIRECTION_LEAD =
  'Camera and staging (the most important composition instruction: follow it literally, even when the angle, distance or crop is extreme or unusual; never fall back to a centered medium shot): ';
const MAX_CAMERA_DIRECTION_CHARS = 900;
// The model sometimes keeps its draft label ("Unusual — Frame the moment…").
const SHOT_LABEL_PREFIX = /^(bold|unusual|quiet)\b\s*(shot)?\s*[:—–-]\s*/i;

/**
 * Appends the safety call's chosen shot to the scene text. Both illustration
 * backends store and render this one string (the Cloudflare job row's
 * `safe_scene_description`), so the camera direction needs no extra column;
 * a missing or blank shot leaves the scene exactly as before.
 */
export function buildSceneWithCameraDirection(
  safeSceneDescription: string,
  cameraDirection?: unknown,
): string {
  const shot = typeof cameraDirection === 'string'
    ? cameraDirection.trim().replace(SHOT_LABEL_PREFIX, '').trim().slice(0, MAX_CAMERA_DIRECTION_CHARS)
    : '';
  return shot ? `${safeSceneDescription}\n${CAMERA_DIRECTION_LEAD}${shot}` : safeSceneDescription;
}

export interface VoiceCleanupMemberContext {
  name: string;
  nicknames?: string[];
  /** Derived label (e.g. "3 years old"), never a birth date — computed by the caller. */
  ageLabel?: string | null;
}

function describeVoiceCleanupMember(member: VoiceCleanupMemberContext): string {
  const parts = [member.name];
  if (member.ageLabel) parts.push(member.ageLabel);
  if (member.nicknames && member.nicknames.length > 0) {
    parts.push(`nicknames: ${member.nicknames.join(', ')}`);
  }
  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join('; ')})` : parts[0];
}

export function buildVoiceCleanupSystemPrompt(
  options: { includeDescription?: boolean; members?: VoiceCleanupMemberContext[] } = {},
): string {
  const lines = [
    'Clean up a voice transcript for a parenting journal entry.',
    'Fix grammar lightly, remove filler words, preserve meaning and names.',
    'Never translate words the speaker said in another language (e.g. English words like "time out" in Spanish speech): keep them as spoken.',
    'Detect if the speaker refers to themselves as parent (I, me, my) → set mentionedUserSelf true.',
  ];

  if (!options.includeDescription) {
    lines.push('JSON only: {"cleanedText":"...","mentionedUserSelf":false}');
    return lines.join(' ');
  }

  // Caption context (audio memories): names anchor spelling and third-person
  // framing; nicknames resolve to canonical names (same rule as the
  // illustration pipeline — a nickname like "cheeky monkey" must never leak
  // into a caption literally); ages inform interpretation only.
  if (options.members && options.members.length > 0) {
    lines.push(
      `Family members: ${options.members.map(describeVoiceCleanupMember).join('; ')}.`,
      'In the caption, refer to family members by their canonical name (resolve nicknames to the real name); use their ages only to interpret what is happening — never state an age in the caption unless the speaker said it. Only name a family member when the speech clearly refers to them — never guess who is in the recording.',
    );
  }

  // Audio-memories "keep the sound" fork (docs/features/audio-memories.md):
  // one extra field on the same cleanup call, not a second provider call.
  lines.push(
    'Also write a short third-person caption describing what the recording is, under 120 characters (examples: "Lila singing Twinkle Twinkle in the bath" / "Tomás contando lo que hizo en la escuela").',
    'Write the caption in the same language the speaker used.',
    'If you can understand ANY of the speaker\'s words, you MUST write a caption — mundane, short, or test recordings included (someone trying out the microphone gets a plain caption of what they said).',
    'An empty-string description "" is reserved for recordings with no intelligible words at all — silence, pure noise, and wordless baby babble or sound play ("ba ba", "goo goo") all count as no intelligible words. Never invent a description for those, never output filler like "...", and never return "" when actual words were understood.',
    'JSON only: {"cleanedText":"...","description":"...","mentionedUserSelf":false}',
  );
  return lines.join(' ');
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

// Living portraits (docs/plans/living-portraits.md). Ported verbatim from
// `livingSpritePrompt` in supabase/scripts/eval-portrait.ts (the spike that
// validated it): one image edit with the still as the only reference returns
// a frame sheet that the app plays back as a quiet looping portrait.
const MOTION_FRAME_WORDS: Record<number, string> = { 6: 'sixth', 9: 'ninth' };

export function buildPortraitMotionPrompt(columns: number, rows: number): string {
  return [
    'Create a single animation sprite sheet for a seamless looping living portrait of the character in the reference',
    'image, like a gently enchanted painted portrait that quietly comes alive.',
    'Keep this exact character in every frame: same face, hair, skin tone, outfit, proportions and illustration style',
    'as the reference. It must clearly be the same person throughout.',
    'The motion is subtle and calm: the character breathes softly, tilts their head a few degrees to one side and',
    'slowly back, blinks once, and their expression warms from a soft smile to a slightly bigger smile and back.',
    'No waving, no hand or arm gestures; hands stay where they are in the reference.',
    `Exactly ${columns * rows} sequential frames arranged in a precise ${columns}-column by ${rows}-row grid,`,
    'read left-to-right then top-to-bottom. Every panel has identical dimensions.',
    'Fixed camera: identical framing and head size in every panel; the head moves only slightly.',
    'Same background as the reference in every panel, and the background does not change or move.',
    `Small incremental changes between frames; the ${MOTION_FRAME_WORDS[columns * rows] ?? 'last'} frame transitions smoothly`,
    'back to the first.',
    'No motion lines, no added sparkles, no captions, no words, no numbers, no logos, no speech bubbles,',
    'no panel labels, no borders, no gutters.',
  ].join(' ');
}

// QA vision check for a generated motion sheet (gpt-4o-mini, JSON mode).
// Image 1 = the still, image 2 = the sheet. Deliberately generic: no names,
// ages or other family details are ever sent with it.
export const PORTRAIT_MOTION_CHECK_PROMPT = [
  'You are a strict quality checker for an animated character portrait.',
  'Image 1 is the reference portrait. Image 2 is a sheet of nine animation frames of that character,',
  'arranged in a 3-column by 3-row grid.',
  'Answer these four questions about image 2 and reply with JSON only, in exactly this shape:',
  '{"same_person": boolean, "equal_panels": boolean, "no_text_or_borders": boolean, "stable_framing": boolean}',
  'same_person: true only if all nine panels clearly show the same person as image 1 (same face, hair, skin tone, outfit and illustration style).',
  'equal_panels: true only if the sheet is a clean grid of nine equally sized panels with one frame in each.',
  'no_text_or_borders: true only if there is no text, numbers, logos, labels, speech bubbles, borders or gutters between or inside panels.',
  'stable_framing: true only if the camera, framing, head size and background are consistent across all nine panels.',
  'Do not describe the person and do not output anything except the JSON object.',
].join(' ');
