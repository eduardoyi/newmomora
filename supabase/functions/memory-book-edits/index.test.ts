import { assertEquals, assertExists, assertRejects, assertStrictEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { TEXT_TARGET_PATTERN,
  collectManifestAssetFiles,
  DEFAULT_DEPENDENCIES,
  FURNITURE_KEYS,
  handleMemoryBookEdits,
  intersectDateWindow,
  measureOriginalDimensions,
  type MemoryBookEditsDependencies,
  normalizeEdits,
  resolveScopeWindow,
  ScopeWindowError,
} from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_FAMILY_ID = '99999999-9999-4999-8999-999999999999';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const MEDIA_ID = '44444444-4444-4444-8444-444444444444';
const MEMORY_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_ID = '66666666-6666-4666-8666-666666666666';

function fakeUser() {
  return { id: USER_ID, is_anonymous: false } as never;
}

function request(body: unknown, options: { method?: string; noAuth?: boolean } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!options.noAuth) headers.Authorization = 'Bearer test-token';
  return new Request('http://localhost/memory-book-edits', {
    method: options.method ?? 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function readyBook(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    family_id: FAMILY_ID,
    child_id: null,
    status: 'ready',
    scope_kind: 'custom_range',
    scope_start_date: '2026-01-01',
    scope_end_date: '2026-06-30',
    book_document: { manifest: { memories: {} } },
    ...overrides,
  };
}

// ── Fake Supabase client ────────────────────────────────────────────────
// Same "filter-blind chain stub" convention as
// generate-memory-book/index.test.ts and workflow-memory-book-bridge/
// index.test.ts: every filter method (select/eq/gte/lt/like/order/limit)
// just returns the same chain object -- these tests exercise THIS file's
// own branching against a given DB response shape, not PostgREST's actual
// filter semantics (which is Postgres/PostgREST's own property, not this
// function's).
interface MediaQueryLog {
  select: string[];
  eq: [string, unknown][];
  in: [string, unknown][];
  order: string[];
  range: [number, number][];
}

function newMediaQueryLog(): MediaQueryLog {
  return { select: [], eq: [], in: [], order: [], range: [] };
}

interface StubOptions {
  book?: Record<string, unknown> | null;
  bookError?: { message: string } | null;
  media?: Record<string, unknown> | null;
  mediaError?: { message: string } | null;
  mediaPool?: Record<string, unknown>[];
  mediaPoolError?: { message: string } | null;
  editsRow?: Record<string, unknown> | null;
  editsError?: { message: string } | null;
  upsertError?: { message: string } | null;
  /** Rows the `everything` first-eligible scan returns (id, memory_date,
   * memory_family_members embed); the stub is filter-blind, so these are
   * already "the rows on/after DOB, ascending". */
  memoriesScan?: Array<Record<string, unknown>>;
  memoriesScanError?: { message: string } | null;
  memoriesLatest?: { memory_date: string } | null;
  memoriesLatestError?: { message: string } | null;
  /** `family_members` DOB lookup used when the book has no frozen window. */
  childRow?: { date_of_birth: string | null } | null;
  childError?: { message: string } | null;
  /** Records the query SHAPE `memory_media` receives (the stub is
   * filter-blind, so picker_pool's select string / filters / range are
   * otherwise invisible to assertions). */
  mediaQueryLog?: MediaQueryLog;
  calls?: string[];
  onUpsert?: (payload: Record<string, unknown>) => void;
  /** save_edit's cover_asset_key recompute: `memory_books.update(...)`. */
  coverUpdateError?: { message: string } | null;
  onCoverUpdate?: (payload: Record<string, unknown>) => void;
}

function createStubClient(options: StubOptions = {}) {
  return () =>
    ({
      from(table: string) {
        options.calls?.push(table);

        if (table === 'memory_books') {
          const chain = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: async () => ({ data: options.book ?? null, error: options.bookError ?? null }),
            // save_edit's cover_asset_key recompute: `.update({...}).eq(...)`
            // -- awaited directly (no terminal `.maybeSingle()`), same
            // thenable-chain convention as the memory_family_members stub
            // below.
            update: (payload: Record<string, unknown>) => {
              options.onCoverUpdate?.(payload);
              return chain;
            },
            then: (resolve: (result: { data: unknown; error: unknown }) => void) =>
              resolve({ data: null, error: options.coverUpdateError ?? null }),
          };
          return chain;
        }

        if (table === 'memory_media') {
          const log = options.mediaQueryLog;
          const chain = {
            select: (cols: string) => {
              log?.select.push(cols);
              return chain;
            },
            eq: (col: string, value: unknown) => {
              log?.eq.push([col, value]);
              return chain;
            },
            gte: () => chain,
            lt: () => chain,
            like: () => chain,
            in: (col: string, values: unknown) => {
              log?.in.push([col, values]);
              return chain;
            },
            order: (col: string) => {
              log?.order.push(col);
              return chain;
            },
            maybeSingle: async () => ({ data: options.media ?? null, error: options.mediaError ?? null }),
            range: async (from: number, to: number) => {
              log?.range.push([from, to]);
              return { data: options.mediaPool ?? [], error: options.mediaPoolError ?? null };
            },
          };
          return chain;
        }

        if (table === 'memory_family_members') {
          // picker_pool's member filter is a nested inner embed on
          // `memory_media` -- a separate top-level `memory_family_members`
          // lookup (the old unpaged tag-id fetch) must never happen again.
          throw new Error('unexpected top-level memory_family_members lookup');
        }

        if (table === 'memory_book_edits') {
          const chain = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: async () => ({ data: options.editsRow ?? null, error: options.editsError ?? null }),
            upsert: async (payload: Record<string, unknown>) => {
              options.onUpsert?.(payload);
              return { error: options.upsertError ?? null };
            },
          };
          return chain;
        }

        if (table === 'memories') {
          // `everything` window resolution: the latest-date lookup
          // (`.limit(1).maybeSingle()`) and the ascending tag-embed scan
          // (`.range(...)`).
          const chain = {
            select: () => chain,
            eq: () => chain,
            gte: () => chain,
            order: () => chain,
            limit: () => chain,
            maybeSingle: async () => ({
              data: options.memoriesLatest ?? null,
              error: options.memoriesLatestError ?? null,
            }),
            range: async () => ({ data: options.memoriesScan ?? [], error: options.memoriesScanError ?? null }),
          };
          return chain;
        }

        if (table === 'family_members') {
          const chain = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: async () => ({ data: options.childRow ?? null, error: options.childError ?? null }),
          };
          return chain;
        }

        throw new Error(`unexpected table ${table}`);
      },
    }) as never;
}

