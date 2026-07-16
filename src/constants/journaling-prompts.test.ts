import { JOURNALING_PROMPTS, pickJournalingPrompt } from '@/constants/journaling-prompts';

describe('journaling prompts', () => {
  it('includes the original static placeholder', () => {
    expect(JOURNALING_PROMPTS).toContain('What happened on this day?');
  });

  it('has around 15 curated prompts, all unique non-empty strings', () => {
    expect(JOURNALING_PROMPTS.length).toBeGreaterThanOrEqual(12);
    expect(JOURNALING_PROMPTS.length).toBeLessThanOrEqual(20);
    expect(new Set(JOURNALING_PROMPTS).size).toBe(JOURNALING_PROMPTS.length);
    for (const prompt of JOURNALING_PROMPTS) {
      expect(prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('never personalizes with a name -- no prompt contains "{" (template-style interpolation)', () => {
    for (const prompt of JOURNALING_PROMPTS) {
      expect(prompt).not.toMatch(/[{}]/);
    }
  });

  it('picks the prompt at the index implied by the random source', () => {
    expect(pickJournalingPrompt(() => 0)).toBe(JOURNALING_PROMPTS[0]);
    expect(pickJournalingPrompt(() => 0.999999)).toBe(
      JOURNALING_PROMPTS[JOURNALING_PROMPTS.length - 1],
    );
  });

  it('clamps an out-of-range random value to the last prompt instead of throwing', () => {
    expect(pickJournalingPrompt(() => 1)).toBe(JOURNALING_PROMPTS[JOURNALING_PROMPTS.length - 1]);
  });

  it('defaults to Math.random when no source is supplied', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const middleIndex = Math.floor(0.5 * JOURNALING_PROMPTS.length);
      expect(pickJournalingPrompt()).toBe(JOURNALING_PROMPTS[middleIndex]);
    } finally {
      spy.mockRestore();
    }
  });
});
