#!/usr/bin/env node
/**
 * The synthetic sample film (docs/plans/year-film.md §10 F5): a birthday film
 * with every scene type and every media shape the real films have — 3:4 and
 * 16:9 photos, square drawings, portrait photo/drawing pairs, vertical and
 * landscape clips, and a vertical clip carrying a (synthetic) voice — all
 * drawn by ffmpeg. No real family data: this is what the render server is
 * benchmarked and tested with before any family's film reaches it.
 *
 * Output: film-data/sample/ (film.json + assets/), committed.
 * usage: node film-renderer/sample/make-sample.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'film-data', 'sample');
const ASSETS = path.join(OUT, 'assets');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(ASSETS, { recursive: true });

// Seeded, so the sample is identical on every run.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const PALETTE = ['0xE8B4C8', '0xB8D8E8', '0xF2D49B', '0xC5E1A5', '0xD1C4E9', '0xFFCCBC', '0xB2DFDB', '0xF8BBD0'];
const pick = (list) => list[Math.floor(rand() * list.length)];

let n = 0;
const nextName = (ext) => `${String(++n).padStart(3, '0')}.${ext}`;
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
// (No labels: ffmpeg builds without libfreetype have no drawtext — colors
// and shapes are enough to tell frames apart in a benchmark render.)

/** A still: soft gradient + shapes + a label (photos) or a flat pastel scene (drawings). */
function still(label, w, h, kind) {
  const file = nextName('jpg');
  const a = pick(PALETTE);
  const b = pick(PALETTE);
  const blobs = Array.from({ length: kind === 'illustration' ? 3 : 6 }, () => {
    const x = Math.floor(rand() * w * 0.8);
    const y = Math.floor(rand() * h * 0.8);
    const s = Math.floor(Math.min(w, h) * (0.15 + rand() * 0.25));
    return `drawbox=x=${x}:y=${y}:w=${s}:h=${s}:color=${pick(PALETTE)}@0.85:t=fill`;
  }).join(',');
  ff(['-f', 'lavfi', '-i', `gradients=s=${w}x${h}:c0=${a}:c1=${b}:duration=1:speed=0.01`, '-vf', blobs, '-frames:v', '1', '-q:v', '3', path.join(ASSETS, file)]);
  return { file: `assets/${file}`, source: { width: w, height: h, duration: 0.04 } };
}

/** A clip: moving test pattern + label; `voice` adds a speech-like tone track. */
function clip(label, w, h, seconds, voice = false) {
  const file = nextName('mp4');
  const inputs = ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=30:d=${seconds}`];
  const audio = voice
    // Syllable-like bursts of a gliding tone — enough for loudness
    // normalization and the ticket's waveform to have something to trace.
    ? ['-f', 'lavfi', '-i', `aevalsrc='0.35*sin(2*PI*(220+60*sin(2*PI*0.7*t))*t)*(0.5+0.5*sin(2*PI*3.1*t))*lt(mod(t,1.3),0.9)':s=44100:d=${seconds}`]
    : [];
  ff([...inputs, ...audio, '-vf', `hue=H=${Math.round(rand() * 6)}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23', '-g', '30', '-keyint_min', '30',
    ...(voice ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : ['-an']), path.join(ASSETS, file)]);
  return { file: `assets/${file}`, source: { width: w, height: h, duration: seconds } };
}

const day = (i) => new Date(Date.UTC(2025, 5, 12) + i * 86400000).toISOString().slice(0, 10); // Jun 12, 2025 + i days
const photo = (label, i) => ({ date: day(i), kind: 'photo', ...still(label, ...(rand() < 0.75 ? [1536, 2048] : [1920, 1080]), 'photo') });
const drawing = (label, i) => ({ date: day(i), kind: 'illustration', ...still(label, 1024, 1024, 'illustration') });
const video = (label, i) => ({ date: day(i), kind: 'video', ...clip(label, ...(rand() < 0.6 ? [1080, 1920] : [1280, 720]), 2.5) });
const portrait = (name, date) => {
  const p = still(`${name} (photo)`, 1024, 1024, 'photo');
  const d = still(`${name} (drawing)`, 1024, 1024, 'illustration');
  return { date, kind: 'portrait', file: d.file, pairFile: p.file, source: d.source };
};
const burst = (count, from, to, label) =>
  Array.from({ length: count }, (_, k) => {
    const i = Math.round(from + ((to - from) * k) / Math.max(1, count - 1));
    const r = k % 7;
    return r === 0 || r === 3 ? video(`${label} clip ${k + 1}`, i) : r === 5 ? drawing(`${label} drawing ${k + 1}`, i) : photo(`${label} photo ${k + 1}`, i);
  });

