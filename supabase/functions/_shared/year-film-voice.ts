// Year Film voice check (docs/plans/year-film.md §5 scene 3; F2). The sound
// scene plays a child's voice — from an audio memory, or from a video clip
// when no audio memory exists. Before a clip carries that scene, an
// audio-capable model listens to the chosen excerpt and says whether a
// young child is clearly heard. Pure: request body + parsing; the fetch
// lives with the caller. Fail-closed: no valid verdict = not verified.

export const VOICE_CHECK_MODEL = 'gpt-audio-1.5';

export type ChildVoice = 'clear' | 'faint' | 'none';

export interface VoiceCheck {
  childVoice: ChildVoice;
  /** An adult's voice is the main thing heard (parent narrating, TV…). */
  adultDominant: boolean;
  /** The excerpt opens on the child's voice — not a cough, bump or noise
   * (owner, F2 review: September's excerpt started with coughing). */
  startsCleanly: boolean;
  /** What's heard, a few words — storyboard/debug only, never rendered. */
  heard: string;
}

export function buildVoiceCheckRequestBody(wavBase64: string, childName: string, model = VOICE_CHECK_MODEL): Record<string, unknown> {
  const instructions = [
    `This audio excerpt may be used in a family film as "the sound of the year" for a young child named ${childName}.`,
    'Listen and answer with STRICT JSON only, no prose:',
    '{"child_voice":"clear|faint|none","adult_dominant":true|false,"starts_cleanly":true|false,"heard":"<at most 10 words describing what you hear>"}',
    '- child_voice "clear": a young child (baby to ~6 years) is plainly heard talking, singing, babbling or laughing for most of the excerpt.',
    '- "faint": a child is heard only briefly, far away, or under other sounds.',
    '- "none": no child\'s voice (only adults, music, TV, wind, traffic, silence).',
    '- adult_dominant: true when an adult voice is the main thing heard.',
    '- starts_cleanly: true when the first second is the child\'s voice (or a clean lead-in), false if it opens on a cough, sneeze, bump, rustle or other noise.',
    'When unsure, choose the more conservative answer ("faint" over "clear").',
  ].join('\n');
  return {
    model,
    modalities: ['text'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instructions },
          { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } },
        ],
      },
    ],
  };
}

const VOICES: ReadonlySet<string> = new Set(['clear', 'faint', 'none']);

/** Tolerates prose or code fences around the JSON; anything else → null. */
export function parseVoiceCheck(raw: string | null): VoiceCheck | null {
  if (!raw) return null;
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const childVoice = parsed.child_voice;
  if (typeof childVoice !== 'string' || !VOICES.has(childVoice)) return null;
  if (typeof parsed.adult_dominant !== 'boolean' || typeof parsed.starts_cleanly !== 'boolean') return null;
  return {
    childVoice: childVoice as ChildVoice,
    adultDominant: parsed.adult_dominant,
    startsCleanly: parsed.starts_cleanly,
    heard: typeof parsed.heard === 'string' ? parsed.heard.trim().slice(0, 120) : '',
  };
}

/** Good enough to carry the sound scene. */
export function isVoiceVerified(check: VoiceCheck | null): boolean {
  return !!check && check.childVoice === 'clear' && !check.adultDominant && check.startsCleanly;
}
