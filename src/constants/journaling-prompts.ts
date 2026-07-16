// Rotating placeholder copy for the new-memory composer's text field
// (app/(app)/new-memory.tsx). A prompt is picked once per screen-open (see
// `pickJournalingPrompt`) so it stays stable for the life of that mount --
// it is placeholder text only and is never inserted into the field or
// submitted with the memory.
//
// Deliberately NOT personalized with family member names (explicit product
// decision -- see docs/features/memories.md). Voice matches existing empty
// states / hints in the app (timeline empty state, family empty state):
// short, warm, second person, no exclamation points.
export const JOURNALING_PROMPTS: readonly string[] = [
  'What happened on this day?',
  'What made you smile today?',
  'What is one small thing worth remembering?',
  'What surprised you today?',
  'What did today feel like?',
  'What is a moment you do not want to forget?',
  'What was said today that is worth keeping?',
  'What almost slipped by unnoticed?',
  'What was worth pausing for today?',
  'What would you want to remember about today, a year from now?',
  'What made today feel ordinary in the best way?',
  'What was hard today, and what helped?',
  'What is still making you smile from earlier?',
  'What did you notice for the first time today?',
  'What small victory happened today?',
];

/**
 * Picks one prompt at random. `random` defaults to `Math.random` and exists
 * as a seam so callers/tests can supply a deterministic source instead.
 */
export function pickJournalingPrompt(random: () => number = Math.random): string {
  const index = Math.min(
    Math.floor(random() * JOURNALING_PROMPTS.length),
    JOURNALING_PROMPTS.length - 1,
  );
  return JOURNALING_PROMPTS[index];
}
