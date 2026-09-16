import {
  WIDGET_LEASE_MS,
  WIDGET_MANIFEST_SCHEMA_VERSION,
  WIDGET_MAX_ENTRIES,
  type WidgetManifest,
  type WidgetManifestColors,
  type WidgetManifestEntry,
} from './types';

const MAX_ID_LENGTH = 128;
const MAX_DATE_LABEL_LENGTH = 80;
const MAX_EXCERPT_LENGTH = 500;
const MAX_FILENAME_LENGTH = 180;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX_COLOR_PATTERN = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export class WidgetManifestError extends Error {
  readonly code = 'WIDGET_MANIFEST_INVALID';
}

function invalid(message: string): never {
  throw new WidgetManifestError(message);
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /\u0000/.test(value)
  ) {
    invalid(`Invalid widget manifest ${field}.`);
  }
  return value;
}

/** Accept Supabase's `+00:00` timestamps and normalize all wire dates to UTC. */
function requireIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) {
    invalid(`Invalid widget manifest ${field}.`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    invalid(`Invalid widget manifest ${field}.`);
  }
  return new Date(milliseconds).toISOString();
}

function parseColors(value: unknown): WidgetManifestColors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Invalid widget manifest colors.');
  }

  const colors = value as Record<string, unknown>;
  const background = requireString(colors.background, 'colors.background', 9);
  const foreground = requireString(colors.foreground, 'colors.foreground', 9);
  const accent = colors.accent === undefined
    ? undefined
    : requireString(colors.accent, 'colors.accent', 9);
  if (
    !HEX_COLOR_PATTERN.test(background) ||
    !HEX_COLOR_PATTERN.test(foreground) ||
    (accent !== undefined && !HEX_COLOR_PATTERN.test(accent))
  ) {
    invalid('Invalid widget manifest colors.');
  }
  return accent ? { background, foreground, accent } : { background, foreground };
}

function parseEntry(value: unknown): WidgetManifestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Invalid widget manifest entry.');
  }
  const entry = value as Record<string, unknown>;
  const kind = entry.kind;
  if (
    kind !== 'illustration' &&
    kind !== 'photo' &&
    kind !== 'video' &&
    kind !== 'audio' &&
    kind !== 'text' &&
    kind !== 'neutral'
  ) {
    invalid('Invalid widget manifest entry kind.');
  }

  const mediaIndex = entry.mediaIndex;
  if (
    mediaIndex !== undefined &&
    (!Number.isInteger(mediaIndex) || (mediaIndex as number) < 0 || (mediaIndex as number) > 9)
  ) {
    invalid('Invalid widget manifest media index.');
  }

  const imageFilename = entry.imageFilename;
  if (
    imageFilename !== undefined &&
    (
      typeof imageFilename !== 'string' ||
      imageFilename.length > MAX_FILENAME_LENGTH ||
      !FILENAME_PATTERN.test(imageFilename) ||
      imageFilename.includes('..')
    )
  ) {
    invalid('Invalid widget manifest image filename.');
  }

  const excerpt = requireString(entry.excerpt, 'excerpt', MAX_EXCERPT_LENGTH);
  const memoryDate = requireString(entry.memoryDate, 'memoryDate', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(memoryDate)) {
    invalid('Invalid widget manifest memory date.');
  }

  return {
    startsAt: requireIsoTimestamp(entry.startsAt, 'startsAt'),
    memoryId: requireString(entry.memoryId, 'memoryId', MAX_ID_LENGTH),
    sourceUpdatedAt: requireIsoTimestamp(entry.sourceUpdatedAt, 'sourceUpdatedAt'),
    memoryDate,
    dateLabel: requireString(entry.dateLabel, 'dateLabel', MAX_DATE_LABEL_LENGTH),
    ...(mediaIndex === undefined ? {} : { mediaIndex: mediaIndex as number }),
    ...(imageFilename === undefined ? {} : { imageFilename: imageFilename as string }),
    excerpt,
    colors: parseColors(entry.colors),
    kind,
  };
}

/** Validate and normalize data crossing the native cache boundary. */
export function parseWidgetManifest(value: unknown): WidgetManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Invalid widget manifest.');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== WIDGET_MANIFEST_SCHEMA_VERSION) {
    invalid('Unsupported widget manifest schema version.');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length > WIDGET_MAX_ENTRIES) {
    invalid('Invalid widget manifest entries.');
  }

  const verifiedAt = requireIsoTimestamp(manifest.verifiedAt, 'verifiedAt');
  const expiresAt = requireIsoTimestamp(manifest.expiresAt, 'expiresAt');
  const verifiedMilliseconds = Date.parse(verifiedAt);
  const expiresMilliseconds = Date.parse(expiresAt);
  if (expiresMilliseconds - verifiedMilliseconds !== WIDGET_LEASE_MS) {
    invalid('Invalid widget manifest lease duration.');
  }

  const generationId = requireString(manifest.generationId, 'generationId', MAX_ID_LENGTH);
  if (!GENERATION_PATTERN.test(generationId)) {
    invalid('Invalid widget manifest generation id.');
  }

  const entries = manifest.entries.map(parseEntry);
  let previousStart = verifiedMilliseconds - 1;
  for (const entry of entries) {
    const startsMilliseconds = Date.parse(entry.startsAt);
    if (
      startsMilliseconds < verifiedMilliseconds ||
      startsMilliseconds >= expiresMilliseconds ||
      startsMilliseconds <= previousStart
    ) {
      invalid('Widget manifest entries must have increasing startsAt values within the lease.');
    }
    previousStart = startsMilliseconds;
  }

  return {
    schemaVersion: WIDGET_MANIFEST_SCHEMA_VERSION,
    accountId: requireString(manifest.accountId, 'accountId', MAX_ID_LENGTH),
    familyId: requireString(manifest.familyId, 'familyId', MAX_ID_LENGTH),
    generationId,
    verifiedAt,
    expiresAt,
    timezone: requireString(manifest.timezone, 'timezone', 128),
    entries,
  };
}

export function serializeWidgetManifest(manifest: WidgetManifest): string {
  return JSON.stringify(parseWidgetManifest(manifest));
}