// ── The film: "Leo", turning 4 on Jun 12, 2026 (every birthday scene) ─────

const leoFrom = portrait('Leo at 3', '2025-06-12');
const leoTo = portrait('Leo at 4', '2026-06-01');
const backdrop = Array.from({ length: 40 }, (_, k) => photo(`moment ${k + 1}`, k * 9));
const people = ['Grandma Lucía', 'Grandpa Tomás', 'Ana', 'Mom', 'Dad', 'Aunt Sofía'].map((name, k) => ({
  memberId: `sample-${k}`,
  name: name.split(' ').at(-1),
  portrait: portrait(name, null),
  moments: [photo(`Leo + ${name} 1`, 20 + k * 40), drawing(`Leo + ${name} 2`, 35 + k * 40), photo(`Leo + ${name} 3`, 50 + k * 40)],
}));
const voiceClip = { date: day(300), kind: 'video', usage: 'voice', ...clip('Leo singing', 1080, 1920, 6, true) };
const party = [photo('birthday cake', 365), photo('party hats', 365)];

const film = {
  version: 1,
  kind: 'birthday',
  language: 'en',
  title: 'Memories of your fourth year, Leo',
  span: { from: '2025-06-12', to: '2026-06-12' },
  sample: true,
  scenes: [
    { type: 'cold_open', title: 'Memories of your fourth year, Leo', from: leoFrom, to: leoTo },
    {
      type: 'counters',
      kicker: 'Your year in',
      counts: [{ key: 'moments', label: 'moments', value: 214 }, { key: 'photos', label: 'photos', value: 162 }, { key: 'videos', label: 'videos', value: 31 }, { key: 'drawings', label: 'drawings', value: 48 }, { key: 'sounds', label: 'sounds', value: 3 }],
      backdrop,
    },
    { type: 'burst', role: 'first_half', titles: [], frames: burst(14, 0, 170, 'first half'), secondsPerFrame: 0.51 },
    { type: 'line', kicker: 'What you told us', quote: 'the moon is following our car!', speakerName: 'Leo', frame: drawing('the moon', 140), alternates: [] },
    { type: 'starring', kicker: 'With your people', people, together: people.map(({ memberId, name, portrait: p }) => ({ memberId, name, portrait: p })) },
    { type: 'burst', role: 'second_half', titlesKicker: 'What you loved this year', titles: ['going to the park', 'riding on wheels', 'building with blocks and trains'], frames: burst(13, 185, 360, 'second half'), secondsPerFrame: 0.51 },
    { type: 'sound', kicker: 'Your voice', source: 'video', frame: voiceClip, caption: 'Leo singing in the car on the way to the beach.', alternates: [] },
    { type: 'firsts', kicker: 'Your milestones', items: [{ milestoneId: 'balance-bike', label: 'First balance bike ride', date: day(230), memoryId: 'sample-first-1', frame: photo('first bike ride', 230) }, { milestoneId: 'first-swim', label: 'First swim', date: day(300), memoryId: 'sample-first-2' }] },
    { type: 'burst', role: 'emotion', titles: ['Your funniest moments'], frames: [drawing('funny 1', 60), photo('funny 2', 120), photo('funny 3', 210), drawing('funny 4', 280)], secondsPerFrame: 0.51 },
    { type: 'burst', role: 'finale', titles: [], frames: burst(19, 5, 360, 'finale'), secondsPerFrame: 0.31 },
    { type: 'close', line: 'Happy 4th birthday, Leo.', source: 'celebration', celebrationDate: '2026-06-12', frames: party },
    { type: 'end_card', grid: backdrop.slice(0, 9) },
  ],
};
fs.writeFileSync(path.join(OUT, 'film.json'), `${JSON.stringify(film, null, 2)}\n`);
const bytes = fs.readdirSync(ASSETS).reduce((sum, f) => sum + fs.statSync(path.join(ASSETS, f)).size, 0);
console.log(`sample: ${film.scenes.length} scenes · ${fs.readdirSync(ASSETS).length} assets · ${(bytes / 1e6).toFixed(1)} MB → ${path.relative(process.cwd(), OUT)}`);
