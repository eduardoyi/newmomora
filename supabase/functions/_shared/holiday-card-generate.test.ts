import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import {
  type ChatPort,
  type ChatResult,
  type ImageReaderPort,
  type ImageSizeParser,
  mapPool,
  sniffVisionContentType,
  type UsageEvent,
} from './holiday-card-generate-ports.ts';
import {
  FRONT_PROBE_BYTES,
  FRONT_PROBE_FALLBACK_BYTES,
  frontMemoriesFromFilmSources,
  isPrintableFrontType,
  type FrontPickInput,
  type FrontPickMemory,
  type FrontPickPorts,
  LEGACY_MEDIA_PREFIX,
  pickFrontCandidates,
  probePhotoDimensions,
  runFrontPipeline,
} from './holiday-card-generate-front.ts';
import {
  buildParentsVoice,
  buildPoolDigest,
  cardToneForAngle,
  type CardLettersData,
  extractChildDetails,
  holidayLetterPool,
  holidayLetterScope,
  prepareCardLetters,
  quoteSubjectsFor,
  verifyLineOfYear,
  writeCardLetters,
} from './holiday-card-generate-letters.ts';
import type { FilmMemorySource, FilmPerson } from './year-film-script.ts';

// A fictional family (the repo is public).
const TOMAS = 'tomas';
const LUCIA = 'lucia';
const ANA = 'ana';
const MARCO = 'marco';
const ROSA = 'rosa';

function person(id: string, name: string, dob: string | null, relationship: string, extra: Partial<FilmPerson> = {}): FilmPerson {
  return { id, name, dateOfBirth: dob, relationship, createdAt: '2024-01-01T00:00:00Z', portraits: [], ...extra };
}

const members: FilmPerson[] = [
  person(TOMAS, 'Tomás Rivera Soto', '2021-10-02', 'child', { gender: 'male' }),
  person(LUCIA, 'Lucía Rivera Soto', '2025-02-10', 'child', { gender: 'female' }),
  person(ANA, 'Ana Soto', '1988-04-01', 'parent', { userId: 'u-ana' }),
  person(MARCO, 'Marco Rivera', '1986-06-09', 'parent', { userId: 'u-marco' }),
  person(ROSA, 'Rosa Soto', '1957-01-01', 'grandparent'),
];

const encoder = new TextEncoder();

// ── Ports helpers ────────────────────────────────────────────────────────

Deno.test('ports: mapPool keeps order and bounds concurrency; the vision sniff reads real signatures', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    return n * 10;
  });
  assertEquals(out, [10, 20, 30, 40, 50, 60]);
  assert(peak <= 2);
  assertEquals(sniffVisionContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assertEquals(sniffVisionContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assertEquals(sniffVisionContentType(encoder.encode('RIFF....WEBPVP8 ')), 'image/webp');
  assertEquals(sniffVisionContentType(new Uint8Array([1, 2, 3])), null);
});

// ── Front picks ──────────────────────────────────────────────────────────

/** Fake "images": a 9-byte header (u32 width, u32 height, orientation) at
 * `headerAt`, zeros elsewhere. */
function fakeImage(width: number, height: number, options: { orientation?: number; headerAt?: number; preview?: boolean } = {}): Uint8Array {
  const at = options.headerAt ?? 0;
  const bytes = new Uint8Array(at + 9);
  const view = new DataView(bytes.buffer);
  view.setUint32(at, width);
  view.setUint32(at + 4, height);
  bytes[at + 8] = options.orientation ?? 0;
  if (options.preview) bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

const readHeader: ImageSizeParser = (bytes) => {
  // The header sits at offset 0, or at the very end of a big object.
  for (const at of [0, bytes.length - 9]) {
    if (at < 0) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 9);
    const width = view.getUint32(0);
    const height = view.getUint32(4);
    if (width > 0 && height > 0 && width < 100_000 && height < 100_000 && (at === 0 || bytes.length > 9)) {
      return { width, height, orientation: view.getUint8(8) || undefined };
    }
  }
  throw new Error('no header');
};

const WHY = 'FAKE-WHY-SECRET';
const SETTING = 'fake-setting-secret';

function judgeEntry(index: number, score: number) {
  return {
    index,
    people_visible: 4,
    all_faces_visible: true,
    eyes_open_mostly: true,
    looking_at_camera: 'most',
    light: 'good',
    sharp: true,
    setting: SETTING,
    unsafe: false,
    screenshot_or_document: false,
    crop_risk: false,
    card_score: score,
    why: WHY,
  };
}

interface FrontHarness {
  ports: FrontPickPorts;
  usage: UsageEvent[];
  rangeReads: { key: string; length: number }[];
  fullReads: string[];
  judgeBatches: number[];
  progress: string[];
}

