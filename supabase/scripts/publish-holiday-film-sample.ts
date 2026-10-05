/**
 * Holiday card dogfood publisher (docs/plans/holiday-cards.md, stage C5).
 *
 * Publishes the owner's locally rendered holiday film so the printed card's QR
 * (https://m.usemomora.com/f/<token>, workers/memory-viewer) plays it:
 *
 *   a. ensures a `year_films` row (kind `family_holiday`, forced, status
 *      `ready`) for the family, reusing it on re-runs (looked up by family +
 *      kind + forced + scope);
 *   b. uploads film.mp4, poster.jpg and poster_thumb.jpg to R2 under
 *      `{ownerId}/year-films/{filmId}/{attemptId}/` (a NEW attempt id per
 *      upload) and only then points the row at them;
 *   c. creates the `film_share_tokens` row (token -> film), refusing if the
 *      token is already active for another film or revoked.
 *
 * DRY RUN unless --apply (service role from --env-file; the dry run only reads).
 * Prints ids, R2 keys, byte counts and a masked token: never memory text, names
 * or the full token.
 *
 *   npm run holiday:publish-sample -- --family <familyId> \
 *     --film-data film-renderer/film-data/holiday-2026 \
 *     --mp4 film-renderer/composition/renders/holiday-2026.mp4 \
 *     --token <22 base62 chars> --year 2026 [--poster-at 3.0] [--bed winter-bells] [--apply]
 *
 * KNOWN GAP (dogfood row): the row is created OUTSIDE the render pipeline, with
 * empty `referenced_*` arrays, so deleting/editing/reporting a memory does NOT
 * invalidate it (no `blocked`, no requeue). Until P1 re-renders the card film
 * under the SAME film id, a removal must be handled by hand: set
 * `year_films.blocked = true` (the page then shows "being updated") or revoke the
 * token. Also: the migration 20261005120000_family_holiday_film_share.sql must be
 * applied first (kind check + film_share_tokens).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getR2Config, headObject, putObjectBytes } from '../functions/_shared/r2.ts';
import {
  buildFilmRowInsert,
  buildFilmRowUpdate,
  filmObjectKeys,
  maskToken,
  parseArgs,
  planToken,
  posterArgs,
  posterThumbArgs,
  readFilmMeta,
  type ExistingToken,
} from './publish-holiday-film-sample-lib.ts';

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const out = await new Deno.Command(cmd, { args, stdout: 'piped', stderr: 'null' }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

async function probe(mp4: string): Promise<{ durationMs: number; width: number; height: number; bytes: number }> {
  const { code, stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', mp4,
  ]);
  if (code !== 0) throw new Error('ffprobe failed on the mp4');
  const info = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
  const stream = info.streams?.[0];
  const seconds = Number(info.format?.duration);
  if (!stream?.width || !stream?.height || !Number.isFinite(seconds) || seconds <= 0) throw new Error('could not read the mp4 dimensions/duration');
  return { durationMs: Math.round(seconds * 1000), width: stream.width, height: stream.height, bytes: (await Deno.stat(mp4)).size };
}

const args = parseArgs(Deno.args);
const mode = args.apply ? 'APPLY' : 'DRY RUN';
console.log(`holiday film publish (${mode}): family ${args.family}, year ${args.year}, token ${maskToken(args.token)}`);

// ── Local inputs ──────────────────────────────────────────────────────────
const filmJson = JSON.parse(await Deno.readTextFile(`${args.filmData.replace(/\/$/, '')}/film.json`));
const meta = readFilmMeta(filmJson, args.year);
const video = await probe(args.mp4);
console.log(`film.json: language ${meta.language}, scope ${meta.scopeStart} -> ${meta.scopeEndExclusive} (exclusive), end card ${meta.greeting ? 'present' : 'missing'}`);
console.log(`mp4: ${video.width}x${video.height}, ${(video.durationMs / 1000).toFixed(1)} s, ${video.bytes} bytes`);
if (video.width !== 1080 || video.height !== 1920) console.warn('warning: the film is not 1080x1920 (9:16)');

// ── Database state (read only) ────────────────────────────────────────────
const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? env('EXPO_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: family, error: familyError } = await supabase.from('families').select('id, owner_id, deleted_at').eq('id', args.family).maybeSingle();
if (familyError) throw new Error(`family lookup failed: ${familyError.code ?? ''}`);
if (!family) throw new Error('family not found');
if (family.deleted_at) throw new Error('the family is pending deletion');
const ownerId = family.owner_id as string;

const { data: existingFilms, error: filmsError } = await supabase
  .from('year_films')
  .select('id, status, blocked, video_key')
  .eq('family_id', args.family)
  .eq('kind', 'family_holiday')
  .eq('forced', true)
  .eq('scope_start_date', meta.scopeStart)
  .eq('scope_end_exclusive', meta.scopeEndExclusive);
if (filmsError) throw new Error(`film lookup failed: ${filmsError.code ?? ''}`);
if ((existingFilms?.length ?? 0) > 1) throw new Error(`${existingFilms!.length} matching forced holiday films; resolve by hand`);
const existing = existingFilms?.[0] as { id: string; status: string; blocked: boolean; video_key: string | null } | undefined;
const filmId = existing?.id ?? crypto.randomUUID();
console.log(
  existing
    ? `film row: existing ${filmId} (status ${existing.status}, blocked ${existing.blocked}, has video ${Boolean(existing.video_key)}) -> will be updated in place`
    : `film row: none yet -> would insert ${filmId} (forced, ready)`,
);

// film_share_tokens only exists once the migration is applied.
let tokenTableMissing = false;
let tokenRow: ExistingToken | null = null;
let activeTokenOfFilm: string | null = null;
{
  const byToken = await supabase.from('film_share_tokens').select('film_id, revoked_at').eq('token', args.token).maybeSingle();
  if (byToken.error) {
    if (['PGRST205', '42P01'].includes(byToken.error.code ?? '')) tokenTableMissing = true;
    else throw new Error(`token lookup failed: ${byToken.error.code ?? ''}`);
  } else {
    tokenRow = (byToken.data as ExistingToken | null) ?? null;
    if (existing) {
      const active = await supabase.from('film_share_tokens').select('token').eq('film_id', existing.id).is('revoked_at', null).maybeSingle();
      if (active.error) throw new Error(`token lookup failed: ${active.error.code ?? ''}`);
      activeTokenOfFilm = (active.data as { token: string } | null)?.token ?? null;
    }
  }
}
if (tokenTableMissing) {
  console.log('film_share_tokens: TABLE NOT FOUND (apply migration 20261005120000_family_holiday_film_share.sql first)');
  if (args.apply) throw new Error('refusing to --apply before the migration is applied');
}
const tokenPlan = tokenTableMissing ? ({ action: 'create' } as const) : planToken(tokenRow, existing?.id ?? null, activeTokenOfFilm, args.token);
console.log(`token: ${tokenTableMissing ? 'would create (after the migration)' : tokenPlan.action === 'conflict' ? `CONFLICT: ${tokenPlan.reason}` : tokenPlan.action === 'noop' ? 'already active for this film (no change)' : 'would create'}`);
if (tokenPlan.action === 'conflict') {
  console.error('Refusing to continue: fix the token conflict first.');
  Deno.exit(1);
}

// ── Plan ──────────────────────────────────────────────────────────────────
const attemptId = crypto.randomUUID();
const keys = filmObjectKeys(ownerId, filmId, attemptId);
const plannedUploads = [
  { key: keys.video, type: 'video/mp4' },
  { key: keys.poster, type: 'image/jpeg' },
  { key: keys.posterThumb, type: 'image/jpeg' },
];
console.log(`${args.apply ? 'Uploading' : '[dry run] would upload'} ${plannedUploads.length} object(s) to R2 under ${keys.prefix}:`);
for (const u of plannedUploads) console.log(`  ${u.key.slice(keys.prefix.length)} (${u.type})`);
console.log(`poster frame at ${args.posterAt} s, ${existing ? 'a NEW attempt directory; the old one is swept by the cleanup job (cleanup_needed)' : 'first upload'}`);

if (!args.apply) {
  console.log('[dry run] nothing was written. Re-run with --apply to publish.');
  Deno.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────────
getR2Config(); // fails early with a clear message when R2 env is missing
const tmp = await Deno.makeTempDir({ prefix: 'holiday-film-' });
try {
  const poster = `${tmp}/poster.jpg`;
  const thumb = `${tmp}/poster_thumb.jpg`;
  if ((await run('ffmpeg', posterArgs(args.mp4, args.posterAt, poster))).code !== 0) throw new Error('ffmpeg could not extract the poster frame');
  if ((await run('ffmpeg', posterThumbArgs(poster, thumb))).code !== 0) throw new Error('ffmpeg could not scale the poster thumbnail');

  const files: { key: string; bytes: Uint8Array; type: string }[] = [
    { key: keys.video, bytes: await Deno.readFile(args.mp4), type: 'video/mp4' },
    { key: keys.poster, bytes: await Deno.readFile(poster), type: 'image/jpeg' },
    { key: keys.posterThumb, bytes: await Deno.readFile(thumb), type: 'image/jpeg' },
  ];
  for (const file of files) {
    await putObjectBytes(file.key, file.bytes, file.type);
    const head = await headObject(file.key);
    if (!head || head.contentLength !== file.bytes.byteLength) throw new Error(`upload verification failed for ${file.key.slice(keys.prefix.length)}`);
    console.log(`  uploaded ${file.key.slice(keys.prefix.length)}: ${file.bytes.byteLength} bytes`);
  }
} finally {
  await Deno.remove(tmp, { recursive: true });
}

// The row is written only now that every object is in R2.
const now = new Date().toISOString();
const rowInput = { familyId: args.family, meta, year: args.year, keys, attemptId, durationMs: video.durationMs, bed: args.bed, now };
if (existing) {
  const { error } = await supabase.from('year_films').update(buildFilmRowUpdate(rowInput)).eq('id', filmId);
  if (error) throw new Error(`row update failed (${error.code ?? ''}); uploaded objects remain under ${keys.prefix}`);
  console.log(`film row ${filmId}: updated (keys now point at attempt ${attemptId})`);
} else {
  const { error } = await supabase.from('year_films').insert(buildFilmRowInsert({ ...rowInput, filmId }));
  if (error) throw new Error(`row insert failed (${error.code ?? ''}); uploaded objects remain under ${keys.prefix}`);
  console.log(`film row ${filmId}: inserted`);
}

if (tokenPlan.action === 'create') {
  const { error } = await supabase.from('film_share_tokens').insert({ token: args.token, film_id: filmId });
  if (error) throw new Error(`token insert failed (${error.code ?? ''})`);
  console.log(`token ${maskToken(args.token)}: created for film ${filmId}`);
} else {
  console.log(`token ${maskToken(args.token)}: already active for film ${filmId}`);
}
console.log(`done: https://m.usemomora.com/f/<token> now serves film ${filmId}`);
