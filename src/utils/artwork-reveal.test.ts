import {
  consumeArtworkReveal,
  markArtworkForReveal,
  resetArtworkReveals,
} from '@/utils/artwork-reveal';

describe('artwork reveal marks', () => {
  beforeEach(() => resetArtworkReveals());

  it('is false for a memory that was never marked (loaded from the server)', () => {
    expect(consumeArtworkReveal('memory-1')).toBe(false);
  });

  it('is true exactly once per mark', () => {
    markArtworkForReveal('memory-1');
    expect(consumeArtworkReveal('memory-1')).toBe(true);
    expect(consumeArtworkReveal('memory-1')).toBe(false);
  });

  it('keeps marks per memory', () => {
    markArtworkForReveal('memory-1');
    markArtworkForReveal('memory-2');
    expect(consumeArtworkReveal('memory-2')).toBe(true);
    expect(consumeArtworkReveal('memory-3')).toBe(false);
    expect(consumeArtworkReveal('memory-1')).toBe(true);
  });

  it('marking twice still reveals once', () => {
    markArtworkForReveal('memory-1');
    markArtworkForReveal('memory-1');
    expect(consumeArtworkReveal('memory-1')).toBe(true);
    expect(consumeArtworkReveal('memory-1')).toBe(false);
  });
});
