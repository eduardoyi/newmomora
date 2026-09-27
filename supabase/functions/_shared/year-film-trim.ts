// Year Film clip trimming (docs/plans/year-film.md §6, §7.4; F2). Pure:
// parses ffmpeg measurements and picks windows. The ffmpeg calls live with
// the caller (eval script now, the Fly renderer in P1).
//
// - Burst clips: the liveliest ~2.5s (motion + loudness), avoiding the
//   first half-second (camera-shake / "is it recording?" frames).
// - Verified clips (award, then/now): start at 0 — the poster the vision
//   check saw is the first frame (posters are captured at t=0).
// - Voice excerpts: the ≤6s window with the most voiced audio, starting
//   just before a voiced onset. "Voiced" is relative to the clip's own
//   noise floor, so outdoor clips work too.

export interface MotionSample {
  t: number; // seconds
  scene: number; // ffmpeg scene score, 0..1
}

export interface LoudnessSample {
  t: number; // window start, seconds
  rmsDb: number; // RMS level of the window, dBFS (-Infinity for silence)
}

export interface Window {
  start: number;
  end: number;
}

export const BURST_CLIP_SECONDS = 2.5;
export const VERIFIED_CLIP_SECONDS = 3;
export const VOICE_MAX_SECONDS = 6;
export const VOICE_LEAD_SECONDS = 0.15;
const AVOID_START_SECONDS = 0.5;
const AVOID_END_SECONDS = 0.2;
/** A window is voiced when it is this far above the clip's noise floor. */
const VOICED_ABOVE_FLOOR_DB = 8;
const VOICED_MIN_DB = -45;

// ── ffmpeg output parsing ────────────────────────────────────────────────

/** `-vf "…,select='gte(scene,0)',metadata=print:file=-"` output. */
export function parseSceneScores(text: string): MotionSample[] {
  const out: MotionSample[] = [];
  let t: number | null = null;
  for (const line of text.split('\n')) {
    const time = /pts_time:([\d.]+)/.exec(line);
    if (time) t = Number(time[1]);
    const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score && t !== null) out.push({ t, scene: Number(score[1]) });
  }
  return out;
}

/** `-af "…,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"` output. */
export function parseRmsLevels(text: string): LoudnessSample[] {
  const out: LoudnessSample[] = [];
  let t: number | null = null;
  for (const line of text.split('\n')) {
    const time = /pts_time:([\d.]+)/.exec(line);
    if (time) t = Number(time[1]);
    const rms = /lavfi\.astats\.Overall\.RMS_level=(-?inf|[-\d.]+)/.exec(line);
    if (rms && t !== null) out.push({ t, rmsDb: rms[1].endsWith('inf') ? -Infinity : Number(rms[1]) });
  }
  return out;
}

// ── Voice ────────────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return -Infinity;
  return finite[Math.min(finite.length - 1, Math.floor(p * finite.length))];
}

/** Contiguous voiced stretches: windows well above the clip's own noise
 * floor (its 20th-percentile level). */
export function voicedSegments(samples: LoudnessSample[], windowSeconds: number): Window[] {
  const floor = percentile(samples.map((s) => s.rmsDb), 0.2);
  const threshold = Math.max(VOICED_MIN_DB, floor + VOICED_ABOVE_FLOOR_DB);
  const out: Window[] = [];
  for (const s of samples) {
    if (!(s.rmsDb >= threshold)) continue;
    const last = out.at(-1);
    if (last && s.t - last.end <= windowSeconds * 1.01) last.end = s.t + windowSeconds;
    else out.push({ start: s.t, end: s.t + windowSeconds });
  }
  return out;
}

function overlap(a: Window, b: Window): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Voice windows best first, one per voiced onset — the caller tries the
 * next when the audio check rejects one (e.g. it opens on a cough). */
export function rankVoiceWindows(
  voiced: Window[],
  duration: number,
  maxSeconds = VOICE_MAX_SECONDS,
  limit = 3,
): (Window & { voicedSeconds: number; coverage: number })[] {
  const out: (Window & { voicedSeconds: number; coverage: number })[] = [];
  let remaining = voiced;
  while (out.length < limit && remaining.length > 0) {
    const best = chooseVoiceWindow(remaining, duration, maxSeconds);
    if (!best) break;
    // Re-score against all voiced audio, then drop the onset it started at.
    const window = chooseVoiceWindow(voiced.filter((v) => v.end > best.start), duration, maxSeconds) ?? best;
    if (!out.some((w) => Math.abs(w.start - window.start) < 0.5)) out.push(window);
    remaining = remaining.filter((v) => v.start > best.start + VOICE_LEAD_SECONDS + 0.01);
  }
  return out;
}

