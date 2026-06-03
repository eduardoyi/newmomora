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

describe('formatMoreTagLabel', () => {
  it('keeps the default label when no selected members are hidden', () => {
    expect(formatMoreTagLabel(0)).toBe('+ More');
  });

  it('shows the hidden selected count in the more label', () => {
    expect(formatMoreTagLabel(2)).toBe('+ More · 2');
  });
});
