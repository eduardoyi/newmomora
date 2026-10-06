/**
 * Loads the rows a holiday card prints from and turns them into the frozen
 * snapshot (docs/plans/holiday-cards-p1.md Step 6, `create_checkout`):
 * `holiday_cards` row + family + people + dated portrait versions + the chosen
 * front photo's media record, with pixel sizes probed from the ORIGINALS by a
 * ranged read, fed to `buildCardSnapshot` (pure) and hashed.
 *
 * Trust: client-supplied keys are never used. The front photo is whatever
 * `edits.frontImage` names (else the best ranked candidate), and its media
 * record must belong to a memory of THIS card's family and be a jpeg/png/webp
 * image; its pixel size comes from the object itself, EXIF-corrected.
 *
 * Tone mapping (reported in the Step 6 notes): the writer's angles are stored
 * as `classic | warm | playful` (`holiday_cards.letters[].tone`), but the card
 * renderer's tones are `classic | short | playful | reflective`: the warm angle
 * is the renderer's `reflective` (`cardToneForAngle` in the letters module). The
 * snapshot module does not translate, so this loader maps `warm -> reflective`
 * in the letters, in `edits.letters` keys and in `edits.choices.tone`.
 *
 * PII: the snapshot holds the family's letter text, names and photo keys by
 * design (it IS the print content). Nothing here logs; errors carry codes.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { coreFamilyMemberIds } from './holiday-card-photos.ts';
import {
  type ImageReaderPort,
  type ImageSizeParser,
} from './holiday-card-generate-ports.ts';
import { probePhotoDimensions } from './holiday-card-generate-front.ts';
import {
  type BuildCardSnapshotInput,
  buildCardSnapshot,
  CARD_GREETING_KEYS,
  type CardFormat,
  type CardGreetingKey,
  type CardLanguage,
  CardSnapshotError,
  type CardSnapshot,
  normalizeCardEdits,
  type SnapshotMedia,
  snapshotHash,
} from './holiday-card-snapshot.ts';
import { type PortraitVersionCandidate, resolvePortraitVersionAtDate } from './portrait-versions.ts';

export type CardLoadErrorCode =
  | 'CARD_NOT_FOUND'
  | 'CARD_DELETED'
  | 'CARD_NOT_READY'
  | 'FAMILY_NOT_FOUND'
  | 'FRONT_PHOTO_UNREADABLE'
  | 'NO_FRONT_PHOTO'
  | 'NO_LETTERS'
  | 'INVALID_CARD'
  | 'LOAD_FAILED';

export class CardLoadError extends Error {
  constructor(public readonly code: CardLoadErrorCode) {
    super(`Card load failed: ${code}`);
    this.name = 'CardLoadError';
  }
}

export interface HolidayCardRow {
  id: string;
  family_id: string;
  status: string;
  deleted_at: string | null;
  year: number;
  language: string;
  locale: string | null;
  film_id: string | null;
  share_token: string | null;
  greeting: string;
  front_candidates: unknown;
  letters: unknown;
  qr_caption: string | null;
  signature: string | null;
  edits: unknown;
  created_at: string;
}

export const HOLIDAY_CARD_COLUMNS =
  'id, family_id, status, deleted_at, year, language, locale, film_id, share_token, greeting, front_candidates, letters, qr_caption, signature, edits, created_at';

export interface SnapshotLoaderDeps {
  /** Presigned GET URLs for R2 keys (`_shared/r2.ts#createPresignedGetUrls`). */
  createPresignedGetUrls: (keys: string[], expiresIn?: number) => Promise<Record<string, string>>;
  fetch: typeof fetch;
  /** Header parser (`image-size`); defaults to `npm:image-size`. */
  imageSize?: ImageSizeParser;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PROBE_URL_EXPIRY_SECONDS = 300;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `warm` (writer angle) -> `reflective` (renderer tone). Anything else passes through. */
export function rendererTone(tone: string): string {
  return tone === 'warm' ? 'reflective' : tone;
}

