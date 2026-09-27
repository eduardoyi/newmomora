/**
 * Year Film F2 -- asset bridge (docs/plans/year-film.md §10 F2). Takes the
 * FilmScripts of a reviewed F1 storyboard run and prepares everything the
 * renderer (F3) needs into `film-renderer/film-data/<slug>/`, the film's
 * twin of eval-memory-book-assets.ts → book-renderer/book-data/:
 *
 *   - stills: originals (HEIC via sips), long edge ≤1920px JPEG
 *   - burst clips: the liveliest 2.5s (motion + loudness), re-encoded, with
 *     ranked fallback windows
 *   - verified clips (awards, then/now): the first 3s — the frame the vision
 *     check saw (posters are captured at t=0)
 *   - the sound scene: up to 3 voiced ≤6s windows per candidate clip, each
 *     checked by an audio model (a child clearly heard, no adult over them,
 *     no cough/noise at the start); the first that passes wins
 *   - FRAME CHECK (owner F2 review): every frame the film will show in a
 *     burst, title, close or end card is vision-checked as cut — clips on a
 *     frame from the middle of the chosen window, not the poster. Screen
 *     recordings and monitor/night-vision footage are removed; in a
 *     birthday film the child must be visible. A failing clip is re-cut from
 *     its next window before being removed.
 *   - film.json: the FilmScript with every frame annotated with its local
 *     file, trim window, dimensions and checks — the renderer's only input
 *   - asset-report.html: everything playable, removals and warnings shown
 *
 * READ-ONLY against the database (reads R2 objects by the keys in the
 * reviewed FilmScript; no DB queries). Calls OpenAI for voice and frame
 * checks (skip with --no-voice / --no-frame-check).
 *
 * PII: film-data/ is gitignored (own account, owner review). stdout stays
 * counts-only.
 *
 * Examples:
 *   npm run eval:year-film-assets -- --from 2026-09-27T15-45-00-086Z
 *   npm run eval:year-film-assets -- --from 2026-09-27T15-45-00-086Z --film birthday-enzo-y4
 */
import { getObjectBytesBatch } from '../functions/_shared/r2.ts';
import type { FilmScene, FilmScript, FrameRef } from '../functions/_shared/year-film-script.ts';
import {
  BURST_CLIP_SECONDS,
  parseRmsLevels,
  parseSceneScores,
  rankClipWindows,
  rankVoiceWindows,
  VERIFIED_CLIP_SECONDS,
  voicedSegments,
  type Window,
} from '../functions/_shared/year-film-trim.ts';
import {
  buildFrameCheckRequestBody,
  describeCheck,
  FRAME_CHECK_BATCH,
  type FrameCheck,
  burstFrameVerdict,
  parseFrameCheckResponse,
  type VisionImage,
} from '../functions/_shared/year-film-vision.ts';
import { buildVoiceCheckRequestBody, isVoiceVerified, parseVoiceCheck, type VoiceCheck } from '../functions/_shared/year-film-voice.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

const args = Deno.args;
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fromRun = argValue('--from');
const onlyFilms = args.flatMap((a, i) => (a === '--film' && args[i + 1] ? [args[i + 1]] : []));
const voiceChecks = !args.includes('--no-voice');
const frameChecks = !args.includes('--no-frame-check');
const VISION_MODEL = 'gpt-5.6-sol';
if (!fromRun) throw new Error('Pass --from <F1 storyboard run id>');

const SCRIPT_RUNS = new URL('./eval-output/year-film-script/', import.meta.url);
const FILM_DATA = new URL('../../film-renderer/film-data/', import.meta.url);
const CACHE = new URL('.cache/', FILM_DATA);

// ── Shell / OpenAI helpers ───────────────────────────────────────────────