function baseDeps(overrides: Partial<MemoryBookEditsDependencies> = {}): Partial<MemoryBookEditsDependencies> {
  return {
    getAuthenticatedUser: async () => fakeUser(),
    getCallerFamilyRole: async () => 'manager',
    createPresignedGetUrls: async (keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, `https://signed.example/${key}`])),
    fetch: async () => new Response(new Blob([new Uint8Array()]), { status: 404 }),
    ...overrides,
  };
}

// ── Auth / method / body validation ─────────────────────────────────────

Deno.test('rejects an unauthenticated caller before any DB read', async () => {
  const calls: string[] = [];
  const response = await handleMemoryBookEdits(request({ op: 'save_edit', bookId: BOOK_ID }), {
    getAuthenticatedUser: async () => null,
    createServiceClient: createStubClient({ calls }),
  });
  assertEquals(response.status, 401);
  assertEquals(calls, []);
});

Deno.test('WP-SEC: default wiring rejects anonymous sessions via the non-anonymous chokepoint', () => {
  assertStrictEquals(DEFAULT_DEPENDENCIES.getAuthenticatedUser, getAuthenticatedNonAnonymousUser);
});

Deno.test('rejects unsupported methods', async () => {
  const response = await handleMemoryBookEdits(
    new Request('http://localhost/memory-book-edits', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    }),
    baseDeps(),
  );
  assertEquals(response.status, 405);
});

Deno.test('rejects invalid JSON body', async () => {
  const response = await handleMemoryBookEdits(
    new Request('http://localhost/memory-book-edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{not json',
    }),
    baseDeps(),
  );
  assertEquals(response.status, 400);
});

Deno.test('rejects an unknown op', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'delete_everything', bookId: BOOK_ID }),
    baseDeps(),
  );
  assertEquals(response.status, 400);
});

Deno.test('rejects a missing bookId', async () => {
  const response = await handleMemoryBookEdits(request({ op: 'save_edit' }), baseDeps());
  assertEquals(response.status, 400);
});

Deno.test('returns 404 for an unknown book', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'dedication', value: 'hi' } }),
    baseDeps({ createServiceClient: createStubClient({ book: null }) }),
  );
  assertEquals(response.status, 404);
});

Deno.test('rejects a caller who is not owner/manager of the book\'s family', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'dedication', value: 'hi' } }),
    baseDeps({
      createServiceClient: createStubClient({ book: readyBook() }),
      getCallerFamilyRole: async () => 'viewer',
    }),
  );
  assertEquals(response.status, 403);
});

Deno.test('rejects edits on a book that is not ready', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'dedication', value: 'hi' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook({ status: 'generating' }) }) }),
  );
  assertEquals(response.status, 409);
});

// ── save_edit: text ──────────────────────────────────────────────────────

Deno.test('save_edit: saves a valid dedication text edit and returns the merged edits', async () => {
  let upserted: Record<string, unknown> | undefined;
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'dedication', value: 'For Mia' } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        editsRow: null,
        onUpsert: (payload) => {
          upserted = payload;
        },
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.text.dedication, { target: 'dedication', value: 'For Mia' });
  assertEquals(upserted?.book_id, BOOK_ID);
  assertEquals(upserted?.family_id, FAMILY_ID);
  assertEquals(upserted?.updated_by, USER_ID);
});

Deno.test('save_edit: merges a new text edit on top of an existing row without dropping other categories', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'closing', value: 'The End' } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        editsRow: {
          edits: {
            text: { dedication: { target: 'dedication', value: 'For Mia' } },
            images: { cover: { slot: 'cover', mediaId: MEDIA_ID, file: 'a', originalFile: 'b', aspectRatio: 1 } },
          },
        },
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.text.dedication.value, 'For Mia');
  assertEquals(body.edits.text.closing.value, 'The End');
  assertEquals(body.edits.images.cover.mediaId, MEDIA_ID);
});

Deno.test('save_edit: rejects a text target that does not match any known shape', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'notARealTarget', value: 'x' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('save_edit: rejects a text value over the length cap', async () => {
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'text', target: 'dedication', value: 'x'.repeat(1001) },
    }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('save_edit: accepts a well-formed caption:<memoryId> target', async () => {
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'text', target: `caption:${MEMORY_ID}`, value: 'Look at that smile' },
    }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.text[`caption:${MEMORY_ID}`].value, 'Look at that smile');
});

// ── save_edit: imageReplace / coverPhoto (mediaId trust boundary) ────────

Deno.test('save_edit: rejects imageReplace when the media belongs to a different family (cross-family mediaId rejection)', async () => {
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'imageReplace', slot: `${MEMORY_ID}:${MEDIA_ID}`, mediaId: MEDIA_ID },
    }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook({ family_id: FAMILY_ID }),
        // The media row resolves to a DIFFERENT family than the book's --
        // this is exactly the spoofed-mediaId attack Design Decision 5's
        // server-side resolution exists to block.
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: 'k/preview.jpg',
          content_type: 'image/jpeg',
          aspect_ratio: 1.5,
          memories: { family_id: FOREIGN_FAMILY_ID },
        },
      }),
    }),
  );
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.code, 'MEDIA_NOT_FOUND');
});