function frontPorts(
  objects: Map<string, Uint8Array>,
  options: { downscale?: boolean; judge?: (count: number, call: number) => ChatResult } = {},
): FrontHarness {
  const harness: FrontHarness = { ports: undefined as unknown as FrontPickPorts, usage: [], rangeReads: [], fullReads: [], judgeBatches: [], progress: [] };
  const images: ImageReaderPort = {
    readRange: (key, length) => {
      harness.rangeReads.push({ key, length });
      const bytes = objects.get(key);
      return Promise.resolve(bytes ? bytes.slice(0, length) : null);
    },
    read: (key) => {
      harness.fullReads.push(key);
      return Promise.resolve(objects.get(key) ?? null);
    },
  };
  let calls = 0;
  const chat: ChatPort = (body) => {
    const content = ((body.messages as { content: unknown }[])[1].content as { type: string; text?: string }[]);
    const count = content.filter((c) => c.type === 'image_url').length;
    harness.judgeBatches.push(count);
    calls += 1;
    if (options.judge) return Promise.resolve(options.judge(count, calls));
    // Best first: index 0 scores highest.
    return Promise.resolve({
      ok: true,
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
      content: JSON.stringify({ photos: Array.from({ length: count }, (_, i) => judgeEntry(i, 9 - i * 0.2)) }),
    });
  };
  harness.ports = {
    chat,
    usage: (event) => {
      harness.usage.push(event);
    },
    images,
    imageSize: readHeader,
    ...(options.downscale ? { downscaleToJpeg: (bytes: Uint8Array) => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, bytes.length % 256])) } : {}),
    progress: (message) => harness.progress.push(message),
  };
  return harness;
}

function frontMemory(id: string, date: string, tagged: string[], photos: FrontPickMemory['photos'], extra: Partial<FrontPickMemory> = {}): FrontPickMemory {
  return {
    id,
    date,
    type: 'media',
    text: 'Un día en familia con todos',
    emotion: 'joy',
    topics: [],
    taggedMemberIds: tagged,
    illustrationReady: false,
    media: [{ kind: 'image', durationMs: null, hasPreview: true }],
    reported: false,
    photos,
    ...extra,
  };
}

function photo(id: string, options: { preview?: boolean; aspect?: number; contentType?: string | null } = {}): FrontPickMemory['photos'][number] {
  return {
    mediaId: id,
    objectKey: `orig/${id}`,
    previewKey: options.preview === false ? null : `prev/${id}`,
    aspectRatio: options.aspect ?? 1.33,
    contentType: options.contentType === undefined ? 'image/jpeg' : options.contentType,
  };
}

function frontFixture() {
  const objects = new Map<string, Uint8Array>();
  const put = (id: string, width: number, height: number, options: { orientation?: number; headerAt?: number; preview?: boolean } = {}) => {
    objects.set(`orig/${id}`, fakeImage(width, height, options));
    if (options.preview !== false) objects.set(`prev/${id}`, fakeImage(1280, 960, { preview: true }));
  };
  const all = [TOMAS, LUCIA, ANA, MARCO];
  const memories: FrontPickMemory[] = [
    frontMemory('m-all', '2026-09-10', all, [photo('p-all')]),
    frontMemory('m-pair', '2026-08-02', [TOMAS, LUCIA], [photo('p-pair-1'), photo('p-pair-2')]),
    frontMemory('m-rot', '2026-07-04', [TOMAS, ANA], [photo('p-rot', { aspect: 0.75 })]),
    frontMemory('m-bigheader', '2026-06-01', [LUCIA, MARCO], [photo('p-bigheader')]),
    frontMemory('m-decpast', '2025-12-24', all, [photo('p-decpast')], { topics: ['christmas'] }),
    frontMemory('m-nopreview', '2026-05-05', [TOMAS, LUCIA], [photo('p-nopreview', { preview: false })]),
    // Dropped before the judge:
    frontMemory('m-one', '2026-09-11', [TOMAS], [photo('p-one')]),
    frontMemory('m-reported', '2026-09-12', all, [photo('p-reported')], { reported: true }),
    frontMemory('m-sad', '2026-09-13', all, [photo('p-sad')], { emotion: 'sad' }),
    frontMemory('m-bath', '2026-09-14', all, [photo('p-bath')], { topics: ['bath'], text: 'Bañándose con los patitos' }),
    frontMemory('m-old', '2025-06-01', all, [photo('p-old')]),
    frontMemory('m-small', '2026-09-15', all, [photo('p-small')]),
    frontMemory('m-missing', '2026-09-16', all, [photo('p-missing')]),
    // Not printable: HEIC/HEIF (and an unknown type) never enter the pool, whatever their pixels.
    frontMemory('m-heic', '2026-09-17', all, [photo('p-heic', { contentType: 'image/heic' })]),
    frontMemory('m-heif', '2026-09-18', all, [photo('p-heif', { contentType: 'image/heif' })]),
    frontMemory('m-notype', '2026-09-19', all, [photo('p-notype', { contentType: null })]),
  ];
  put('p-all', 4032, 3024);
  put('p-pair-1', 4032, 3024);
  put('p-pair-2', 4032, 3024);
  put('p-rot', 3000, 4000, { orientation: 6 }); // stored 3000x4000, rotated: 4000x3000 landscape
  put('p-bigheader', 4032, 3024, { headerAt: 300 * 1024 }); // header beyond the first 256 KB
  put('p-decpast', 4032, 3024);
  put('p-nopreview', 4032, 3024, { preview: false });
  put('p-one', 4032, 3024);
  put('p-reported', 4032, 3024);
  put('p-sad', 4032, 3024);
  put('p-bath', 4032, 3024);
  put('p-old', 4032, 3024);
  put('p-small', 800, 600);
  put('p-heic', 4032, 3024);
  put('p-heif', 4032, 3024);
  put('p-notype', 4032, 3024);
  // p-missing: no object at all.
  const input: FrontPickInput = {
    today: '2026-10-06',
    members: members.map((m) => ({ id: m.id, dateOfBirth: m.dateOfBirth, relationship: m.relationship })),
    memories,
    milestones: [],
  };
  return { objects, input };
}

