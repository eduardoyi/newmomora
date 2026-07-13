export const colors = {
  bg: '#FAFAFD',
  surface: '#F4F3F8',
  surface2: '#F2EFF8',
  border: '#EBE7F2',
  borderStrong: '#CFC8E0',
  white: '#FFFFFF',

  ink: '#2C2418',
  ink2: '#6B5E4F',
  ink3: '#9A8B79',

  primary: '#D63E78',
  primaryDark: '#B22A60',
  primarySoft: '#FBD3E2',
  primaryTint: '#FDEAF1',

  error: '#B42318',
  errorSoft: '#FCE4E1',
  success: '#4F8A5E',
  successSoft: '#DCEADD',

  sea: '#3FA8A1',
  seaSoft: '#C9ECE9',
  seaInk: '#1f5a56',

  // Legacy aliases for backward compat
  background: '#FAFAFD',
  text: '#2C2418',
  textMuted: '#6B5E4F',
  primaryDarkLegacy: '#B22A60',
} as const;

// Keep keys in sync with EMOTION_PALETTES in supabase/functions/_shared/prompts.ts —
// that map drives the classifier's allowed labels, this one drives UI color.
export const emotionColors = {
  // Warm / positive
  joy:         { c: '#F5A623', soft: '#FFE7B0', ink: '#8a5b13' },
  funny:       { c: '#F07E3A', soft: '#FCDCC0', ink: '#8a4416' },
  calm:        { c: '#6BB58A', soft: '#D6EDDE', ink: '#3f6a4c' },
  wonder:      { c: '#4F8FCC', soft: '#CFE1F4', ink: '#3a5b7a' },
  tender:      { c: '#EC7FA1', soft: '#FBD6E1', ink: '#9c4f68' },
  mischief:    { c: '#9863B8', soft: '#E5D2F1', ink: '#5c4374' },
  pride:       { c: '#E0654E', soft: '#F8D6CC', ink: '#893524' },
  // Wistful / mixed
  bittersweet: { c: '#C77FA0', soft: '#EFD7E1', ink: '#743f59' },
  // Harder moments
  worry:       { c: '#5C7A9B', soft: '#D7E0EA', ink: '#354a63' },
  weary:       { c: '#8F8A86', soft: '#E6E1DD', ink: '#524d49' },
  sad:         { c: '#6A6CA6', soft: '#DCDCEF', ink: '#3f4066' },
} as const;

export type EmotionName = keyof typeof emotionColors;

export function getEmotionColors(emotion: string | null | undefined) {
  if (!emotion || !(emotion in emotionColors)) return null;
  return emotionColors[emotion as EmotionName];
}

// Soft top-down gradient stops for the memory detail background. Falls back to a
// neutral surface→bg fade when the emotion is unknown or not yet analyzed.
export function getEmotionGradient(emotion: string | null | undefined): [string, string, string] {
  const emo = getEmotionColors(emotion);
  if (!emo) {
    return [colors.surface, colors.bg, colors.bg];
  }
  return [emo.soft, colors.bg, colors.bg];
}

export const fonts = {
  display: 'Newsreader_400Regular',
  displayItalic: 'Newsreader_400Regular_Italic',
  displayMedium: 'Newsreader_500Medium',
  sans: 'PlusJakartaSans_400Regular',
  sansMedium: 'PlusJakartaSans_500Medium',
  sansBold: 'PlusJakartaSans_700Bold',
  script: 'Caveat_400Regular',
  scriptBold: 'Caveat_700Bold',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;