async function run(cmd: string, cmdArgs: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const out = await new Deno.Command(cmd, { args: cmdArgs, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
}

async function chat(body: Record<string, unknown>): Promise<string | null> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) return null;
  const call = () =>
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let response = await call();
  if (!response.ok && (response.status === 429 || response.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    response = await call();
  }
  if (!response.ok) {
    console.error(`OpenAI ${response.status}`);
    return null;
  }
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content ?? null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

interface Probe {
  width: number | null;
  height: number | null;
  duration: number | null;
  hasVideo: boolean;
}

async function probe(path: string): Promise<Probe | null> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:stream_side_data=rotation:format=duration', '-of', 'json', path]);
  if (!r.ok) return null;
  const j = JSON.parse(r.stdout);
  const streams: { codec_type: string; width?: number; height?: number; side_data_list?: { rotation?: number }[] }[] = j.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const rotated = Math.abs(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) === 90;
  return {
    width: (rotated ? video?.height : video?.width) ?? null,
    height: (rotated ? video?.width : video?.height) ?? null,
    duration: j.format?.duration ? Number(j.format.duration) : null,
    hasVideo: !!video,
  };
}

// ── Download (cached across films) ───────────────────────────────────────

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cachePath = async (key: string) => new URL(`${await sha(key)}${key.match(/\.[a-z0-9]+$/i)?.[0] ?? ''}`, CACHE).pathname;

async function ensureDownloaded(keys: string[]): Promise<Map<string, string>> {
  await Deno.mkdir(CACHE, { recursive: true });
  const local = new Map<string, string>();
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    const path = await cachePath(key);
    try {
      await Deno.stat(path);
      local.set(key, path);
    } catch {
      missing.push(key);
    }
  }
  for (let i = 0; i < missing.length; i += 6) {
    const batch = await getObjectBytesBatch(missing.slice(i, i + 6));
    for (const [key, entry] of batch) {
      if (!entry.ok || !entry.bytes) continue;
      const path = await cachePath(key);
      await Deno.writeFile(path, entry.bytes);
      local.set(key, path);
    }
  }
  return local;
}

// ── Media operations ─────────────────────────────────────────────────────

/** Stills: HEIC through sips (macOS), then JPEG with long edge ≤1920. */
async function prepareStill(src: string, dst: string): Promise<boolean> {
  let input = src;
  if (/\.(heic|heif)$/i.test(src)) {
    const jpg = `${src}.jpg`;
    const r = await run('sips', ['-s', 'format', 'jpeg', src, '--out', jpg]);
    if (!r.ok) return false;
    input = jpg;
  }
  const r = await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'", '-q:v', '3', dst]);
  return r.ok;
}

async function measure(src: string, withMotion: boolean) {
  const loud = await run('ffmpeg', [
    '-v', 'error', '-i', src, '-vn', '-af',
    'aresample=16000,asetnsamples=n=4000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ]);
  const motion = withMotion
    ? await run('ffmpeg', ['-v', 'error', '-i', src, '-an', '-vf', "fps=4,scale=160:-2,select='gte(scene,0)',metadata=print:file=-", '-f', 'null', '-'])
    : { ok: true, stdout: '', stderr: '' };
  return { loudness: parseRmsLevels(loud.stdout), motion: parseSceneScores(motion.stdout) };
}

async function cutVideo(src: string, dst: string, w: Window, keepAudio: boolean): Promise<boolean> {
  const r = await run('ffmpeg', [
    '-v', 'error', '-y', '-ss', String(w.start), '-i', src, '-t', String(Math.max(0.1, w.end - w.start)),
    '-vf', "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)',fps=30",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    ...(keepAudio ? ['-c:a', 'aac', '-b:a', '128k', '-af', `afade=t=in:d=0.12,afade=t=out:st=${Math.max(0, w.end - w.start - 0.2)}:d=0.2`] : ['-an']),
    '-movflags', '+faststart', dst,
  ]);
  return r.ok;
}

async function cutAudio(src: string, dst: string, w: Window): Promise<boolean> {
  const len = Math.max(0.1, w.end - w.start);
  const r = await run('ffmpeg', [
    '-v', 'error', '-y', '-ss', String(w.start), '-i', src, '-t', String(len), '-vn',
    '-af', `afade=t=in:d=0.12,afade=t=out:st=${Math.max(0, len - 0.25)}:d=0.25`, '-c:a', 'aac', '-b:a', '128k', dst,
  ]);
  return r.ok;
}

/** A 512px JPEG of an image, or of a video at `at` seconds. */
async function visionImage(path: string, at: number | null): Promise<VisionImage | null> {
  const out = await Deno.makeTempFile({ suffix: '.jpg' });
  const r = await run('ffmpeg', [
    '-v', 'error', '-y', ...(at !== null ? ['-ss', String(at)] : []), '-i', path, '-frames:v', '1',
    '-vf', "scale='min(512,iw)':-2", '-q:v', '5', out,
  ]);
  const bytes = r.ok ? await Deno.readFile(out) : null;
  await Deno.remove(out).catch(() => {});
  return bytes ? { base64: base64(bytes), contentType: 'image/jpeg' } : null;
}

async function voiceCheck(src: string, w: Window): Promise<VoiceCheck | null> {
  if (!voiceChecks) return null;
  const wav = await Deno.makeTempFile({ suffix: '.wav' });
  const r = await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(w.start), '-i', src, '-t', String(w.end - w.start), '-vn', '-ac', '1', '-ar', '16000', wav]);
  const bytes = r.ok ? await Deno.readFile(wav) : null;
  await Deno.remove(wav).catch(() => {});
  if (!bytes) return null;
  return parseVoiceCheck(await chat(buildVoiceCheckRequestBody(base64(bytes), 'the child')));
}

