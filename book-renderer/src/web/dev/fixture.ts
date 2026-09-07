import { parseManifest, parseOutline } from '../../model/loader';
import type { BookManifest, BookOutline } from '../../model/types';
import { COVER_SLOT_KEY, isFurnitureKey, type MemoryBookEditsShape } from '../../model/edits';
import type { MemoryBookRow } from '../types';
import type { PickerPoolItem, PickerPoolPage, SaveEditInput, SaveEditResult } from '../edits/editsApi';

/**
 * DEV-ONLY fixture mode (owner-approved follow-up round: "diagnose live" —
 * reproduce the reported picker/popover bugs, and verify the furniture-
 * namespace + always-on-editing work, without a running Supabase backend or
 * a logged-in session). Loads one book's `manifest.json`/`book.outline.json`
 * straight from `book-data/<slug>/` (served by the dev server's own
 * `publicDir` — see `vite.web.config.ts`'s header comment) and stands in for
 * every network call the real editing flow makes (`useEditableBook`'s
 * Supabase reads, `editsApi.ts`'s `memory-book-edits` invocations,
 * `coalescer.ts`'s `get-media-url` invocations) with an equivalent local,
 * in-memory implementation.
 *
 * SAFETY: every export here is gated behind `import.meta.env.DEV` (a
 * compile-time constant Vite replaces per-build — `false` for
 * `vite build --config vite.web.config.ts`), so the `if (false) { ... }`
 * branches this module's callers wrap around every use of it are dead code
 * a production build's minifier eliminates, taking this module's import
 * with them. `scripts/check-web-bundle.mjs` asserts that held for the REAL
 * built output, not just this file's intent (same "don't trust the config
 * alone" posture that script's own header comment documents for
 * `publicDir`) — see its `FIXTURE_MARKERS` check.
 */

const FIXTURE_QUERY_PARAM = 'fixture';

/** The active `?fixture=<slug>` slug, DEV-only — always `null` in a
 * production build (both because the query param won't be set on a real
 * deploy, and because `import.meta.env.DEV` itself is statically `false`
 * there). */
export function getFixtureSlug(): string | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  const slug = new URLSearchParams(window.location.search).get(FIXTURE_QUERY_PARAM);
  return slug && slug.length > 0 ? slug : null;
}

