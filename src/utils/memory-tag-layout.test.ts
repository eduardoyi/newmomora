import { calculateInlineTagCount, formatMoreTagLabel } from './memory-tag-layout';

describe('calculateInlineTagCount', () => {
  it('shows every member when all chips fit in the row', () => {
    expect(
      calculateInlineTagCount({
        chipWidths: [50, 60, 70],
        containerWidth: 196,
        gap: 8,
        moreChipWidth: 72,
      }),
    ).toBe(3);
  });

  it('reserves space for the more chip when members are hidden', () => {
    expect(
      calculateInlineTagCount({
        chipWidths: [50, 50, 50, 50],
        containerWidth: 156,
        gap: 8,
        moreChipWidth: 40,
      }),
    ).toBe(2);
  });

  it('hides every member chip when only the more chip fits', () => {
    expect(
      calculateInlineTagCount({
        chipWidths: [90, 90],
        containerWidth: 50,
        gap: 8,
        moreChipWidth: 40,
      }),
    ).toBe(0);
  });

  it('waits for all measurements before calculating the row', () => {
    expect(
      calculateInlineTagCount({
        chipWidths: [50, undefined],
        containerWidth: 156,
        gap: 8,
        moreChipWidth: 40,
      }),
    ).toBeNull();
  });
});

describe('calculateInlineTagCount with a trailing chip', () => {
  it('shows every member when they fit together with the trailing chip', () => {
    expect(
      calculateInlineTagCount({
        chipWidths: [80, 80],
        containerWidth: 220,
        gap: 8,
        moreChipWidth: 60,
        trailingChipWidth: 36,
      }),
    ).toBe(2);
  });

  it('switches to overflow when members fit but the trailing chip does not', () => {
    // 80 + 8 + 80 = 168 fits in 200, but + 8 + 36 = 212 does not, so the row
    // falls back to one chip + the more chip (80 + 8 + 60 = 148).
    expect(
      calculateInlineTagCount({
        chipWidths: [80, 80],
        containerWidth: 200,
        gap: 8,
        moreChipWidth: 60,
        trailingChipWidth: 36,
      }),
    ).toBe(1);
  });
});

describe('formatMoreTagLabel', () => {
  it('keeps the default label when no selected members are hidden', () => {
    expect(formatMoreTagLabel(0)).toBe('+ More');
  });

  it('shows the hidden selected count in the more label', () => {
    expect(formatMoreTagLabel(2)).toBe('+ More · 2');
  });
});
