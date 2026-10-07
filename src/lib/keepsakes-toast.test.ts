import { consumePendingKeepsakesToast, setPendingKeepsakesToast } from '@/lib/keepsakes-toast';

describe('keepsakes toast store', () => {
  it('returns null when nothing is pending', () => {
    expect(consumePendingKeepsakesToast()).toBeNull();
  });

  it('hands the text over exactly once', () => {
    setPendingKeepsakesToast('We’re making your Year One book…');
    expect(consumePendingKeepsakesToast()).toBe('We’re making your Year One book…');
    expect(consumePendingKeepsakesToast()).toBeNull();
  });

  it('keeps only the latest text', () => {
    setPendingKeepsakesToast('first');
    setPendingKeepsakesToast('second');
    expect(consumePendingKeepsakesToast()).toBe('second');
  });
});