Deno.test('save_edit: rejects imageReplace for an unknown mediaId', async () => {
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'imageReplace', slot: `${MEMORY_ID}:${MEDIA_ID}`, mediaId: MEDIA_ID },
    }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), media: null }) }),
  );
  assertEquals(response.status, 404);
});

Deno.test('save_edit: rejects imageReplace against a non-photo media row', async () => {
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'imageReplace', slot: `${MEMORY_ID}:${MEDIA_ID}`, mediaId: MEDIA_ID },
    }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.mp4',
          preview_object_key: null,
          content_type: 'video/mp4',
          aspect_ratio: 1.77,
          memories: { family_id: FAMILY_ID },
        },
      }),
    }),
  );
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.code, 'MEDIA_NOT_PHOTO');
});

Deno.test('save_edit: rejects imageReplace with the reserved "cover" slot', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'imageReplace', slot: 'cover', mediaId: MEDIA_ID } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('save_edit: imageReplace resolves family-owned media and measures original dimensions', async () => {
  const pngBytes = buildPngBytes(3000, 2000);
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'imageReplace', slot: `${MEMORY_ID}:${MEDIA_ID}`, mediaId: MEDIA_ID },
    }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: 'k/preview.jpg',
          content_type: 'image/jpeg',
          aspect_ratio: 1.5,
          memories: { family_id: FAMILY_ID },
        },
      }),
      fetch: async () => new Response(new Blob([pngBytes]), { status: 206 }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  const record = body.edits.images[`${MEMORY_ID}:${MEDIA_ID}`];
  assertEquals(record.mediaId, MEDIA_ID);
  assertEquals(record.file, 'k/preview.jpg');
  assertEquals(record.originalFile, 'k/original.jpg');
  assertEquals(record.aspectRatio, 1.5);
  assertEquals(record.originalWidth, 3000);
  assertEquals(record.originalHeight, 2000);
});

Deno.test('save_edit: coverPhoto is keyed under the "cover" slot and falls back to object_key when there is no preview', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'coverPhoto', mediaId: MEDIA_ID } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: null,
          content_type: 'image/jpeg',
          aspect_ratio: null,
          memories: { family_id: FAMILY_ID },
        },
      }),
      fetch: async () => new Response(new Blob([new Uint8Array(4)]), { status: 404 }), // dimension probe fails -> absent, not fabricated
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  const record = body.edits.images.cover;
  assertEquals(record.slot, 'cover');
  assertEquals(record.file, 'k/original.jpg');
  assertEquals(record.originalWidth, undefined);
  assertEquals(record.originalHeight, undefined);
  // aspect_ratio was null and dimensions couldn't be measured -- falls
  // back to 1, never fabricated from nothing.
  assertEquals(record.aspectRatio, 1);
});

Deno.test('save_edit: dimension measurement fallback -- a probe read that comes back FULL but unparseable retries with the larger fallback range', async () => {
  const pngBytes = buildPngBytes(1200, 800);
  let call = 0;
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'coverPhoto', mediaId: MEDIA_ID },
    }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: 'k/preview.jpg',
          content_type: 'image/jpeg',
          aspect_ratio: 1.5,
          memories: { family_id: FAMILY_ID },
        },
      }),
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        call += 1;
        const range = (init?.headers as Record<string, string> | undefined)?.Range ?? '';
        if (call === 1) {
          // First (256KB) probe: a FULL-length, unparseable buffer -- the
          // real object is larger than the probe and the header didn't
          // fit, exactly the case the fallback exists for.
          assertEquals(range, 'bytes=0-262143');
          return new Response(new Blob([new Uint8Array(262144)]), { status: 206 });
        }
        assertEquals(range, 'bytes=0-4194303');
        return new Response(new Blob([pngBytes]), { status: 206 });
      },
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(call, 2);
  assertEquals(body.edits.images.cover.originalWidth, 1200);
  assertEquals(body.edits.images.cover.originalHeight, 800);
});

Deno.test('save_edit: dimension measurement absent (never fabricated) when the original object is missing entirely', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'coverPhoto', mediaId: MEDIA_ID } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: 'k/preview.jpg',
          content_type: 'image/jpeg',
          aspect_ratio: 1.4,
          memories: { family_id: FAMILY_ID },
        },
      }),
      createPresignedGetUrls: async () => ({}), // presign step itself fails to produce a URL
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  const record = body.edits.images.cover;
  assertEquals('originalWidth' in record, false);
  assertEquals('originalHeight' in record, false);
  assertEquals(record.aspectRatio, 1.4); // still trusts the DB column when present
});

// ── save_edit: cover_asset_key recompute (shelf cover-edit awareness,
// 2026-09-17 owner decision) ──────────────────────────────────────────────

Deno.test('save_edit: a qualifying coverPhoto edit recomputes memory_books.cover_asset_key from the edit itself', async () => {
  const pngBytes = buildPngBytes(3000, 2000);
  let coverUpdate: Record<string, unknown> | undefined;
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'coverPhoto', mediaId: MEDIA_ID } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(), // book_document: { manifest: { memories: {} } } -- no AI candidate at all
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: 'k/preview.jpg',
          content_type: 'image/jpeg',
          aspect_ratio: 1.5,
          memories: { family_id: FAMILY_ID },
        },
        onCoverUpdate: (payload) => {
          coverUpdate = payload;
        },
      }),
      fetch: async () => new Response(new Blob([pngBytes]), { status: 206 }), // originalWidth 3000 clears the 2000px gate
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.images.cover.file, 'k/preview.jpg');
  assertEquals(coverUpdate?.cover_asset_key, 'k/preview.jpg');
});

