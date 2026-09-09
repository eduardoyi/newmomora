import type { BookPage, TemplateId } from '../../model/types';
import { findPageForEditableSlot } from './slotKeys';

/** Templates the fitter's full-bleed/panorama trust gate can place a photo
 * into (`fitter.ts`'s `FULL_BLEED_TRUSTED_MIN_WIDTH_PX` doc comment) — the
 * two "big" treatments a swap can silently fall out of on reflow: the
 * RESOLUTION gate still applies to a user-swapped photo even though
 * commit 3bd7b33 made full-bleed's ASPECT gate ignore it (see this
 * module's own caller, `BookViewScreen.tsx`, for the full context). */
export function isFullBleedTemplate(templateId: TemplateId): boolean {
  return templateId === 'full-bleed' || templateId === 'panorama-spread';
}

export interface ReflowResult {
  /** Raw index (into `afterPages`) of the page that now contains the
   * edited slot — `null` if the slot doesn't render anywhere in the
   * refitted document (shouldn't happen for a slot that was just
   * successfully saved, but never assumed — see
   * `findPageForEditableSlot`'s own doc comment). */
  rawIndex: number | null;
  /** True when the slot's page was full-bleed/panorama-spread BEFORE this
   * save and isn't anymore AFTER it. */
  demoted: boolean;
  /** True when the slot's page IS full-bleed/panorama-spread AFTER the
   * save — `BookViewScreen` combines this with the edit record's measured
   * `originalWidth` to warn when a kept full-page swap sits between the
   * user-chosen (250ppi) and strict (~294ppi) trust floors: admitted by
   * the fitter, but worth a "may print slightly soft" heads-up. */
  keptFullBleed: boolean;
}

/**
 * Item 4 (owner-approved editing-UX round): after an image edit saves and
 * the preview refits, decide where to navigate the viewer and whether the
 * full-bleed/panorama treatment was lost. Pure and independently testable
 * — no DOM, no React, no server round trip (the DB stores no pixel
 * dimensions; the refit result itself IS the signal) — `BookViewScreen.tsx`
 * is the only caller, comparing the document's `pages` array from
 * immediately BEFORE the save against the refitted one immediately after.
 */
export function computeReflowResult(
  beforePages: BookPage[],
  afterPages: BookPage[],
  slotKey: string,
): ReflowResult {
  const beforePage = findPageForEditableSlot(beforePages, slotKey);
  const afterPage = findPageForEditableSlot(afterPages, slotKey);
  const rawIndex = afterPage ? afterPages.indexOf(afterPage) : null;
  const wasFullBleed = beforePage ? isFullBleedTemplate(beforePage.templateId) : false;
  const isFullBleedNow = afterPage ? isFullBleedTemplate(afterPage.templateId) : false;
  // `afterPage` must actually exist for this to count as a "moved to a
  // regular spot" demotion — an orphaned slot (no after-page at all,
  // `rawIndex: null`) has nowhere to navigate to and nothing concrete to
  // report as "regular" instead.
  return {
    rawIndex,
    demoted: Boolean(afterPage) && wasFullBleed && !isFullBleedNow,
    keptFullBleed: isFullBleedNow,
  };
}