Deno.test('front: probe reads a 256 KB range, then 4 MB; EXIF 5-8 swaps; a missing object is null', async () => {
  const { objects } = frontFixture();
  const h = frontPorts(objects);
  assertEquals(await probePhotoDimensions('orig/p-all', h.ports.images, readHeader), { width: 4032, height: 3024 });
  assertEquals(h.rangeReads.map((r) => r.length), [FRONT_PROBE_BYTES]);
  h.rangeReads.length = 0;
  assertEquals(await probePhotoDimensions('orig/p-bigheader', h.ports.images, readHeader), { width: 4032, height: 3024 });
  assertEquals(h.rangeReads.map((r) => r.length), [FRONT_PROBE_BYTES, FRONT_PROBE_FALLBACK_BYTES]);
  assertEquals(await probePhotoDimensions('orig/p-rot', h.ports.images, readHeader), { width: 4000, height: 3000 });
  assertEquals(await probePhotoDimensions('orig/nope', h.ports.images, readHeader), null);
  // A short unparseable object is not re-read with the larger range.
  h.rangeReads.length = 0;
  objects.set('orig/junk', new Uint8Array(4));
  assertEquals(await probePhotoDimensions('orig/junk', h.ports.images, () => null), null);
  assertEquals(h.rangeReads.length, 1);
});

Deno.test('front: candidates are ranked; unsafe-by-rule photos never reach the judge; the summary has no model text', async () => {
  const { objects, input } = frontFixture();
  const h = frontPorts(objects, { downscale: true });
  const run = await runFrontPipeline(input, h.ports);

  // Pool filters (outside window, single tag, reported, low mood, share-sensitive) happen before any pixel read.
  const probed = new Set(h.rangeReads.map((r) => r.key));
  for (const id of ['p-one', 'p-reported', 'p-sad', 'p-bath', 'p-old', 'p-heic', 'p-heif', 'p-notype']) assertFalse(probed.has(`orig/${id}`), id);
  assertEquals(run.pool.notPrintable, 3);
  assert(probed.has('orig/p-all'));
  assertEquals(run.selection.dropped['unreadable-size'], 1); // p-missing
  assertEquals(run.selection.dropped['low-print'], 1); // p-small
  assertEquals(run.coreMemberIds.size, 4); // Tomás, Lucía and both parents; not the grandparent

  // Everything judged is a print-ready candidate with an image; no-preview photos use the downscaled original.
  assert(run.previews.get('p-nopreview')?.source === 'original');
  assert(run.previews.get('p-all')?.source === 'preview');
  assertEquals(h.fullReads.filter((k) => k.startsWith('orig/')), ['orig/p-nopreview']);
  assertEquals(run.selection.candidates.length, 7); // 9 pool photos minus the unreadable and the low-print ones
  assertEquals(run.ranking.picks.length, 7);
});