/** The ≤maxSeconds window with the most voiced audio, starting just before
 * a voiced onset. Null when nothing is voiced. */
export function chooseVoiceWindow(
  voiced: Window[],
  duration: number,
  maxSeconds = VOICE_MAX_SECONDS,
): (Window & { voicedSeconds: number; coverage: number }) | null {
  if (voiced.length === 0) return null;
  let best: (Window & { voicedSeconds: number; coverage: number }) | null = null;
  for (const onset of voiced) {
    const start = Math.max(0, onset.start - VOICE_LEAD_SECONDS);
    const end = Math.min(duration, start + maxSeconds);
    const window = { start, end };
    const voicedSeconds = voiced.reduce((sum, v) => sum + overlap(window, v), 0);
    if (!best || voicedSeconds > best.voicedSeconds + 1e-6) {
      best = { start, end, voicedSeconds, coverage: voicedSeconds / Math.max(0.001, end - start) };
    }
  }
  if (!best) return null;
  // End on the last voiced moment, not on trailing silence.
  const lastVoiced = Math.max(...voiced.filter((v) => v.start < best!.end).map((v) => Math.min(v.end, best!.end)));
  const end = Math.min(best.end, lastVoiced + 0.3);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { ...best, start: round(best.start), end: round(end), coverage: round(best.voicedSeconds / Math.max(0.001, end - best.start)) };
}

// ── Burst clips ──────────────────────────────────────────────────────────

/** Up to `limit` non-overlapping clip windows, liveliest first — the caller
 * falls back to the next when the frame check rejects one. */
export function rankClipWindows(
  motion: MotionSample[],
  loudness: LoudnessSample[],
  duration: number,
  length = BURST_CLIP_SECONDS,
  limit = 3,
): (Window & { score: number })[] {
  const out: (Window & { score: number })[] = [];
  let m = motion;
  let l = loudness;
  for (let i = 0; i < limit; i += 1) {
    const w = chooseClipWindow(m, l, duration, length);
    if (out.some((o) => w.start < o.end && o.start < w.end)) break;
    out.push(w);
    if (duration <= length + AVOID_START_SECONDS) break;
    // Silence the chosen span so the next pick lands elsewhere.
    m = m.map((s) => (s.t >= w.start && s.t < w.end ? { ...s, scene: -10 } : s));
    l = l.map((s) => (s.t >= w.start && s.t < w.end ? { ...s, rmsDb: -Infinity } : s));
  }
  return out;
}

/** The liveliest `length`-second window: mean motion (scene score) plus a
 * smaller loudness term, skipping the clip's first half-second. Short clips
 * play whole. */
export function chooseClipWindow(
  motion: MotionSample[],
  loudness: LoudnessSample[],
  duration: number,
  length = BURST_CLIP_SECONDS,
): Window & { score: number } {
  if (duration <= length + AVOID_START_SECONDS) return { start: 0, end: round2(Math.min(duration, length)), score: 0 };
  const floor = percentile(loudness.map((s) => s.rmsDb), 0.2);
  const ceiling = percentile(loudness.map((s) => s.rmsDb), 0.95);
  const loudNorm = (db: number) =>
    Number.isFinite(db) && ceiling > floor ? Math.min(1, Math.max(0, (db - floor) / (ceiling - floor))) : 0;
  const mean = <T>(items: T[], f: (x: T) => number) => (items.length ? items.reduce((s, x) => s + f(x), 0) / items.length : 0);

  let best = { start: AVOID_START_SECONDS, end: AVOID_START_SECONDS + length, score: -1 };
  const lastStart = duration - length - AVOID_END_SECONDS;
  for (let start = AVOID_START_SECONDS; start <= lastStart + 1e-6; start += 0.25) {
    const end = start + length;
    const m = mean(motion.filter((s) => s.t >= start && s.t < end), (s) => Math.min(1, s.scene * 10));
    const l = mean(loudness.filter((s) => s.t >= start && s.t < end), (s) => loudNorm(s.rmsDb));
    const score = m + 0.5 * l;
    if (score > best.score + 1e-9) best = { start, end, score };
  }
  return { start: round2(best.start), end: round2(best.end), score: round2(best.score) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