// ── Scene walk ───────────────────────────────────────────────────────────

type Usage = 'still' | 'burst' | 'verified' | 'voice';

interface Use {
  frame: FrameRef;
  usage: Usage;
  /** Shown in the film's dense/visual parts → frame-checked. */
  checked: boolean;
}

/** Every frame with what it's used for. End cards and title cards are
 * small tiles → stills (video posters). */
function uses(scene: FilmScene): Use[] {
  const as = (frames: FrameRef[], usage: Usage, checked: boolean) => frames.map((frame) => ({ frame, usage, checked }));
  const motion = (f: FrameRef, verified: boolean, checked: boolean): Use => ({
    frame: f,
    usage: f.kind === 'video' ? (verified ? 'verified' : 'burst') : 'still',
    checked,
  });
  switch (scene.type) {
    case 'cold_open':
      return as([...(scene.from ? [scene.from] : []), scene.to], 'still', false);
    case 'title':
      return as(scene.cards, 'still', true);
    case 'end_card':
      return as(scene.grid, 'still', true);
    case 'burst':
      return scene.frames.map((f) => motion(f, false, true));
    case 'sound':
      return [{ frame: scene.frame, usage: 'voice', checked: false }];
    case 'line':
      return scene.frame ? [motion(scene.frame, false, false)] : [];
    case 'starring':
      return as(scene.people.map((p) => p.portrait), 'still', false);
    case 'award':
      return [motion(scene.frame, true, false)]; // verified in F1
    case 'close':
      return scene.frames.map((f) => motion(f, scene.source === 'then_now', scene.source === 'celebration'));
    case 'firsts':
    case 'counters':
      return [];
  }
}

function stillKey(frame: FrameRef, usage: Usage): string {
  // Tiles of videos show the poster; everything else the original.
  return usage === 'still' && frame.kind === 'video' && frame.previewKey ? frame.previewKey : frame.key;
}

// ── Per-film preparation ─────────────────────────────────────────────────

interface Prepared {
  file: string | null; // relative to the film folder
  usage: Usage;
  kind: FrameRef['kind'] | 'pair_photo';
  src: string | null;
  source: { width: number | null; height: number | null; duration: number | null };
  trim?: Window & { score?: number; voicedSeconds?: number; coverage?: number };
  alternatives?: Window[];
  voice?: VoiceCheck | null;
  voiceTries?: { window: Window; voice: VoiceCheck | null }[];
  warnings: string[];
}

interface Removal {
  scene: string;
  file: string | null;
  reason: string;
}

type AnnotatedFrame = FrameRef & {
  file?: string | null;
  usage?: Usage;
  trim?: unknown;
  frameCheck?: string;
};

const runDir = new URL(`${fromRun}/`, SCRIPT_RUNS);
const slugs: string[] = [];
for await (const entry of Deno.readDir(runDir)) {
  if (entry.isDirectory && (onlyFilms.length === 0 || onlyFilms.includes(entry.name))) slugs.push(entry.name);
}
slugs.sort();