Deno.test('front: pickFrontCandidates returns ids, numbers and enums only, in rank order, and records usage per batch', async () => {
  const { objects, input } = frontFixture();
  const h = frontPorts(objects, { downscale: true });
  const result = await pickFrontCandidates({ ...input, keep: 5 }, h.ports);

  assertEquals(result.candidates.length, 5);
  assertEquals(result.candidates.map((c) => c.rank), [1, 2, 3, 4, 5]);
  for (let i = 1; i < result.candidates.length; i += 1) assert(result.candidates[i - 1].score >= result.candidates[i].score);
  const text = JSON.stringify(result);
  assertFalse(text.includes(WHY));
  assertFalse(text.includes(SETTING));
  assert(result.candidates.every((c) => !c.mediaId.startsWith(LEGACY_MEDIA_PREFIX)));
  assertEquals(result.counts.poolPhotos, 9); // 17 photos, minus single tag, reported, sad, bath, old and the 3 not printable
  assertEquals(result.dropped['not-printable'], 3);
  assert(result.candidates.every((c) => !['p-heic', 'p-heif', 'p-notype'].includes(c.mediaId)));
  assertEquals(result.counts.candidates, 7);
  assertEquals(result.counts.judged, 7);
  assertEquals(h.judgeBatches, [7]); // one batch (FRONT_JUDGE_BATCH = 8)
  assertEquals(h.usage.map((e) => [e.operation, e.key, e.ok]), [['holiday_card_front_judge', 'front_judge:0:0', true]]);
  assert(h.progress.some((m) => m.startsWith('probing ')));
  // Progress lines are counts only.
  assertFalse(h.progress.some((m) => /Tomás|Lucía|Rivera/.test(m)));
});

Deno.test('front: an incomplete judge batch is asked once more; a failed call records ok:false', async () => {
  const { objects, input } = frontFixture();
  let first = true;
  const h = frontPorts(objects, {
    downscale: true,
    judge: (count) => {
      if (first) {
        first = false;
        return { ok: true, usage: null, content: JSON.stringify({ photos: [judgeEntry(0, 8)] }) };
      }
      return { ok: true, usage: null, content: JSON.stringify({ photos: Array.from({ length: count }, (_, i) => judgeEntry(i, 8)) }) };
    },
  });
  const result = await pickFrontCandidates(input, h.ports);
  assertEquals(h.usage.map((e) => e.key), ['front_judge:0:0', 'front_judge:0:1']);
  assertEquals(result.counts.judged, 7);

  const failing = frontPorts(objects, { downscale: true, judge: () => ({ ok: false, usage: null, content: null }) });
  const none = await pickFrontCandidates(input, failing.ports);
  assertEquals(none.candidates, []);
  assertEquals(none.counts.unjudged, 7);
  assertEquals(failing.usage.map((e) => e.ok), [false, false]);
});

Deno.test('front: without a downscaler a photo with no stored preview is left unjudged and its original is never read in full', async () => {
  const { objects, input } = frontFixture();
  const h = frontPorts(objects);
  const run = await runFrontPipeline(input, h.ports);
  assertFalse(run.previews.has('p-nopreview'));
  assertEquals(h.fullReads.filter((k) => k.startsWith('orig/')), []);
  assertEquals(run.ranking.unjudged, 1);
});

Deno.test('front: film-source memories become front memories (image assets only; legacy ids are explicit)', () => {
  const source = (overrides: Partial<FilmMemorySource>): FilmMemorySource => ({
    id: 'm1',
    date: '2026-03-03',
    type: 'media',
    text: null,
    emotion: null,
    topics: [],
    taggedMemberIds: [TOMAS, LUCIA],
    illustrationReady: false,
    illustrationKey: null,
    media: [],
    assets: [],
    reported: false,
    ...overrides,
  });
  const memories = [
    source({
      id: 'm1',
      assets: [
        { id: 'a1', kind: 'image', key: 'k1', previewKey: 'p1', durationMs: null, aspectRatio: 1.5, contentType: 'image/heic' },
        { id: 'v1', kind: 'video', key: 'kv', previewKey: 'pv', durationMs: 4000, aspectRatio: 1.5 },
      ],
    }),
    source({ id: 'm2', assets: [{ kind: 'image', key: 'legacy-key', previewKey: null, durationMs: null, aspectRatio: null }] }),
  ];
  const all = frontMemoriesFromFilmSources(memories);
  assertEquals(all[0].photos, [{ mediaId: 'a1', objectKey: 'k1', previewKey: 'p1', aspectRatio: 1.5, contentType: 'image/heic' }]);
  assertEquals(all[1].photos, [{ mediaId: `${LEGACY_MEDIA_PREFIX}m2`, objectKey: 'legacy-key', previewKey: null, aspectRatio: null, contentType: null }]);
  assertEquals(frontMemoriesFromFilmSources(memories, { includeLegacy: false })[1].photos, []);
});

// ── Letters ──────────────────────────────────────────────────────────────

const QUOTE = 'la luna nos está siguiendo';

let counter = 0;
function memory(overrides: Partial<FilmMemorySource>): FilmMemorySource {
  counter += 1;
  const id = overrides.id ?? `m${String(counter).padStart(3, '0')}`;
  return {
    id,
    date: '2026-03-15',
    type: 'media',
    text: `Un día en el parque con la familia, memoria número ${counter}`,
    emotion: 'joy',
    topics: ['park-playground'],
    taggedMemberIds: [TOMAS],
    illustrationReady: false,
    illustrationKey: null,
    media: [{ kind: 'image', durationMs: null, hasPreview: true }],
    assets: [{ id: `a-${id}`, kind: 'image', key: `${id}.jpg`, previewKey: `${id}-p.jpg`, durationMs: null, aspectRatio: 1.33 }],
    reported: false,
    authorId: 'u-ana',
    ...overrides,
  };
}

