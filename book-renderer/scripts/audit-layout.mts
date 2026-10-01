import fs from 'node:fs';
import path from 'node:path';
import { parseManifest, parseOutline } from '../src/model/loader';
import { normalizeEditsShapeForClient } from '../src/web/book/normalizeEdits';
import { fitBookForPrint } from './lib/fitBookForPrint';
import { auditBookDocument, summarizeAssetCoverage } from '../src/model/audit';
import { planChapterDemotions } from '../src/model/fitter';
import type { BookManifest, BookOutline, BookPage } from '../src/model/types';

/**
 * Offline layout audit (memory-book everything-fixes plan, steps 1.2 + 1.4).
 *
 * Runs the SAME fit pipeline print uses — `fitBookForPrint` (applyPreFit ->
 * fitBook -> applyPostFit), fed the way production feeds it (parseOutline/
 * parseManifest on `book_document`, and `normalizeEditsShapeForClient` on the
 * `memory_book_edits.edits` jsonb, exactly like useEditableBook.ts and
 * PrintApp.tsx) — entirely offline: no asset downloads, no network, no DB.
 * Image dimensions come from the manifest.
 *
 * Input: a JSON export shaped
 *   { id, scopeLabel, scopeKind, coverAssetKey,
 *     bookDocument: { outline, manifest },
 *     edits: { edits: <memory_book_edits.edits jsonb> } | null }
 *
 * PRIVACY: the input is private family data. This tool prints ids, counts,
 * page numbers and template names ONLY — never memory text/captions, child or
 * family names, or the scope label (child/family PII rule).
 *
 * Usage:
 *   npx vite-node scripts/audit-layout.mts -- <export.json> [more.json ...] [--json] [--out <file>]
 *     --json        print only the machine-readable JSON (array of reports) on stdout
 *     --out <file>  also write the JSON array of reports to <file>
 */

/** A text-page holding exactly one entry whose caption is under this many chars is a "lone short caption" page (plan 1.4). */
const LONE_SHORT_CAPTION_MAX_CHARS = 120;

/**
 * How each template positions a `params.sectionHeader` (SectionHeader is
 * absolute top:0/left:0 of its containing block, so a template that renders
 * it outside a SafeArea puts it at the BLEED ORIGIN, where trim cuts off the
 * eyebrow). Keep in sync with HEADER_CAPABLE in src/model/fitter.ts.
 *   safe-area      — rendered inside <SafeArea> (correct).
 *   manual-offset  — no SafeArea, but the template offsets it by hand (QuoteCollection).
 *   bare-before-fix — rendered bare in the page frame until the 2026-10-01 TextPage fix:
 *                     pages of this template in books printed BEFORE the fix had the
 *                     header at the page edge (current code renders it in SafeArea).
 *   not-rendered   — template never renders a header (a header carried here would vanish).
 */
type HeaderPositioning = 'safe-area' | 'manual-offset' | 'bare-before-fix' | 'not-rendered';
const HEADER_POSITIONING: Record<string, HeaderPositioning> = {
  'flex-grid': 'safe-area',
  'anchor-media': 'safe-area',
  'illustrated-story': 'safe-area',
  'audio-note': 'safe-area',
  'photo-story': 'safe-area',
  'quote-collection': 'manual-offset',
  'text-page': 'bare-before-fix',
};

interface PageRef {
  pageNumber: number | null;
  pageNumbers: number[] | null;
  sectionId: string;
  template: string;
}

function pageRef(page: BookPage): PageRef {
  return {
    pageNumber: page.pageNumbers?.[0] ?? null,
    pageNumbers: page.pageNumbers,
    sectionId: page.sourceElementId,
    template: page.templateId,
  };
}

function hasHeader(page: BookPage): boolean {
  return page.params.sectionHeader != null;
}

/** Mirrors fitter.ts MIN_MEMORIES_PER_MONTH (the per-month demotion floor; not exported). */
const MONTH_FLOOR = 2;

interface ChapterStat {
  chapterId: string;
  ageYear: number;
  pages: number;
  memoriesTotal: number;
  memoriesKept: number;
  keepRate: number | null;
  monthsAtFloor: number;
  monthsEmpty: number;
  months: number;
}

/**
 * Chapter-mode stats (Everything books; null for a book with < 2 chapter
 * elements). Ids/counts only. Memory population = backbone + themed members
 * + firsts members (exactly the fitter's budgeting population). A month is "at floor" when
 * demotion hit it (omitted > 0) and <= MONTH_FLOOR memories remain; "empty"
 * when it had memories and none remain.
 */