/** Ranked media ids out of `front_candidates` (an array, or `{ candidates: [...] }`); legacy ids dropped. */
export function candidateIdsFrom(value: unknown): string[] {
  const list = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.candidates) ? value.candidates : [];
  const ids: string[] = [];
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : isObj(entry) && typeof entry.mediaId === 'string' ? entry.mediaId : null;
    if (id && UUID.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Letter variants out of `letters` (an array, or `{ variants: [...] }`), tone mapped for the renderer. */
export function lettersFrom(value: unknown): { tone: string; text: string }[] {
  const list = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.variants) ? value.variants : [];
  const out: { tone: string; text: string }[] = [];
  for (const entry of list) {
    if (isObj(entry) && typeof entry.tone === 'string' && typeof entry.text === 'string' && entry.text.trim()) {
      out.push({ tone: rendererTone(entry.tone), text: entry.text });
    }
  }
  return out;
}

/** The card's `edits` with the writer tone names translated (`edits.letters` keys and `choices.tone`). */
export function editsForRenderer(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const edits: Record<string, unknown> = { ...raw };
  if (isObj(raw.letters)) {
    const letters: Record<string, unknown> = {};
    for (const [tone, text] of Object.entries(raw.letters)) letters[rendererTone(tone)] = text;
    edits.letters = letters;
  }
  if (isObj(raw.choices) && typeof raw.choices.tone === 'string') {
    edits.choices = { ...raw.choices, tone: rendererTone(raw.choices.tone) };
  }
  return edits;
}

async function defaultImageSize(): Promise<ImageSizeParser> {
  const { imageSize } = await import('npm:image-size@1.2.1');
  return imageSize as unknown as ImageSizeParser;
}

