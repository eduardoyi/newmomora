import { describe, expect, it } from 'vitest';
import { qualifiesForFirsts, reassignUnqualifiedFirsts } from '../firstsGate';
import { fitBook } from '../fitter';
import { auditBookDocument } from '../audit';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import type { BookDocument, ManifestMemory } from '../types';

const ms = (status?: string) => ({ id: 'first-steps', name: 'First steps', detail: '', ...(status ? { status } : {}) });
const mem = (date: string, over: Partial<ManifestMemory> = {}) => makeMemory({ date, assets: [makeAsset({ aspectRatio: 1.5 })], ...over });

/** Backbone months 2024-03, 2024-04_2024-05 (merged), 2024-07; firsts element with the given members. */
function book(memories: Record<string, ManifestMemory>, firstsIds: string[]) {
  const manifest = makeManifest(memories);
  const outline = makeOutline([
    makeElement({ id: 'backbone:2024-03', kind: 'backbone', title: 'March', memoryIds: ['b3a', 'b3b'] }),
    makeElement({ id: 'backbone:2024-04_2024-05', kind: 'backbone', title: 'April–May', memoryIds: ['b4', 'b5'] }),
    makeElement({ id: 'backbone:2024-07', kind: 'backbone', title: 'July', memoryIds: ['b7'] }),
    makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: firstsIds }),
    makeElement({ id: 'closing', kind: 'closing', title: 'Closing' }),
  ]);
  return { manifest, outline };
}

const base = (): Record<string, ManifestMemory> => ({
  b3a: mem('2024-03-02'),
  b3b: mem('2024-03-20'),
  b4: mem('2024-04-05'),
  b5: mem('2024-05-25'),
  b7: mem('2024-07-09'),
});

describe('qualifiesForFirsts', () => {
  it('confirmed milestone qualifies', () => expect(qualifiesForFirsts(mem('2024-01-01', { milestones: [ms('confirmed')] }))).toBe(true));
  it('candidate / absent status without explicit text does not', () => {
    expect(qualifiesForFirsts(mem('2024-01-01', { text: 'Lorem ipsum', milestones: [ms('candidate')] }))).toBe(false);
    expect(qualifiesForFirsts(mem('2024-01-01', { text: 'Lorem ipsum', milestones: [ms()] }))).toBe(false);
  });
  it('explicit first-time text qualifies regardless of status', () => {
    expect(qualifiesForFirsts(mem('2024-01-01', { text: 'Lo probó por primera vez', milestones: [ms()] }))).toBe(true);
  });
  it('no milestones and no explicit text does not', () => expect(qualifiesForFirsts(mem('2024-01-01', { text: 'hola' }))).toBe(false));
});

describe('reassignUnqualifiedFirsts', () => {
  it('returns the same outline object when every member qualifies (and when there are no firsts)', () => {
    const memories = { ...base(), f1: mem('2024-04-10', { milestones: [ms('confirmed')] }), f2: mem('2024-06-01', { text: 'Su primer baño' }) };
    const { manifest, outline } = book(memories, ['f1', 'f2']);
    expect(reassignUnqualifiedFirsts(outline, manifest)).toBe(outline);
    const noFirsts = makeOutline(outline.elements.filter((e) => e.kind !== 'firsts'));
    expect(reassignUnqualifiedFirsts(noFirsts, manifest)).toBe(noFirsts);
  });

  it('confirmed status keeps a member; explicit text keeps a member; the rest move', () => {
    const memories = {
      ...base(),
      fKeepConfirmed: mem('2024-03-10', { milestones: [ms('confirmed')] }),
      fKeepText: mem('2024-04-10', { text: 'Fue la primera vez que se rió', milestones: [ms()] }),
      fMove: mem('2024-04-20', { text: 'Se subió a la bici', milestones: [ms('candidate')] }),
    };
    const { manifest, outline } = book(memories, ['fKeepConfirmed', 'fKeepText', 'fMove']);
    const out = reassignUnqualifiedFirsts(outline, manifest);
    expect(out.elements.find((e) => e.id === 'firsts')!.memoryIds).toEqual(['fKeepConfirmed', 'fKeepText']);
    // 2024-04-20 sits between b4 (04-05) and b5 (05-25) in the merged April–May element.
    expect(out.elements.find((e) => e.id === 'backbone:2024-04_2024-05')!.memoryIds).toEqual(['b4', 'fMove', 'b5']);
    expect(outline.elements.find((e) => e.id === 'firsts')!.memoryIds).toHaveLength(3); // input untouched
  });

  it('reassigns into the containing month in date order, or the nearest PRECEDING backbone element, never duplicating', () => {
    const memories = {
      ...base(),
      f1: mem('2024-03-10', { text: 'a' }), // contained by 2024-03, between b3a and b3b
      f2: mem('2024-03-01', { text: 'b' }), // earliest in 2024-03
      f3: mem('2024-06-15', { text: 'c' }), // no 2024-06 element: nearest preceding = April–May
      f4: mem('2024-12-01', { text: 'd' }), // after everything: last backbone (July)
      f5: mem('2024-03-10', { text: 'e' }), // same date as f1: lands after it
    };
    const { manifest, outline } = book(memories, ['f2', 'f1', 'f5', 'f3', 'f4']);
    const out = reassignUnqualifiedFirsts(outline, manifest);
    const members = (id: string) => out.elements.find((e) => e.id === id)!.memoryIds;
    expect(members('backbone:2024-03')).toEqual(['f2', 'b3a', 'f1', 'f5', 'b3b']);
    expect(members('backbone:2024-04_2024-05')).toEqual(['b4', 'b5', 'f3']);
    expect(members('backbone:2024-07')).toEqual(['b7', 'f4']);
    // every id appears exactly once across the whole outline
    const all = out.elements.flatMap((e) => e.memoryIds);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...Object.keys(memories)].sort());
  });

  it('a memory before the first backbone element goes to the first one', () => {
    const memories = { ...base(), f1: mem('2023-11-01', { text: 'x' }) };
    const { manifest, outline } = book(memories, ['f1']);
    const out = reassignUnqualifiedFirsts(outline, manifest);
    expect(out.elements.find((e) => e.id === 'backbone:2024-03')!.memoryIds).toEqual(['f1', 'b3a', 'b3b']);
  });

  it('when no member qualifies the firsts element disappears (and the result is idempotent)', () => {
    const memories = { ...base(), f1: mem('2024-03-10', { text: 'x', milestones: [ms()] }), f2: mem('2024-07-30', { text: 'y' }) };
    const { manifest, outline } = book(memories, ['f1', 'f2']);
    const out = reassignUnqualifiedFirsts(outline, manifest);
    expect(out.elements.some((e) => e.kind === 'firsts')).toBe(false);
    expect(reassignUnqualifiedFirsts(out, manifest)).toBe(out);
  });

  it('a member already placed in another element just leaves Firsts (no duplicate)', () => {
    const memories = { ...base(), f1: mem('2024-03-10', { text: 'x' }) };
    const { manifest, outline } = book(memories, ['f1']);
    outline.elements.find((e) => e.id === 'backbone:2024-03')!.memoryIds.push('f1');
    const out = reassignUnqualifiedFirsts(outline, manifest);
    expect(out.elements.flatMap((e) => e.memoryIds).filter((id) => id === 'f1')).toHaveLength(1);
  });

  it('trims firstsEntries to the surviving members', () => {
    const memories = { ...base(), keep: mem('2024-03-10', { milestones: [ms('confirmed')] }), move: mem('2024-04-10', { text: 'x' }) };
    const { manifest, outline } = book(memories, ['keep', 'move']);
    const firsts = outline.elements.find((e) => e.kind === 'firsts')!;
    firsts.firstsEntries = [{ memoryId: 'keep', warmName: 'a' }, { memoryId: 'move', warmName: 'b' }];
    const out = reassignUnqualifiedFirsts(outline, manifest);
    expect(out.elements.find((e) => e.kind === 'firsts')!.firstsEntries).toEqual([{ memoryId: 'keep', warmName: 'a' }]);
  });
});

