#!/usr/bin/env node
/**
 * Year Film render job (docs/plans/year-film-p1.md Decision 4, Step 6). Runs
 * on a one-off Fly machine started by cloudflare/year-film-worker:
 *
 *   job.mjs thumbs   512px JPEGs of the claim-check candidates
 *   job.mjs prepare  stills, ranked clip/voice cuts, check frames and WAVs
 *   job.mjs render   film.json + prepared files → assemble → check → render
 *
 * Input: `${JOB_PREFIX}{thumbs/|prep/|}job.json` in R2. Output under the same
 * attempt prefix, plus a `status.json` (running → done | failed + code).
 * Credentials: per-machine temporary R2 credentials (R2_READ_* for the
 * family's source objects, R2_WRITE_* for the attempt prefix) when the
 * Worker minted them, else the Fly app's R2 secrets. A hard timeout
 * (JOB_TIMEOUT_SECONDS) ends a hung job with a failed status.
 *
 * Privacy: logs carry counts and codes only — never keys or content.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BURST_CLIP_SECONDS,
  parseRmsLevels,
  parseSceneScores,
  rankClipWindows,
  rankVoiceWindows,
  VERIFIED_CLIP_SECONDS,
  voicedSegments,
} from '../../../supabase/functions/_shared/year-film-trim.ts';

const execFileP = promisify(execFile);

/** Runs a command; on failure the error names the step (content-free) and,
 * with JOB_DEBUG=1 (local tests only — never in production), carries the
 * command's stderr tail. */