function rangedReader(deps: SnapshotLoaderDeps): ImageReaderPort {
  const get = async (key: string, length: number | null): Promise<Uint8Array | null> => {
    let url: string | undefined;
    try {
      url = (await deps.createPresignedGetUrls([key], PROBE_URL_EXPIRY_SECONDS))[key];
    } catch {
      return null;
    }
    if (!url) return null;
    try {
      const response = await deps.fetch(url, length ? { headers: { Range: `bytes=0-${length - 1}` } } : undefined);
      if (!response.ok && response.status !== 206) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  };
  return { readRange: (key, length) => get(key, length), read: (key) => get(key, null) };
}

export interface LoadedCardSnapshot {
  card: HolidayCardRow;
  snapshot: CardSnapshot;
  /** sha256 hex over what prints (`snapshotHash`). */
  hash: string;
}

/**
 * Builds the card's snapshot from the database. Throws `CardLoadError` for a
 * card that cannot be printed (codes only) and lets a thrown supabase error
 * surface as `LOAD_FAILED`.
 */
export async function loadCardSnapshot(
  deps: SnapshotLoaderDeps,
  supabase: SupabaseClient,
  card: HolidayCardRow,
  options: { format: CardFormat; shareTokenActive: boolean },
): Promise<LoadedCardSnapshot> {
  if (card.deleted_at) throw new CardLoadError('CARD_DELETED');
  if (card.status !== 'ready') throw new CardLoadError('CARD_NOT_READY');
  if (!(CARD_GREETING_KEYS as readonly string[]).includes(card.greeting)) throw new CardLoadError('INVALID_CARD');

  const imageSize = deps.imageSize ?? await defaultImageSize();
  const reader = rangedReader(deps);
  const must = <T>(result: { data: T | null; error: unknown }): T => {
    if (result.error) throw new CardLoadError('LOAD_FAILED');
    return (result.data ?? ([] as unknown)) as T;
  };

  const { data: family, error: familyError } = await supabase
    .from('families')
    .select('id, name')
    .eq('id', card.family_id)
    .maybeSingle<{ id: string; name: string }>();
  if (familyError) throw new CardLoadError('LOAD_FAILED');
  if (!family) throw new CardLoadError('FAMILY_NOT_FOUND');

  const people = must(await supabase
    .from('family_members')
    .select('id, name, date_of_birth, relationship, illustrated_profile_key, illustrated_profile_status')
    .eq('family_id', card.family_id)) as {
      id: string;
      name: string;
      date_of_birth: string | null;
      relationship: string | null;
      illustrated_profile_key: string | null;
      illustrated_profile_status: string | null;
    }[];
  const versions = people.length === 0
    ? []
    : must(await supabase
      .from('family_member_portrait_versions')
      .select('id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, created_at')
      .in('family_member_id', people.map((p) => p.id))) as PortraitVersionCandidate[];

  const asOfDate = card.created_at.slice(0, 10);

  // Portraits: probe only the ones the snapshot can use (core members, their
  // dated version or current portrait).
  const coreIds = coreFamilyMemberIds(
    people.map((p) => ({ id: p.id, dateOfBirth: p.date_of_birth, relationship: p.relationship })),
    asOfDate,
  );
  const portraitKeys = new Set<string>();
  for (const person of people.filter((p) => coreIds.has(p.id))) {
    const resolved = resolvePortraitVersionAtDate(versions.filter((v) => v.family_member_id === person.id), asOfDate);
    const key = resolved?.illustrated_profile_key ?? (person.illustrated_profile_status === 'ready' ? person.illustrated_profile_key : null);
    if (key) portraitKeys.add(key);
  }
  const portraitDimensions: Record<string, { width: number; height: number }> = {};
  await Promise.all([...portraitKeys].map(async (key) => {
    const size = await probePhotoDimensions(key, reader, imageSize);
    if (size) portraitDimensions[key] = { width: size.width, height: size.height };
  }));

  // Front photo: the editor's pick (trusted: media must belong to this family)
  // or the top ranked candidates.
  const edits = normalizeCardEdits(card.edits);
  const pickId = edits.frontImage;
  const candidateIds = candidateIdsFrom(card.front_candidates);
  if (pickId !== null && !UUID.test(pickId)) throw new CardLoadError('FRONT_PHOTO_UNREADABLE');
  // The editor shows the pick, or else candidate #1: that photo, and no other, is what prints.
  const wantedIds = pickId ? [pickId] : candidateIds.slice(0, 1);
  if (wantedIds.length === 0) throw new CardLoadError('NO_FRONT_PHOTO');

  const mediaRows = must(await supabase
    .from('memory_media')
    .select('id, memory_id, object_key, preview_object_key, content_type')
    .in('id', wantedIds)) as { id: string; memory_id: string; object_key: string; preview_object_key: string | null; content_type: string }[];
  const memoryIds = [...new Set(mediaRows.map((m) => m.memory_id))];
  const memories = memoryIds.length === 0
    ? []
    : must(await supabase.from('memories').select('id, family_id, memory_date').in('id', memoryIds)) as { id: string; family_id: string; memory_date: string | null }[];
  const memoryById = new Map(memories.map((m) => [m.id, m]));

  const media: SnapshotMedia[] = [];
  await Promise.all(mediaRows.map(async (row) => {
    const memory = memoryById.get(row.memory_id);
    if (!memory || memory.family_id !== card.family_id || !PRINTABLE_TYPES.has(row.content_type)) return;
    const size = await probePhotoDimensions(row.object_key, reader, imageSize);
    media.push({
      id: row.id,
      originalKey: row.object_key,
      previewKey: row.preview_object_key,
      width: size?.width ?? null,
      height: size?.height ?? null,
      memoryId: row.memory_id,
      date: memory.memory_date,
    });
  }));

  const input: BuildCardSnapshotInput = {
    cardId: card.id,
    year: card.year,
    language: (card.language === 'es' ? 'es' : 'en') as CardLanguage,
    locale: card.locale ?? card.language,
    greeting: card.greeting as CardGreetingKey,
    familyName: family.name,
    signature: card.signature ?? '',
    qrCaption: card.qr_caption,
    shareToken: options.shareTokenActive ? card.share_token : null,
    format: options.format,
    letters: lettersFrom(card.letters),
    edits: editsForRenderer(card.edits),
    frontCandidateIds: pickId ? candidateIds : candidateIds.slice(0, 1),
    media,
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      dateOfBirth: p.date_of_birth,
      relationship: p.relationship,
      illustratedProfileKey: p.illustrated_profile_key,
      illustratedProfileStatus: p.illustrated_profile_status,
    })),
    portraitVersions: versions,
    portraitDimensions,
    asOfDate,
  };

  let snapshot: CardSnapshot;
  try {
    snapshot = buildCardSnapshot(input);
  } catch (error) {
    if (error instanceof CardSnapshotError) {
      // A pick the buyer chose that cannot be printed is "unreadable", not "no photo".
      if (error.code === 'NO_FRONT_PHOTO') throw new CardLoadError('FRONT_PHOTO_UNREADABLE');
      throw new CardLoadError(error.code === 'NO_LETTERS' ? 'NO_LETTERS' : 'INVALID_CARD');
    }
    throw error;
  }
  // The buyer previewed this photo: never silently print another one.
  if (snapshot.front.mediaId !== wantedIds[0]) throw new CardLoadError('FRONT_PHOTO_UNREADABLE');

  return { card, snapshot, hash: await snapshotHash(snapshot) };
}