for (const slug of slugs) {
  const script: FilmScript = JSON.parse(await Deno.readTextFile(new URL(`${slug}/film-script.json`, runDir)));
  const film = JSON.parse(JSON.stringify(script)) as FilmScript;
  const filmDir = new URL(`${slug}/`, FILM_DATA);
  await Deno.remove(filmDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(new URL('assets/', filmDir), { recursive: true });
  const at = (file: string) => new URL(file, filmDir).pathname;

  const soundScene = film.scenes.find((s): s is Extract<FilmScene, { type: 'sound' }> => s.type === 'sound');
  const allUses = film.scenes.flatMap(uses);
  const local = await ensureDownloaded([
    ...allUses.map((u) => stillKey(u.frame, u.usage)),
    ...allUses.flatMap((u) => (u.frame.pairKey ? [u.frame.pairKey] : [])),
    ...(soundScene?.alternates.map((f) => f.key) ?? []),
    ...(film.subjects ?? []).flatMap((s) => (s.referenceKey ? [s.referenceKey] : [])),
  ]);
  const prepared = new Map<string, Prepared>(); // by `${usage}:${key}`
  let n = 0;
  const outName = (ext: string) => `assets/${String(++n).padStart(3, '0')}.${ext}`;

  async function prepare(frame: FrameRef, usage: Usage, kind: Prepared['kind'] = frame.kind): Promise<Prepared> {
    const key = kind === 'pair_photo' ? frame.pairKey! : stillKey(frame, usage);
    const id = `${usage}:${key}`;
    const cached = prepared.get(id);
    if (cached) return cached;
    const src = local.get(key) ?? null;
    const result: Prepared = { file: null, usage, kind, src, source: { width: null, height: null, duration: null }, warnings: [] };
    prepared.set(id, result);
    if (!src) {
      result.warnings.push('download failed');
      return result;
    }
    const info = await probe(src);
    result.source = { width: info?.width ?? null, height: info?.height ?? null, duration: info?.duration ?? null };

    if (usage === 'still' || (usage !== 'voice' && frame.kind !== 'video')) {
      const file = outName('jpg');
      if (!(await prepareStill(src, at(file)))) result.warnings.push('could not decode image');
      else result.file = file;
      const short = Math.min(info?.width ?? 0, info?.height ?? 0);
      // 1024px drawings on a 1080-wide frame are a ~5% upscale — fine for
      // video (print needed more). Flag only real shortfalls.
      if (kind === 'illustration' && short < 900) result.warnings.push(`drawing is ${short}px — needs upscaling`);
      else if (kind === 'photo' && short > 0 && short < 1080) result.warnings.push(`low-res photo (${short}px short side)`);
      return result;
    }

    const duration = info?.duration ?? 0;
    if (usage === 'voice') {
      // Up to 3 windows per clip; the first the audio check passes wins.
      const { loudness } = await measure(src, false);
      const windows = rankVoiceWindows(voicedSegments(loudness, 0.25), duration);
      if (windows.length === 0) {
        result.warnings.push('no voiced audio found');
        return result;
      }
      result.voiceTries = [];
      for (const window of windows) {
        const voice = await voiceCheck(src, window);
        result.voiceTries.push({ window, voice });
        result.trim = window;
        result.voice = voice;
        if (voice === null || isVoiceVerified(voice)) break;
      }
      const isVideo = frame.kind === 'video' && info?.hasVideo;
      const file = outName(isVideo ? 'mp4' : 'm4a');
      const ok = isVideo ? await cutVideo(src, at(file), result.trim!, true) : await cutAudio(src, at(file), result.trim!);
      if (ok) result.file = file;
      if ((result.trim!.coverage ?? 1) < 0.5) result.warnings.push(`only ${Math.round((result.trim!.coverage ?? 0) * 100)}% of the excerpt is voiced`);
      return result;
    }

    // burst / verified clips
    let windows: (Window & { score?: number })[];
    if (usage === 'verified') windows = [{ start: 0, end: Math.min(duration || VERIFIED_CLIP_SECONDS, VERIFIED_CLIP_SECONDS) }];
    else {
      const { loudness, motion } = await measure(src, true);
      windows = rankClipWindows(motion, loudness, duration, BURST_CLIP_SECONDS);
      if ((windows[0]?.score ?? 0) < 0.05 && duration > BURST_CLIP_SECONDS) result.warnings.push('very little motion — may read as a still');
    }
    result.trim = windows[0];
    result.alternatives = windows.slice(1);
    const file = outName('mp4');
    if (await cutVideo(src, at(file), windows[0], false)) result.file = file;
    else result.warnings.push('could not cut clip');
    return result;
  }

  /** Audio memories are the parent's own "keep the sound" clips: an unchecked
   * one still passes. Video fallbacks must be verified. */
  const passesVoice = (p: Prepared | undefined, source: 'audio' | 'video') =>
    !!p?.file && (source === 'audio' ? p.voice == null || isVoiceVerified(p.voice) : isVoiceVerified(p.voice ?? null));

  // 1. Voice: the first candidate clip (and window) that passes wins.
  let soundNote = '';
  if (soundScene) {
    let chosen: FrameRef | null = null;
    for (const candidate of [soundScene.frame, ...soundScene.alternates]) {
      if (passesVoice(await prepare(candidate, 'voice'), soundScene.source)) {
        chosen = candidate;
        break;
      }
    }
    if (chosen && chosen !== soundScene.frame) {
      soundNote = `primary sound failed the voice check → alternate ${chosen.memoryId}`;
      soundScene.frame = chosen;
    } else if (!chosen) soundNote = 'no candidate passed the voice check → scene would drop';
    const p = prepared.get(`voice:${soundScene.frame.key}`);
    Object.assign(soundScene.frame, { file: p?.file ?? null, usage: 'voice', trim: p?.trim ?? null, voice: p?.voice ?? null });
    Object.assign(soundScene, { voiceVerified: passesVoice(p, soundScene.source), note: soundNote });
  }

  // 2. Everything else, annotated in place.
  for (const scene of film.scenes) {
    if (scene.type === 'sound') continue;
    for (const use of uses(scene)) {
      const p = await prepare(use.frame, use.usage);
      Object.assign(use.frame, { file: p.file, usage: use.usage, trim: p.trim ?? null, source: p.source });
      if (use.frame.pairKey) Object.assign(use.frame, { pairFile: (await prepare(use.frame, 'still', 'pair_photo')).file });
    }
  }

  // 3. Frame check on what the film will actually show.
  const removals: Removal[] = [];
  let checkedCount = 0;
  const subjects = film.subjects ?? [];
  // All own children, so a sibling-led frame is recognizable (F2 round 2).
  const people = film.references?.length ? film.references : subjects;
  const ownChildIds = new Set(people.map((p) => p.id));
  const requiredChild = film.kind === 'birthday' ? subjects[0]?.id ?? null : null;
  if (frameChecks && people.length > 0) {
    const references = (await Promise.all(people.map(async (s) => {
      const src = s.referenceKey ? local.get(s.referenceKey) : undefined;
      const image = src ? await visionImage(src, null) : null;
      return image ? { ...image, name: s.name } : null;
    }))).filter((r): r is VisionImage & { name: string } => !!r);
    const names = references.map((r) => r.name);
    const idByName = new Map(people.map((s) => [s.name.toLowerCase(), s.id]));
    const nameById = new Map(people.map((s) => [s.id, s.name]));

    const checkFiles = async (items: { file: string; clip: Prepared | null }[]): Promise<(FrameCheck | undefined)[]> => {
      const out: (FrameCheck | undefined)[] = [];
      for (let i = 0; i < items.length; i += FRAME_CHECK_BATCH) {
        const batch = items.slice(i, i + FRAME_CHECK_BATCH);
        const images = await Promise.all(batch.map(({ file, clip }) =>
          visionImage(at(file), clip?.trim ? (clip.trim.end - clip.trim.start) / 2 : null)
        ));
        const sendable = batch.map((_, j) => images[j]).filter((x): x is VisionImage => !!x);
        const raw = references.length > 0 && sendable.length > 0
          ? await chat(buildFrameCheckRequestBody(names, references, sendable, VISION_MODEL))
          : null;
        const parsed = raw ? parseFrameCheckResponse(raw, sendable.length, idByName) : new Map();
        let k = 0;
        for (let j = 0; j < batch.length; j += 1) out.push(images[j] ? parsed.get(k++) : undefined);
      }
      return out;
    };

    // Each distinct prepared asset is checked once, then retried for clips.
    const targets = new Map<string, { p: Prepared; frames: { scene: FilmScene; frame: AnnotatedFrame }[] }>();
    for (const scene of film.scenes) {
      for (const use of uses(scene)) {
        if (!use.checked) continue;
        // Drawings are made from the memory's tagged people, so they carry
        // the tags' assurance; vision can't match a drawn face to a photo
        // (F2 round 2: 20 of 30 removals were drawings).
        if (use.frame.kind === 'illustration') {
          (use.frame as AnnotatedFrame).frameCheck = 'drawing — not checked';
          continue;
        }
        const p = prepared.get(`${use.usage}:${stillKey(use.frame, use.usage)}`);
        if (!p?.file) continue;
        const entry = targets.get(p.file) ?? { p, frames: [] };
        entry.frames.push({ scene, frame: use.frame as AnnotatedFrame });
        targets.set(p.file, entry);
      }
    }
    const list = [...targets.values()];
    const verdicts = await checkFiles(list.map(({ p }) => ({ file: p.file!, clip: p.usage === 'still' ? null : p })));
    checkedCount = list.length;
    const verdictOf = (check: FrameCheck | undefined, tags?: string[]) =>
      burstFrameVerdict(check, requiredChild, ownChildIds, tags);
    const tagsOf = (t: (typeof list)[number]) => t.frames[0]?.frame.tags;
    const flagged: { t: (typeof list)[number]; verdict: ReturnType<typeof verdictOf> }[] = [];
    list.forEach((t, i) => {
      const verdict = verdictOf(verdicts[i], tagsOf(t));
      for (const f of t.frames) f.frame.frameCheck = describeCheck(verdicts[i], nameById);
      if (verdict !== 'keep') flagged.push({ t, verdict });
    });

    // Clips try their other windows first. 'prefer_other_window' (nobody in
    // the window) never removes: without a better window the original stays.
    for (const { t, verdict } of flagged) {
      const original = t.p.trim;
      let rescued = false;
      while (t.p.usage !== 'still' && (t.p.alternatives?.length ?? 0) > 0 && !rescued) {
        const next = t.p.alternatives!.shift()!;
        if (!t.p.src || !(await cutVideo(t.p.src, at(t.p.file!), next, false))) continue;
        t.p.trim = next;
        const [check] = await checkFiles([{ file: t.p.file!, clip: t.p }]);
        if (verdictOf(check, tagsOf(t)) === 'keep') {
          rescued = true;
          for (const f of t.frames) Object.assign(f.frame, { trim: next, frameCheck: `${describeCheck(check, nameById)} (re-cut)` });
        }
      }
      if (rescued) continue;
      if (verdict === 'prefer_other_window') {
        if (original && t.p.trim !== original && t.p.src) {
          await cutVideo(t.p.src, at(t.p.file!), original, false);
          t.p.trim = original;
        }
        continue;
      }
      for (const f of t.frames) {
        removals.push({ scene: f.scene.type === 'burst' ? `burst/${f.scene.role}` : f.scene.type, file: t.p.file, reason: f.frame.frameCheck ?? 'no verdict' });
        const drop = (frames: FrameRef[]) => frames.filter((x) => x !== f.frame);
        if (f.scene.type === 'burst') f.scene.frames = drop(f.scene.frames);
        if (f.scene.type === 'title') f.scene.cards = drop(f.scene.cards);
        if (f.scene.type === 'end_card') f.scene.grid = drop(f.scene.grid);
        if (f.scene.type === 'close') f.scene.frames = drop(f.scene.frames);
      }
    }
  }

  await Deno.writeTextFile(new URL('film.json', filmDir), JSON.stringify(film, null, 2));

  // Report.
  const items = [...prepared.entries()].map(([id, p]) => ({ id, ...p }));
  const warnings = items.flatMap((p) => p.warnings.map((w) => `${p.usage} ${p.kind}: ${w}`));
  await Deno.writeTextFile(new URL('asset-report.json', filmDir), JSON.stringify({ slug, soundNote, removals, items, warnings }, null, 2));
  await Deno.writeTextFile(new URL('asset-report.html', filmDir), renderReport(slug, script.title, soundNote, items, removals, checkedCount));
  const count = (u: Usage) => items.filter((p) => p.usage === u && p.file).length;
  console.log(
    `${slug}: ${count('still')} stills, ${count('burst')} burst clips, ${count('verified')} verified clips, ` +
      `${count('voice')} voice excerpts · frame check ${checkedCount} checked, ${new Set(removals.map((r) => r.file)).size} removed · ` +
      `${warnings.length} warnings${soundNote ? ` · ${soundNote}` : ''}`,
  );
}
console.log(`\nDone. ${FILM_DATA.pathname}`);

// ── Report HTML ──────────────────────────────────────────────────────────

function esc(text: string | null | undefined): string {
  return (text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function renderReport(
  slug: string,
  title: string,
  soundNote: string,
  items: (Prepared & { id: string })[],
  removals: Removal[],
  checked: number,
): string {
  // Landscape media shows whole on a dark ground — how the renderer places
  // it (blurred fill), not cropped (owner, F2 review).
  const media = (file: string | null) => {
    if (!file) return '<div class="ph">missing</div>';
    if (file.endsWith('.mp4')) return `<video src="${file}" controls muted playsinline loop preload="metadata"></video>`;
    if (file.endsWith('.m4a')) return `<audio src="${file}" controls></audio>`;
    return `<img src="${file}" loading="lazy">`;
  };
  const voiceLine = (v: VoiceCheck | null | undefined) =>
    v ? `${esc(v.childVoice)}${v.adultDominant ? ' · adult dominant' : ''}${v.startsCleanly ? '' : ' · noisy start'} — ${esc(v.heard)}` : 'unchecked';
  const card = (p: Prepared) => `<div class="card ${p.warnings.length ? 'warn' : ''}">${media(p.file)}
    <p><b>${esc(p.usage)}</b> · ${esc(p.kind)} · ${p.source.width ?? '?'}×${p.source.height ?? '?'}${p.source.duration ? ` · ${p.source.duration.toFixed(1)}s` : ''}</p>
    ${p.trim ? `<p>trim ${p.trim.start}s → ${p.trim.end}s${p.trim.score !== undefined ? ` · score ${p.trim.score}` : ''}${p.trim.coverage !== undefined ? ` · ${Math.round(p.trim.coverage * 100)}% voiced` : ''}</p>` : ''}
    ${p.voiceTries?.map((t, i) => `<p class="voice ${isVoiceVerified(t.voice) ? 'ok' : 'bad'}">try ${i + 1} (${t.window.start}s): ${voiceLine(t.voice)}</p>`).join('') ?? ''}
    ${p.warnings.map((w) => `<p class="w">⚠ ${esc(w)}</p>`).join('')}</div>`;
  const section = (usage: Usage, label: string) => {
    const list = items.filter((p) => p.usage === usage);
    return list.length ? `<h2>${label} (${list.length})</h2><div class="grid">${list.map(card).join('')}</div>` : '';
  };
  // One card per removed photo/clip; a frame reused in several scenes (the
  // end card repeats finale frames) lists them all (owner, F2 round 3).
  const byFile = new Map<string, { file: string | null; scenes: string[]; reason: string }>();
  for (const r of removals) {
    const entry = byFile.get(r.file ?? r.reason) ?? { file: r.file, scenes: [], reason: r.reason };
    if (!entry.scenes.includes(r.scene)) entry.scenes.push(r.scene);
    byFile.set(r.file ?? r.reason, entry);
  }
  const removedAssets = [...byFile.values()];
  const removed = removedAssets.length
    ? `<h2>Removed by the frame check (${removedAssets.length})</h2><div class="grid">${
      removedAssets.map((r) => `<div class="card bad">${media(r.file)}<p><b>${esc(r.scenes.join(' + '))}</b></p><p class="w">${esc(r.reason)}</p></div>`).join('')
    }</div>`
    : '';
  const warnCount = items.reduce((n, p) => n + p.warnings.length, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — assets</title><style>
body{font-family:system-ui,sans-serif;background:#f6f3fb;color:#2a2438;margin:0 auto;padding:20px;max-width:1200px}
h1{margin:0}h2{margin:28px 0 10px;font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:#7a6aa8}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.card{background:#fff;border-radius:12px;padding:8px;font-size:11px;box-shadow:0 1px 3px #0001}
.card.warn{outline:2px solid #f0c36d}.card.bad{outline:2px solid #e57373}
.card img,.card video{width:100%;aspect-ratio:9/16;object-fit:contain;border-radius:8px;background:#1c1826}
.card audio{width:100%}
.card p{margin:4px 0}.w{color:#8a5a00}.voice.ok{color:#2e7d32}.voice.bad{color:#b3261e}
.ph{aspect-ratio:9/16;display:flex;align-items:center;justify-content:center;background:#eee;border-radius:8px;color:#999}
.note{background:#fff;border-radius:12px;padding:12px}
</style></head><body>
<h1>${esc(title)}</h1><p>${esc(slug)} · ${items.length} prepared assets · frame check: ${checked} checked, ${new Set(removals.map((r) => r.file)).size} removed · ${warnCount} warning(s)</p>
${soundNote ? `<p class="note">🔊 ${esc(soundNote)}</p>` : ''}
${section('voice', 'Sound of the year — voice excerpt')}
${removed}
${section('verified', 'Verified clips (awards, then/now) — first 3s')}
${section('burst', 'Burst clips — liveliest 2.5s')}
${section('still', 'Stills')}
</body></html>`;
}
