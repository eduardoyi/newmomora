import type { BookManifest, BookPage } from '../../model/types';
import type { PhotoSlotContent } from '../../model/types';
import type { SectionHeaderParams } from '../../templates/common/SectionHeader.types';
import { COVER_SLOT_KEY } from '../../model/edits';
import type { MemoryBookEditsShape } from '../../model/edits';
import { resolveEditableSlotKey } from './slotKeys';
import { getFurniture, getLanguage } from '../../templates/furniture';

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
 *
 * `manifest` is used ONLY to compute the six `furniture:<key>` fields'
 * (owner-approved follow-up round) starting `value` when no edit has been
 * saved yet — those fields are otherwise-fixed furniture copy (book chrome
 * the templates own, see `templates/furniture.ts`), language-dependent via
 * `manifest.language`, so an honest "what's actually rendered right now"
 * pre-fill needs the same `getFurniture(getLanguage(manifest))` lookup the
 * templates themselves use (`Dedication.tsx`/`ThroughTheYears.tsx`) — never
 * re-derived by hand here, to avoid the exact class of drift this
 * codebase's own comments repeatedly flag as dangerous (see `edits.ts`'s
 * header comment on `geometry.ts`).
 */
export function computeTextFields(pages: BookPage[], manifest: BookManifest): TextField[] {
  const fields = new Map<string, TextField>();
  const furniture = getFurniture(getLanguage(manifest));

  for (const page of pages) {
    if (page.templateId === 'dedication') {
      fields.set('dedication', {
        target: 'dedication',
        label: 'Dedication',
        value: String(page.params.body ?? ''),
        multiline: true,
      });
      const childName = String(page.params.childName ?? '');
      fields.set('furniture:dedicationSalutation', {
        target: 'furniture:dedicationSalutation',
        label: 'Salutation',
        value: typeof page.params.greeting === 'string' ? page.params.greeting : furniture.dedication.greeting(childName),
        multiline: false,
      });
      fields.set('furniture:dedicationSignoff', {
        target: 'furniture:dedicationSignoff',
        label: 'Sign-off',
        value: typeof page.params.signature === 'string' ? page.params.signature : furniture.dedication.signature,
        multiline: false,
      });
      // Print-polish round (owner decision 2026-09-14, item D1): only
      // offered when the page actually renders the footnote
      // (`params.hasScanMarks`, set by the fitter) — a book with no scan
      // marks has no on-page anchor for the popover to attach to, same
      // reasoning `computeEditablePhotoSlots` already applies elsewhere.
      if (page.params.hasScanMarks) {
        fields.set('furniture:scanInstruction', {
          target: 'furniture:scanInstruction',
          label: 'Scan instruction',
          value: typeof page.params.scanInstruction === 'string' ? page.params.scanInstruction : furniture.dedication.scanInstruction,
          multiline: true,
        });
      }
    }
    if (page.templateId === 'cover-wrap') {
      fields.set('backCover', {
        target: 'backCover',
        label: 'Back cover text',
        value: String(page.params.backCoverLine ?? ''),
        multiline: true,
      });
      fields.set('furniture:coverName', {
        target: 'furniture:coverName',
        label: 'Cover name',
        value: String(page.params.childName ?? ''),
        multiline: false,
      });
      fields.set('furniture:coverTagline', {
        target: 'furniture:coverTagline',
        label: 'Cover tagline',
        value: String(page.params.backCoverLine ?? ''),
        multiline: true,
      });
    }
    if (page.templateId === 'through-the-years') {
      fields.set('furniture:ttyKicker', {
        target: 'furniture:ttyKicker',
        label: 'Kicker',
        value: typeof page.params.ttyKicker === 'string' ? page.params.ttyKicker : furniture.throughTheYears.kicker,
        multiline: false,
      });
      fields.set('furniture:ttyTitle', {
        target: 'furniture:ttyTitle',
        label: 'Title',
        value:
          typeof page.params.ttyTitle === 'string' ? page.params.ttyTitle : furniture.throughTheYears.titleLines.join('\n'),
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
      fields.set('furniture:closingTitle', {
        target: 'furniture:closingTitle',
        label: 'Closing title',
        value: typeof page.params.closingTitle === 'string' ? page.params.closingTitle : furniture.closing.headline,
        multiline: false,
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
  /**
   * Video slots are locked in v1 (owner-approved follow-up round, item 4):
   * a photo slot backed by a video-poster asset never offers a Replace
   * affordance (Reposition/focal-point still can, gated separately by the
   * crop-delta threshold — see `overlay/repositionGate.ts`). Reuses
   * `PhotoSlotContent.qr` as the signal rather than re-deriving it from the
   * manifest: `fitter.ts` sets `qr: isVideoAsset(asset)` at every one of its
   * three photo-slot-building call sites, so `content.qr === true` is
   * already an exact, zero-extra-lookup proxy for "this slot's asset is
   * `kind: 'video-poster'`" (a photo slot has no other reason to carry a
   * scan mark). Always `false` for the cover slot — `buildCoverPages` only
   * ever nominates a `kind === 'photo'` candidate.
   */
  isVideoPoster: boolean;
}

/** Every v1-editable photo slot (plan Design Decision 6 eligibility:
 * `PhotoSlotContent` slots + the cover photo) on the currently displayed
 * unit, de-duplicated by key (a memory whose photo appears twice on a
 * facing pair — rare, but the flex-grid/anchor-media layouts don't
 * guarantee otherwise — should offer exactly one "replace" control). */
export function computeEditablePhotoSlots(pages: BookPage[]): EditablePhotoSlot[] {
  const slots = new Map<string, EditablePhotoSlot>();

  for (const page of pages) {
    if (page.templateId === 'cover-wrap') {
      const assetFile = typeof page.params.assetFile === 'string' ? page.params.assetFile : null;
      if (assetFile) {
        slots.set(COVER_SLOT_KEY, { key: COVER_SLOT_KEY, memoryId: null, assetFile, isCover: true, isVideoPoster: false });
      }
    }
    for (const slot of page.slots) {
      if (slot.content.kind !== 'photo') continue;
      const content = slot.content as PhotoSlotContent;
      const key = resolveEditableSlotKey(content);
      if (!slots.has(key)) {
        slots.set(key, {
          key,
          memoryId: content.memoryId,
          assetFile: content.assetFile,
          isCover: false,
          isVideoPoster: content.qr,
        });
      }
    }
  }

  return Array.from(slots.values());
}