function lettersData(): CardLettersData {
  counter = 0;
  const memories: FilmMemorySource[] = [];
  ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].forEach((month, i) => {
    memories.push(memory({ date: `${month}-03`, topics: ['park-playground'], taggedMemberIds: [TOMAS, LUCIA], text: `Tomás y Lucía jugando en el parque grande, tarde número ${i + 1}` }));
    memories.push(memory({ date: `${month}-09`, topics: ['beach'], taggedMemberIds: [TOMAS, ROSA, LUCIA, ANA], text: `Día de playa con la abuela y los niños, ola número ${i + 1}` }));
    memories.push(memory({ date: `${month}-14`, topics: ['pretend-play'], taggedMemberIds: [TOMAS], text: `Tomás disfrazado de superhéroe otra vez, capa número ${i + 1}` }));
    memories.push(memory({ date: `${month}-20`, topics: ['christmas'], taggedMemberIds: [LUCIA], text: `Lucía descubriendo los columpios, vuelta número ${i + 1}` }));
  });
  memories.push(memory({ id: 'm-swim', date: '2026-06-18', taggedMemberIds: [TOMAS], text: 'Tomás aprendió a nadar sin flotadores en la piscina', topics: ['swimming'] }));
  memories.push(memory({ id: 'm-moon', date: '2026-08-21', taggedMemberIds: [TOMAS], text: `Mirando por la ventana, Tomás se volteó y dijo: "${QUOTE}"`, topics: ['pretend-play'] }));
  // Never in a letter: share-sensitive, reported, sad.
  memories.push(memory({ id: 'm-bath', date: '2026-04-04', topics: ['bath'], text: 'Bañándose con los patitos de goma en casa', taggedMemberIds: [TOMAS] }));
  memories.push(memory({ id: 'm-rep', date: '2026-07-04', reported: true, text: 'Memoria reportada por alguien más en la familia', taggedMemberIds: [TOMAS] }));
  memories.push(memory({ id: 'm-sad', date: '2026-06-04', emotion: 'sad', text: 'Un día difícil para todos en casa hoy', taggedMemberIds: [TOMAS] }));
  return { familyName: 'Rivera Soto', language: 'es-CO', captionInstructions: null, members, memories, milestones: [] };
}

interface LettersHarness {
  chat: ChatPort;
  usage: UsageEvent[];
  calls: { operation: string; model: string }[];
}

const WARM_BAD = 'Queridos todos:\n\nEste año Tomás y Lucía crecieron mucho y la abuela Rosa nos acompañó siempre.\n\nLes deseamos una feliz Navidad.';
const CLASSIC = 'Queridos todos:\n\nLes queremos contar un poquito de cómo nos fue este año, entre la piscina y los paseos. Tomás aprendió a nadar sin flotadores y Lucía no se pierde los columpios.\n\nLos queremos mucho y les deseamos una feliz Navidad.';
const PLAYFUL = 'Queridos todos:\n\nLes contamos en qué andamos: mucha piscina, mucho parque y capas de superhéroe por toda la casa. Tomás nadó sin flotadores y Lucía conquistó los columpios.\n\nLos queremos mucho. ¡Feliz Navidad!';

