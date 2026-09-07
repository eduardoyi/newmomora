import { useEffect, useState, type RefObject } from 'react';
import type { BookManifest, BookPage } from '../../model/types';
import type { MemoryBookEditsShape } from '../../model/edits';
import { computeEditablePhotoSlots, computeTextFields, type EditablePhotoSlot } from '../book/editableFields';
import { photoSelectorPlanForPage, resolveTextAnchor, type TextAnchorPlan } from './geometry';

/**
 * The DOM-reading half of the inline-editing overlay (polish-round item 3).
 * See `geometry.ts`'s header comment for why this reads real rendered
 * `getBoundingClientRect()`s (via stable selectors/structural traversal
 * `geometry.ts` already resolved) rather than re-deriving mm rects from the
 * layout modules by hand — this hook is the only place that touches the
 * DOM; everything it delegates to is pure and independently testable.
 *
 * Never mutates, reads, or attaches anything to the template DOM nodes it
 * queries — purely observational (`querySelector`/`getBoundingClientRect`)
 * — so the single-renderer rule's "zero props/markup added to template
 * components" holds by construction: nothing here could add markup even by
 * accident, since it never calls a template component or touches JSX.
 */

export interface DOMRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PositionedPhotoRegion {
  kind: 'photo';
  key: string;
  memoryId: string | null;
  assetFile: string;
  isCover: boolean;
  rect: DOMRectLike;
}

export interface PositionedTextRegion {
  kind: 'text';
  target: string;
  label: string;
  value: string;
  multiline: boolean;
  placeholder?: string;
  /** True when the primary DOM node for this target isn't rendered yet (no
   * saved value there today) and the rect anchors to a documented fallback
   * location instead — see `geometry.ts`'s `TextAnchorPlan`. */
  approximate: boolean;
  rect: DOMRectLike;
}

interface OverlayGeometry {
  photoRegions: PositionedPhotoRegion[];
  textRegions: PositionedTextRegion[];
}

const EMPTY: OverlayGeometry = { photoRegions: [], textRegions: [] };

export function useOverlayGeometry(
  containerRef: RefObject<HTMLElement | null>,
  pages: BookPage[],
  edits: MemoryBookEditsShape,
  manifest: BookManifest,
): OverlayGeometry {
  const [geometry, setGeometry] = useState<OverlayGeometry>(EMPTY);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setGeometry(EMPTY);
      return;
    }

    function recompute() {
      const containerEl = containerRef.current;
      if (!containerEl) return;
      const containerRect = containerEl.getBoundingClientRect();
      // `.page-frame` (`data-testid="page-frame"`, see PageFrame.tsx) is
      // rendered exactly once per entry in `pages`, IN ORDER — a facing
      // pair's two halves, a solo unit's one page, or the item-2 synthetic
      // closing partner (which also renders a real, if empty, PageFrame via
      // `Blank.tsx`) all preserve this 1:1 index correspondence.
      const pageFrames = Array.from(containerEl.querySelectorAll<HTMLElement>('[data-testid="page-frame"]'));

      const photoRegions: PositionedPhotoRegion[] = [];
      const textRegions: PositionedTextRegion[] = [];

      pages.forEach((page, pageIndex) => {
        const frame = pageFrames[pageIndex];
        if (!frame) return;

        const plan = photoSelectorPlanForPage(page);
        if (plan) {
          const photoSlots = computeEditablePhotoSlots([page], edits);
          const nodes = Array.from(frame.querySelectorAll<HTMLElement>(plan.selector));
          if (plan.perSlot) {
            photoSlots.forEach((slot, i) => {
              const node = nodes[i];
              if (node) photoRegions.push(toPhotoRegion(slot, node, containerRect));
            });
          } else if (nodes[0] && photoSlots[0]) {
            photoRegions.push(toPhotoRegion(photoSlots[0], nodes[0], containerRect));
          }
        }

        // A consolidated footer-index row (several memories' numerals on one
        // line, sharing one `note` — see `FooterIndex.tsx`) resolves EVERY
        // one of those memories' own `caption:<memoryId>` target to the SAME
        // DOM node (`geometry.ts`'s `footer-row` strategy keys by
        // `entryIndex`, not memory id). Without de-duplicating, each would
        // push its own full-size region at the identical rect — invisible
        // stacked hitboxes where only the topmost is ever clickable, and the
        // rest were only reachable through the now-removed `EditPanel`
        // fallback list. Tracked per-page (a `footerIndex` never spans
        // pages) so exactly ONE hitbox renders per rendered row, whichever
        // of its memories' targets is encountered first.
        const claimedFooterRowNodes = new Set<HTMLElement>();

        const textFields = computeTextFields([page], manifest);
        for (const field of textFields) {
          const anchorPlan = resolveTextAnchor(page, field.target);
          if (!anchorPlan) continue;
          const found = resolveAnchorNode(frame, anchorPlan);
          if (!found) continue;
          if (anchorPlan.strategy === 'footer-row') {
            if (claimedFooterRowNodes.has(found.node)) continue;
            claimedFooterRowNodes.add(found.node);
          }
          textRegions.push({
            kind: 'text',
            target: field.target,
            label: field.label,
            value: field.value,
            multiline: field.multiline,
            placeholder: field.placeholder,
            approximate: found.approximate,
            rect: relativeRect(found.node.getBoundingClientRect(), containerRect),
          });
        }
      });

      setGeometry({ photoRegions, textRegions });
    }

    recompute();

    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    // Image loads / edit-driven re-renders change layout without firing a
    // resize on the observed container (its own box may stay the same size
    // while its content shifts) — a MutationObserver catches those too.
    const mo = new MutationObserver(recompute);
    mo.observe(container, { childList: true, subtree: true, attributes: true });
    window.addEventListener('resize', recompute);

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [containerRef, pages, edits, manifest]);

  return geometry;
}

