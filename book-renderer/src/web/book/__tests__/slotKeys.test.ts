import { describe, it, expect } from 'vitest';
import { resolveEditableSlotKey } from '../slotKeys';
import { slotKey } from '../../../model/edits';
import type { PhotoSlotContent } from '../../../model/types';

/**
 * Regression coverage for the owner-hit duplicate-replace bug (2026-09-09):
 * after replacing slot A's photo with one that natively lives in slot B,
 * the OLD resolver (which reverse-engineered identity by scanning edit
 * records for a matching rendered file) resolved slot B to slot A's edit
 * key — every replace attempted on B silently retargeted A. Resolution is
 * now an exact lookup on the threaded `editedFromFile` identity
 * (`ManifestAsset.editedFromFile`'s doc comment), so the same rendered
 * file in two slots can never collide.
 */
function content(overrides: Partial<PhotoSlotContent>): PhotoSlotContent {
  return {
    kind: 'photo',
    assetFile: 'assets/a.jpg',
    assetWidth: 1200,
    assetHeight: 900,
    assetAspectRatio: 4 / 3,
    memoryId: 'mem-1',
    date: '2026-01-01',
    caption: null,
    hero: false,
    qr: false,
    shareToken: null,
    taggedMembers: [],
    milestones: [],
    targetAspect: 4 / 3,
    looseFit: false,
    index: null,
    cropBand: null,
    focalPoint: null,
    ...overrides,
  } as PhotoSlotContent;
}

describe('resolveEditableSlotKey', () => {
  it('an unedited slot resolves to its own memoryId:assetFile', () => {
    const slot = content({ memoryId: 'mem-1', assetFile: 'assets/a.jpg' });
    expect(resolveEditableSlotKey(slot)).toBe(slotKey('mem-1', 'assets/a.jpg'));
  });

  it('an edited slot resolves to its PRISTINE key via editedFromFile, not the rendered file', () => {
    const slot = content({ memoryId: 'mem-1', assetFile: 'assets/b.jpg', editedFromFile: 'assets/a.jpg' });
    expect(resolveEditableSlotKey(slot)).toBe(slotKey('mem-1', 'assets/a.jpg'));
  });

  it('duplicate-replace regression: the native home of a photo that was ALSO swapped into another slot keeps its own key', () => {
    // Slot A (mem-1) was edited to show b.jpg; slot B (mem-2) natively owns
    // b.jpg. Both render the same file — their keys must stay distinct.
    const editedSlot = content({ memoryId: 'mem-1', assetFile: 'assets/b.jpg', editedFromFile: 'assets/a.jpg' });
    const nativeSlot = content({ memoryId: 'mem-2', assetFile: 'assets/b.jpg' });
    expect(resolveEditableSlotKey(editedSlot)).toBe(slotKey('mem-1', 'assets/a.jpg'));
    expect(resolveEditableSlotKey(nativeSlot)).toBe(slotKey('mem-2', 'assets/b.jpg'));
  });

  it('same-memory variant: a photo swapped into a sibling slot of the memory that natively owns it stays distinct', () => {
    const editedSlot = content({ memoryId: 'mem-1', assetFile: 'assets/b.jpg', editedFromFile: 'assets/a.jpg' });
    const nativeSibling = content({ memoryId: 'mem-1', assetFile: 'assets/b.jpg' });
    expect(resolveEditableSlotKey(editedSlot)).toBe(slotKey('mem-1', 'assets/a.jpg'));
    expect(resolveEditableSlotKey(nativeSibling)).toBe(slotKey('mem-1', 'assets/b.jpg'));
  });
});