Deno.test('save_edit: a non-cover edit (text/focalPoint/non-cover imageReplace) never touches memory_books.cover_asset_key', async () => {
  let coverUpdateCalls = 0;
  const deps = (edit: Record<string, unknown>) =>
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: 'k/preview.jpg',
          content_type: 'image/jpeg',
          aspect_ratio: 1.5,
          memories: { family_id: FAMILY_ID },
        },
        onCoverUpdate: () => {
          coverUpdateCalls += 1;
        },
      }),
    });

  const textResponse = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'dedication', value: 'For Mia' } }),
    deps({}),
  );
  assertEquals(textResponse.status, 200);

  const focalPointResponse = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'focalPoint', slot: `${MEMORY_ID}:${MEDIA_ID}`, x: 0.5, y: 0.5 } }),
    deps({}),
  );
  assertEquals(focalPointResponse.status, 200);

  const imageReplaceResponse = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'imageReplace', slot: `${MEMORY_ID}:${MEDIA_ID}`, mediaId: MEDIA_ID } }),
    deps({}),
  );
  assertEquals(imageReplaceResponse.status, 200);

  assertEquals(coverUpdateCalls, 0);
});

Deno.test('save_edit: removing a cover edit (delete images/cover) recomputes back to the AI pick', async () => {
  let coverUpdate: Record<string, unknown> | undefined;
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'delete', category: 'images', key: 'cover' } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook({
          book_document: {
            outline: { coverCandidates: ['memory-1'] },
            manifest: {
              scope: { start: '2025-01-01', end: '2025-12-31' },
              memories: {
                'memory-1': { date: '2025-06-01', assets: [{ file: 'ai-pick.jpg', kind: 'photo', width: 2500 }] },
              },
            },
          },
        }),
        editsRow: {
          edits: {
            images: {
              cover: {
                slot: 'cover', mediaId: MEDIA_ID, file: 'edited-cover.jpg', originalFile: 'orig.jpg',
                aspectRatio: 1.5, originalWidth: 3000, originalHeight: 2000,
              },
            },
          },
        },
        onCoverUpdate: (payload) => {
          coverUpdate = payload;
        },
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.images.cover, undefined);
  assertEquals(coverUpdate?.cover_asset_key, 'ai-pick.jpg');
});

Deno.test('save_edit: a cover_asset_key recompute failure still returns a successful edit save', async () => {
  const pngBytes = buildPngBytes(3000, 2000);
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'coverPhoto', mediaId: MEDIA_ID } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        media: {
          id: MEDIA_ID,
          memory_id: MEMORY_ID,
          object_key: 'k/original.jpg',
          preview_object_key: 'k/preview.jpg',
          content_type: 'image/jpeg',
          aspect_ratio: 1.5,
          memories: { family_id: FAMILY_ID },
        },
        coverUpdateError: { message: 'boom' },
      }),
      fetch: async () => new Response(new Blob([pngBytes]), { status: 206 }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.success, true);
  assertEquals(body.edits.images.cover.file, 'k/preview.jpg');
});

// ── save_edit: focalPoint ─────────────────────────────────────────────────

Deno.test('save_edit: saves a valid focal point', async () => {
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'focalPoint', slot: `${MEMORY_ID}:${MEDIA_ID}`, x: 0.25, y: 0.75 },
    }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.focalPoints[`${MEMORY_ID}:${MEDIA_ID}`], {
    slot: `${MEMORY_ID}:${MEDIA_ID}`,
    x: 0.25,
    y: 0.75,
  });
});

Deno.test('save_edit: rejects an out-of-range focal point', async () => {
  const response = await handleMemoryBookEdits(
    request({
      op: 'save_edit',
      bookId: BOOK_ID,
      edit: { kind: 'focalPoint', slot: `${MEMORY_ID}:${MEDIA_ID}`, x: 1.5, y: 0.5 },
    }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('save_edit: rejects an unknown edit kind', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'deleteEverything' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

// ── picker_pool ────────────────────────────────────────────────────────

function poolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ID,
    memory_id: MEMORY_ID,
    preview_object_key: 'k/preview.jpg',
    object_key: 'k/original.jpg',
    aspect_ratio: 1.5,
    content_type: 'image/jpeg',
    memories: { memory_date: '2026-03-01' },
    ...overrides,
  };
}

Deno.test('picker_pool: returns items with an alreadyInBook flag from the manifest', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, limit: 10 }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook({
          book_document: { manifest: { memories: { [MEMORY_ID]: { assets: [{ file: 'k/preview.jpg' }] } } } },
        }),
        mediaPool: [poolRow(), poolRow({ id: 'other-media-id', preview_object_key: 'k/preview-2.jpg', object_key: 'k/original-2.jpg' })],
        editsRow: null,
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.length, 2);
  assertEquals(body.items[0].alreadyInBook, true); // matches manifest asset file
  assertEquals(body.items[1].alreadyInBook, false);
  assertEquals(body.items[0].memoryId, MEMORY_ID);
  assertEquals(body.items[0].date, '2026-03-01');
});

Deno.test('picker_pool: a mediaId already claimed by a saved image edit counts as alreadyInBook too', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, limit: 10 }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        mediaPool: [poolRow()],
        editsRow: {
          edits: {
            images: {
              cover: { slot: 'cover', mediaId: MEDIA_ID, file: 'x', originalFile: 'y', aspectRatio: 1 },
            },
          },
        },
      }),
    }),
  );
  const body = await response.json();
  assertEquals(body.items[0].alreadyInBook, true);
});

Deno.test('picker_pool: caps the page size at 50 and returns a nextCursor exactly when the page is full', async () => {
  const fullPage = Array.from({ length: 50 }, (_, i) => poolRow({ id: `media-${i}` }));
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, limit: 500 }), // over-request, should be clamped
    baseDeps({
      createServiceClient: createStubClient({ book: readyBook(), mediaPool: fullPage, editsRow: null }),
    }),
  );
  const body = await response.json();
  assertEquals(body.items.length, 50);
  assertExists(body.nextCursor);
});

