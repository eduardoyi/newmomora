// Resolves an audio memory's emotion into the three colors every sound
// surface needs (fill, wash, ink). Keeps the app's real `emotionColors`
// palette (src/constants/theme.ts) as the single source of truth -- this
// file only maps its shape onto what the audio kit's prototype
// (audio-kit.jsx: `moEmo`) expected, plus the approved neutral state.
//
// Every audio memory is BORN with `emotion: null` (analysis runs
// fire-and-forget after save, and babble/silence never gets a label at
// all -- see docs/features/audio-memories.md). Rendering that as "no
// color" or a greyed-out placeholder would read as broken. The design
// handoff's approved fix is a graphite neutral -- ink `#6B5E4F` / wash
// `#F4F3F8` -- deliberately the same pair theme.ts's own
// `getEmotionGradient()` falls back to ([colors.surface, colors.bg,
// colors.bg]) for a memory with no emotion yet. Do not invent a different
// neutral treatment; this is the approved one (docs/plans/audio-memories-v1.md P3.1).
import { colors, emotionColors, type EmotionName } from '@/constants/theme';

export interface AudioEmotionColors {
  /** The saturated emotion color -- seal fill, played-ink tint source, tile accent. */
  main: string;
  /** The soft wash used for card/stub background tints. */
  soft: string;
  /** The ink tone used for trace strokes and small glyphs (readable at 1-2px). */
  ink: string;
  /** True when this is the pre-analysis / no-emotion neutral, not a real emotion. */
  neutral: boolean;
}

export const AUDIO_NEUTRAL_COLORS: AudioEmotionColors = {
  main: colors.ink2,
  soft: colors.surface,
  ink: colors.ink2,
  neutral: true,
};

/**
 * `emotion` is nullable everywhere in the audio kit -- null before analysis
 * lands (every clip's birth state) and permanently for babble/silence that
 * never gets classified. An unrecognized string (future label added to the
 * classifier before the app updates) falls back to the same neutral rather
 * than throwing or rendering an undefined color.
 */
export function resolveAudioEmotionColors(emotion: string | null | undefined): AudioEmotionColors {
  if (!emotion || !(emotion in emotionColors)) {
    return AUDIO_NEUTRAL_COLORS;
  }
  const emo = emotionColors[emotion as EmotionName];
  return { main: emo.c, soft: emo.soft, ink: emo.ink, neutral: false };
}

/** Shared "m:ss" formatter -- clip durations/positions are always sub-2-minute (v1 cap). */
export function formatClipTime(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
