// Fictional family + fakes for the holiday card Workflow tests (the repo is
// public: no real names, ids or text).
import type { BridgeClient } from '../src/bridge';
import { AttemptStopped } from '../src/bridge';
import type { CardStageDeps } from '../src/card-stages';
import type { ChatFn } from '../src/openai';
import type { Storage } from '../src/storage';
import type { FamilyRows, MemoryRow } from '../../../supabase/functions/_shared/year-film-context.ts';

export const CARD = '11111111-1111-4111-8111-111111111111';
export const ATTEMPT = '22222222-2222-4222-8222-222222222222';
export const OWNER = '33333333-3333-4333-8333-333333333333';
export const FAMILY = '44444444-4444-4444-8444-444444444444';
export const FILM = '55555555-5555-4555-8555-555555555555';
export const FILM_ATTEMPT = '66666666-6666-4666-8666-666666666666';
export const PREFIX = `${OWNER}/holiday-cards/${CARD}/${ATTEMPT}/`;

export const TOMAS = 'tomas';
export const LUCIA = 'lucia';
export const ANA = 'ana';
export const MARCO = 'marco';
export const ROSA = 'rosa';
export const QUOTE = 'la luna nos está siguiendo';
/** Strings that must never appear in a step result, a log or a stored front summary. */
export const SECRET_TEXT = ['superhéroe', 'columpios', QUOTE, 'Tomás', 'FAKE-WHY-SECRET', 'fake-setting-secret'];

export const TODAY = '2026-10-06';

const member = (id: string, name: string, dob: string | null, relationship: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, date_of_birth: dob, relationship, created_at: '2024-01-01T00:00:00Z', ...extra });

export interface FixtureOptions {
  /** How many of the 36 monthly memories to keep (fewer = below the film floors). */
  monthly?: number;
  /** Extra tagged photo memories (for the probe-chunking tests). */
  extraPhotos?: number;
}

export function familyRows(options: FixtureOptions = {}): FamilyRows {
  const memories: MemoryRow[] = [];
  const media: FamilyRows['media'] = [];
  const tags: FamilyRows['tags'] = [];
  const add = (id: string, date: string, text: string, tagged: string[], topics: string[], extra: Partial<MemoryRow> = {}) => {
    memories.push({
      id, content: text, memory_date: date, memory_type: 'media', emotion: 'joy', topics, labels: [], illustration_status: 'none',
      illustration_key: null, media_key: null, media_content_type: null, onboarding_media_pending: false,
      created_at: `${date}T10:00:00Z`, user_id: 'u-ana', ...extra,
    });
    media.push({ id: `a-${id}`, memory_id: id, object_key: `orig/a-${id}`, preview_object_key: `prev/a-${id}`, content_type: 'image/jpeg', duration_ms: null, aspect_ratio: 1.33, position: 0 });
    for (const t of tagged) tags.push({ memory_id: id, family_member_id: t });
  };
  const monthly: (() => void)[] = [];
  ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].forEach((month, i) => {
    monthly.push(() => add(`m-park-${i}`, `${month}-03`, `Tomás y Lucía jugando en el parque grande, tarde número ${i + 1}`, [TOMAS, LUCIA], ['park-playground']));
    monthly.push(() => add(`m-beach-${i}`, `${month}-09`, `Día de playa con la abuela y los niños, ola número ${i + 1}`, [TOMAS, ROSA, LUCIA, ANA], ['beach']));
    monthly.push(() => add(`m-cape-${i}`, `${month}-14`, `Tomás disfrazado de superhéroe otra vez, capa número ${i + 1}`, [TOMAS], ['pretend-play']));
    monthly.push(() => add(`m-swing-${i}`, `${month}-20`, `Lucía descubriendo los columpios, vuelta número ${i + 1}`, [LUCIA], ['christmas']));
  });
  const keep = options.monthly ?? monthly.length;
  monthly.slice(0, keep).forEach((fn) => fn());
  add('m-swim', '2026-06-18', 'Tomás aprendió a nadar sin flotadores en la piscina', [TOMAS], ['swimming']);
  add('m-moon', '2026-08-21', `Mirando por la ventana, Tomás se volteó y dijo: "${QUOTE}"`, [TOMAS], ['pretend-play']);
  for (let i = 0; i < (options.extraPhotos ?? 0); i += 1) {
    const day = String((i % 27) + 1).padStart(2, '0');
    add(`m-extra-${i}`, `2026-0${(i % 9) + 1}-${day}`, `Una tarde en familia número ${i}`, [TOMAS, LUCIA], ['family-gathering']);
  }
  return {
    family: { id: FAMILY, name: 'Rivera Soto', gallery_caption_language: 'es-CO' },
    members: [
      member(TOMAS, 'Tomás Rivera Soto', '2021-10-02', 'child', { gender: 'male' }),
      member(LUCIA, 'Lucía Rivera Soto', '2025-02-10', 'child', { gender: 'female' }),
      member(ANA, 'Ana Soto', '1988-04-01', 'parent', { user_id: 'u-ana' }),
      member(MARCO, 'Marco Rivera', '1986-06-09', 'parent', { user_id: 'u-marco' }),
      member(ROSA, 'Rosa Soto', '1957-01-01', 'grandparent'),
    ],
    memories,
    media,
    tags,
    milestones: [],
    portraits: [],
    reports: [],
  };
}