function chapterStats(
  outline: BookOutline,
  manifest: BookManifest,
  pages: BookPage[],
  omitted: Set<string>,
): { chapters: ChapterStat[]; firstsPages: number; tierCPlanned: number; tierCOmitted: number; planOmissionsByTier: Record<string, number> } | null {
  const spans = outline.elements
    .filter((e) => e.kind === 'chapter' && e.chapter && typeof e.chapter.startMonth === 'string')
    .map((e) => ({ id: e.id, ageYear: e.chapter!.ageYear, startMonth: e.chapter!.startMonth }))
    .sort((a, b) => a.startMonth.localeCompare(b.startMonth) || a.ageYear - b.ageYear);
  if (spans.length < 2) return null;
  const chapterOfMonth = (month: string) => {
    let idx = 0;
    for (let i = 0; i < spans.length; i++) if (spans[i].startMonth <= month) idx = i;
    return idx;
  };

  // Page -> chapter: walk outline order; a chapter/backbone/themed element belongs to the latest chapter opener.
  const chapterOfElement = new Map<string, number>();
  let current = -1;
  for (const e of outline.elements) {
    if (e.kind === 'chapter') current = spans.findIndex((s) => s.id === e.id);
    else if (e.kind === 'backbone' || e.kind === 'themed') chapterOfElement.set(e.id, Math.max(current, 0));
    if (e.kind === 'chapter') chapterOfElement.set(e.id, current);
  }
  const pagesBy = spans.map(() => 0);
  let firstsPages = 0;
  const firstsIds = new Set(outline.elements.filter((e) => e.kind === 'firsts').map((e) => e.id));
  for (const p of pages) {
    const n = p.pageNumbers?.length ?? 1;
    const ci = chapterOfElement.get(p.sourceElementId);
    if (ci != null) pagesBy[ci] += n;
    else if (firstsIds.has(p.sourceElementId)) firstsPages += n;
  }

  const monthOriginal = spans.map(() => new Map<string, number>());
  const monthOmitted = spans.map(() => new Map<string, number>());
  const total = spans.map(() => 0);
  const kept = spans.map(() => 0);
  for (const e of outline.elements) {
    if (e.kind === 'firsts') {
      // Never demoted, in no backbone section — but kept memories of their own chapter (planner counts them too).
      for (const id of e.memoryIds) {
        const m = manifest.memories[id];
        if (!m) continue;
        const ci = chapterOfMonth(m.date.slice(0, 7));
        total[ci]++;
        kept[ci]++;
      }
      continue;
    }
    if (e.kind !== 'backbone' && e.kind !== 'themed') continue;
    for (const id of e.memoryIds) {
      const m = manifest.memories[id];
      if (!m) continue;
      const month = m.date.slice(0, 7);
      const ci = chapterOfMonth(month);
      total[ci]++;
      monthOriginal[ci].set(month, (monthOriginal[ci].get(month) ?? 0) + 1);
      if (omitted.has(id)) monthOmitted[ci].set(month, (monthOmitted[ci].get(month) ?? 0) + 1);
      else kept[ci]++;
    }
  }

  const chapters: ChapterStat[] = spans.map((s, i) => {
    let atFloor = 0;
    let empty = 0;
    for (const [month, orig] of monthOriginal[i]) {
      const om = monthOmitted[i].get(month) ?? 0;
      const remaining = orig - om;
      if (remaining === 0) empty++;
      else if (om > 0 && remaining <= MONTH_FLOOR) atFloor++;
    }
    return {
      chapterId: s.id,
      ageYear: s.ageYear,
      pages: pagesBy[i],
      memoriesTotal: total[i],
      memoriesKept: kept[i],
      keepRate: total[i] > 0 ? Math.round((kept[i] / total[i]) * 1000) / 1000 : null,
      monthsAtFloor: atFloor,
      monthsEmpty: empty,
      months: monthOriginal[i].size,
    };
  });

  // Tier C: which planned omissions came from the captioned-demotion tier, restricted to what the fit actually omitted.
  const plan = planChapterDemotions(outline, manifest);
  const planOmissionsByTier: Record<string, number> = {};
  for (const d of plan) planOmissionsByTier[d.tier] = (planOmissionsByTier[d.tier] ?? 0) + 1;
  const tierCOmitted = plan.filter((d) => d.tier === 'C' && omitted.has(d.id)).length;
  return { chapters, firstsPages, tierCPlanned: planOmissionsByTier.C ?? 0, tierCOmitted, planOmissionsByTier };
}

interface ExportShape {
  id?: string;
  scopeKind?: string;
  coverAssetKey?: string | null;
  bookDocument?: { outline?: unknown; manifest?: unknown };
  edits?: { edits?: unknown } | null;
}

