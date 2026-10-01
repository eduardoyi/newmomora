/**
 * WP-0 characterization ("golden") tests for the fitter — see
 * docs/plans/memory-book-everything-phase2.md §2.8 and "Where single-year
 * behaviour could regress". These freeze TODAY's output on a seeded,
 * synthetic ~300-memory year book (fixtures/syntheticYearBook.ts) for each
 * scope-kind variant, both uncapped and squeezed so page-cap demotion
 * actually runs. Every later Phase 2 work package must keep them green:
 * year books and legacy `custom` books (which carry NO `chapter` outline
 * elements) must stay byte-identical.
 *
 * If a snapshot here changes, that is a BEHAVIOUR CHANGE of the fitter for
 * existing book kinds. Do not blindly `vitest -u` — confirm the change is
 * intended and (per the plan) gated away from year/custom books.
 *
 * What is serialized (per variant): totalPages, cap/pairing/overCap,
 * omittedMemoryIds (ORDER IS SEMANTIC — the demotion order), gaps (order
 * kept), pages (order kept: id, template, page numbers, parity, blank
 * reason, readable scalar params + hashes of structured ones, one summary
 * per slot incl. a content hash, variant template ids, and a hash of the
 * statically rendered template markup), and the `auditBookDocument` result.
 *
 * What it does NOT cover: `model/edits.ts` (applyPreFit/applyPostFit — edits
 * application), multi-year `chapter` elements (don't exist yet), `birthday`
 * elements beyond the one (deliberately re-pinned) test below, print/PDF output,
 * the Fly `/fit` wrapper, the web preview. Slot ids (`photo:slot-12`) are
 * deliberately NOT serialized: they come from a module counter and are an
 * implementation detail; slot CONTENT (memory ids, assets, captions, index)
 * is.
 */
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { auditBookDocument } from '../audit';
import { fitBook } from '../fitter';
import { parseManifest, parseOutline } from '../loader';
import type { BookManifest, BookOutline, BookPage, FitResult, LayoutSlot, TemplateParams } from '../types';
import { TemplateRenderer } from '../../templates';
import { buildSyntheticYearBook, type SyntheticScopeKind } from './fixtures/syntheticYearBook';

// ---------------------------------------------------------------------------
// Stable serialization helpers
// ---------------------------------------------------------------------------

const hash = (value: string, length = 8): string => createHash('sha1').update(value).digest('hex').slice(0, length);

/** JSON with object keys sorted (array order is preserved — it is semantic). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const READABLE_MAX = 40;

/** Readable scalars (short strings, numbers, booleans, null); a hash for anything structured or long. */
function summarizeParams(params: TemplateParams): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return `${key}=${String(v)}`;
      if (typeof v === 'string' && v.length <= READABLE_MAX) return `${key}=${JSON.stringify(v)}`;
      return `${key}=#${hash(stableStringify(v))}`;
    })
    .join(' ');
}

function slotMemoryId(slot: LayoutSlot): string {
  const content = slot.content as { memoryId?: string | null; kind: string };
  if (content.kind === 'portrait-strip') return '-';
  return content.memoryId ? content.memoryId.slice(0, 8) : '-';
}

/** `kind:memory8:contentHash` — slot ids excluded (module counter). */
function summarizeSlot(slot: LayoutSlot): string {
  return `${slot.kind}:${slotMemoryId(slot)}:${hash(stableStringify(slot.content), 6)}`;
}

function renderHash(page: BookPage, manifest: BookManifest): string {
  const html = renderToStaticMarkup(createElement(TemplateRenderer, { page, manifest, bookSlug: 'golden-book', showGuides: false }));
  return hash(html, 10);
}