// ── R2 + image headers ───────────────────────────────────────────────────

/** A fake photo: u32 width, u32 height at offset 0; the preview is a JPEG header. */
export function fakeImage(width: number, height: number, preview = false): Uint8Array {
  const bytes = new Uint8Array(9);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  if (preview) bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

export const readHeader = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error('no header');
  return { width: view.getUint32(0), height: view.getUint32(4) };
};

export function photoObjects(rows: FamilyRows): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  for (const m of rows.media) {
    objects.set(m.object_key, fakeImage(4032, 3024));
    if (m.preview_object_key) objects.set(m.preview_object_key, fakeImage(1280, 960, true));
  }
  return objects;
}

export function memoryStorage(initial: Record<string, unknown> = {}) {
  const objects = new Map<string, unknown>(Object.entries(initial));
  const storage: Storage & { objects: Map<string, unknown> } = {
    objects,
    async putJson(key, value) { objects.set(key, JSON.parse(JSON.stringify(value))); },
    async getJson(key) { return (objects.get(key) as never) ?? null; },
    async getBase64(key) { return objects.has(key) ? 'QUJD' : null; },
    async deleteKeys(keys) { for (const k of keys) objects.delete(k); },
    async deletePrefix(prefix) {
      let n = 0;
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) { objects.delete(k); n += 1; }
      return n;
    },
  };
  return storage;
}

// ── Model fakes (same shapes as supabase/functions/_shared/holiday-card-generate.test.ts) ──

const WHY = 'FAKE-WHY-SECRET';
const SETTING = 'fake-setting-secret';
const CLASSIC = 'Queridos todos:\n\nLes queremos contar un poquito de cómo nos fue este año, entre la piscina y los paseos. Tomás aprendió a nadar sin flotadores y Lucía no se pierde los columpios.\n\nLos queremos mucho y les deseamos una feliz Navidad.';
const WARM = 'Queridos todos:\n\nEste año fue de parque, de playa y de piscina, y Lucía no se pierde los columpios. Tomás aprendió a nadar sin flotadores y se disfrazó de superhéroe cada semana.\n\nLes deseamos una feliz Navidad con todo el cariño.';
const PLAYFUL = 'Queridos todos:\n\nLes contamos en qué andamos: mucha piscina, mucho parque y capas de superhéroe por toda la casa. Tomás nadó sin flotadores y Lucía conquistó los columpios.\n\nLos queremos mucho. ¡Feliz Navidad!';

export interface FakeChat {
  chat: ChatFn;
  calls: string[];
}

