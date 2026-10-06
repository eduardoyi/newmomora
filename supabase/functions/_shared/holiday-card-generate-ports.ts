// Holiday card generation, shared plumbing (docs/plans/holiday-cards-p1.md
// Step 4a). The card's AI orchestration (front picks, letters) lives in
// holiday-card-generate-front.ts / holiday-card-generate-letters.ts and runs
// in three places: the Cloudflare Worker (HolidayCardWorkflow), the eval
// scripts (supabase/scripts/eval-holiday-card-*.ts) and the Deno tests. All
// IO therefore comes in through the small ports below; the modules import
// only other pure `_shared` files (no supabase-js, no Deno.*, no process.env,
// no node/npm/jsr/url imports) so a Worker can bundle them.
//
// PII rule: nothing here logs or returns memory text, captions, names or
// letters. `progress` messages carry counts only; usage events carry the
// operation, model, an idempotency key made of ids/indices, and the raw token
// usage.

/** The `ai_usage_events.operation` values the card pipeline records. */
export type HolidayCardOperation =
  | 'holiday_card_front_judge'
  | 'holiday_card_voice'
  | 'holiday_card_details'
  | 'holiday_card_editor'
  | 'holiday_card_writer'
  | 'holiday_card_quote_check';

/** One Chat Completions call: the content (null on failure), the raw usage
 * object and whether the HTTP call succeeded. Same shape as the film worker's
 * `ChatFn` (cloudflare/year-film-worker/src/openai.ts), so the Worker passes
 * `createChat(apiKey)` straight in. The port owns retries and must not log
 * the body or the answer. */
export interface ChatResult {
  content: string | null;
  usage: unknown;
  ok: boolean;
}

export type ChatPort = (body: Record<string, unknown>) => Promise<ChatResult>;

export interface UsageEvent {
  operation: HolidayCardOperation;
  model: string;
  /** Unique per call inside one generation run, deterministic (ids and
   * indices only), e.g. `editor:es`, `writer:es:warm`, `front_judge:0:1`,
   * `details:<childMemberId>:0`. The Worker derives `aiCallId` from it so a
   * replayed step does not double-record. */
  key: string;
  ok: boolean;
  usage: unknown;
}

export type UsageSink = (event: UsageEvent) => void | Promise<void>;

/** R2 reads. Both return null for a missing/unreadable object; a thrown error
 * is treated as "unreadable" by the probes and propagated elsewhere. */
export interface ImageReaderPort {
  /** The first `length` bytes of the object (a ranged read; fewer when the
   * object is shorter). */
  readRange(key: string, length: number): Promise<Uint8Array | null>;
  /** The whole object. */
  read(key: string): Promise<Uint8Array | null>;
}

export interface ImageSize {
  /** Absent/0 when the header holds no size (what `image-size` returns for a
   * truncated header). */
  width?: number;
  height?: number;
  /** EXIF orientation (1-8) when the header carries it. 5-8 mean the stored
   * pixels are rotated by 90 degrees. */
  orientation?: number;
}

/** Header parser (the `image-size` package in the eval and in the Worker).
 * Returns null/throws when the bytes hold no complete header. */
export type ImageSizeParser = (bytes: Uint8Array) => ImageSize | null | undefined;

/** Counts-only progress lines ("pixel probe 50/120"). Optional; the Worker
 * passes nothing. */
export type ProgressFn = (message: string) => void;

/** One model call + its usage record. Throws only when the port or the sink
 * throws; a failed call returns null (and is recorded with `ok: false`). */
export async function callModel(
  ports: { chat: ChatPort; usage: UsageSink },
  operation: HolidayCardOperation,
  key: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  const result = await ports.chat(body);
  await ports.usage({ operation, model: String(body.model), key, ok: result.ok, usage: result.usage });
  return result.ok ? result.content : null;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Bounded-concurrency map: `fn` runs for every item, at most `concurrency`
 * at a time. Results keep the input order. */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The content types the vision judge accepts, sniffed from the bytes. */
export function sniffVisionContentType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return null;
}