Deno.test('picker_pool: a short (final) page returns nextCursor: null', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, limit: 50 }),
    baseDeps({
      createServiceClient: createStubClient({ book: readyBook(), mediaPool: [poolRow()], editsRow: null }),
    }),
  );
  const body = await response.json();
  assertEquals(body.nextCursor, null);
});

Deno.test('picker_pool: rejects a malformed cursor', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, cursor: 'not-a-real-cursor!!' }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), mediaPool: [] }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('picker_pool: accepts a previously issued cursor and keeps paginating', async () => {
  const cursor = btoa('50');
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, cursor }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), mediaPool: [poolRow()], editsRow: null }) }),
  );
  assertEquals(response.status, 200);
});

// ── picker_pool filters (item 1, owner-approved editing-UX round) ────────

Deno.test('picker_pool: rejects a malformed dateStart', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, dateStart: 'not-a-date' }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), mediaPool: [] }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('picker_pool: rejects a calendrically invalid dateEnd (e.g. Feb 30)', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, dateEnd: '2026-02-30' }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), mediaPool: [] }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('picker_pool: rejects a malformed memberId', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, memberId: 'not-a-uuid' }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), mediaPool: [] }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('picker_pool: a well-formed dateStart/dateEnd range is accepted alongside a cursor (filters do not break offset pagination)', async () => {
  const cursor = btoa('50');
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, cursor, dateStart: '2026-02-01', dateEnd: '2026-05-31' }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), mediaPool: [poolRow()], editsRow: null }) }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.length, 1);
});

Deno.test('picker_pool: memberId filter is a nested inner embed on memory_media (no separate tag lookup, no .in(memory_id))', async () => {
  const calls: string[] = [];
  const mediaQueryLog = newMediaQueryLog();
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, memberId: MEMBER_ID, cursor: btoa('50'), limit: 25 }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        mediaPool: [poolRow()],
        editsRow: null,
        calls,
        mediaQueryLog,
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.length, 1);

  // Query SHAPE: the membership join lives in the select string + a nested eq.
  assertEquals(mediaQueryLog.select.length, 1);
  assertStringIncludes(
    mediaQueryLog.select[0],
    'memories!inner(memory_date, family_id, memory_family_members!inner(family_member_id))',
  );
  assertEquals(
    mediaQueryLog.eq.some(([col, v]) => col === 'memories.memory_family_members.family_member_id' && v === MEMBER_ID),
    true,
  );
  assertEquals(
    mediaQueryLog.eq.some(([col, v]) => col === 'memories.family_id' && v === FAMILY_ID),
    true,
  );
  // No `.in('memory_id', ...)` id list, and no separate tag-table lookup.
  assertEquals(mediaQueryLog.in, []);
  assertEquals(calls.includes('memory_family_members'), false);
  // Global ordering + offset cursor semantics are untouched.
  assertEquals(mediaQueryLog.order, ['memories(memory_date)', 'id']);
  assertEquals(mediaQueryLog.range, [[50, 74]]);
});

Deno.test('picker_pool: without memberId the select keeps the plain memories embed and no tag filter', async () => {
  const mediaQueryLog = newMediaQueryLog();
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        mediaPool: [poolRow()],
        editsRow: null,
        mediaQueryLog,
      }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(mediaQueryLog.select[0].includes('memory_family_members'), false);
  assertEquals(mediaQueryLog.eq.some(([col]) => col.includes('memory_family_members')), false);
  assertEquals(mediaQueryLog.in, []);
});

Deno.test('picker_pool: a member with 200+ tagged memories needs no id list (nothing for the URL limit to truncate)', async () => {
  const pool = Array.from({ length: 200 }, (_, i) =>
    poolRow({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      memory_id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      memories: { memory_date: '2026-03-01' },
    }),
  );
  const mediaQueryLog = newMediaQueryLog();
  const calls: string[] = [];
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, memberId: MEMBER_ID, limit: 50 }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        mediaPool: pool.slice(0, 50),
        editsRow: null,
        mediaQueryLog,
        calls,
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.length, 50);
  assertEquals(body.nextCursor, btoa('50'));
  assertEquals(mediaQueryLog.in, []);
  assertEquals(calls.filter((t) => t === 'memory_media').length, 1);
});

Deno.test('picker_pool: a member with no tagged memories returns an empty, exhausted page', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, memberId: MEMBER_ID }),
    baseDeps({
      createServiceClient: createStubClient({ book: readyBook(), mediaPool: [], editsRow: null }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { items: [], nextCursor: null });
});

Deno.test('picker_pool: a media query failure with a memberId surfaces as a 500', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID, memberId: MEMBER_ID }),
    baseDeps({
      createServiceClient: createStubClient({ book: readyBook(), mediaPoolError: { message: 'boom' } }),
    }),
  );
  assertEquals(response.status, 500);
});

Deno.test('picker_pool: an everything-scope window lookup error surfaces as a 500, not an empty pool', async () => {
  for (const failing of [
    { memoriesScanError: { message: 'boom' } },
    { memoriesLatestError: { message: 'boom' } },
    { childError: { message: 'boom' } },
  ]) {
    const mediaQueryLog = newMediaQueryLog();
    const response = await handleMemoryBookEdits(
      request({ op: 'picker_pool', bookId: BOOK_ID }),
      baseDeps({
        createServiceClient: createStubClient({
          book: readyBook({ scope_kind: 'everything', child_id: MEMBER_ID, scope_start_date: null, scope_end_date: null }),
          childRow: { date_of_birth: null },
          memoriesLatest: { memory_date: '2026-02-10' },
          memoriesScan: [{ id: 'm1', memory_date: '2024-01-01', memory_family_members: [] }],
          ...failing,
          mediaPool: [poolRow()],
          mediaQueryLog,
        }),
      }),
    );
    assertEquals(response.status, 500, JSON.stringify(failing));
    assertEquals((await response.json()).code, 'internal_error');
    assertEquals(mediaQueryLog.select, []);
  }
});

