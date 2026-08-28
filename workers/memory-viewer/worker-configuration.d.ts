/* eslint-disable */
// Hand-written (not `wrangler types` generated -- see README "Local
// development" for why) to match cloudflare/momora-export-worker's
// worker-configuration.d.ts convention: only the shapes this worker
// actually touches, not the full @cloudflare/workers-types surface.

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MEDIA: MemoryViewerR2Bucket;
}

/**
 * The three shapes R2's real R2Range type accepts, per
 * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2range.
 * `range.ts`'s parseRangeHeader() only ever produces the first or third
 * shape (a plain `Range: bytes=...` header has no "unbounded start, fixed
 * end" form), but all three are declared here for fidelity with the real
 * binding.
 */
type MemoryViewerR2Range =
  | { offset: number; length?: number }
  | { offset?: number; length: number }
  | { suffix: number };

interface MemoryViewerR2GetOptions {
  range?: MemoryViewerR2Range;
}

/** The range R2 actually served, normalized to offset+length (unlike the
 * request-side R2Range union, R2 always reports back a concrete slice). */
interface MemoryViewerR2ServedRange {
  offset: number;
  length: number;
}

interface MemoryViewerR2ObjectBody {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpEtag: string;
  range?: MemoryViewerR2ServedRange;
  writeHttpMetadata(headers: Headers): void;
}

interface MemoryViewerR2Bucket {
  get(key: string, options?: MemoryViewerR2GetOptions): Promise<MemoryViewerR2ObjectBody | null>;
}
