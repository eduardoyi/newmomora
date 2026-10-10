/**
 * Backfill `memory_media.waveform` for existing audio memories that predate
 * real-waveform capture (docs/plans/audio-trim-import.md, "Backfill"). Mirrors
 * backfill-media-previews.ts: dry-run by default, presigned R2 GETs,
 * DATABASE_PAGE_SIZE-batched candidate paging, per-object worker pool, one
 * retry for transient failures, `waveform is null` update guard.
 *
 * Pipeline per row: presigned GET -> temp file -> `ffmpeg -i <tmp> -ac 1
 * -ar 48000 -f f32le -` -> `energiesFromPcm` (maxBuckets 4000, minBucketMs 20:
 * the same parameters the app uses) -> `waveformFromEnergies` ->
 * `sanitizeWaveform` -> guarded update. ALL loudness math lives in
 * src/utils/audio-waveform.ts so backfilled contours match freshly recorded
 * ones; do not reimplement any of it here.
 *
 * Dry run (downloads and analyses, writes NOTHING to the database):
 * deno run --allow-all --env-file=supabase/.env.local --env-file=.env.local \
 *   supabase/scripts/backfill-audio-waveforms.ts
 * # or: npm run backfill:audio-waveforms
 *
 * Apply (service-role write to the database; get owner approval first --
 * dry-run, then a --memory-id pilot, then --apply):
 * ... backfill-audio-waveforms.ts --apply
 * # or: npm run backfill:audio-waveforms -- --apply
 *
 * Optional flags:
 *   --limit N           first N candidate rows only
 *   --memory-id <uuid>  scope to a single memory (pilot run)
 *   --concurrency N     worker pool size (default 4)
 *
 * Idempotent and safe to re-run: the update is guarded by `waveform is null`
 * so an existing waveform is never overwritten. New null-waveform rows keep
 * appearing (older app binaries, analysis timeouts), so re-run periodically.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET (same names as every other
 * script in this directory -- no new secrets). Also requires a local
 * `ffmpeg` binary on PATH.
 *
 * Privacy: logs only row ids, counts, timings and stable error categories.
 * Never object keys, URLs, error bodies or any content (child PII).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

import { createPresignedGetUrls } from '../functions/_shared/r2.ts';
import {
  energiesFromPcm,
  sanitizeWaveform,
  waveformFromEnergies,
} from '../../src/utils/audio-waveform.ts';

// Analysis parameters -- MUST stay identical to what the app passes to the
// native `analyze` call and to energiesFromPcm in the composer.
export const ANALYSIS_MAX_BUCKETS = 4000;
export const ANALYSIS_MIN_BUCKET_MS = 20;
export const DECODE_SAMPLE_RATE = 48000;

/** Every audio content type memory_media can hold (ALLOWED_AUDIO_CONTENT_TYPES). */
export const AUDIO_CONTENT_TYPES = ['audio/mp4', 'audio/m4a', 'audio/x-m4a'] as const;

const DATABASE_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 4;
const PRESIGN_EXPIRES_IN_SECONDS = 300;

export interface AudioMediaRow {
  id: string;
  memory_id: string;
  object_key: string;
}

export type FailureCategory =
  | 'presign'
  | 'download'
  | 'temp_file'
  | 'decode'
  | 'empty_audio'
  | 'invalid_waveform'
  | 'db_update'
  | 'unknown';

/** Error whose `category` is the only thing ever logged about it. */
export class BackfillError extends Error {
  category: FailureCategory;
  constructor(category: FailureCategory) {
    super(category);
    this.name = 'BackfillError';
    this.category = category;
  }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  apply: boolean;
  limit?: number;
  memoryId?: string;
  concurrency: number;
}