function auditBook(file: string) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as ExportShape;
  if (!raw.bookDocument?.outline || !raw.bookDocument?.manifest) {
    throw new Error(`${path.basename(file)}: missing bookDocument.outline / bookDocument.manifest`);
  }
  const outline = parseOutline(raw.bookDocument.outline);
  const manifest = parseManifest(raw.bookDocument.manifest);
  const edits = normalizeEditsShapeForClient(raw.edits?.edits);
  const editCounts = {
    text: Object.keys(edits.text ?? {}).length,
    images: Object.keys(edits.images ?? {}).length,
    focalPoints: Object.keys(edits.focalPoints ?? {}).length,
  };

  let fitCount = 0;
  const fit = fitBookForPrint({ outline, manifest, edits, onRunFit: () => { fitCount++; } });
  const pages = fit.document.pages;

  // Content-integrity audit (src/model/audit.ts) on the finished document — violation counts by check.
  const violations = auditBookDocument(fit.document, outline, manifest, { omittedMemoryIds: fit.capacity.omittedMemoryIds });
  const violationsByCheck: Record<string, number> = {};
  for (const v of violations) violationsByCheck[v.check] = (violationsByCheck[v.check] ?? 0) + 1;
  const omittedIds = new Set(fit.capacity.omittedMemoryIds);
  // Kept memories / assets vs what actually renders (ids and counts only). Phase 2c: in chapter mode a
  // memory shows at most 2 assets, so `hiddenByCap` (a deliberate cap) is reported apart from `assetsLost`
  // (shown but never rendered: a genuine loss, should be 0). Uses the EDITED manifest, like the slots.
  const mediaCoverage = summarizeAssetCoverage(fit.document, outline, fit.editedManifest, omittedIds);
  const chapterMode = chapterStats(outline, manifest, pages, omittedIds);

  const templateHistogram: Record<string, number> = {};
  for (const p of pages) templateHistogram[p.templateId] = (templateHistogram[p.templateId] ?? 0) + 1;

  // Section headers landing on a text-page (printed pre-fix: header at the page edge, eyebrow trimmed).
  const headerOnTextPage = pages.filter((p) => p.templateId === 'text-page' && hasHeader(p)).map(pageRef);

  // Lone short-caption text pages (plan 1.4).
  const loneShortCaptionPages = pages
    .filter((p) => p.templateId === 'text-page')
    .flatMap((p) => {
      const textSlots = p.slots.filter((s) => s.kind === 'text');
      if (textSlots.length !== 1) return [];
      const content = textSlots[0].content as { text?: string };
      const len = (content.text ?? '').length;
      if (len >= LONE_SHORT_CAPTION_MAX_CHARS) return [];
      return [{ ...pageRef(p), captionChars: len, carriesSectionHeader: hasHeader(p) }];
    });

  // Every header-carrying page, grouped by template + how that template positions the header.
  const headerPagesByTemplate: Record<string, { positioning: HeaderPositioning; count: number; pages: Array<number | null> }> = {};
  for (const p of pages) {
    if (!hasHeader(p)) continue;
    const positioning = HEADER_POSITIONING[p.templateId] ?? 'not-rendered';
    const entry = (headerPagesByTemplate[p.templateId] ??= { positioning, count: 0, pages: [] });
    entry.count += 1;
    entry.pages.push(p.pageNumbers?.[0] ?? null);
  }
  const headerPagesWithoutSafeArea = Object.entries(headerPagesByTemplate)
    .filter(([, v]) => v.positioning !== 'safe-area')
    .map(([template, v]) => ({ template, positioning: v.positioning, count: v.count, pages: v.pages }));

  return {
    id: raw.id ?? path.basename(file, '.json'),
    scopeKind: raw.scopeKind ?? manifest.scope?.kind ?? null,
    language: (manifest as { language?: string }).language ?? null,
    hasEdits: raw.edits != null,
    editCounts,
    skippedEdits: fit.skipped.length,
    totalPages: fit.document.totalPages,
    interiorPages: fit.pageCount,
    pageEntries: pages.length,
    templateHistogram,
    headerPagesTotal: pages.filter(hasHeader).length,
    headerOnTextPage,
    loneShortCaptionPages,
    headerPagesByTemplate,
    headerPagesWithoutSafeArea,
    fitCapacity: { cap: fit.capacity.cap, overCap: fit.capacity.overCap, omitted: fit.capacity.omittedMemoryIds.length },
    layoutGaps: fit.gaps.length,
    integrity: {
      total: violations.length,
      byCheck: violationsByCheck,
      // ids/page ids only — never message text (messages can embed content-derived detail)
      items: violations.map((v) => ({ check: v.check, elementId: v.elementId ?? null, pageId: v.pageId ?? null })),
    },
    fitCount,
    omittedTotal: omittedIds.size,
    mediaCoverage,
    chapterMode,
  };
}

type Report = ReturnType<typeof auditBook>;