describe('fitBook / audit with the Firsts gate', () => {
  const printed = (doc: BookDocument) => {
    const ids: string[] = [];
    for (const page of doc.pages) for (const slot of page.slots) {
      const id = (slot.content as { memoryId?: string | null }).memoryId;
      if (typeof id === 'string') ids.push(id);
    }
    return ids;
  };

  it('all-fail: no firsts pages, every former member still prints exactly once, audit clean', () => {
    const memories = { ...base(), f1: mem('2024-03-10', { text: 'x', milestones: [ms()] }), f2: mem('2024-07-30', { text: 'y', milestones: [ms()] }) };
    const { manifest, outline } = book(memories, ['f1', 'f2']);
    const { document, capacity } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.sourceElementId === 'firsts')).toBe(false);
    const ids = printed(document);
    for (const id of ['f1', 'f2']) expect(ids.filter((x) => x === id)).toHaveLength(1);
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: capacity.omittedMemoryIds })).toEqual([]);
  });

  it('mixed: the qualifying member stays in the firsts section, the other prints in its month', () => {
    const memories = { ...base(), keep: mem('2024-03-10', { milestones: [ms('confirmed')] }), move: mem('2024-07-30', { text: 'x', milestones: [ms()] }) };
    const { manifest, outline } = book(memories, ['keep', 'move']);
    const { document, capacity } = fitBook(outline, manifest);
    const sourceOf = (id: string) => document.pages.find((p) => p.slots.some((s) => (s.content as { memoryId?: string }).memoryId === id))?.sourceElementId;
    expect(sourceOf('keep')).toBe('firsts');
    expect(sourceOf('move')).toBe('backbone:2024-07');
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: capacity.omittedMemoryIds })).toEqual([]);
  });

  it('a reassigned milestone holder keeps the ordinary milestone protection: never page-cap demoted', () => {
    const memories: Record<string, ManifestMemory> = {};
    const b3: string[] = [];
    for (let i = 0; i < 30; i++) {
      memories[`p${i}`] = mem(`2024-03-${String((i % 27) + 1).padStart(2, '0')}`);
      b3.push(`p${i}`);
    }
    memories.moved = mem('2024-03-15', { text: 'x', milestones: [ms()] });
    const manifest = makeManifest(memories);
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-03', kind: 'backbone', title: 'March', memoryIds: b3 }),
      makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['moved'] }),
      makeElement({ id: 'closing', kind: 'closing', title: 'Closing' }),
    ]);
    const { capacity, document } = fitBook(outline, manifest, { maxPages: 14 });
    expect(capacity.omittedMemoryIds.length).toBeGreaterThan(0); // the cap really forced demotion
    expect(capacity.omittedMemoryIds).not.toContain('moved');
    expect(printed(document)).toContain('moved');
  });
});