function summarizePage(page: BookPage, manifest: BookManifest): string {
  return [
    page.id,
    page.templateId,
    `pn=${page.pageNumbers ? page.pageNumbers.join('-') : '-'}`,
    `even=${page.isEvenPage}`,
    `spread=${page.isSpread}`,
    `blank=${page.blankReason ?? '-'}`,
    `src=${page.sourceElementId}`,
    `params{${summarizeParams(page.params)}}`,
    `slots[${page.slots.map(summarizeSlot).join(',')}]`,
    `variants[${page.variants.map((v) => `${v.templateId}@${v.score.toFixed(3)}`).join(',')}]`,
    `render#${renderHash(page, manifest)}`,
  ].join(' | ');
}

/** Cap-demotion gap reasons are long boilerplate; keep kind + rank readable and hash the full text (so any wording change still trips the golden). Every other gap reason is kept verbatim. */
function summarizeGapReason(reason: string): string {
  const match = /^Omitted \((\w+)\) .*?\(rank (\d+),/.exec(reason);
  return match ? `Omitted(${match[1]}) rank=${match[2]} #${hash(reason)}` : reason;
}

export interface FitGolden {
  summary: {
    cap: number;
    totalPages: number;
    pageCount: number;
    pairingLevelUsed: number;
    overCap: boolean;
    omittedCount: number;
    gapCount: number;
    templateHistogram: Record<string, number>;
  };
  omittedMemoryIds: string[];
  gaps: string[];
  audit: string[];
  pages: string[];
}

export function serializeFit(result: FitResult, manifest: BookManifest, outline: BookOutline): FitGolden {
  const histogram: Record<string, number> = {};
  for (const page of result.document.pages) histogram[page.templateId] = (histogram[page.templateId] ?? 0) + 1;
  const violations = auditBookDocument(result.document, outline, manifest);
  return {
    summary: {
      cap: result.capacity.cap,
      totalPages: result.document.totalPages,
      pageCount: result.document.pages.length,
      pairingLevelUsed: result.capacity.pairingLevelUsed,
      overCap: result.capacity.overCap,
      omittedCount: result.capacity.omittedMemoryIds.length,
      gapCount: result.gaps.length,
      templateHistogram: Object.fromEntries(Object.entries(histogram).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    omittedMemoryIds: result.capacity.omittedMemoryIds,
    gaps: result.gaps.map((g) => `${g.elementId} | ${g.memoryIds.join(',')} | ${summarizeGapReason(g.reason)}`),
    audit: violations.map((v) => `${v.check} | el=${v.elementId ?? '-'} | page=${v.pageId ?? '-'} | ${v.message}`),
    pages: result.document.pages.map((p) => summarizePage(p, manifest)),
  };
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

interface Variant {
  name: string;
  scopeKind: SyntheticScopeKind;
  language: 'es' | 'en';
}

const VARIANTS: Variant[] = [
  { name: 'age-year/en', scopeKind: 'age-year', language: 'en' },
  { name: 'age-year/es', scopeKind: 'age-year', language: 'es' },
  { name: 'calendar-year/en', scopeKind: 'calendar-year', language: 'en' },
  { name: 'legacy-custom/en', scopeKind: 'custom', language: 'en' },
];

/** Effectively no cap: the natural, un-demoted layout (still goes through every pairing level logic — none needed). */
const UNCAPPED = 100_000;
/** The real printer cap (`PHYSICAL.maxPrintablePages`): the synthetic books are ~350 natural pages, so this forces pairing level 3 AND heavy cap demotion. */
const PRINTER_CAP = 122;
/** A mid squeeze: lands between the natural size and the printer cap. */
const MID_CAP = 200;
/** Below what the demotion pools can reach — exercises pool EXHAUSTION (overCap stays true). */
const EXHAUSTED_CAP = 90;

function load(variant: Variant): { outline: BookOutline; manifest: BookManifest } {
  const built = buildSyntheticYearBook({ scopeKind: variant.scopeKind, language: variant.language });
  // Round-trip through the real loaders so a fixture-shape regression fails loudly here, not in the fitter.
  return { outline: parseOutline(JSON.parse(JSON.stringify(built.outline))), manifest: parseManifest(JSON.parse(JSON.stringify(built.manifest))) };
}

describe('synthetic fixture sanity', () => {
  it('is deterministic: two builds are deeply equal', () => {
    for (const variant of VARIANTS) {
      expect(buildSyntheticYearBook({ scopeKind: variant.scopeKind, language: variant.language })).toEqual(
        buildSyntheticYearBook({ scopeKind: variant.scopeKind, language: variant.language }),
      );
    }
  });

  it.each(VARIANTS)('$name: ~300 memories with the intended mix and structure', (variant) => {
    const { outline, manifest } = load(variant);
    const memories = Object.values(manifest.memories);
    expect(memories.length).toBe(300);
    expect(memories.some((m) => m.assets.some((a) => a.kind === 'video-poster'))).toBe(true);
    expect(memories.some((m) => m.type === 'text_illustration' && m.illustration)).toBe(true);
    expect(memories.some((m) => m.assets.length > 0 && m.text)).toBe(true);
    expect(memories.some((m) => m.milestones.some((ms) => ms.id === 'birthday'))).toBe(true);
    expect(memories.some((m) => m.engagement > 0)).toBe(true);
    expect(outline.elements.filter((e) => e.kind === 'backbone').length).toBeGreaterThanOrEqual(10);
    expect(outline.elements.filter((e) => e.kind === 'themed').length).toBe(4);
    expect(outline.elements.some((e) => e.kind === 'firsts')).toBe(true);
    expect(outline.heroCandidates?.length).toBeGreaterThan(0);
    expect(outline.coverCandidates?.length).toBeGreaterThan(0);
    expect(outline.panoramaCandidates?.length).toBeGreaterThan(0);
    expect(manifest.portraits.length).toBe(6);
    // Scope identity is what each variant is meant to pin.
    expect(manifest.scope.kind).toBe(variant.scopeKind);
    expect(outline.scope.type).toBe(variant.scopeKind);
    // No chapter elements: this is the legacy single-window structure the golden protects.
    expect(outline.elements.some((e) => (e.kind as string) === 'chapter')).toBe(false);
  });
});

describe('fitter golden — year / calendar / legacy custom books', () => {
  describe.each(VARIANTS)('$name', (variant) => {
    const { outline, manifest } = load(variant);

    it('uncapped fit is unchanged and demotes nothing', () => {
      const result = fitBook(outline, manifest, { maxPages: UNCAPPED });
      expect(result.capacity.omittedMemoryIds).toEqual([]);
      expect(result.capacity.overCap).toBe(false);
      expect(serializeFit(result, manifest, outline)).toMatchSnapshot();
    });

    it(`squeezed to the printer cap (${PRINTER_CAP}, default options) demotes and is unchanged`, () => {
      const result = fitBook(outline, manifest); // default options: the production code path
      // Demotion MUST actually happen, else this golden proves nothing about the cap loop.
      expect(result.capacity.cap).toBe(PRINTER_CAP);
      expect(result.capacity.omittedMemoryIds.length).toBeGreaterThan(0);
      expect(result.capacity.pairingLevelUsed).toBe(3);
      expect(result.capacity.overCap).toBe(false);
      expect(result.document.totalPages).toBeLessThanOrEqual(PRINTER_CAP);
      // Every omitted memory is a real manifest memory, each omitted exactly once, and none is a protected treasure.
      const omitted = result.capacity.omittedMemoryIds;
      expect(new Set(omitted).size).toBe(omitted.length);
      const protectedIds = new Set([...(outline.heroCandidates ?? []), ...(outline.panoramaCandidates ?? [])]);
      for (const id of omitted) {
        expect(manifest.memories[id]).toBeTruthy();
        expect(protectedIds.has(id)).toBe(false);
        expect(manifest.memories[id].milestones).toHaveLength(0);
      }
      // One demotion gap per omission, in omission order.
      const demotionGaps = result.gaps.filter((g) => g.reason.startsWith('Omitted ('));
      expect(demotionGaps.map((g) => g.memoryIds[0])).toEqual(omitted);
      expect(serializeFit(result, manifest, outline)).toMatchSnapshot();
    });

    it(`mid squeeze (${MID_CAP}) is unchanged`, () => {
      const result = fitBook(outline, manifest, { maxPages: MID_CAP });
      expect(result.capacity.omittedMemoryIds.length).toBeGreaterThan(0);
      expect(result.document.totalPages).toBeLessThanOrEqual(MID_CAP);
      expect(serializeFit(result, manifest, outline)).toMatchSnapshot();
    });

    it('is a pure function of its inputs: refitting yields an identical serialization', () => {
      const first = serializeFit(fitBook(outline, manifest, { maxPages: MID_CAP }), manifest, outline);
      const second = serializeFit(fitBook(outline, manifest, { maxPages: MID_CAP }), manifest, outline);
      expect(second).toEqual(first);
    });

    it('integrity audit baseline is frozen (a later change cannot silently add violations)', () => {
      const countsFor = (maxPages: number | undefined) => {
        const result = fitBook(outline, manifest, maxPages === undefined ? {} : { maxPages });
        const counts: Record<string, number> = {};
        for (const v of auditBookDocument(result.document, outline, manifest)) counts[v.check] = (counts[v.check] ?? 0) + 1;
        return counts;
      };
      expect({
        uncapped: countsFor(UNCAPPED),
        mid: countsFor(MID_CAP),
        printerCap: countsFor(undefined),
      }).toMatchSnapshot();
    });
  });

  it('exhausted demotion pools (age-year/en at cap 90): every candidate omitted, still over cap, unchanged', () => {
    const variant = VARIANTS[0];
    const { outline, manifest } = load(variant);
    const result = fitBook(outline, manifest, { maxPages: EXHAUSTED_CAP });
    expect(result.capacity.overCap).toBe(true);
    expect(result.document.totalPages).toBeGreaterThan(EXHAUSTED_CAP);
    expect(result.capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    expect(serializeFit(result, manifest, outline)).toMatchSnapshot();
  });
});

describe('fitter golden — birthday elements (defect fixed in Phase 2d, deliberately re-pinned)', () => {
  it('a `birthday` outline element is now laid out: a localized title page, then its members', () => {
    // docs/plans/memory-book-everything-phase2d.md item 3b. This test used to
    // pin the DEFECT (runFit had no `birthday` case, so the worker's
    // `birthday-N` elements and the memories moved into them were silently
    // never laid out). Phase 2d fixed it on purpose, so the expectation is
    // inverted: the members print, behind a `spread-title` opener. The rest
    // of the golden snapshots are unaffected (no synthetic book carries a
    // birthday element).
    const { outline, manifest } = load(VARIANTS[0]);
    const backbone = outline.elements.find((e) => e.kind === 'backbone' && e.memoryIds.length >= 4)!;
    const moved = backbone.memoryIds.slice(0, 3);
    const withBirthday: BookOutline = {
      ...outline,
      elements: outline.elements.map((e) => (e.id === backbone.id ? { ...e, memoryIds: e.memoryIds.slice(3) } : e)),
    };
    withBirthday.elements.splice(3, 0, {
      id: 'birthday-2',
      kind: 'birthday',
      title: 'Birthday -- turns 2',
      memoryIds: moved,
      rationale: {},
    });
    const result = fitBook(withBirthday, manifest, { maxPages: UNCAPPED });
    const laidOut = new Set(
      result.document.pages.flatMap((p) => p.slots.map((s) => (s.content as { memoryId?: string | null }).memoryId).filter(Boolean)),
    );
    for (const id of moved) expect(laidOut.has(id)).toBe(true);
    const title = result.document.pages.find((p) => p.sourceElementId === 'birthday-2' && p.templateId === 'spread-title');
    expect(title).toBeDefined();
    expect(title!.params.title).toBe('When you turned two');
    expect(auditBookDocument(result.document, withBirthday, manifest, { omittedMemoryIds: result.capacity.omittedMemoryIds })).toEqual([]);
  });
});