function printTable(r: Report): void {
  const short = r.id.slice(0, 8);
  console.log(`\n=== book ${short} (${r.scopeKind}, ${r.language ?? '?'}) ===`);
  console.log(`total pages: ${r.totalPages} (interior ${r.interiorPages}, ${r.pageEntries} page entries) | edits: ${r.hasEdits ? `text ${r.editCounts.text}, images ${r.editCounts.images}, focal ${r.editCounts.focalPoints}` : 'none'} | skipped edits: ${r.skippedEdits}`);
  console.log('template histogram:');
  for (const [t, n] of Object.entries(r.templateHistogram).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(20)} ${n}`);
  console.log(`section headers total: ${r.headerPagesTotal}`);
  console.log(`section headers on text-page: ${r.headerOnTextPage.length}`);
  for (const h of r.headerOnTextPage) console.log(`  page ${h.pageNumber}  section ${h.sectionId}  template ${h.template}`);
  console.log(`lone short-caption text pages (<${LONE_SHORT_CAPTION_MAX_CHARS} chars, 1 entry): ${r.loneShortCaptionPages.length}`);
  for (const l of r.loneShortCaptionPages) console.log(`  page ${l.pageNumber}  section ${l.sectionId}  ${l.captionChars} chars${l.carriesSectionHeader ? '  (carries header)' : ''}`);
  console.log('header-carrying pages by template / positioning:');
  for (const [t, v] of Object.entries(r.headerPagesByTemplate)) console.log(`  ${t.padEnd(20)} ${String(v.count).padStart(3)}  ${v.positioning}`);
  const bare = r.headerPagesWithoutSafeArea.filter((x) => x.positioning === 'bare-before-fix' || x.positioning === 'not-rendered');
  console.log(`header pages lacking SafeArea (bare-before-fix / not-rendered): ${bare.reduce((n, x) => n + x.count, 0)}`);
  console.log(`integrity violations: ${r.integrity.total}${r.integrity.total ? '  ' + Object.entries(r.integrity.byCheck).map(([c, n]) => `${c}=${n}`).join(' ') : ''}`);
  for (const v of r.integrity.items) console.log(`  ${v.check}  element ${v.elementId ?? '-'}  page ${v.pageId ?? '-'}`);
  const mc = r.mediaCoverage;
  console.log(`kept memories ${mc.memoriesKept} | media memories kept/rendered ${mc.mediaMemoriesKept}/${mc.mediaMemoriesRendered} | assets: memory assets ${mc.assetsKept}, shown ${mc.assetsShown} (hidden by cap ${mc.hiddenByCap}), rendered ${mc.assetsRendered}, genuinely lost ${mc.assetsLost}`);
  console.log(`fit passes (onRunFit): ${r.fitCount} | omitted memories: ${r.omittedTotal} | over cap: ${r.fitCapacity.overCap}`);
  if (r.chapterMode) {
    const c = r.chapterMode;
    console.log(`chapter mode: ${c.chapters.length} chapters | firsts pages ${c.firstsPages} | Tier C engaged: ${c.tierCOmitted > 0 ? 'YES' : 'no'} (captioned omissions ${c.tierCOmitted}; plan by tier ${JSON.stringify(c.planOmissionsByTier)})`);
    console.log('  chapter          pages  kept/total  keep-rate  months  at-floor  empty');
    for (const ch of c.chapters) {
      console.log(`  ${ch.chapterId.padEnd(15)} ${String(ch.pages).padStart(5)}  ${`${ch.memoriesKept}/${ch.memoriesTotal}`.padStart(10)}  ${String(ch.keepRate ?? '-').padStart(9)}  ${String(ch.months).padStart(6)}  ${String(ch.monthsAtFloor).padStart(8)}  ${String(ch.monthsEmpty).padStart(5)}`);
    }
  } else {
    console.log('chapter mode: off (no chapter elements)');
  }
}

const argv = process.argv.slice(2);
const files: string[] = [];
let jsonOnly = false;
let outFile: string | null = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') continue;
  if (a === '--json') jsonOnly = true;
  else if (a === '--out') outFile = argv[++i] ?? null;
  else files.push(a);
}
if (files.length === 0) {
  console.error('Usage: npx vite-node scripts/audit-layout.mts -- <export.json> [more.json ...] [--json] [--out <file>]');
  process.exit(1);
}

const reports: Report[] = [];
for (const f of files) {
  try {
    reports.push(auditBook(path.resolve(f)));
  } catch (e) {
    // Error text can embed JSON fragments from the input (PII) — print only the message head, never the payload.
    console.error(`[audit-layout] ${path.basename(f)}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)}`);
    process.exit(1);
  }
}

if (outFile) fs.writeFileSync(path.resolve(outFile), JSON.stringify(reports, null, 2));
if (jsonOnly) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const r of reports) printTable(r);
  console.log('\nJSON:');
  console.log(JSON.stringify(reports, null, 2));
}
