import type { BookPageVariant } from '../model/types';

/** Cycles the fitter's rank 2-3 alternates live — proves the variant mechanism. */
export function VariantSwitcher({
  variants,
  selectedIndex,
  onSelect,
}: {
  variants: BookPageVariant[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  if (variants.length <= 1) return null;
  return (
    <div className="variant-switcher">
      <span className="variant-switcher__label">Layout</span>
      {variants.map((v, i) => (
        <button
          key={i}
          type="button"
          className={`variant-switcher__btn${i === selectedIndex ? ' variant-switcher__btn--active' : ''}`}
          onClick={() => onSelect(i)}
          title={`score ${v.score.toFixed(2)}`}
        >
          {v.templateId}
        </button>
      ))}
    </div>
  );
}