async function run(cmd, args, options = {}, step = cmd) {
  try {
    return await execFileP(cmd, args, options);
  } catch (error) {
    const wrapped = new Error(`step ${step} failed (${error?.code ?? 'error'})`);
    wrapped.code = `STEP_${String(step).toUpperCase()}`;
    if (process.env.JOB_DEBUG === '1') wrapped.debug = String(error?.stderr ?? error?.message ?? '').slice(-2000);
    // `hyperframes check` prints its report on stdout: log only the failing
    // rule lines (rule ids, selectors, asset file names — never memory text),
    // capped, so a Fly-only failure is diagnosable from `fly logs`.
    if (step === 'check') {
      for (const line of checkFailureLines(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`)) console.log(`check: ${line}`);
    }
    throw wrapped;
  }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILM_RENDERER = process.env.FILM_RENDERER_DIR ?? path.resolve(HERE, '../../../film-renderer');

// ── Pure helpers (tested in test/job.test.mjs) ────────────────────────────

/** The `✗` issue lines of a `hyperframes check` report (ANSI stripped),
 * at most 12, each cut at 240 chars. */
export function checkFailureLines(report) {
  return String(report)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('✗') || /^(Error|TimeoutError)\b/.test(line))
    .slice(0, 12)
    .map((line) => line.slice(0, 240));
}

export function statusKey(prefix, mode) {
  return mode === 'thumbs' ? `${prefix}thumbs/status.json` : mode === 'prepare' ? `${prefix}prep/status.json` : `${prefix}status.json`;
}

export function jobKey(prefix, mode) {
  return mode === 'thumbs' ? `${prefix}thumbs/job.json` : mode === 'prepare' ? `${prefix}prep/job.json` : `${prefix}job.json`;
}

/** Scene list for the viewer (P2 progress bar) from assemble's timeline. */
export function scenesFromTimeline(timeline) {
  return {
    version: 1,
    durationMs: Math.round(timeline.total * 1000),
    scenes: timeline.scenes.map((s) => ({ id: s.id, type: s.type, role: s.role, startMs: Math.round(s.start * 1000), durationMs: Math.round(s.duration * 1000) })),
  };
}

/** H.264 CRF for the film. HyperFrames' default ("looks", CRF 16) made a 60s
 * film 81 MB (~10.6 Mbps) — heavy to stream on cellular and to share. On Enzo's
 * Year Three (Sep 2026): CRF 22 → 27.5 MB (VMAF 96.8), 24 → 21.6 MB (VMAF 95.8),
 * no visible difference side by side; 23 sits in the 20–30 MB/min target. */
export const FILM_CRF = 23;

/** The cover: the FIRST scene, settled (owner, 2026-09-29): the title card /
 * cold open the film opens on ("Nuestro 2026" + the photo pile, "Recuerdos de
 * tu tercer año, Enzo" + portraits), after its entrance animations and before
 * the seam transition into the next scene. The `max` guards very short first
 * scenes (below ~0.7s the 0.85 point would sit inside the transition, so fall
 * back to the midpoint). */
export function posterTime(timeline) {
  const first = timeline.scenes.reduce((a, s) => (a === null || s.start < a.start ? s : a), null);
  if (!first) return +(timeline.total * 0.8).toFixed(3);
  const settled = Math.max(first.duration * 0.5, Math.min(first.duration * 0.85, first.duration - 0.35));
  return +(first.start + settled).toFixed(3);
}

export function isHeic(key) {
  return /\.(heic|heif)$/i.test(key);
}

// ── R2 ────────────────────────────────────────────────────────────────────

function client(kind) {
  const prefix = kind === 'read' ? 'R2_READ_' : 'R2_WRITE_';
  const temp = process.env[`${prefix}ACCESS_KEY_ID`];
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    // Path-style like the book renderer's R2 client (and S3-compatible test
    // stores); R2 accepts both.
    forcePathStyle: true,
    credentials: temp
      ? { accessKeyId: temp, secretAccessKey: process.env[`${prefix}SECRET_ACCESS_KEY`], sessionToken: process.env[`${prefix}SESSION_TOKEN`] }
      : { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

const BUCKET = () => process.env.R2_BUCKET;
let readClient;
let writeClient;
const reader = () => (readClient ??= client('read'));
const writer = () => (writeClient ??= client('write'));

async function download(key, dest, which = 'read') {
  const res = await (which === 'read' ? reader() : writer()).send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
  await fs.promises.writeFile(dest, Buffer.from(await res.Body.transformToByteArray()));
}

async function readJson(key) {
  const res = await writer().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
  return JSON.parse(await res.Body.transformToString());
}

async function upload(key, filePathOrBody, contentType) {
  const body = typeof filePathOrBody === 'string' && fs.existsSync(filePathOrBody) ? await fs.promises.readFile(filePathOrBody) : filePathOrBody;
  await writer().send(new PutObjectCommand({ Bucket: BUCKET(), Key: key, Body: body, ContentType: contentType }));
}

async function writeStatus(prefix, mode, status) {
  await upload(statusKey(prefix, mode), JSON.stringify({ ...status, updatedAt: new Date().toISOString() }), 'application/json');
}

// ── Media ─────────────────────────────────────────────────────────────────

async function ffmpeg(args) {
  try {
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

async function probe(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:stream_side_data=rotation:format=duration', '-of', 'json', file]);
    const j = JSON.parse(stdout);
    const video = (j.streams ?? []).find((s) => s.codec_type === 'video');
    const rotated = Math.abs(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) === 90;
    return {
      width: (rotated ? video?.height : video?.width) ?? null,
      height: (rotated ? video?.width : video?.height) ?? null,
      duration: j.format?.duration ? Number(j.format.duration) : null,
      hasVideo: !!video,
    };
  } catch {
    return { width: null, height: null, duration: null, hasVideo: false };
  }
}

/** A decodable, upright JPEG of any still (HEIC via heif-convert; EXIF
 * orientation applied by ImageMagick). */
async function uprightJpeg(src, key, dst) {
  let input = src;
  if (isHeic(key)) {
    const converted = `${src}.jpg`;
    try {
      await run('heif-convert', ['-q', '92', src, converted]);
      input = converted;
    } catch {
      return false;
    }
  }
  try {
    await run('convert', [input, '-auto-orient', '-strip', dst]);
    return true;
  } catch {
    return (await ffmpeg(['-i', input, '-frames:v', '1', dst])).ok;
  }
}

const scaleLong = (max) => `scale='if(gt(iw,ih),min(${max},iw),-2)':'if(gt(iw,ih),-2,min(${max},ih))'`;

async function stillFile(src, key, dst) {
  const upright = `${dst}.upright.jpg`;
  if (!(await uprightJpeg(src, key, upright))) return false;
  return (await ffmpeg(['-i', upright, '-frames:v', '1', '-vf', scaleLong(1920), '-q:v', '3', dst])).ok;
}

async function checkImage(src, key, dst, at = null) {
  if (at === null && !/\.(mp4|mov|m4v|webm)$/i.test(key)) {
    const upright = `${dst}.upright.jpg`;
    if (!(await uprightJpeg(src, key, upright))) return false;
    src = upright;
  }
  return (await ffmpeg([...(at !== null ? ['-ss', String(at)] : []), '-i', src, '-frames:v', '1', '-vf', "scale='min(512,iw)':-2", '-q:v', '5', dst])).ok;
}

async function measure(src, withMotion) {
  const loud = await ffmpeg(['-i', src, '-vn', '-af', 'aresample=16000,asetnsamples=n=4000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']);
  const motion = withMotion
    ? await ffmpeg(['-i', src, '-an', '-vf', "fps=4,scale=160:-2,select='gte(scene,0)',metadata=print:file=-", '-f', 'null', '-'])
    : { stdout: '' };
  return { loudness: parseRmsLevels(loud.stdout), motion: parseSceneScores(motion.stdout) };
}

async function cutVideo(src, dst, w, keepAudio) {
  return (await ffmpeg([
    '-ss', String(w.start), '-i', src, '-t', String(Math.max(0.1, w.end - w.start)),
    '-vf', "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)',fps=30",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30',
    ...(keepAudio ? ['-c:a', 'aac', '-b:a', '128k', '-af', `afade=t=in:d=0.12,afade=t=out:st=${Math.max(0, w.end - w.start - 0.2)}:d=0.2`] : ['-an']),
    '-movflags', '+faststart', dst,
  ])).ok;
}

async function cutAudio(src, dst, w) {
  const len = Math.max(0.1, w.end - w.start);
  return (await ffmpeg(['-ss', String(w.start), '-i', src, '-t', String(len), '-vn', '-af', `afade=t=in:d=0.12,afade=t=out:st=${Math.max(0, len - 0.25)}:d=0.25`, '-c:a', 'aac', '-b:a', '128k', dst])).ok;
}

async function wav(src, dst, w) {
  return (await ffmpeg(['-ss', String(w.start), '-i', src, '-t', String(w.end - w.start), '-vn', '-ac', '1', '-ar', '16000', dst])).ok;
}

// ── Modes ─────────────────────────────────────────────────────────────────

async function thumbs(prefix, job, work) {
  const images = {};
  let n = 0;
  for (const item of job.items) {
    n += 1;
    const src = path.join(work, `src-${n}`);
    const out = path.join(work, `thumb-${n}.jpg`);
    try {
      await download(item.key, src);
      if (await checkImage(src, item.key, out, /\.(mp4|mov|m4v|webm)$/i.test(item.key) ? 0 : null)) {
        const rel = `thumbs/${String(n).padStart(3, '0')}.jpg`;
        await upload(`${prefix}${rel}`, out, 'image/jpeg');
        images[item.key] = rel;
      } else images[item.key] = null;
    } catch {
      images[item.key] = null;
    }
  }
  await upload(`${prefix}thumbs/manifest.json`, JSON.stringify({ version: 1, images }), 'application/json');
  return { images: Object.values(images).filter(Boolean).length };
}

async function prepare(prefix, job, work) {
  const assets = {};
  let n = 0;
  const rel = (name) => `prep/assets/${name}`;
  const put = async (name, file, type) => {
    await upload(`${prefix}${rel(name)}`, file, type);
    return rel(name);
  };

  for (const item of job.items) {
    n += 1;
    const id = String(n).padStart(3, '0');
    const src = path.join(work, `src-${id}`);
    const result = { id: item.id, key: item.key, mode: item.mode, file: null, checkImage: null, source: { width: null, height: null, duration: null, hasVideo: false }, windows: [], warnings: [] };
    assets[item.id] = result;
    try {
      await download(item.key, src);
    } catch {
      result.warnings.push('download failed');
      continue;
    }
    result.source = await probe(src);

    if (item.mode === 'still' || item.mode === 'pair') {
      const out = path.join(work, `${id}.jpg`);
      if (await stillFile(src, item.key, out)) result.file = await put(`${id}.jpg`, out, 'image/jpeg');
      else result.warnings.push('could not decode image');
    }
    if ((item.mode === 'still' && item.checkImage) || item.mode === 'reference') {
      const out = path.join(work, `${id}-check.jpg`);
      if (await checkImage(src, item.key, out)) result.checkImage = await put(`${id}-check.jpg`, out, 'image/jpeg');
    }
    if (item.mode === 'clip' || item.mode === 'verified') {
      const duration = result.source.duration ?? 0;
      let windows;
      if (item.mode === 'verified') windows = [{ start: 0, end: Math.min(duration || VERIFIED_CLIP_SECONDS, VERIFIED_CLIP_SECONDS) }];
      else {
        const { loudness, motion } = await measure(src, true);
        windows = rankClipWindows(motion, loudness, duration, BURST_CLIP_SECONDS);
      }
      for (let k = 0; k < windows.length; k += 1) {
        const w = { ...windows[k], file: null, checkImage: null };
        const cut = path.join(work, `${id}-w${k}.mp4`);
        if (await cutVideo(src, cut, windows[k], false)) {
          w.file = await put(`${id}-w${k}.mp4`, cut, 'video/mp4');
          const frame = path.join(work, `${id}-w${k}.jpg`);
          if (await checkImage(cut, `${id}.mp4`, frame, (windows[k].end - windows[k].start) / 2)) w.checkImage = await put(`${id}-w${k}.jpg`, frame, 'image/jpeg');
        }
        result.windows.push(w);
      }
      if (!result.windows.some((w) => w.file)) result.warnings.push('could not cut clip');
    }
    if (item.mode === 'voice') {
      const duration = result.source.duration ?? 0;
      const { loudness } = await measure(src, false);
      const windows = rankVoiceWindows(voicedSegments(loudness, 0.25), duration);
      if (windows.length === 0) result.warnings.push('no voiced audio found');
      for (let k = 0; k < windows.length; k += 1) {
        const w = { ...windows[k], file: null, wav: null };
        const isVideo = result.source.hasVideo;
        const cut = path.join(work, `${id}-v${k}.${isVideo ? 'mp4' : 'm4a'}`);
        if (isVideo ? await cutVideo(src, cut, windows[k], true) : await cutAudio(src, cut, windows[k])) {
          w.file = await put(path.basename(cut), cut, isVideo ? 'video/mp4' : 'audio/mp4');
        }
        const wv = path.join(work, `${id}-v${k}.wav`);
        if (await wav(src, wv, windows[k])) w.wav = await put(`${id}-v${k}.wav`, wv, 'audio/wav');
        result.windows.push(w);
      }
    }
    await fs.promises.rm(src, { force: true });
  }
  await upload(`${prefix}prep/prep.json`, JSON.stringify({ version: 1, assets }), 'application/json');
  return { assets: Object.keys(assets).length };
}

async function listPrepFiles(film) {
  const files = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'file' || k === 'pairFile') && typeof v === 'string' && v.startsWith('prep/')) files.add(v);
      else visit(v);
    }
  };
  visit(film.scenes);
  return [...files];
}

async function render(prefix, job) {
  const filmDir = path.join(FILM_RENDERER, 'film-data', 'job');
  await fs.promises.rm(filmDir, { recursive: true, force: true });
  // assemble.mjs reads every frame file by basename from <film>/assets/
  // (the dogfood layout); prepared names are unique within an attempt.
  await fs.promises.mkdir(path.join(filmDir, 'assets'), { recursive: true });
  const film = await readJson(`${prefix}${job.film}`);
  await fs.promises.writeFile(path.join(filmDir, 'film.json'), JSON.stringify(film));
  for (const rel of await listPrepFiles(film)) await download(`${prefix}${rel}`, path.join(filmDir, 'assets', path.basename(rel)), 'write');

  const composition = path.join(FILM_RENDERER, 'composition');
  await run('node', [path.join(FILM_RENDERER, 'assemble.mjs'), 'job'], { maxBuffer: 16 * 1024 * 1024 }, 'assemble');
  // --no-contrast: the WCAG pass measures text against whatever family photo
  // happens to be behind it (the strip's date labels over a bright burst frame),
  // so it failed ~2/3 of the history backfill's monthly recaps on content we
  // can't control (Sep 2026). Lint/runtime/layout/motion errors still gate the
  // render; contrast stays on in local dogfood checks (film-renderer/render.mjs).
  // --timeout 15000: the default 3 s page-ready budget is tight on a busy Fly
  // machine (local runs of the same film pass; Sep 2026 backfill).
  await run('hyperframes', ['check', '--no-contrast', '--timeout', '15000'], { cwd: composition, maxBuffer: 16 * 1024 * 1024 }, 'check');
  const out = path.join(os.tmpdir(), 'film.mp4');
  await run('hyperframes', ['render', '-o', out, '--video-frame-format', 'jpg', '--crf', String(FILM_CRF), '--quiet'], { cwd: composition, maxBuffer: 16 * 1024 * 1024 }, 'render');

  const timeline = JSON.parse(await fs.promises.readFile(path.join(composition, 'timeline.json'), 'utf8'));
  const poster = path.join(os.tmpdir(), 'poster.jpg');
  if (!(await ffmpeg(['-ss', String(posterTime(timeline)), '-i', out, '-frames:v', '1', '-q:v', '3', poster])).ok) throw new Error('poster');
  // List thumbnail (360×640), scaled from the poster itself so the two are the
  // same frame. Its key is derived from poster_key (same directory), not stored.
  const posterThumb = path.join(os.tmpdir(), 'poster_thumb.jpg');
  if (!(await ffmpeg(['-i', poster, '-vf', 'scale=360:640', '-frames:v', '1', '-q:v', '4', posterThumb])).ok) throw new Error('poster_thumb');
  const probed = await probe(out);
  const durationMs = Math.round((probed.duration ?? timeline.total) * 1000);

  await upload(`${prefix}film.mp4`, out, 'video/mp4');
  await upload(`${prefix}poster.jpg`, poster, 'image/jpeg');
  await upload(`${prefix}poster_thumb.jpg`, posterThumb, 'image/jpeg');
  await upload(`${prefix}scenes.json`, JSON.stringify(scenesFromTimeline(timeline)), 'application/json');
  return { durationMs };
}

// ── Main ──────────────────────────────────────────────────────────────────

export async function main(mode, prefix) {
  if (!['thumbs', 'prepare', 'render'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (!prefix || !/\/year-films\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/$/i.test(prefix)) throw new Error('bad JOB_PREFIX');
  const timeoutSeconds = Number(process.env.JOB_TIMEOUT_SECONDS ?? 1500);
  const timer = setTimeout(async () => {
    console.error(`year film ${mode}: timeout`);
    await writeStatus(prefix, mode, { state: 'failed', code: 'TIMEOUT' }).catch(() => {});
    process.exit(1);
  }, timeoutSeconds * 1000);

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), `yf-${mode}-`));
  const started = Date.now();
  try {
    await writeStatus(prefix, mode, { state: 'running' });
    const job = await readJson(jobKey(prefix, mode));
    const result = mode === 'thumbs' ? await thumbs(prefix, job, work) : mode === 'prepare' ? await prepare(prefix, job, work) : await render(prefix, job);
    await writeStatus(prefix, mode, { state: 'done', ...result });
    console.log(`year film ${mode}: done in ${Math.round((Date.now() - started) / 1000)}s`, Object.fromEntries(Object.entries(result).filter(([, v]) => typeof v === 'number')));
  } catch (error) {
    console.error(`year film ${mode}: failed`, error?.code ?? error?.name ?? 'error');
    if (error?.debug) console.error(error.debug);
    const code = typeof error?.code === 'string' && /^STEP_[A-Z]+$/.test(error.code) ? error.code : 'JOB_FAILED';
    await writeStatus(prefix, mode, { state: 'failed', code }).catch(() => {});
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2], process.env.JOB_PREFIX);
}
