import { hasExplicitFirstLanguage } from './explicitFirst';
import type { BookManifest, BookOutline, ManifestMemory, OutlineElement } from './types';

/**
 * Fit-time Firsts honesty gate (Phase 2e owner rule, applied to STORED books).
 *
 * Older generations placed memories in the Firsts section without explicit
 * evidence (a haircut memory tagged `first-haircut`, ...). The worker now
 * gates Firsts at generation time, but books already stored still carry those
 * members, so the fitter re-applies the same rule on every fit: a memory may
 * sit in Firsts only if (a) one of its manifest milestones has status
 * `'confirmed'` (a parent confirmation; `status` is absent on manifests that
 * predate the field, which counts as a plain candidate), or (b) the memory's
 * OWN text carries explicit first-time language (`hasExplicitFirstLanguage`).
 *
 * A non-qualifying member is REASSIGNED, never dropped: it moves into the
 * chronological backbone element whose month range contains its date (the
 * nearest preceding backbone element if none contains it; the earliest
 * following one if none precedes), inserted in date order. A `firsts` element
 * left with no members is removed, so its title page + pages disappear.
 *
 * Pure and idempotent. Returns the SAME outline object when nothing changes,
 * otherwise a copy (the input is never mutated). Both `fitBook` and the audit
 * normalise through this, so they always agree on which element a memory is in.
 */

export function qualifiesForFirsts(memory: ManifestMemory): boolean {
  if ((memory.milestones ?? []).some((m) => m.status === 'confirmed')) return true;
  return hasExplicitFirstLanguage(memory.text);
}

interface MonthRange {
  min: string;
  max: string;
}

const BACKBONE_ID_RE = /^backbone:(\d{4}-\d{2}(?:_\d{4}-\d{2})*)$/;

/** `YYYY-MM` range a backbone element covers: from its id, else from its members' dates. */
function backboneRange(element: OutlineElement, manifest: BookManifest): MonthRange | null {
  const match = BACKBONE_ID_RE.exec(element.id);
  const months = match
    ? match[1].split('_')
    : element.memoryIds.map((id) => manifest.memories[id]?.date?.slice(0, 7)).filter((m): m is string => Boolean(m));
  if (months.length === 0) return null;
  const sorted = [...months].sort();
  return { min: sorted[0], max: sorted[sorted.length - 1] };
}

function pickTargetIndex(ranges: Array<{ index: number; range: MonthRange }>, month: string): number | null {
  const containing = ranges.find(({ range }) => range.min <= month && month <= range.max);
  if (containing) return containing.index;
  let preceding: { index: number; range: MonthRange } | null = null;
  for (const candidate of ranges) {
    if (candidate.range.max >= month) continue;
    if (!preceding || candidate.range.max >= preceding.range.max) preceding = candidate;
  }
  if (preceding) return preceding.index;
  let following: { index: number; range: MonthRange } | null = null;
  for (const candidate of ranges) {
    if (!following || candidate.range.min < following.range.min) following = candidate;
  }
  return following ? following.index : null;
}

export function reassignUnqualifiedFirsts(outline: BookOutline, manifest: BookManifest): BookOutline {
  const firstsIndexes = outline.elements.flatMap((e, i) => (e.kind === 'firsts' ? [i] : []));
  if (firstsIndexes.length === 0) return outline;

  const unqualified = (id: string) => {
    const memory = manifest.memories[id];
    return memory ? !qualifiesForFirsts(memory) : false;
  };
  if (!firstsIndexes.some((i) => outline.elements[i].memoryIds.some(unqualified))) return outline;

  const elements = outline.elements.map((e) => ({ ...e, memoryIds: [...e.memoryIds] }));
  const ranges = elements.flatMap((e, index) => {
    if (e.kind !== 'backbone') return [];
    const range = backboneRange(e, manifest);
    return range ? [{ index, range }] : [];
  });
  // Memories already placed outside every firsts element (never duplicate them).
  const placedElsewhere = new Set<string>();
  for (const e of elements) if (e.kind !== 'firsts') for (const id of e.memoryIds) placedElsewhere.add(id);

  const dateOf = (id: string) => manifest.memories[id]?.date ?? '';
  const dropped = new Set<number>();
  for (const fi of firstsIndexes) {
    const firsts = elements[fi];
    const keep: string[] = [];
    const moved: string[] = [];
    for (const id of firsts.memoryIds) {
      const memory = manifest.memories[id];
      if (!memory) {
        keep.push(id); // unresolvable: prints nothing either way; leave untouched
      } else if (qualifiesForFirsts(memory)) {
        keep.push(id);
      } else if (placedElsewhere.has(id)) {
        // already prints in another section: simply leave Firsts
      } else if (pickTargetIndex(ranges, memory.date.slice(0, 7)) === null) {
        keep.push(id); // no backbone to receive it: never drop a memory
      } else {
        moved.push(id);
      }
    }
    for (const id of moved) {
      const target = elements[pickTargetIndex(ranges, manifest.memories[id].date.slice(0, 7))!];
      const at = target.memoryIds.findIndex((other) => dateOf(other) > dateOf(id));
      target.memoryIds.splice(at === -1 ? target.memoryIds.length : at, 0, id);
      placedElsewhere.add(id);
    }
    firsts.memoryIds = keep;
    if (firsts.firstsEntries) firsts.firstsEntries = firsts.firstsEntries.filter((e) => keep.includes(e.memoryId));
    if (firsts.firstsWarmNames) firsts.firstsWarmNames = firsts.firstsWarmNames.filter((e) => keep.includes(e.memoryId));
    // Nothing printable left (only unresolvable ids, or none): the section disappears.
    if (!keep.some((id) => manifest.memories[id])) dropped.add(fi);
  }

  return { ...outline, elements: elements.filter((_, i) => !dropped.has(i)) };
}
