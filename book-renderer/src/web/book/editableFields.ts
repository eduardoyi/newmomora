import type { BookPage, PhotoSlotContent } from '../../model/types';
import type { SectionHeaderParams } from '../../templates/common/SectionHeader.types';
import { COVER_SLOT_KEY } from '../../model/edits';
import type { MemoryBookEditsShape } from '../../model/edits';
import { resolveEditableSlotKey } from './slotKeys';

export interface TextField {
  target: string;
  label: string;
  value: string;
  multiline: boolean;
  placeholder?: string;
}

/**
 * The v1 text edit targets (plan Design Decision 6) that apply to the
 * CURRENTLY displayed unit (1 or 2 facing pages) — de-duplicated by
 * `target`, since a target can legitimately appear on both a
 * `spread-title` page and a content page's `sectionHeader` in the same
 * unit (`applyPostFit`'s own "updated in lockstep" behavior).
 */
export function computeTextFields(pages: BookPage[]): TextField[] {
  const fields = new Map<string, TextField>();

  for (const page of pages) {
    if (page.templateId === 'dedication') {
      fields.set('dedication', {
        target: 'dedication',
        label: 'Dedication',
        value: String(page.params.body ?? ''),
        multiline: true,
      });
    }
    if (page.templateId === 'cover-wrap') {
      fields.set('backCover', {
        target: 'backCover',
        label: 'Back cover text',
        value: String(page.params.backCoverLine ?? ''),
        multiline: true,
      });
    }
    if (page.templateId === 'closing') {
      fields.set('closing', {
        target: 'closing',
        label: 'Closing line',
        value: typeof page.params.closingLine === 'string' ? page.params.closingLine : '',
        multiline: false,
        placeholder: 'Leave blank to use the default line',
      });
    }

    const elementId = page.sourceElementId;
    let title: string | null = null;
    let kicker: string | null = null;
    if (page.templateId === 'spread-title') {
      title = typeof page.params.title === 'string' ? page.params.title : null;
      kicker = typeof page.params.kicker === 'string' ? page.params.kicker : null;
    }
    const header = page.params.sectionHeader as SectionHeaderParams | null | undefined;
    if (header) {
      title = title ?? header.title;
      kicker = kicker ?? header.kicker;
    }
    if (title !== null) {
      const key = `sectionTitle:${elementId}`;
      if (!fields.has(key)) {
        fields.set(key, { target: key, label: 'Section title', value: title, multiline: false });
      }
    }
    // Eyebrow is overridable even when the outline never supplied a kicker
    // (Design Decision 6: "eyebrows derived-but-overridable") — the field
    // always shows once a title exists, with an empty starting value.
    if (title !== null) {
      const key = `eyebrow:${elementId}`;
      if (!fields.has(key)) {
        fields.set(key, { target: key, label: 'Eyebrow', value: kicker ?? '', multiline: false });
      }
    }

    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      const content = slot.content as PhotoSlotContent;
      // `applyCaptionEdit` (edits.ts) only takes effect on a slot with a
      // numbered footer-index entry (`content.index !== null`) — a slot
      // without one has no footer line for the override to land on, so
      // offering the field there would silently do nothing on save.
      if (content.index === null) continue;
      const key = `caption:${content.memoryId}`;
      if (!fields.has(key)) {
        fields.set(key, { target: key, label: 'Caption', value: content.caption ?? '', multiline: false });
      }
    }
  }

  return Array.from(fields.values());
}

export interface EditablePhotoSlot {
  /** The stable `images`/`focalPoints` key — `resolveEditableSlotKey`'s
   * output, or the literal cover sentinel for the cover photo. */
  key: string;
  memoryId: string | null;
  /** Current asset file this slot renders — the coalescer resolves its
   * thumbnail through the same key the templates use. */
  assetFile: string;
  isCover: boolean;
}

/** Every v1-editable photo slot (plan Design Decision 6 eligibility:
 * `PhotoSlotContent` slots + the cover photo) on the currently displayed
 * unit, de-duplicated by key (a memory whose photo appears twice on a
 * facing pair — rare, but the flex-grid/anchor-media layouts don't
 * guarantee otherwise — should offer exactly one "replace" control). */
export function computeEditablePhotoSlots(pages: BookPage[], edits: MemoryBookEditsShape): EditablePhotoSlot[] {
  const slots = new Map<string, EditablePhotoSlot>();

  for (const page of pages) {
    if (page.templateId === 'cover-wrap') {
      const assetFile = typeof page.params.assetFile === 'string' ? page.params.assetFile : null;
      if (assetFile) {
        slots.set(COVER_SLOT_KEY, { key: COVER_SLOT_KEY, memoryId: null, assetFile, isCover: true });
      }
    }
    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      const content = slot.content as PhotoSlotContent;
      const key = resolveEditableSlotKey(content, edits);
      if (!slots.has(key)) {
        slots.set(key, { key, memoryId: content.memoryId, assetFile: content.assetFile, isCover: false });
      }
    }
  }

  return Array.from(slots.values());
}
