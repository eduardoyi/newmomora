/**
 * Pure HTTP Range parsing/formatting for the `/media/:memoryId` streaming
 * endpoint. See README "Why stream through the Worker (not a presigned R2
 * GET)" for the design rationale.
 */

/** The three shapes R2Bucket.get(key, { range }) accepts -- see
 * worker-configuration.d.ts's MemoryViewerR2Range comment. */
export type R2RangeLike = { offset: number; length?: number } | { suffix: number };

/**
 * Parse a single-range `Range: bytes=<start>-<end>` request header into the
 * shape R2's native binding accepts directly. Deliberately does NOT need
 * the object's total size up front: R2 clamps/validates against the real
 * object size server-side and reports back exactly what it served via
 * R2ObjectBody.range, which the caller uses to build the response
 * Content-Range header (see formatContentRange below).
 *
 * Multi-range requests ("bytes=0-10,20-30") are not supported by this
 * worker or by R2's native range option -- returns null, and the caller
 * falls back to serving the full object with a 200. That's spec-compliant
 * (RFC 7233 §3.1 permits ignoring an unsupported Range header and
 * returning the full representation instead of erroring).
 */
export function parseRangeHeader(rangeHeader: string | null | undefined): R2RangeLike | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    // Suffix range: "bytes=-500" == last 500 bytes.
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return { suffix };
  }

  const offset = Number(startText);
  if (!Number.isInteger(offset) || offset < 0) return null;

  if (endText === '') {
    // Open-ended range: "bytes=1000-" == from byte 1000 to the end.
    return { offset };
  }

  const end = Number(endText);
  if (!Number.isInteger(end) || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

export interface ContentRangeInput {
  servedOffset: number;
  servedLength: number;
  totalSize: number;
}

/** Format the `Content-Range` header value for a served partial response. */
export function formatContentRange({ servedOffset, servedLength, totalSize }: ContentRangeInput): string {
  const end = servedOffset + servedLength - 1;
  return `bytes ${servedOffset}-${end}/${totalSize}`;
}