function lettersHarness(options: { fail?: boolean } = {}): LettersHarness {
  const harness: LettersHarness = { usage: [], calls: [], chat: undefined as unknown as ChatPort };
  const lineNumber = (prompt: string, phrase: string, pattern: (n: string) => RegExp): number => {
    for (const line of prompt.split('\n')) {
      if (line.includes(phrase)) {
        const m = pattern('').exec(line);
        if (m) return Number(m[1]);
      }
    }
    throw new Error(`phrase not in prompt: ${phrase}`);
  };
  harness.chat = (body) => {
    const [system, user] = (body.messages as { content: string }[]).map((m) => m.content);
    const record = (operation: string) => harness.calls.push({ operation, model: String(body.model) });
    if (options.fail) {
      record('failed');
      return Promise.resolve({ ok: false, usage: null, content: null });
    }
    const ok = (content: unknown): ChatResult => ({ ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, content: JSON.stringify(content) });
    if (system.startsWith('You pick quotes')) {
      record('quote');
      return Promise.resolve(ok({
        language: 'es',
        quotes: [
          { memory_id: 'm-moon', speaker: 'Tomás', quote: QUOTE },
          { memory_id: 'm-moon', speaker: 'Tomás', quote: 'una frase que nadie dijo' },
        ],
      }));
    }
    if (system.includes('pull out the SPECIFIC things')) {
      record('details');
      if (user.startsWith('Child: Lucía')) {
        return Promise.resolve(ok({ details: [{ detail: 'columpios', memory_ids: [lineNumber(user, 'columpios', () => /^\[(\d+)\]/)], recurring: true }] }));
      }
      return Promise.resolve(ok({
        details: [
          { detail: 'superhéroe', memory_ids: [lineNumber(user, 'superhéroe', () => /^\[(\d+)\]/)], recurring: true },
          { detail: 'dragones de fuego', memory_ids: [1], recurring: false },
        ],
      }));
    }
    if (system.includes('You describe HOW a family')) {
      record('voice');
      return Promise.resolve(ok({
        register: 'tú, casual', kids_reference: 'first names', person: 'we', addressee: 'about_the_child', sentence_length: 'medium', rhythm: 'short run-ons',
        formality: 'casual', humor: 'warm', openers: ['Hoy'], closers: ['un abrazo'], punctuation: { exclamations: 'rare', emojis: 'none', ellipses: 'none', notes: '' },
        characteristic: ['otra vez', 'grande', 'capa'], never: ['emojis'],
      }));
    }
    if (system.includes('You are the EDITOR')) {
      record('editor');
      const swim = lineNumber(user, 'nadar sin flotadores', () => /^(\d+)\./);
      return Promise.resolve(ok({
        facts: [
          { about: 'Tomás', kind: 'skill', fact: 'Tomás aprendió a nadar sin flotadores.', evidence: [swim] },
          { about: 'Tomás', kind: 'new', fact: 'Tomás ganó un campeonato.', evidence: [] },
          { about: 'Lucía', kind: 'trait', fact: 'Lucía no se pierde los columpios.', evidence: [lineNumber(user, 'columpios', () => /^(\d+)\./)] },
        ],
        broad_strokes: 'Fue un año de parque, de playa y de piscina.',
        qr_caption: 'Escanea para ver nuestro año: parque y piscina.',
      }));
    }
    if (system.startsWith('You write a family')) {
      record('writer');
      const angle = /WRITE THE (\w+) LETTER/.exec(user)![1];
      return Promise.resolve(ok({ text: angle === 'CLASSIC' ? CLASSIC : angle === 'WARM' ? WARM_BAD : PLAYFUL }));
    }
    throw new Error('unexpected model call');
  };
  return harness;
}

function usageSink(harness: LettersHarness) {
  return (event: UsageEvent) => {
    harness.usage.push(event);
  };
}

Deno.test('letters: scope, pool and the quote subjects follow the film rules', () => {
  const data = lettersData();
  const scope = holidayLetterScope('2026-10-06');
  assertEquals(scope, { start: '2026-01-01', endExclusive: '2026-10-07' });
  const pool = holidayLetterPool(data.memories, data.milestones, scope);
  const ids = new Set(pool.map((m) => m.id));
  for (const id of ['m-bath', 'm-rep', 'm-sad']) assertFalse(ids.has(id), id);
  assert(ids.has('m-swim'));
  assertEquals(quoteSubjectsFor(data.members, scope), [{ id: TOMAS, name: 'Tomás' }, { id: LUCIA, name: 'Lucía' }]);
  assertEquals(cardToneForAngle('warm'), 'reflective');
  assertEquals(cardToneForAngle('classic'), 'classic');
});

Deno.test('letters: buildPoolDigest decides filmPresent from the card and takes the line of the year from verified quotes', () => {
  const data = lettersData();
  const scope = holidayLetterScope('2026-10-06');
  const base = { memories: data.memories, milestones: data.milestones, members: data.members, scope, language: 'es' as const, familyName: 'Rivera Soto' };
  const quotes = [{ memoryId: 'm-moon', quote: QUOTE, speakerId: TOMAS }];
  const film = buildPoolDigest({ ...base, quotes, filmPresent: true });
  assertEquals(film.filmPresent, true);
  assertEquals(film.lineOfYear?.speaker, 'Tomás');
  assertEquals(film.lineOfYear?.quote, QUOTE);
  assertEquals(buildPoolDigest({ ...base, filmPresent: false }).filmPresent, false);
  assertEquals(buildPoolDigest({ ...base, filmPresent: false }).lineOfYear, null);
});

