import { fitBookForPrint } from '../../../book-renderer/scripts/lib/fitBookForPrint';
import type { BookManifest, BookOutline } from '../../../book-renderer/src/model/types';
import type { MemoryBookEditsShape } from '../../../book-renderer/src/model/edits';

/**
 * `POST /fit` (memory-book-5c plan, Decision 2): "Node, no Chrome:
 * applyPreFit -> fitBook -> applyPostFit on the frozen inputs, returns THE
 * page count in ~seconds". This is a THIN wrapper — `fitBookForPrint()`
 * (wave 1, `book-renderer/scripts/lib/fitBookForPrint.ts`) already runs
 * exactly that chain and defines "THE page count" once; this module's only
 * job is the HTTP request/response shape.
 *
 * No R2/asset access happens here at all — `fitBookForPrint` never touches
 * `asset.file`/`.originalFile` (pagination doesn't depend on image bytes),
 * so `/fit` needs no presigning, unlike `/render`.
 */

export interface FitRequestBody {
  bookDocument: { outline: BookOutline; manifest: BookManifest };
  edits?: MemoryBookEditsShape;
  /** Optional — per fitBookForPrint's own doc comment, spine width only affects the cover-wrap page's width, never interior pagination/page count. */
  spineMm?: number;
}

export interface FitResponseBody {
  pageCount: number;
}

export function isFitRequestBody(value: unknown): value is FitRequestBody {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const doc = v.bookDocument as Record<string, unknown> | undefined;
  return Boolean(doc) && typeof doc === 'object' && Boolean(doc?.outline) && Boolean(doc?.manifest);
}

export function runFit(body: FitRequestBody): FitResponseBody {
  const { outline, manifest } = body.bookDocument;
  const result = fitBookForPrint({ outline, manifest, edits: body.edits, spineMm: body.spineMm });
  return { pageCount: result.pageCount };
}