export function fakeChat(options: { failEditor?: boolean; failAll?: boolean } = {}): FakeChat {
  const calls: string[] = [];
  const lineNumber = (prompt: string, phrase: string, pattern: RegExp): number => {
    for (const line of prompt.split('\n')) {
      if (line.includes(phrase)) {
        const m = pattern.exec(line);
        if (m) return Number(m[1]);
      }
    }
    throw new Error('phrase not in prompt');
  };
  const ok = (content: unknown) => ({ ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, content: JSON.stringify(content) });
  const chat: ChatFn = async (body) => {
    const messages = body.messages as { content: unknown }[];
    if (options.failAll) { calls.push('failed'); return { ok: false, usage: null, content: null }; }
    if (Array.isArray(messages[1].content)) {
      calls.push('judge');
      const count = (messages[1].content as { type: string }[]).filter((c) => c.type === 'image_url').length;
      return ok({
        photos: Array.from({ length: count }, (_, index) => ({
          index, people_visible: 4, all_faces_visible: true, eyes_open_mostly: true, looking_at_camera: 'most', light: 'good', sharp: true,
          setting: SETTING, unsafe: false, screenshot_or_document: false, crop_risk: false, card_score: 9 - index * 0.2, why: WHY,
        })),
      });
    }
    const [system, user] = messages.map((m) => m.content as string);
    if (system.startsWith('You pick quotes')) {
      calls.push('quote');
      return ok({ language: 'es', quotes: [{ memory_id: 'm-moon', speaker: 'Tomás', quote: QUOTE }] });
    }
    if (system.includes('pull out the SPECIFIC things')) {
      calls.push('details');
      const detail = user.startsWith('Child: Lucía') ? 'columpios' : 'superhéroe';
      return ok({ details: [{ detail, memory_ids: [lineNumber(user, detail, /^\[(\d+)\]/)], recurring: true }] });
    }
    if (system.includes('You describe HOW a family')) {
      calls.push('voice');
      return ok({
        register: 'tú, casual', kids_reference: 'first names', person: 'we', addressee: 'about_the_child', sentence_length: 'medium', rhythm: 'short run-ons',
        formality: 'casual', humor: 'warm', openers: ['Hoy'], closers: ['un abrazo'], punctuation: { exclamations: 'rare', emojis: 'none', ellipses: 'none', notes: '' },
        characteristic: ['otra vez', 'grande', 'capa'], never: ['emojis'],
      });
    }
    if (system.includes('You are the EDITOR')) {
      calls.push('editor');
      if (options.failEditor) return { ok: false, usage: null, content: null };
      return ok({
        facts: [{ about: 'Tomás', kind: 'skill', fact: 'Tomás aprendió a nadar sin flotadores.', evidence: [lineNumber(user, 'nadar sin flotadores', /^(\d+)\./)] }],
        broad_strokes: 'Fue un año de parque, de playa y de piscina.',
        qr_caption: 'Escanea para ver nuestro año: parque y piscina.',
      });
    }
    if (system.startsWith('You write a family')) {
      calls.push('writer');
      const angle = /WRITE THE (\w+) LETTER/.exec(user)![1];
      return ok({ text: angle === 'CLASSIC' ? CLASSIC : angle === 'WARM' ? WARM : PLAYFUL });
    }
    throw new Error('unexpected model call');
  };
  return { chat, calls };
}

// ── The card "database" behind a fake bridge ─────────────────────────────

export interface BridgeCall { op: string; body: Record<string, unknown> }

export interface CardDb {
  calls: BridgeCall[];
  rows: FamilyRows;
  card: {
    status: string;
    attemptId: string;
    deleted: boolean;
    filmId: string | null;
    greeting: string;
    year: number;
    front: unknown;
    letters: unknown;
    saved: Record<string, unknown> | null;
    failureCode: string | null;
  };
  usage: { aiCallId: string; usageOperation: string; model: string }[];
  /** `claim_year_film_by_id` outcome: a film attempt id, or null (zero rows). */
  claim: string | null;
  /** Throw this from the named op (once per call) to simulate failures. */
  failOn: Record<string, Error>;
  bridge: BridgeClient;
}