// ── Film / QR gate ───────────────────────────────────────────────────────

export type FilmGate =
  | { ok: true; shareTokenActive: boolean }
  | { ok: false; code: 'FILM_NOT_READY' | 'FILM_BLOCKED' };

/**
 * The QR is OFF (no share token is passed to the snapshot, nothing is checked
 * about the film) when the card has no `share_token`, the token row is missing
 * or revoked (the owner's `disable_link` revokes it WITHOUT touching
 * `edits.choices.qr`), or the buyer switched it off (`edits.choices.qr ===
 * false`). Only when the QR is ON must the film be PUBLISHED: it has a
 * `video_key`, was `ready_at` some time, and is not `blocked` -- whatever its
 * current status (a re-render, or a failed re-render with the video still in
 * place, still serves the old video at the printed link). A film that never
 * published, or lost its video (`ended`), is not ready. A card with no film at
 * all (below the film floor) has no token, so it prints without a QR.
 */
export async function checkFilmGate(supabase: SupabaseClient, card: HolidayCardRow): Promise<FilmGate> {
  const qrOff = normalizeCardEdits(card.edits).choices.qr === false;
  if (qrOff || !card.share_token) return { ok: true, shareTokenActive: false };

  const { data: token, error: tokenError } = await supabase
    .from('film_share_tokens')
    .select('token, revoked_at')
    .eq('token', card.share_token)
    .maybeSingle<{ token: string; revoked_at: string | null }>();
  if (tokenError) throw new CardLoadError('LOAD_FAILED');
  if (!token || token.revoked_at) return { ok: true, shareTokenActive: false };

  if (!card.film_id) return { ok: true, shareTokenActive: false };
  const { data: film, error } = await supabase
    .from('year_films')
    .select('id, status, blocked, video_key, ready_at')
    .eq('id', card.film_id)
    .maybeSingle<{ id: string; status: string; blocked: boolean; video_key: string | null; ready_at: string | null }>();
  if (error) throw new CardLoadError('LOAD_FAILED');
  if (!film) return { ok: true, shareTokenActive: false };
  if (film.blocked) return { ok: false, code: 'FILM_BLOCKED' };
  if (!film.video_key || !film.ready_at || film.status === 'ended') return { ok: false, code: 'FILM_NOT_READY' };
  return { ok: true, shareTokenActive: true };
}

/**
 * Last look before an order moves to `checkout`: the card may have been deleted
 * (or its link disabled) while the print files were being made. `printedToken`
 * is the share token the snapshot printed as a QR (null when it printed none).
 * Returns false when anything changed; throws `CardLoadError('LOAD_FAILED')`
 * on a database error.
 */
export async function cardUnchangedForPrint(
  supabase: SupabaseClient,
  cardId: string,
  printedToken: string | null,
): Promise<boolean> {
  const { data: card, error } = await supabase
    .from('holiday_cards')
    .select('id, deleted_at, share_token')
    .eq('id', cardId)
    .maybeSingle<{ id: string; deleted_at: string | null; share_token: string | null }>();
  if (error) throw new CardLoadError('LOAD_FAILED');
  if (!card || card.deleted_at) return false;
  if (!printedToken) return true;
  if (card.share_token !== printedToken) return false;
  const { data: token, error: tokenError } = await supabase
    .from('film_share_tokens')
    .select('token, revoked_at')
    .eq('token', printedToken)
    .maybeSingle<{ token: string; revoked_at: string | null }>();
  if (tokenError) throw new CardLoadError('LOAD_FAILED');
  return Boolean(token) && !token?.revoked_at;
}
