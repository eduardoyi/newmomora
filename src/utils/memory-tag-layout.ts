export interface CalculateInlineTagCountInput {
  chipWidths: readonly (number | undefined)[];
  containerWidth: number;
  gap: number;
  moreChipWidth: number;
}

function isMeasuredWidth(width: number | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

function sumWidths(widths: readonly number[], count: number): number {
  return widths.slice(0, count).reduce((total, width) => total + width, 0);
}

export function calculateInlineTagCount({
  chipWidths,
  containerWidth,
  gap,
  moreChipWidth,
}: CalculateInlineTagCountInput): number | null {
  const totalMembers = chipWidths.length;
  const rowGap = Math.max(gap, 0);

  if (totalMembers === 0) {
    return 0;
  }

  if (!isMeasuredWidth(containerWidth) || !isMeasuredWidth(moreChipWidth)) {
    return null;
  }

  if (!chipWidths.every(isMeasuredWidth)) {
    return null;
  }

  const measuredChipWidths = chipWidths as readonly number[];
  const allChipsWidth =
    sumWidths(measuredChipWidths, totalMembers) + rowGap * Math.max(totalMembers - 1, 0);

  if (allChipsWidth <= containerWidth) {
    return totalMembers;
  }

  for (let count = totalMembers - 1; count >= 0; count -= 1) {
    const gapsWidth = count > 0 ? rowGap * count : 0;
    const rowWidth = sumWidths(measuredChipWidths, count) + moreChipWidth + gapsWidth;

    if (rowWidth <= containerWidth) {
      return count;
    }
  }

  return 0;
}

export function formatMoreTagLabel(hiddenSelectedCount: number): string {
  if (hiddenSelectedCount <= 0) {
    return '+ More';
  }

  return `+ More · ${hiddenSelectedCount}`;
}