export function cardDb(rows: FamilyRows = familyRows()): CardDb {
  const db: CardDb = {
    calls: [],
    rows,
    card: { status: 'generating', attemptId: ATTEMPT, deleted: false, filmId: null, greeting: 'christmas', year: 2026, front: null, letters: null, saved: null, failureCode: null },
    usage: [],
    claim: FILM_ATTEMPT,
    failOn: {},
    bridge: {
      async call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
        db.calls.push({ op, body });
        if (db.failOn[op]) throw db.failOn[op];
        // card_start claims an unleased card (the callers only dispatch an attempt id).
        if (op === 'card_start' && db.card.attemptId === '' && db.card.status === 'generating' && !db.card.deleted) db.card.attemptId = ATTEMPT;
        const lease = db.card.deleted ? 'deleted' : db.card.attemptId !== ATTEMPT || db.card.status !== 'generating' ? 'superseded' : 'ok';
        if (op === 'card_start' || op === 'card_heartbeat') {
          return (lease === 'ok' ? { state: 'ok', card: { year: db.card.year, greeting: db.card.greeting, filmId: db.card.filmId } } : { state: lease }) as T;
        }
        if (lease !== 'ok') throw new AttemptStopped(lease);
        switch (op) {
          case 'card_load_context':
            return {
              card: { id: CARD, familyId: FAMILY, ownerId: OWNER, year: db.card.year, greeting: db.card.greeting, language: 'es', locale: 'es-CO', filmId: db.card.filmId, shareToken: db.card.filmId ? 'tok' : null },
              today: body.today, captionInstructions: null, rows: db.rows,
            } as T;
          case 'card_load_media': {
            const ids = new Set(body.mediaIds as string[]);
            return {
              media: db.rows.media.filter((m) => ids.has(m.id)).map((m) => ({ id: m.id, memoryId: m.memory_id, objectKey: m.object_key, previewKey: m.preview_object_key, aspectRatio: m.aspect_ratio })),
            } as T;
          }
          case 'card_save_front': db.card.front = body.front; return { state: 'ok' } as T;
          case 'card_create_film': db.card.filmId = FILM; return { filmId: FILM } as T;
          case 'card_claim_film':
            return (db.claim ? { claimed: true, filmId: FILM, filmAttemptId: db.claim } : { claimed: false, filmId: FILM }) as T;
          case 'card_end_film_cycle': return { status: 'queued' } as T;
          case 'card_save_letters': db.card.letters = body.letters; db.card.saved = body; return { state: 'ok' } as T;
          case 'card_record_usage':
            db.usage.push({ aiCallId: body.aiCallId as string, usageOperation: body.usageOperation as string, model: body.model as string });
            return { recorded: true } as T;
          case 'card_finish':
            db.card.status = body.outcome === 'ready' ? 'ready' : 'failed';
            db.card.failureCode = (body.code as string | undefined) ?? null;
            db.card.attemptId = '';
            return { state: 'ok' } as T;
        }
        throw new Error(`unexpected bridge op ${op}`);
      },
    },
  };
  return db;
}

export interface Harness {
  db: CardDb;
  deps: CardStageDeps;
  storage: ReturnType<typeof memoryStorage>;
  chat: FakeChat;
  rangeReads: string[];
  fullReads: string[];
  filmStarts: { filmId: string; attemptId: string }[];
  startFilmError: { value: Error | null };
}

export function harness(options: { rows?: FamilyRows; chat?: FakeChat; objects?: Map<string, Uint8Array> } = {}): Harness {
  const rows = options.rows ?? familyRows();
  const db = cardDb(rows);
  const objects = options.objects ?? photoObjects(rows);
  const storage = memoryStorage();
  const chat = options.chat ?? fakeChat();
  const h = { db, storage, chat, rangeReads: [] as string[], fullReads: [] as string[], filmStarts: [] as Harness['filmStarts'], startFilmError: { value: null as Error | null } };
  const deps: CardStageDeps = {
    cardId: CARD,
    attemptId: ATTEMPT,
    bridge: db.bridge,
    storage,
    images: {
      readRange: async (key, length) => { h.rangeReads.push(key); const b = objects.get(key); return b ? b.slice(0, length) : null; },
      read: async (key) => { h.fullReads.push(key); return objects.get(key) ?? null; },
    },
    imageSize: readHeader,
    chat: chat.chat,
    startFilm: async (filmId, attemptId) => {
      if (h.startFilmError.value) throw h.startFilmError.value;
      h.filmStarts.push({ filmId, attemptId });
    },
    now: () => new Date(`${TODAY}T15:30:00Z`),
  };
  return { ...h, deps };
}