Deno.test('picker_pool: an everything book with a frozen outline.window uses it without touching memories', async () => {
  const calls: string[] = [];
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook({
          scope_kind: 'everything',
          scope_start_date: null,
          scope_end_date: null,
          book_document: { outline: { window: { start: '2024-02-03', endExclusive: '2026-09-01' } }, manifest: { memories: {} } },
        }),
        mediaPool: [poolRow()],
        editsRow: null,
        calls,
      }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(calls.includes('memories'), false);
  assertEquals(calls.includes('family_members'), false);
});

Deno.test('picker_pool: an everything book without a frozen window falls back to the shared first-eligible resolution', async () => {
  const calls: string[] = [];
  const response = await handleMemoryBookEdits(
    request({ op: 'picker_pool', bookId: BOOK_ID }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook({ scope_kind: 'everything', child_id: MEMBER_ID, scope_start_date: null, scope_end_date: null }),
        childRow: { date_of_birth: '2024-01-01' },
        memoriesScan: [{ id: 'm1', memory_date: '2024-05-01', memory_family_members: [] }],
        memoriesLatest: { memory_date: '2026-02-10' },
        mediaPool: [poolRow()],
        editsRow: null,
        calls,
      }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(calls.includes('memories'), true);
  assertEquals(calls.includes('family_members'), true);
});

// ── intersectDateWindow (direct) ──────────────────────────────────────────

Deno.test('intersectDateWindow: no filters passes the scope window through unchanged', () => {
  const window = intersectDateWindow({ start: '2026-01-01', endExclusive: '2026-07-01' }, undefined, undefined);
  assertEquals(window, { start: '2026-01-01', endExclusive: '2026-07-01' });
});

Deno.test('intersectDateWindow: a dateStart/dateEnd fully inside the window narrows it', () => {
  const window = intersectDateWindow(
    { start: '2026-01-01', endExclusive: '2026-07-01' },
    '2026-02-01',
    '2026-03-15',
  );
  assertEquals(window, { start: '2026-02-01', endExclusive: '2026-03-16' });
});

Deno.test('intersectDateWindow: a dateStart before the window, or a dateEnd past it, is clamped -- never widened', () => {
  const window = intersectDateWindow(
    { start: '2026-01-01', endExclusive: '2026-07-01' },
    '2025-01-01', // before the scope window
    '2026-12-31', // after the scope window
  );
  assertEquals(window, { start: '2026-01-01', endExclusive: '2026-07-01' });
});

Deno.test('intersectDateWindow: only dateStart supplied leaves the window end untouched', () => {
  const window = intersectDateWindow({ start: '2026-01-01', endExclusive: '2026-07-01' }, '2026-05-01', undefined);
  assertEquals(window, { start: '2026-05-01', endExclusive: '2026-07-01' });
});

// ── Direct unit coverage of exported helpers ──────────────────────────────

Deno.test('normalizeEdits: fills in every category for a bare {} row', () => {
  assertEquals(normalizeEdits({}), { text: {}, images: {}, focalPoints: {} });
});

Deno.test('normalizeEdits: preserves existing categories and ignores unknown/malformed shapes', () => {
  assertEquals(normalizeEdits({ text: { dedication: { target: 'dedication', value: 'x' } }, images: 'not-an-object' }), {
    text: { dedication: { target: 'dedication', value: 'x' } },
    images: {},
    focalPoints: {},
  });
  assertEquals(normalizeEdits(null), { text: {}, images: {}, focalPoints: {} });
  assertEquals(normalizeEdits([1, 2, 3]), { text: {}, images: {}, focalPoints: {} });
});

Deno.test('collectManifestAssetFiles: collects every asset file across every memory, ignoring illustrations', () => {
  const files = collectManifestAssetFiles({
    manifest: {
      memories: {
        [MEMORY_ID]: {
          assets: [{ file: 'a.jpg' }, { file: 'b.jpg' }],
          illustration: { file: 'illustration.jpg' },
        },
        'other-memory': { assets: [{ file: 'c.jpg' }] },
      },
    },
  });
  assertEquals(files.has('a.jpg'), true);
  assertEquals(files.has('b.jpg'), true);
  assertEquals(files.has('c.jpg'), true);
  assertEquals(files.has('illustration.jpg'), false);
});

Deno.test('collectManifestAssetFiles: returns an empty set for a book with no document yet', () => {
  assertEquals(collectManifestAssetFiles(null).size, 0);
  assertEquals(collectManifestAssetFiles({}).size, 0);
});

Deno.test('resolveScopeWindow: custom_range uses the frozen dates with an inclusive-to-exclusive end', async () => {
  const window = await resolveScopeWindow(createStubClient()(), {
    family_id: FAMILY_ID,
    scope_kind: 'custom_range',
    scope_start_date: '2026-01-01',
    scope_end_date: '2026-01-31',
  });
  assertEquals(window, { start: '2026-01-01', endExclusive: '2026-02-01' });
});

const EVERYTHING_BOOK = {
  family_id: FAMILY_ID,
  child_id: MEMBER_ID,
  scope_kind: 'everything' as const,
  scope_start_date: null,
  scope_end_date: null,
};

Deno.test('resolveScopeWindow: everything without a frozen window resolves via the shared first-eligible helper', async () => {
  const window = await resolveScopeWindow(
    createStubClient({
      childRow: { date_of_birth: '2024-01-01' },
      memoriesScan: [{ id: 'm1', memory_date: '2024-05-01', memory_family_members: [] }],
      memoriesLatest: { memory_date: '2026-02-10' },
    })(),
    EVERYTHING_BOOK,
  );
  assertEquals(window, { start: '2024-05-01', endExclusive: '2026-02-11' });
});

Deno.test('resolveScopeWindow: everything skips a first memory tagged only to another member', async () => {
  const window = await resolveScopeWindow(
    createStubClient({
      childRow: { date_of_birth: null },
      memoriesScan: [
        { id: 'm1', memory_date: '2024-01-01', memory_family_members: [{ family_member_id: 'someone-else' }] },
        { id: 'm2', memory_date: '2024-03-03', memory_family_members: [{ family_member_id: MEMBER_ID }] },
      ],
      memoriesLatest: { memory_date: '2024-03-03' },
    })(),
    EVERYTHING_BOOK,
  );
  assertEquals(window, { start: '2024-03-03', endExclusive: '2024-03-04' });
});

Deno.test('resolveScopeWindow: everything with a null child_id skips the DOB lookup entirely', async () => {
  const calls: string[] = [];
  const window = await resolveScopeWindow(
    createStubClient({
      calls,
      memoriesScan: [{ id: 'm1', memory_date: '2024-01-01', memory_family_members: [] }],
      memoriesLatest: { memory_date: '2024-01-01' },
    })(),
    { ...EVERYTHING_BOOK, child_id: null },
  );
  assertEquals(window, { start: '2024-01-01', endExclusive: '2024-01-02' });
  assertEquals(calls.includes('family_members'), false);
});

Deno.test('resolveScopeWindow: everything with zero memories collapses to the empty-window sentinel', async () => {
  const window = await resolveScopeWindow(
    createStubClient({ childRow: { date_of_birth: null }, memoriesLatest: null })(),
    EVERYTHING_BOOK,
  );
  assertEquals(window.start, window.endExclusive);
});

Deno.test('resolveScopeWindow: everything prefers the book\'s frozen outline.window (the picker pool equals the generated window)', async () => {
  const calls: string[] = [];
  const window = await resolveScopeWindow(createStubClient({ calls })(), {
    ...EVERYTHING_BOOK,
    book_document: { outline: { window: { start: '2024-02-03', endExclusive: '2026-09-01', label: 'Everything' } } },
  });
  assertEquals(window, { start: '2024-02-03', endExclusive: '2026-09-01' });
  assertEquals(calls, [], 'no DB read when a valid frozen window exists');
});

Deno.test('resolveScopeWindow: a malformed frozen window falls back to re-deriving it', async () => {
  const stub = () =>
    createStubClient({
      childRow: { date_of_birth: null },
      memoriesScan: [{ id: 'm1', memory_date: '2024-05-01', memory_family_members: [] }],
      memoriesLatest: { memory_date: '2024-06-01' },
    })();
  for (const outlineWindow of [
    { start: '2024-02-30', endExclusive: '2026-09-01' }, // calendrically bogus
    { start: '2026-09-01', endExclusive: '2024-02-03' }, // inverted
    { start: '2024-02-03' }, // missing end
    'nope',
    null,
  ]) {
    const window = await resolveScopeWindow(stub(), {
      ...EVERYTHING_BOOK,
      book_document: { outline: { window: outlineWindow } },
    });
    assertEquals(window, { start: '2024-05-01', endExclusive: '2024-06-02' });
  }
});

Deno.test('resolveScopeWindow: a frozen window is ignored for non-everything kinds', async () => {
  const window = await resolveScopeWindow(createStubClient()(), {
    family_id: FAMILY_ID,
    scope_kind: 'age_year',
    scope_start_date: '2025-01-01',
    scope_end_date: '2025-12-31',
    book_document: { outline: { window: { start: '2020-01-01', endExclusive: '2021-01-01' } } },
  });
  assertEquals(window, { start: '2025-01-01', endExclusive: '2026-01-01' });
});

Deno.test('resolveScopeWindow: everything throws ScopeWindowError when the DOB lookup errors (never "no DOB")', async () => {
  await assertRejects(
    () =>
      resolveScopeWindow(
        createStubClient({ childError: { message: 'boom' }, memoriesLatest: { memory_date: '2026-02-10' } })(),
        EVERYTHING_BOOK,
      ),
    ScopeWindowError,
  );
});

Deno.test('resolveScopeWindow: everything throws ScopeWindowError when the first-eligible scan errors (never the empty sentinel)', async () => {
  await assertRejects(
    () =>
      resolveScopeWindow(
        createStubClient({
          childRow: { date_of_birth: null },
          memoriesScanError: { message: 'boom' },
          memoriesLatest: { memory_date: '2026-02-10' },
        })(),
        EVERYTHING_BOOK,
      ),
    ScopeWindowError,
  );
});

Deno.test('resolveScopeWindow: everything throws ScopeWindowError when the latest lookup errors', async () => {
  await assertRejects(
    () =>
      resolveScopeWindow(
        createStubClient({ childRow: { date_of_birth: null }, memoriesLatestError: { message: 'boom' } })(),
        EVERYTHING_BOOK,
      ),
    ScopeWindowError,
  );
});

// ── measureOriginalDimensions (direct) ────────────────────────────────────

/** A minimal, real, parseable PNG: signature + an IHDR chunk carrying
 * width/height at their fixed offsets -- `image-size`'s PNG handler reads
 * exactly these bytes, no CRC validation needed for a read-only probe. */
function buildPngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(33);
  const dv = new DataView(buf.buffer);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  dv.setUint32(8, 13);
  buf.set(new TextEncoder().encode('IHDR'), 12);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  buf[24] = 8;
  buf[25] = 6;
  return buf;
}