function toPhotoRegion(slot: EditablePhotoSlot, node: HTMLElement, containerRect: DOMRect): PositionedPhotoRegion {
  return {
    kind: 'photo',
    key: slot.key,
    memoryId: slot.memoryId,
    assetFile: slot.assetFile,
    isCover: slot.isCover,
    rect: relativeRect(node.getBoundingClientRect(), containerRect),
  };
}

function resolveAnchorNode(frame: HTMLElement, plan: TextAnchorPlan): { node: HTMLElement; approximate: boolean } | null {
  if (plan.strategy === 'selector') {
    const primary = frame.querySelector<HTMLElement>(plan.selector);
    if (primary) return { node: primary, approximate: false };
    if (plan.fallbackSelector) {
      const fallback = frame.querySelector<HTMLElement>(plan.fallbackSelector);
      if (fallback) return { node: fallback, approximate: true };
    }
    return null;
  }
  if (plan.strategy === 'section-title') {
    const h2 = frame.querySelector<HTMLElement>('h2');
    return h2 ? { node: h2, approximate: false } : null;
  }
  if (plan.strategy === 'tty-title') {
    // `data-testid="portrait-strip"` is the template's own testing hook
    // (`ThroughTheYears.tsx`'s outer `.ttty` div) — a stable, already-there
    // attribute selector, not a class added for this overlay.
    const h2 = frame.querySelector<HTMLElement>('[data-testid="portrait-strip"] h2');
    return h2 ? { node: h2, approximate: false } : null;
  }
  if (plan.strategy === 'tty-kicker') {
    // No wrapping row here (unlike `SectionHeader.tsx`'s kicker+divider
    // pair) — the kicker `<div>` IS the title `<h2>`'s previous sibling
    // directly (see `ThroughTheYears.tsx`'s JSX: kicker div, then h2, both
    // direct children of the same positioned wrapper).
    const h2 = frame.querySelector<HTMLElement>('[data-testid="portrait-strip"] h2');
    const kicker = h2?.previousElementSibling as HTMLElement | null;
    return kicker ? { node: kicker, approximate: false } : null;
  }
  if (plan.strategy === 'section-kicker') {
    // `SectionHeader.tsx` renders no className at all (inline styles only —
    // see `geometry.ts`'s doc comment): the kicker row, when present, is
    // the title `<h2>`'s previous sibling, and the kicker `<span>` itself
    // is that row's first child (the second child is the divider rule
    // span). Depends on `SectionHeader.tsx`'s current internal DOM
    // structure — acceptable per the polish-round brief's "derive an
    // approximate hitbox... document approximations", flagged here as the
    // one selector in this module tied to a component's internals rather
    // than a stable className.
    const h2 = frame.querySelector<HTMLElement>('h2');
    const row = h2?.previousElementSibling;
    const kicker = row && row.tagName === 'DIV' ? (row.firstElementChild as HTMLElement | null) : null;
    return kicker ? { node: kicker, approximate: false } : null;
  }
  // 'footer-row'
  const footer = frame.querySelector<HTMLElement>('.footer-index');
  // `FooterIndex.tsx`: outer div -> [hairline rule div, entries row div] ->
  // entries row's children are the (unclassed) per-entry divs, in order.
  const entriesRow = footer?.children[1];
  const entry = entriesRow?.children[plan.entryIndex] as HTMLElement | undefined;
  return entry ? { node: entry, approximate: false } : null;
}

function relativeRect(rect: DOMRect, containerRect: DOMRect): DOMRectLike {
  return {
    left: rect.left - containerRect.left,
    top: rect.top - containerRect.top,
    width: rect.width,
    height: rect.height,
  };
}