function parsePositiveInt(flag: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} needs a positive integer`);
  }
  return Number(value);
}

/** Pure arg parser (covered by the test). Unknown flags throw so typos never silently run a full pass. */
export function parseArgs(args: string[]): BackfillOptions {
  const options: BackfillOptions = { apply: false, concurrency: DEFAULT_CONCURRENCY };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case '--apply':
        options.apply = true;
        break;
      case '--limit':
        options.limit = parsePositiveInt(arg, args[++index]);
        break;
      case '--concurrency':
        options.concurrency = parsePositiveInt(arg, args[++index]);
        break;
      case '--memory-id': {
        const value = args[++index];
        if (!value || value.startsWith('--')) {
          throw new Error('--memory-id needs a value');
        }
        options.memoryId = value;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// PCM helpers
// ---------------------------------------------------------------------------

/** Little-endian float32 bytes (ffmpeg `-f f32le`) -> Float32Array. Copies so alignment never matters. */
export function f32leToFloat32Array(bytes: Uint8Array): Float32Array {
  const usable = bytes.byteLength - (bytes.byteLength % 4);
  const copy = new Uint8Array(usable);
  copy.set(bytes.subarray(0, usable));
  return new Float32Array(copy.buffer);
}

export function buildFfmpegDecodeArgs(inputPath: string): string[] {
  return [
    '-nostdin',
    '-v',
    'error',
    '-i',
    inputPath,
    '-ac',
    '1',
    '-ar',
    String(DECODE_SAMPLE_RATE),
    '-f',
    'f32le',
    '-',
  ];
}

/** Pure core: decoded f32le bytes -> sanitized 64-bucket waveform + decoded duration. */
export function waveformFromPcmBytes(pcmBytes: Uint8Array): {
  waveform: number[];
  durationMs: number;
} {
  const samples = f32leToFloat32Array(pcmBytes);
  if (samples.length === 0) {
    throw new BackfillError('empty_audio');
  }

  const { durationMs, energies } = energiesFromPcm(samples, DECODE_SAMPLE_RATE, {
    maxBuckets: ANALYSIS_MAX_BUCKETS,
    minBucketMs: ANALYSIS_MIN_BUCKET_MS,
  });
  const waveform = sanitizeWaveform(waveformFromEnergies(energies));
  if (!waveform) {
    throw new BackfillError('invalid_waveform');
  }
  return { waveform, durationMs };
}

// ---------------------------------------------------------------------------
// Dependencies (injected so tests spawn no ffmpeg and touch no network / disk)
// ---------------------------------------------------------------------------

export interface WaveformStore {
  /** One page of candidate rows (audio content type, waveform is null). */
  listCandidates(page: { offset: number; size: number; memoryId?: string }): Promise<AudioMediaRow[]>;
  /** `update ... set waveform = … where id = … and waveform is null`; true when a row was written. */
  setWaveformIfNull(id: string, waveform: number[]): Promise<boolean>;
}

export interface TempFiles {
  write(bytes: Uint8Array): Promise<string>;
  remove(path: string): Promise<void>;
}

export interface BackfillDeps {
  store: WaveformStore;
  /** Presigned GET + fetch -> object bytes. Throws BackfillError('presign' | 'download'). */
  downloadObject(objectKey: string): Promise<Uint8Array>;
  tempFiles: TempFiles;
  /** Decode the file at `inputPath` to mono 48 kHz f32le bytes. Throws on failure. */
  runFfmpeg(inputPath: string): Promise<Uint8Array>;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  now?: () => number;
}

export interface BackfillSummary {
  candidates: number;
  /** Rows written (apply) or that would be written (dry run). */
  updated: number;
  /** Rows that already had a waveform by the time we wrote (guarded update matched nothing). */
  skipped: number;
  failed: number;
  failedByCategory: Partial<Record<FailureCategory, number>>;
  failedIds: string[];
}

async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    // Category-only logging: never surface the first error's message.
    return await fn();
  }
}

function categoryOf(error: unknown): FailureCategory {
  return error instanceof BackfillError ? error.category : 'unknown';
}

export async function runBackfill(
  options: BackfillOptions,
  deps: BackfillDeps,
): Promise<BackfillSummary> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const now = deps.now ?? Date.now;

  // Page through candidates (stop early once --limit is reached).
  const candidates: AudioMediaRow[] = [];
  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    const page = await deps.store.listCandidates({
      offset,
      size: DATABASE_PAGE_SIZE,
      memoryId: options.memoryId,
    });
    candidates.push(...page);
    if (page.length < DATABASE_PAGE_SIZE) break;
    if (options.limit && candidates.length >= options.limit) break;
  }
  const rows = options.limit ? candidates.slice(0, options.limit) : candidates;

  const summary: BackfillSummary = {
    candidates: rows.length,
    updated: 0,
    skipped: 0,
    failed: 0,
    failedByCategory: {},
    failedIds: [],
  };

  if (rows.length === 0) {
    log('No audio waveforms need backfilling');
    return summary;
  }

  const memoryCount = new Set(rows.map((row) => row.memory_id)).size;
  log(`Found ${rows.length} candidate audio row(s) across ${memoryCount} memory/memories`);
  log(`${options.apply ? 'Applying' : 'Dry-running'} audio waveform backfill`);

  // Group by object_key so a shared R2 object is downloaded/decoded once.
  const rowsByObjectKey = new Map<string, AudioMediaRow[]>();
  for (const row of rows) {
    const group = rowsByObjectKey.get(row.object_key) ?? [];
    group.push(row);
    rowsByObjectKey.set(row.object_key, group);
  }

  async function analyse(objectKey: string): Promise<{ waveform: number[]; durationMs: number }> {
    const bytes = await withOneRetry(() => deps.downloadObject(objectKey));

    let tempPath: string | undefined;
    try {
      try {
        tempPath = await deps.tempFiles.write(bytes);
      } catch {
        throw new BackfillError('temp_file');
      }

      const path = tempPath;
      let pcm: Uint8Array;
      try {
        pcm = await deps.runFfmpeg(path);
      } catch {
        throw new BackfillError('decode');
      }
      return waveformFromPcmBytes(pcm);
    } finally {
      if (tempPath) {
        await deps.tempFiles.remove(tempPath).catch(() => undefined);
      }
    }
  }

  async function processGroup(objectKey: string, group: AudioMediaRow[]): Promise<void> {
    const startedAt = now();
    const label = `Audio ${group[0].id}${group.length > 1 ? ` (+${group.length - 1} duplicate row(s))` : ''}`;

    try {
      const { waveform, durationMs } = await analyse(objectKey);

      for (const row of group) {
        if (!options.apply) {
          summary.updated += 1;
          continue;
        }

        let written: boolean;
        try {
          written = await withOneRetry(() => deps.store.setWaveformIfNull(row.id, waveform));
        } catch {
          throw new BackfillError('db_update');
        }
        if (written) {
          summary.updated += 1;
        } else {
          summary.skipped += 1;
        }
      }

      log(
        `${label}: ${durationMs}ms decoded, ${waveform.length} buckets, ${now() - startedAt}ms` +
          (options.apply ? ' saved' : ' (dry run)'),
      );
    } catch (error) {
      const category = categoryOf(error);
      summary.failed += group.length;
      summary.failedByCategory[category] = (summary.failedByCategory[category] ?? 0) + group.length;
      summary.failedIds.push(...group.map((row) => row.id));
      logError(`${label}: failed (${category})`);
    }
  }

  const entries = [...rowsByObjectKey.entries()];
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < entries.length) {
      const entry = entries[nextIndex];
      nextIndex += 1;
      await processGroup(...entry);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, entries.length) }, () => runWorker()),
  );

  const categories = Object.entries(summary.failedByCategory)
    .map(([category, count]) => `${category}=${count}`)
    .join(', ');
  log(
    `Finished: ${summary.candidates} candidate(s), ` +
      `${summary.updated} ${options.apply ? 'updated' : 'would be updated'}, ` +
      `${summary.skipped} skipped (already had a waveform), ${summary.failed} failed` +
      (categories ? ` [${categories}]` : '') +
      (summary.failedIds.length > 0 ? ` ids: ${summary.failedIds.join(', ')}` : ''),
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Real dependencies -- everything below has side effects (network/env/disk/
// process spawn) and is exercised only by the manual local check, except
// createSupabaseStore, whose query shape the test pins with a fake builder.
// ---------------------------------------------------------------------------

// Structural slice of the supabase-js client the store needs. Typed loosely on
// purpose: a standalone parameter type for the generated client trips a known
// generic-default mismatch across call sites (see backfill-media-previews.ts).
// deno-lint-ignore no-explicit-any
type LooseSupabase = { from(table: string): any };

export function createSupabaseStore(admin: LooseSupabase): WaveformStore {
  return {
    async listCandidates({ offset, size, memoryId }) {
      let query = admin
        .from('memory_media')
        .select('id, memory_id, object_key')
        .in('content_type', [...AUDIO_CONTENT_TYPES])
        .is('waveform', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + size - 1);

      if (memoryId) {
        query = query.eq('memory_id', memoryId);
      }

      const { data, error } = await query;
      if (error) {
        throw new Error('Could not load audio media rows');
      }
      return data as AudioMediaRow[];
    },

    async setWaveformIfNull(id, waveform) {
      const { data, error } = await admin
        .from('memory_media')
        .update({ waveform })
        .eq('id', id)
        .is('waveform', null)
        .select('id');
      if (error) {
        throw new Error('Could not write waveform');
      }
      return Array.isArray(data) && data.length > 0;
    },
  };
}

async function downloadFromR2(objectKey: string): Promise<Uint8Array> {
  let url: string | undefined;
  try {
    const urls = await createPresignedGetUrls([objectKey], PRESIGN_EXPIRES_IN_SECONDS);
    url = urls[objectKey];
  } catch {
    throw new BackfillError('presign');
  }
  if (!url) {
    throw new BackfillError('presign');
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('bad status');
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new BackfillError('download');
  }
}

const realTempFiles: TempFiles = {
  async write(bytes) {
    const path = await Deno.makeTempFile({ prefix: 'momora-waveform-', suffix: '.m4a' });
    try {
      await Deno.writeFile(path, bytes);
    } catch (error) {
      await Deno.remove(path).catch(() => undefined);
      throw error;
    }
    return path;
  },
  async remove(path) {
    await Deno.remove(path);
  },
};

async function runRealFfmpeg(inputPath: string): Promise<Uint8Array> {
  const output = await new Deno.Command('ffmpeg', {
    args: buildFfmpegDecodeArgs(inputPath),
    stdin: 'null',
    stdout: 'piped',
    stderr: 'null',
  }).output();
  if (!output.success) {
    throw new Error('ffmpeg exited non-zero');
  }
  return output.stdout;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? requireEnv('EXPO_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const summary = await runBackfill(options, {
    store: createSupabaseStore(admin),
    downloadObject: downloadFromR2,
    tempFiles: realTempFiles,
    runFfmpeg: runRealFfmpeg,
  });

  if (summary.failed > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
