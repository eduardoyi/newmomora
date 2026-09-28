#!/usr/bin/env node
/**
 * Year Film music beds (docs/plans/year-film.md §6): generates each bed in
 * beds.plan.json with ElevenLabs music_v1 (instrumental, commercially cleared
 * on the paid plan — the launch bed's provider), then measures it and writes
 * the beat map the assembler reads:
 *
 *   - tempo + phase: the beat comb that best fits the onset envelope over the
 *     whole track; the leading audio before the first beat is trimmed, so beat 0
 *     is at 0s and the assembler's beat grid (n × 60/bpm) lands on the music
 *   - drop: where the plan puts it (after the intro section); the loudness
 *     rise nearest it is measured as a note — bar accents make a loudness
 *     "drop" ambiguous on its own (the launch bed accents every bar)
 *
 * Output: composition/assets/audio/beds/<id>.mp3 (normalized to −13.5 LUFS)
 * + beds.json (committed — no family data).
 *
 * usage: node --env-file=.env.local film-renderer/music/generate.mjs [--force] [--only id,id] [--analyze-only]
 * The key is read from the environment (ELEVENLABS_API_KEY) and never printed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'composition', 'assets', 'audio', 'beds');
const RAW_DIR = path.join(HERE, 'raw'); // gitignored: untrimmed API output
const plan = JSON.parse(fs.readFileSync(path.join(HERE, 'beds.plan.json'), 'utf8'));
const args = process.argv.slice(2);
const force = args.includes('--force');
const analyzeOnly = args.includes('--analyze-only');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

function apiKey() {
  const named = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_API_KEY ?? process.env.XI_API_KEY;
  if (named) return named;
  const fallback = Object.keys(process.env).find((k) => /ELEVEN/i.test(k) && /KEY/i.test(k));
  if (fallback) return process.env[fallback];
  throw new Error('No ElevenLabs key in the environment — run with node --env-file=.env.local');
}

function compositionPlan(bed) {
  const beatMs = 60000 / bed.bpm;
  return {
    positive_global_styles: [...bed.styles, `${bed.bpm} bpm`],
    negative_global_styles: plan.avoid,
    sections: plan.sections.map((s) => ({
      section_name: s.name,
      positive_local_styles: s.styles,
      negative_local_styles: s.avoid,
      duration_ms: Math.round(s.beats * beatMs),
      lines: [],
    })),
  };
}

async function generate(bed, file) {
  const res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json' },
    body: JSON.stringify({ composition_plan: compositionPlan(bed), model_id: 'music_v1' }),
  });
  if (!res.ok) throw new Error(`${bed.id}: ElevenLabs ${res.status} ${(await res.text()).slice(0, 300)}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// ── Analysis ──────────────────────────────────────────────────────────────

const SR = 22050;
const HOP = 256;

function decode(file) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 512 * 1024 * 1024 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function analyze(file, requestedBpm) {
  const x = decode(file);
  const frames = Math.floor(x.length / HOP);
  // Percussive onset envelope: energy of the first difference (a high-pass),
  // log-compressed, positive changes only.
  const energy = new Float64Array(frames);
  const full = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let e = 0;
    let f = 0;
    for (let j = Math.max(1, i * HOP); j < (i + 1) * HOP; j++) {
      const d = x[j] - x[j - 1];
      e += d * d;
      f += x[j] * x[j];
    }
    energy[i] = Math.log10(1e-9 + e / HOP);
    full[i] = f / HOP;
  }
  const onset = new Float64Array(frames);
  for (let i = 1; i < frames; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  const fps = SR / HOP;
  const at = (t) => {
    const i = Math.floor(t);
    return i + 1 < frames ? onset[i] * (1 - (t - i)) + onset[i + 1] * (t - i) : 0;
  };
  // Tempo and phase together: the beat comb (0.02 BPM steps, ±4 BPM of the
  // request) that collects the most onset energy over the whole track. A
  // slightly wrong tempo drifts off the beat, so the whole track decides.
  let best = { bpm: requestedBpm, offset: 0, score: -Infinity };
  for (let bpm = requestedBpm - 4; bpm <= requestedBpm + 4 + 1e-9; bpm += 0.02) {
    const period = (60 / bpm) * fps;
    for (let off = 0; off < period; off += 0.5) {
      let score = 0;
      for (let t = off; t < frames - 1; t += period) score += at(t);
      if (score > best.score) best = { bpm: Math.round(bpm * 100) / 100, offset: off, score };
    }
  }
  const phaseSeconds = best.offset / fps;
  // Drop: the sharpest 1s-vs-1s loudness rise between 4s and 14s.
  const rmsDb = (from, to) => {
    let e = 0;
    const a = Math.max(0, Math.floor(from * fps));
    const b = Math.min(frames, Math.floor(to * fps));
    for (let i = a; i < b; i++) e += full[i];
    return 10 * Math.log10(1e-12 + e / Math.max(1, b - a));
  };
  let drop = { t: 8, rise: -Infinity };
  const planned = phaseSeconds + plan.sections[0].beats * (60 / best.bpm);
  for (let t = Math.max(1.5, planned - 1.5); t <= planned + 1.5; t += 0.02) {
    const rise = rmsDb(t, t + 1) - rmsDb(t - 1, t);
    if (rise > drop.rise) drop = { t, rise };
  }
  // When the song actually arrives: the first 2s window within 1.5 dB of the
  // track's body loudness (its 60th-percentile window). Owner, 2026-09-28:
  // the first beds took 15–30s to build — half a 60s film.
  const windows = [];
  for (let t = 0; t + 2 <= frames / fps; t += 0.5) windows.push({ t, db: rmsDb(t, t + 2) });
  const body = [...windows].map((w) => w.db).sort((p, q) => p - q)[Math.floor(windows.length * 0.6)];
  const fullAt = (windows.find((w) => w.db >= body - 1.5) ?? windows[0]).t;
  const beat = 60 / best.bpm;
  const dropBeat = plan.sections[0].beats;
  return { bpm: best.bpm, phaseSeconds, dropBeat, dropSeconds: dropBeat * beat, dropRiseDb: Math.round(drop.rise * 10) / 10, rawDrop: drop.t, fullAt };
}

const TARGET_LUFS = -13.5;
function integratedLufs(file) {
  // loudnorm reports on stderr.
  const out = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const start = out.lastIndexOf('{');
  return Number(JSON.parse(out.slice(start, out.indexOf('}', start) + 1)).input_i);
}

function duration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

// ── Run ───────────────────────────────────────────────────────────────────

const mapFile = path.join(OUT_DIR, 'beds.json');
const map = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : { beds: [] };
for (const bed of plan.beds) {
  if (only && !only.has(bed.id)) continue;
  const raw = path.join(RAW_DIR, `${bed.id}.mp3`);
  if (!analyzeOnly && (force || !fs.existsSync(raw))) {
    process.stdout.write(`${bed.id}: generating… `);
    await generate(bed, raw);
    process.stdout.write(`done (${duration(raw).toFixed(1)}s)\n`);
  }
  if (!fs.existsSync(raw)) continue;
  const a = analyze(raw, bed.bpm);
  const out = path.join(OUT_DIR, `${bed.id}.mp3`);
  // Trim to the first beat so the assembler's grid starts on the music, and
  // bring every bed to one loudness (the voice carve assumes it; the raw
  // beds ranged −11 to −16 LUFS).
  // Measure, then one linear gain (a single-pass loudnorm rides the dynamics
  // and overshot by up to 2 dB); a limiter catches the peaks.
  const gain = TARGET_LUFS - integratedLufs(raw);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', a.phaseSeconds.toFixed(4), '-i', raw, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false`, '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', out]);
  const entry = {
    id: bed.id,
    file: `assets/audio/beds/${bed.id}.mp3`,
    bpm: a.bpm,
    drop: +a.dropSeconds.toFixed(3),
    dropBeat: a.dropBeat,
    length: +duration(out).toFixed(2),
    use: bed.use,
    requestedBpm: bed.bpm,
    fullEnergyAt: a.fullAt,
  };
  map.beds = [...map.beds.filter((b) => b.id !== bed.id), entry];
  console.log(`${bed.id}: ${a.bpm} BPM (asked ${bed.bpm}) · trimmed ${a.phaseSeconds.toFixed(3)}s · drop at beat ${a.dropBeat} (${entry.drop}s; heard at ${a.rawDrop.toFixed(2)}s, +${a.dropRiseDb} dB) · full energy at ${a.fullAt}s · ${entry.length}s`);
}
map.beds.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(mapFile, `${JSON.stringify(map, null, 2)}\n`);