export function fixtureAssetUrl(slug: string, file: string): string {
  // `book-data/<slug>/` is this dev server's own `publicDir` root, and
  // manifest `file` values already carry their own `assets/` prefix (see
  // `model/loader.ts`'s `staticAssetUrl` doc comment) — identical
  // resolution to the local preview app's default asset URL provider.
  return `/${slug}/${file}`;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fixture: failed to fetch ${path} (${res.status})`);
  return res.json();
}

export interface FixtureBook {
  book: MemoryBookRow;
  outline: BookOutline;
  manifest: BookManifest;
}

/** Loads + parses one fixture book's outline/manifest through the SAME
 * validated parsers the real load path uses (`model/loader.ts`) — never a
 * separate ad hoc shape, so a malformed local export fails the same way it
 * would for a real book. */
export async function loadFixtureBook(slug: string): Promise<FixtureBook> {
  const [manifestRaw, outlineRaw] = await Promise.all([
    fetchJson(`/${slug}/manifest.json`),
    fetchJson(`/${slug}/book.outline.json`),
  ]);
  const manifest = parseManifest(manifestRaw);
  const outline = parseOutline(outlineRaw);
  const now = new Date().toISOString();
  const book: MemoryBookRow = {
    id: slug,
    family_id: 'fixture-family',
    child_id: manifest.child.id,
    status: 'ready',
    scope_label: manifest.scope.label,
    failure_reason: null,
    created_at: now,
    updated_at: now,
    book_document: { outline: outlineRaw, manifest: manifestRaw },
    child: { name: manifest.child.name },
  };
  return { book, outline, manifest };
}

// ---------------------------------------------------------------------------
// Edits store — one per fixture slug. Backed by `sessionStorage` (owner-
// approved follow-up round, item 1: "toast Remove flow incl. reload
// persistence" needs a real reload to mean something) rather than a bare
// module-level `Map`: a `Map` alone is wiped by ANY full page reload (a new
// JS realm starts from scratch), which made "does the orphan actually stay
// gone after a reload" impossible to verify against fixture mode at all —
// every reload looked "fixed" whether or not the delete really worked.
// `sessionStorage` survives a same-tab reload but still clears itself when
// the tab/window closes, so this is still throwaway, dev-only data with no
// real persistence layer behind it — just enough to make a reload a
// meaningful test within one diagnosis session.
// ---------------------------------------------------------------------------

const EDITS_STORAGE_PREFIX = 'momora-fixture-edits:';
const editsCache = new Map<string, MemoryBookEditsShape>();

function currentEdits(slug: string): MemoryBookEditsShape {
  const cached = editsCache.get(slug);
  if (cached) return cached;
  if (typeof window === 'undefined' || !window.sessionStorage) return {};
  try {
    const raw = window.sessionStorage.getItem(EDITS_STORAGE_PREFIX + slug);
    const parsed = raw ? (JSON.parse(raw) as MemoryBookEditsShape) : {};
    editsCache.set(slug, parsed);
    return parsed;
  } catch {
    return {};
  }
}

function persistEdits(slug: string, edits: MemoryBookEditsShape): void {
  editsCache.set(slug, edits);
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(EDITS_STORAGE_PREFIX + slug, JSON.stringify(edits));
  } catch {
    // Best-effort only — dev diagnosis tooling, never a real data path.
  }
}

/** Read-only accessor for `useEditableBook.ts`'s fixture `load()` branch —
 * so re-loading a fixture book (a remount, or a real reload within the same
 * tab/session) picks up whatever this book's edits already are, exactly like
 * the real path re-fetching `memory_book_edits` would, instead of always
 * starting over from an empty `{}`. */
export function fixtureCurrentEdits(slug: string): MemoryBookEditsShape {
  return currentEdits(slug);
}

const TEXT_TARGET_PATTERN =
  /^(dedication|closing|backCover|sectionTitle:[^\x00-\x1f]{1,128}|eyebrow:[^\x00-\x1f]{1,128}|caption:[0-9a-f-]{36})$/i;
const TEXT_VALUE_MAX_LENGTH = 1000;

function isValidTextTarget(target: string): boolean {
  if (target.startsWith('furniture:')) return isFurnitureKey(target.slice('furniture:'.length));
  return TEXT_TARGET_PATTERN.test(target);
}

/** Fixture stand-in for `editsApi.ts`'s `saveEdit` — mirrors
 * `supabase/functions/memory-book-edits/index.ts`'s `handleSaveEdit`
 * validation just closely enough to catch a genuinely malformed edit during
 * local diagnosis, WITHOUT re-implementing its server-only trust-boundary
 * work (media-row family-ownership resolution, ranged-GET dimension
 * measurement) — `mediaId` here is trusted directly against the fixture's
 * own synthetic picker pool (`fixturePickerPool` below), which is the only
 * source of `mediaId`s a fixture-mode caller could ever pass. */
export async function fixtureSaveEdit(slug: string, edit: SaveEditInput): Promise<SaveEditResult> {
  const current = currentEdits(slug);
  const next: MemoryBookEditsShape = {
    text: { ...current.text },
    images: { ...current.images },
    focalPoints: { ...current.focalPoints },
  };

  switch (edit.kind) {
    case 'text': {
      if (!isValidTextTarget(edit.target)) return { edits: current, error: 'Invalid text edit target' };
      if (edit.value.length > TEXT_VALUE_MAX_LENGTH) return { edits: current, error: 'Invalid text edit value' };
      next.text![edit.target] = { target: edit.target, value: edit.value };
      break;
    }
    case 'imageReplace':
    case 'coverPhoto': {
      const pool = poolForSlug(slug);
      const item = pool.find((i) => i.mediaId === edit.mediaId);
      if (!item) return { edits: current, error: 'Media not found' };
      const slotKeyValue = edit.kind === 'coverPhoto' ? COVER_SLOT_KEY : edit.slot;
      next.images![slotKeyValue] = {
        slot: slotKeyValue,
        mediaId: item.mediaId,
        file: item.previewKey,
        originalFile: item.previewKey,
        aspectRatio: item.aspectRatio ?? 1,
      };
      break;
    }
    case 'focalPoint': {
      if (edit.x < 0 || edit.x > 1 || edit.y < 0 || edit.y > 1) return { edits: current, error: 'Invalid focal point' };
      next.focalPoints![edit.slot] = { slot: edit.slot, x: edit.x, y: edit.y };
      break;
    }
    case 'delete': {
      // Mirrors the Edge Function's `delete` kind (owner-approved follow-up
      // round, item 3a "Reset to original") — removing a key that was never
      // set is a no-op, same idempotent posture as the real server.
      const category = next[edit.category];
      if (category) delete category[edit.key];
      break;
    }
    default:
      return { edits: current, error: 'Unknown edit kind' };
  }

  persistEdits(slug, next);
  return { edits: next, error: null };
}

// ---------------------------------------------------------------------------
// Picker pool — every photo asset across the fixture manifest's memories,
// paginated with a deliberately SMALL page size so exhausting it (to verify
// "hide Load more when nextCursor is null") doesn't need hundreds of clicks.
// ---------------------------------------------------------------------------

const FIXTURE_PICKER_PAGE_SIZE = 12;
const poolCache = new Map<string, PickerPoolItem[]>();

function poolForSlug(slug: string): PickerPoolItem[] {
  return poolCache.get(slug) ?? [];
}

function buildPool(manifest: BookManifest): PickerPoolItem[] {
  const items: PickerPoolItem[] = [];
  const entries = Object.entries(manifest.memories).sort(([, a], [, b]) => a.date.localeCompare(b.date));
  for (const [memoryId, memory] of entries) {
    memory.assets.forEach((asset, i) => {
      if (asset.kind !== 'photo') return;
      items.push({
        memoryId,
        mediaId: `${memoryId}::${i}`,
        previewKey: asset.file,
        date: memory.date,
        aspectRatio: asset.aspectRatio,
        alreadyInBook: false,
      });
    });
  }
  return items;
}

/** Registers this fixture's picker pool — called once from `loadFixtureBook`'s
 * caller (`useEditableBook.ts`) after the manifest is available, so
 * `fixturePickerPool`/`fixtureSaveEdit` (both slug-keyed, no manifest of
 * their own) can resolve `mediaId`s against it. */
export function registerFixturePool(slug: string, manifest: BookManifest): void {
  if (poolCache.has(slug)) return;
  poolCache.set(slug, buildPool(manifest));
}

/** Fixture stand-in for `editsApi.ts`'s `fetchPickerPool` — offset-paginated
 * over the registered pool, same `nextCursor: null` exhaustion contract the
 * real Edge Function uses (see `handlePickerPool`'s own doc comment). An
 * item already chosen via a saved `imageReplace`/`coverPhoto` edit in THIS
 * fixture session is flagged `alreadyInBook`, mirroring
 * `collectImageEditMediaIds`. */
export async function fixtureFetchPickerPool(slug: string, cursor: string | null): Promise<PickerPoolPage> {
  const pool = poolForSlug(slug);
  const offset = cursor ? Number(cursor) : 0;
  if (cursor && (!Number.isInteger(offset) || offset < 0)) {
    return { items: [], nextCursor: null, error: 'Invalid cursor' };
  }
  const claimedMediaIds = new Set(Object.values(currentEdits(slug).images ?? {}).map((r) => r.mediaId));
  const page = pool.slice(offset, offset + FIXTURE_PICKER_PAGE_SIZE).map((item) => ({
    ...item,
    alreadyInBook: claimedMediaIds.has(item.mediaId),
  }));
  const nextOffset = offset + FIXTURE_PICKER_PAGE_SIZE;
  const nextCursor = nextOffset < pool.length ? String(nextOffset) : null;
  return { items: page, nextCursor, error: null };
}

/** Fixture stand-in for `coalescer.ts`'s `getMediaUrls` — every key resolves
 * synchronously to this book's own static asset URL (no presigning, no
 * network round trip: `book-data/` is already being served locally). */
export function fixtureMediaUrls(slug: string, keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) out.set(key, fixtureAssetUrl(slug, key));
  return out;
}