Deno.test('letters: the quote check keeps only verbatim quotes and skips when nothing can be quoted', async () => {
  const data = lettersData();
  const h = lettersHarness();
  const scope = holidayLetterScope('2026-10-06');
  const result = await verifyLineOfYear({ ...data, scope }, { chat: h.chat, usage: usageSink(h) });
  assertEquals(result.quotes, [{ memoryId: 'm-moon', quote: QUOTE, speakerId: TOMAS }]);
  assertEquals(result.rejected, 1);
  assertEquals(result.rejectedReasons, { not_verbatim: 1 });
  assertEquals(h.usage.map((e) => [e.operation, e.key, e.model]), [['holiday_card_quote_check', 'quote_check', 'gpt-6.1-sol']]);

  const none = lettersHarness();
  const empty = await verifyLineOfYear({ ...data, memories: [], scope }, { chat: none.chat, usage: usageSink(none) });
  assertEquals([empty.skipped, none.calls.length], ['no_candidates', 0]);
  const off = await verifyLineOfYear({ ...data, scope, disabledReason: '--no-llm' }, { chat: none.chat, usage: usageSink(none) });
  assertEquals([off.skipped, none.calls.length], ['--no-llm', 0]);
});

Deno.test('letters: details are verified against the excerpts, and the voice uses the parents\' captions', async () => {
  const data = lettersData();
  const h = lettersHarness();
  const ports = { chat: h.chat, usage: usageSink(h) };
  const scope = holidayLetterScope('2026-10-06');
  const digest = buildPoolDigest({ memories: data.memories, milestones: data.milestones, members: data.members, scope, language: 'es', familyName: data.familyName, filmPresent: false });
  const details = await extractChildDetails({ memories: data.memories, milestones: data.milestones, scope, digest }, ports);
  assertEquals(details.entries.map((e) => [e.name, e.skipped]), [['Tomás', null], ['Lucía', null]]);
  assertEquals(details.specifics[TOMAS].map((d) => d.detail), ['superhéroe']); // "dragones de fuego" is not in the captions
  assertEquals(details.entries[0].result?.dropped, 1);
  assertEquals(details.specifics[LUCIA].map((d) => d.detail), ['columpios']);
  // Fewer than 3 verified details -> one retry per child.
  assertEquals(h.usage.filter((e) => e.operation === 'holiday_card_details').map((e) => e.key).sort(), [
    `details:${LUCIA}:0`, `details:${LUCIA}:1`, `details:${TOMAS}:0`, `details:${TOMAS}:1`,
  ]);

  const voice = await buildParentsVoice({ memories: data.memories, milestones: data.milestones, members: data.members, digest, today: '2026-10-06' }, ports);
  assertEquals([voice.source, voice.authors, voice.skipped], ['linked_parents', 2, null]);
  assert(voice.samples.length > 0 && voice.samples.every((s) => s.text.length >= 40));
  assertEquals(voice.card?.person, 'we');
  assert(voice.examples.length > 0);
  assertEquals(h.usage.filter((e) => e.operation === 'holiday_card_voice').length, 1);

  // A known style card skips the call but still picks the examples.
  const before = h.calls.length;
  const known = await buildParentsVoice({ memories: data.memories, milestones: data.milestones, members: data.members, digest, today: '2026-10-06', knownCard: voice.card }, ports);
  assertEquals(h.calls.length, before);
  assertEquals(known.examples, voice.examples);
});

Deno.test('letters: writeCardLetters runs quote check, details, voice, editor and one writer per angle', async () => {
  const data = lettersData();
  const h = lettersHarness();
  const result = await writeCardLetters(
    { today: '2026-10-06', data, greeting: 'christmas', filmPresent: true },
    { chat: h.chat, usage: usageSink(h) },
  );

  assertEquals([result.language, result.locale, result.skipped], ['es', 'es-CO', null]);
  assertEquals(result.signature, 'Con cariño, la familia Rivera Soto');
  // The warm letter names a family member outside the core (hard rule): rejected, counted, codes only.
  assertEquals(result.letters.map((l) => l.tone), ['classic', 'playful']);
  assertEquals(result.dropped.letters, 1);
  assertEquals(result.dropped.letterCodes, [{ tone: 'warm', codes: ['forbidden_name'] }]);
  assertEquals(result.dropped.quotes, 1);
  assertEquals(result.dropped.details, 1);
  assertEquals(result.dropped.editorFacts, 1); // "ganó un campeonato" has no evidence
  assertEquals(result.dropped.editorReasons, { no_evidence: 1 });
  assertEquals(result.editorFacts.map((f) => f.kind), ['skill', 'trait']);
  assertEquals(result.editorFacts[0].evidence, ['m-swim']);
  assertEquals(result.qrCaption, 'Escanea para ver nuestro año: parque y piscina.');
  assertEquals(result.lineOfYear?.quote, QUOTE);
  assertEquals(result.lineOfYear?.speaker, 'Tomás');
  assert(result.letters.every((l) => l.chars === Array.from(l.text).length));

  // Usage: every paid call recorded under the card operations, with unique keys.
  const ops = h.usage.map((e) => e.operation);
  const count = (op: string) => ops.filter((o) => o === op).length;
  assertEquals(count('holiday_card_quote_check'), 1);
  assertEquals(count('holiday_card_voice'), 1);
  assertEquals(count('holiday_card_details'), 4);
  assertEquals(count('holiday_card_editor'), 1);
  assertEquals(count('holiday_card_writer'), 3);
  assertEquals(new Set(h.usage.map((e) => e.key)).size, h.usage.length);
  assert(h.usage.some((e) => e.key === 'writer:es:warm' && e.model === 'gpt-6.1-sol'));
  assert(h.usage.some((e) => e.key === 'editor:es'));
  // Cheap model for the voice card and details, Sol for the creative steps.
  assertEquals(h.usage.find((e) => e.operation === 'holiday_card_voice')?.model, 'gpt-6-luna');
});