Deno.test('measureOriginalDimensions: parses a real image on the first (256KB) probe', async () => {
  const bytes = buildPngBytes(640, 480);
  const dims = await measureOriginalDimensions(
    {
      createPresignedGetUrls: async (keys: string[]) => ({ [keys[0]]: 'https://signed.example/original.png' }),
      fetch: async () => new Response(new Blob([bytes]), { status: 206 }),
    },
    'k/original.png',
  );
  assertEquals(dims, { width: 640, height: 480 });
});

Deno.test('measureOriginalDimensions: returns null (never throws) when the object is missing', async () => {
  const dims = await measureOriginalDimensions(
    {
      createPresignedGetUrls: async (keys: string[]) => ({ [keys[0]]: 'https://signed.example/missing.png' }),
      fetch: async () => new Response(null, { status: 404 }),
    },
    'k/missing.png',
  );
  assertEquals(dims, null);
});

Deno.test('measureOriginalDimensions: a SHORT, unparseable read (smaller than the probe) is treated as the whole (corrupt) object -- no fallback fetch', async () => {
  let calls = 0;
  const dims = await measureOriginalDimensions(
    {
      createPresignedGetUrls: async (keys: string[]) => ({ [keys[0]]: 'https://signed.example/corrupt.png' }),
      fetch: async () => {
        calls += 1;
        return new Response(new Blob([new Uint8Array(10)]), { status: 206 }); // shorter than the 256KB probe request
      },
    },
    'k/corrupt.png',
  );
  assertEquals(dims, null);
  assertEquals(calls, 1);
});

