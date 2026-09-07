import { assertEquals, assertExists, assertStrictEquals } from 'jsr:@std/assert@1';
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { TEXT_TARGET_PATTERN,
  collectManifestAssetFiles,
  DEFAULT_DEPENDENCIES,
  handleMemoryBookEdits,
  measureOriginalDimensions,
  type MemoryBookEditsDependencies,
  normalizeEdits,
  resolveScopeWindow,
} from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_FAMILY_ID = '99999999-9999-4999-8999-999999999999';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const MEDIA_ID = '44444444-4444-4444-8444-444444444444';
const MEMORY_ID = '55555555-5555-4555-8555-555555555555';

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
  memoriesEarliest?: { memory_date: string } | null;
  memoriesLatest?: { memory_date: string } | null;
  calls?: string[];
  onUpsert?: (payload: Record<string, unknown>) => void;
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
          };
          return chain;
        }

        if (table === 'memory_media') {
          const chain = {
            select: () => chain,
            eq: () => chain,
            gte: () => chain,
            lt: () => chain,
            like: () => chain,
            order: () => chain,
            maybeSingle: async () => ({ data: options.media ?? null, error: options.mediaError ?? null }),
            range: async () => ({ data: options.mediaPool ?? [], error: options.mediaPoolError ?? null }),
          };
          return chain;
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
          let ascending = true;
          const chain = {
            select: () => chain,
            eq: () => chain,
            order: (_col: string, opts: { ascending: boolean }) => {
              ascending = opts.ascending;
              return chain;
            },
            limit: () => chain,
            maybeSingle: async () => ({
              data: (ascending ? options.memoriesEarliest : options.memoriesLatest) ?? null,
              error: null,
            }),
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

Deno.test('resolveScopeWindow: everything resolves to the family\'s live min/max memory_date', async () => {
  const window = await resolveScopeWindow(
    createStubClient({
      memoriesEarliest: { memory_date: '2024-05-01' },
      memoriesLatest: { memory_date: '2026-02-10' },
    })(),
    { family_id: FAMILY_ID, scope_kind: 'everything', scope_start_date: null, scope_end_date: null },
  );
  assertEquals(window, { start: '2024-05-01', endExclusive: '2026-02-11' });
});

Deno.test('resolveScopeWindow: everything with zero memories collapses to the empty-window sentinel', async () => {
  const window = await resolveScopeWindow(
    createStubClient({ memoriesEarliest: null, memoriesLatest: null })(),
    { family_id: FAMILY_ID, scope_kind: 'everything', scope_start_date: null, scope_end_date: null },
  );
  assertEquals(window.start, window.endExclusive);
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