Deno.test('letters: no film -> no QR caption; prepared results skip the paid preparation calls', async () => {
  const data = lettersData();
  const prep = lettersHarness();
  const prepared = await prepareCardLetters({ today: '2026-10-06', data, greeting: 'holidays', filmPresent: false }, { chat: prep.chat, usage: usageSink(prep) });
  assertEquals(prepared.quotes.length, 1);
  assertEquals(Object.keys(prepared.specifics).sort(), [LUCIA, TOMAS]);
  assertEquals(prepared.voiceCard?.person, 'we');
  assertEquals(prep.calls.map((c) => c.operation).filter((o) => o === 'editor' || o === 'writer'), []);

  const h = lettersHarness();
  const result = await writeCardLetters(
    { today: '2026-10-06', data, greeting: 'holidays', filmPresent: false, prepared },
    { chat: h.chat, usage: usageSink(h) },
  );
  assertEquals(h.calls.map((c) => c.operation), ['editor', 'writer', 'writer', 'writer']);
  assertEquals(result.qrCaption, null); // the editor's caption is dropped when there is no film
  assertEquals(result.lineOfYear?.quote, QUOTE);
  assertEquals(result.dropped.quotes, 1);
});

Deno.test('letters: failed calls are recorded and leave no letters; no log carries text', async () => {
  const data = lettersData();
  const h = lettersHarness({ fail: true });
  const logged: unknown[][] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => void logged.push(a);
  console.error = (...a) => void logged.push(a);
  console.warn = (...a) => void logged.push(a);
  let result;
  try {
    result = await writeCardLetters({ today: '2026-10-06', data, greeting: 'christmas', filmPresent: true }, { chat: h.chat, usage: usageSink(h) });
  } finally {
    Object.assign(console, original);
  }
  assertEquals(result.letters, []);
  assertEquals(result.skipped, 'editor_call_failed');
  assertEquals(result.lineOfYear, null);
  assert(h.usage.length > 0 && h.usage.every((e) => !e.ok));
  assertEquals(logged, []);
});

Deno.test('letters: a pool with no text to tell yields no letters and no editor/writer calls', async () => {
  const data = lettersData();
  const bare: CardLettersData = { ...data, memories: data.memories.map((m) => ({ ...m, text: null })) };
  const h = lettersHarness();
  const result = await writeCardLetters({ today: '2026-10-06', data: bare, greeting: null, filmPresent: false }, { chat: h.chat, usage: usageSink(h) });
  assertEquals([result.letters, result.skipped], [[], 'no_highlights']);
  assertEquals(h.calls.filter((c) => c.operation === 'editor' || c.operation === 'writer'), []);
});

// ── Worker safety ────────────────────────────────────────────────────────

Deno.test('the generation modules and everything they import stay Worker-safe (no Deno/process/npm/jsr/url imports)', async () => {
  const root = new URL('./', import.meta.url);
  const seen = new Set<string>();
  const queue = ['holiday-card-generate-front.ts', 'holiday-card-generate-letters.ts', 'holiday-card-generate-ports.ts'];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await Deno.readTextFile(new URL(file, root));
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assertFalse(/\bDeno\.[A-Za-z]/.test(code), `${file} uses a Deno API`);
    assertFalse(/\bprocess\.[a-z]/.test(code), `${file} reads process`);
    assertFalse(/\bimport\(/.test(code), `${file} has a dynamic import`);
    for (const match of code.matchAll(/^(?:import\b.*|\})\s*from\s*['"]([^'"]+)['"]/gm)) {
      assert(match[1].startsWith('./'), `${file} imports ${match[1]}`);
      queue.push(match[1].slice(2));
    }
  }
  assert(seen.size > 10);
});

Deno.test('front: only jpeg/png/webp are printable (parameters and case ignored)', () => {
  for (const t of ['image/jpeg', 'image/png', 'image/webp', 'IMAGE/JPEG', 'image/jpeg; charset=binary']) assert(isPrintableFrontType(t), t);
  for (const t of ['image/heic', 'image/heif', 'image/gif', 'video/mp4', '', null, undefined]) assertFalse(isPrintableFrontType(t), String(t));
});