Deno.test('measureOriginalDimensions: returns null when the presign step yields no URL for the key', async () => {
  const dims = await measureOriginalDimensions(
    {
      createPresignedGetUrls: async () => ({}),
      fetch: async () => {
        throw new Error('should not be called');
      },
    },
    'k/whatever.png',
  );
  assertEquals(dims, null);
});

Deno.test('measureOriginalDimensions: returns null when presigning itself throws', async () => {
  const dims = await measureOriginalDimensions(
    {
      createPresignedGetUrls: async () => {
        throw new Error('missing R2 env vars');
      },
      fetch: async () => {
        throw new Error('should not be called');
      },
    },
    'k/whatever.png',
  );
  assertEquals(dims, null);
});

Deno.test('save_edit text target accepts colon-namespaced element ids (backbone:2022-10 regression)', () => {
  const pattern = TEXT_TARGET_PATTERN;
  for (const target of ['sectionTitle:backbone:2022-10', 'sectionTitle:topic:extended-family', 'eyebrow:people:b7c69687-b13d-4b0d-8da3-07ae92478999']) {
    if (!pattern.test(target)) throw new Error(`expected valid target rejected: ${target}`);
  }
  if (pattern.test('sectionTitle:')) throw new Error('empty suffix must stay invalid');
});

Deno.test('save_edit text target: furniture:<key> accepts every allowlisted key, case-insensitively, and nothing else', () => {
  const pattern = TEXT_TARGET_PATTERN;
  for (const key of FURNITURE_KEYS) {
    if (!pattern.test(`furniture:${key}`)) throw new Error(`expected valid furniture target rejected: furniture:${key}`);
    if (!pattern.test(`furniture:${key.toUpperCase()}`)) {
      throw new Error(`expected case-insensitive furniture target rejected: furniture:${key.toUpperCase()}`);
    }
  }
  // Not free-form -- an arbitrary/unlisted key, or a stale name from before
  // the allowlist existed, must stay invalid (this is the whole point of an
  // allowlist over a wildcard suffix like `sectionTitle:`/`eyebrow:` above).
  for (const bad of ['furniture:', 'furniture:childName', 'furniture:yearRangeLabel', 'furniture:coverNameX']) {
    if (pattern.test(bad)) throw new Error(`expected invalid furniture target accepted: ${bad}`);
  }
});

Deno.test('save_edit: saves a valid furniture:coverName text edit and returns the merged edits', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'furniture:coverName', value: 'Mia' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), editsRow: null }) }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.text['furniture:coverName'], { target: 'furniture:coverName', value: 'Mia' });
});

Deno.test('save_edit: rejects a furniture target outside the allowlist', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'furniture:notAllowlisted', value: 'x' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('save_edit: saves a valid furniture:closingTitle text edit and returns the merged edits', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'text', target: 'furniture:closingTitle', value: 'See you soon.' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), editsRow: null }) }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.text['furniture:closingTitle'], { target: 'furniture:closingTitle', value: 'See you soon.' });
});

// ── save_edit: delete (owner-approved follow-up round, "Reset to original") ─

Deno.test('save_edit: delete removes a text key from the row and keeps the rest untouched', async () => {
  let upserted: Record<string, unknown> | undefined;
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'delete', category: 'text', key: 'dedication' } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        editsRow: {
          edits: {
            text: { dedication: { target: 'dedication', value: 'Old.' }, closing: { target: 'closing', value: 'Kept.' } },
            images: {},
            focalPoints: {},
          },
        },
        onUpsert: (payload) => {
          upserted = payload;
        },
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.text.dedication, undefined);
  assertEquals(body.edits.text.closing, { target: 'closing', value: 'Kept.' });
  assertEquals((upserted?.edits as Record<string, unknown>).text, { closing: { target: 'closing', value: 'Kept.' } });
});

Deno.test('save_edit: delete on a key that was never saved is a no-op, not an error', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'delete', category: 'images', key: 'never-saved' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook(), editsRow: null }) }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.images, {});
});

Deno.test('save_edit: delete rejects an unknown category', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'delete', category: 'notACategory', key: 'x' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('save_edit: delete rejects a malformed key', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'delete', category: 'text', key: '' } }),
    baseDeps({ createServiceClient: createStubClient({ book: readyBook() }) }),
  );
  assertEquals(response.status, 400);
});

Deno.test('save_edit: delete can remove a focalPoints entry, restoring the default center on next render', async () => {
  const response = await handleMemoryBookEdits(
    request({ op: 'save_edit', bookId: BOOK_ID, edit: { kind: 'delete', category: 'focalPoints', key: `${MEMORY_ID}:${MEDIA_ID}` } }),
    baseDeps({
      createServiceClient: createStubClient({
        book: readyBook(),
        editsRow: { edits: { text: {}, images: {}, focalPoints: { [`${MEMORY_ID}:${MEDIA_ID}`]: { slot: `${MEMORY_ID}:${MEDIA_ID}`, x: 0.2, y: 0.8 } } } },
      }),
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.edits.focalPoints, {});
});
