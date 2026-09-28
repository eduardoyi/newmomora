#!/usr/bin/env node
/**
 * Year Film assembler (docs/plans/year-film.md §7.4, §9; F3).
 *
 * film.json (FilmScript annotated by F2) → a HyperFrames project in
 * film-renderer/composition/: index.html (music, the year strip, scene hosts)
 * + one sub-composition per scene under compositions/, with the film's
 * prepared assets copied to assets/film/. Scenes are laid on the music's beat
 * grid. The renderer never selects anything — every frame and string comes
 * from film.json (plan §3).
 *
 * Answers F3's open question: conditional scenes are HTML assembly (this
 * file), not HyperFrames variables — scenes drop in and out and bursts vary
 * in length, which variables can't express.
 *
 * usage: node film-renderer/assemble.mjs <slug>
 * Generated files are gitignored (they carry real family data).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, 'composition');
const slug = process.argv[2] ?? 'birthday-enzo-y4';
const FILM_DIR = path.join(HERE, 'film-data', slug);
const film = JSON.parse(fs.readFileSync(path.join(FILM_DIR, 'film.json'), 'utf8'));

// ── Music & beat grid ────────────────────────────────────────────────────
// Dedicated beds with measured beat maps (music/generate.mjs → beds.json):
// each trimmed so beat 0 is at 0s. A film's bed comes from its kind — two
// birthday beds picked by the film's slug so siblings don't always share one,
// six monthly beds rotated by calendar month — or from --bed <id>.
const BEDS = JSON.parse(fs.readFileSync(path.join(PROJECT, 'assets', 'audio', 'beds', 'beds.json'), 'utf8')).beds;
function pickBed() {
  const forced = process.argv.includes('--bed') ? process.argv[process.argv.indexOf('--bed') + 1] : null;
  if (forced) {
    const bed = BEDS.find((b) => b.id === forced);
    if (!bed) throw new Error(`no bed "${forced}" (have ${BEDS.map((b) => b.id).join(', ')})`);
    return bed;
  }
  const options = BEDS.filter((b) => b.use.includes(film.kind)).sort((x, y) => x.id.localeCompare(y.id));
  if (options.length === 0) throw new Error(`no bed for film kind ${film.kind}`);
  // Monthlies come out every month: rotate by calendar month so consecutive
  // months never share a bed and none repeats within options.length months
  // (owner, 2026-09-28). P1 stores the chosen bed, so adding a bed later
  // doesn't reshuffle films already made.
  if (film.kind === 'family_month') {
    const [y, m] = film.span.from.split('-').map(Number);
    return options[(y * 12 + (m - 1)) % options.length];
  }
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return options[h % options.length];
}
const BED = pickBed();
const BEAT = 60 / BED.bpm;
const beats = (n) => +(n * BEAT).toFixed(4);
// Pacing is designed in beats at 118 BPM (the approved cut). On a faster or
// slower bed a scene keeps its duration and snaps to the nearest whole beat,
// so every film runs about the same length on any bed, still cut on the beat.
const REF_BEAT = 60 / 118;
const nb = (refBeats) => Math.max(1, Math.round((refBeats * REF_BEAT) / BEAT));
const TEMPO = REF_BEAT / BEAT; // < 1 on a slower bed
const W = 1080;
const H = 1920;
const MAX_SECONDS = 60; // plan §5: approved burst pace first, films up to the ~60s bed

// ── Palette & type (frame.md) ────────────────────────────────────────────
const C = {
  lav: '#ECE8F5', cream: '#F7F1EA', plum: '#2A2230', ink: '#2C2418', ink2: '#6B5E4F',
  rose: '#D63E78', card: '#FFFFFF', paper: '#FFFDF9',
};
const FONTS = `
@font-face{font-family:"Newsreader";src:url("assets/fonts/Newsreader_500Medium.ttf");font-weight:500}
@font-face{font-family:"Newsreader";src:url("assets/fonts/Newsreader_400Regular_Italic.ttf");font-weight:400;font-style:italic}
@font-face{font-family:"Plus Jakarta Sans";src:url("assets/fonts/PlusJakartaSans_500Medium.ttf");font-weight:500}
@font-face{font-family:"Plus Jakarta Sans";src:url("assets/fonts/PlusJakartaSans_700Bold.ttf");font-weight:700}
@font-face{font-family:"Caveat";src:url("assets/fonts/Caveat_700Bold.ttf");font-weight:700}`;

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const months = film.language === 'es' ? MONTHS_ES : MONTHS_EN;
function fdate(iso, withDay = true) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return withDay ? `${d} ${months[m - 1]} ${y}` : `${months[m - 1]} ${y}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Seeded PRNG (determinism rules: no Math.random).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Assets ───────────────────────────────────────────────────────────────

const OUT_ASSETS = path.join(PROJECT, 'assets', 'film');
fs.rmSync(OUT_ASSETS, { recursive: true, force: true });
fs.mkdirSync(OUT_ASSETS, { recursive: true });
fs.cpSync(path.join(FILM_DIR, 'assets'), OUT_ASSETS, { recursive: true });
const asset = (file) => (file ? `assets/film/${path.basename(file)}` : '');

/** A still for a clip (blurred fills, tiles): first frame of the cut. */
function poster(file) {
  const out = path.join(OUT_ASSETS, `${path.basename(file, path.extname(file))}-poster.jpg`);
  if (!fs.existsSync(out)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.05', '-i', path.join(OUT_ASSETS, path.basename(file)), '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '4', out]);
  }
  return `assets/film/${path.basename(out)}`;
}
const still = (f) => (!f?.file ? '' : f.file.endsWith('.mp4') ? poster(f.file) : asset(f.file));
const isClip = (f) => !!f?.file?.endsWith('.mp4');

/** Loudness envelope of the voice excerpt → the trace's real shape. */
function envelope(file, points = 120) {
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-i', path.join(OUT_ASSETS, path.basename(file)), '-vn', '-af',
    'aresample=16000,asetnsamples=n=640:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lv = [...out.matchAll(/RMS_level=(-?inf|[-\d.]+)/g)].map((m) => (m[1].endsWith('inf') ? -90 : Number(m[1])));
  const lo = -55;
  const hi = Math.max(-12, ...lv);
  const norm = lv.map((v) => Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
  const step = Math.max(1, Math.floor(norm.length / points));
  const out2 = [];
  for (let i = 0; i < norm.length; i += step) out2.push(Math.max(...norm.slice(i, i + step)));
  return out2;
}

function probeDims(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(OUT_ASSETS, path.basename(file))], { encoding: 'utf8' });
  const [w, h] = out.trim().split(',').map(Number);
  return w && h ? { w, h } : null;
}

function probeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(OUT_ASSETS, path.basename(file))], { encoding: 'utf8' });
  return Number(out.trim()) || 0;
}

/** A card shaped like its photo (owner, F3: "try to not crop media"): the
 * largest box with the media's aspect inside maxW×maxH (padding included),
 * centered on (cx, cy) — or hung from `top` when given. */
function fitCard(f, { cx, cy, top, maxW, maxH, pad = 14 }) {
  const sw = f?.source?.width;
  const sh = f?.source?.height;
  const aspect = sw && sh ? sh / sw : f?.kind === 'portrait' || f?.kind === 'illustration' ? 1 : 4 / 3;
  let cw = maxW - 2 * pad;
  let ch = cw * aspect;
  if (ch > maxH - 2 * pad) {
    ch = maxH - 2 * pad;
    cw = ch / aspect;
  }
  const w = Math.round(cw + 2 * pad);
  const h = Math.round(ch + 2 * pad);
  const left = Math.round(cx - w / 2);
  const y = top ?? Math.round(cy - h / 2);
  return { w, h, left, top: y, style: `left:${left}px;top:${y}px;width:${w}px;height:${h}px;padding:${pad}px` };
}

// ── Media blocks ─────────────────────────────────────────────────────────

/** A frame layer: 9:16-ish media full-bleed; anything else whole, on a
 * blurred copy of itself (owner, F2 round 1: never crop the moment away). */
function mediaLayer(f, { cls = '', id, start, dur }) {
  const w = f.source?.width ?? 1080;
  const h = f.source?.height ?? 1920;
  const tall = h / w > 1.55;
  const bg = still(f);
  const fg = isClip(f)
    ? `<video id="${id}-v" class="clip fg${tall ? ' cover' : ''}" src="${asset(f.file)}" data-start="${start}" data-duration="${dur}" data-media-start="0" data-hf-media-start-basis="local" data-track-index="2" muted playsinline></video>`
    : `<img class="fg${tall ? ' cover' : ''}" src="${asset(f.file)}">`;
  return `<div id="${id}" class="layer ${cls}">${tall ? '' : `<div class="blur" data-layout-allow-overflow style="background-image:url(${bg})"></div>`}<div class="push" data-layout-allow-overflow>${fg}</div></div>`;
}

// ── Sub-composition wrapper ──────────────────────────────────────────────

const BASE_CSS = `${FONTS}
*{box-sizing:border-box;margin:0;padding:0}
#root{position:absolute;inset:0;overflow:hidden}
.sc{position:absolute;inset:0;font-family:"Plus Jakarta Sans",sans-serif;color:${C.ink}}
.sc .abs{position:absolute}
.sc .layer{position:absolute;inset:0;overflow:hidden;opacity:0}
.sc .layer .blur{position:absolute;left:-10%;top:-10%;width:120%;height:120%;background:center/cover no-repeat;filter:blur(48px) brightness(.62) saturate(1.1)}
.sc .layer .push{position:absolute;inset:0}
.sc .layer .fg{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.sc .layer .fg.cover{object-fit:cover}
.sc .card{position:absolute;background:${C.card};border-radius:40px;padding:16px;box-shadow:0 22px 48px rgba(44,36,24,.22)}
.sc .card img{display:block;width:100%;height:100%;object-fit:cover;border-radius:28px}
.sc .kicker{position:absolute;left:96px;font:500 40px/1 "Plus Jakarta Sans";letter-spacing:.12em;text-transform:uppercase;color:${C.ink2}}
.sc .kicker.light{color:rgba(247,241,234,.72)}
.sc .title{position:absolute;left:96px;right:120px;font:500 132px/0.98 "Newsreader";letter-spacing:-.03em;color:${C.ink}}
.sc .word{display:inline-block}`;

const files = [];
function subcomp(id, { bg, css = '', html, js }) {
  const text = `<!doctype html>
<html><head><meta charset="UTF-8"></head><body>
<template>
<style>${BASE_CSS}
[data-composition-id="${id}"]{background:${bg}}
${css}</style>
<div id="root" data-composition-id="${id}" data-width="${W}" data-height="${H}"><div class="sc ${id}">${html}</div></div>
<script>(function(){
  var R = document.querySelector('[data-composition-id="${id}"] .sc');
  var q = gsap.utils.selector(R);
  var tl = gsap.timeline({ paused: true });
  ${js}
  window.__timelines["${id}"] = tl;
})();</script>
</template></body></html>`;
  files.push({ id, text });
}

// Waterfall a title word by word (rule: waterfall-entry).
function words(text, cls = 'word') {
  return String(text).split(/\s+/).map((w) => `<span class="${cls}">${esc(w)}</span>`).join(' ');
}

// ── Scenes ───────────────────────────────────────────────────────────────
// Each returns { beats, events } and registers its sub-composition. `events`
// feed the year strip: [{ t (scene-local s), date|null }].

const scenes = [];
const bySceneType = (t, role) => film.scenes.find((s) => s.type === t && (role === undefined || s.role === role));

function coldOpen(s, id) {
  const n = nb(8);
  const from = s.from;
  const to = s.to;
  subcomp(id, {
    bg: C.lav,
    css: `
.${id} .morph{position:absolute;border-radius:48px;overflow:hidden;background:#fff;box-shadow:0 30px 70px rgba(44,36,24,.28)}
.${id} .morph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.${id} .morph .sweep{position:absolute;left:0;top:-10%;bottom:-10%;width:18%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.85),transparent)}
.${id} .glow{position:absolute;left:190px;top:560px;width:760px;height:760px;border-radius:50%;background:radial-gradient(circle,rgba(214,62,120,.20),transparent 68%)}`,
    html: `
<div class="glow"></div>
${from ? `<div class="morph back" style="left:120px;top:420px;width:400px;height:400px"><img src="${asset(from.pairFile)}"><img class="drawn" src="${asset(from.file)}"><i class="sweep"></i></div>` : ''}
<div class="morph front" style="left:230px;top:640px;width:660px;height:660px"><img src="${asset(to.pairFile)}"><img class="drawn" src="${asset(to.file)}"><i class="sweep"></i></div>
<h1 class="title" style="top:1330px;font-size:118px">${words(s.title)}</h1>`,
    js: `
var B=${BEAT};
tl.fromTo(q('.glow'),{scale:.7,opacity:0},{scale:1,opacity:1,duration:2.2,ease:'sine.out'},0);
${from ? `
tl.fromTo(q('.back'),{y:90,rotation:-12,opacity:0},{y:0,rotation:-7,opacity:1,duration:.55,ease:'power3.out'},.1);
tl.fromTo(q('.back .drawn'),{clipPath:'inset(0 0 0 100%)'},{clipPath:'inset(0 0 0 0%)',duration:.7,ease:'power2.inOut'},B*1.5);
tl.fromTo(q('.back .sweep'),{xPercent:560},{xPercent:-120,duration:.7,ease:'power2.inOut'},B*1.5);` : ''}
tl.fromTo(q('.front'),{y:260,scale:.86,opacity:0},{y:0,scale:1,opacity:1,duration:.7,ease:'power3.out'},B*2.5);
tl.fromTo(q('.front .drawn'),{clipPath:'inset(0 0 0 100%)'},{clipPath:'inset(0 0 0 0%)',duration:.9,ease:'power2.inOut'},B*4);
tl.fromTo(q('.front .sweep'),{xPercent:560},{xPercent:-120,duration:.9,ease:'power2.inOut'},B*4);
tl.fromTo(q('.front'),{rotation:0},{rotation:2.5,duration:B*4,ease:'sine.inOut'},B*4);
tl.fromTo(q('.title .word'),{y:70,opacity:0},{y:0,opacity:1,duration:.5,ease:'power3.out',stagger:.07},B*4.5);`,
  });
  return { beats: n, events: [{ t: 0, date: from?.date ?? film.span.from }, { t: BEAT * 2.5, date: to.date ?? null }] };
}

// ── The year mosaic (counters backdrop, end card) ─────────────────────────
// A tilted wall of the year's stills, denser than any one scene: the
// counters' backdrop tiles first, then every other still the film uses.
// Cycled to fill when the film has fewer stills than cells (a larger
// backdrop in film.json removes the repeats).
// Density follows the film: 9 columns (108 tiles) for a full year, as few as
// 5 for a month, so a small month isn't the same few photos over and over.
const MOSAIC = { cols: 9, gap: 8, tilt: -8, width: 1404 };
function sizeMosaic(uniqueStills) {
  MOSAIC.cols = Math.max(5, Math.min(9, Math.round(Math.sqrt(uniqueStills / 1.33))));
  MOSAIC.tileW = (MOSAIC.width - (MOSAIC.cols + 1) * MOSAIC.gap) / MOSAIC.cols;
  MOSAIC.tileH = MOSAIC.tileW * 4 / 3;
  MOSAIC.rows = Math.ceil(2380 / (MOSAIC.tileH + MOSAIC.gap));
  MOSAIC.height = MOSAIC.rows * (MOSAIC.tileH + MOSAIC.gap) + MOSAIC.gap;
}
let mosaicCache = null;
function mosaicTiles() {
  if (mosaicCache) return mosaicCache;
  const seen = new Set();
  const pool = [];
  const add = (f) => {
    if (!f?.file || f.kind === 'portrait' || f.kind === 'audio' || seen.has(f.file)) return;
    seen.add(f.file);
    pool.push(still(f));
  };
  for (const sc of film.scenes) if (sc.type === 'counters') (sc.backdrop ?? []).forEach(add);
  for (const sc of film.scenes) { (sc.frames ?? []).forEach(add); (sc.grid ?? []).forEach(add); (sc.cards ?? []).forEach(add); add(sc.frame); }
  sizeMosaic(pool.length);
  const r = rng(23);
  const shuffled = pool.map((src) => [r(), src]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const cells = [];
  for (let row = 0; row < MOSAIC.rows; row++) {
    for (let col = 0; col < MOSAIC.cols; col++) {
      const k = cells.length;
      const x = MOSAIC.gap + col * (MOSAIC.tileW + MOSAIC.gap);
      const y = MOSAIC.gap + row * (MOSAIC.tileH + MOSAIC.gap);
      const cx = x + MOSAIC.tileW / 2 - MOSAIC.width / 2;
      const cy = y + MOSAIC.tileH / 2 - MOSAIC.height / 2;
      cells.push({ src: shuffled[k % shuffled.length], x, y, cx, cy, d: Math.hypot(cx, cy) });
    }
  }
  return (mosaicCache = cells);
}
function mosaicCss(id) {
  return `
.${id} .mwrap{position:absolute;left:50%;top:50%;width:0;height:0}
.${id} .mosaic{position:absolute;left:${-MOSAIC.width / 2}px;top:${(-MOSAIC.height / 2).toFixed(1)}px;width:${MOSAIC.width}px;height:${MOSAIC.height.toFixed(1)}px;transform:rotate(${MOSAIC.tilt}deg)}
.${id} .mosaic i{position:absolute;width:${MOSAIC.tileW.toFixed(1)}px;height:${MOSAIC.tileH.toFixed(1)}px;border-radius:12px;background:center/cover no-repeat}`;
}
function mosaicHtml() {
  return `<div class="mwrap" data-layout-allow-overflow><div class="mosaic" data-layout-allow-overflow>${mosaicTiles().map((c) => `<i style="left:${c.x.toFixed(1)}px;top:${c.y.toFixed(1)}px;background-image:url(${c.src})"></i>`).join('')}</div></div>`;
}

function counters(s, id) {
  const n = nb(4);
  const cells = mosaicTiles();
  const r = rng(7);
  const order = cells.map((_, i) => [r(), i]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const rows = s.counts.map((c, i) => `<div class="row${i === 0 ? ' big' : ''}"><span class="num" data-v="${c.value}">0</span><em>${esc(c.label)}</em></div>`).join('');
  subcomp(id, {
    bg: C.cream,
    css: `${mosaicCss(id)}
.${id} .mosaic{filter:saturate(.45)}
.${id} .veil{position:absolute;inset:0;background:rgba(247,241,234,.8)}
.${id} .counts{position:absolute;left:96px;right:150px;top:420px}
.${id} .row{display:flex;align-items:baseline;gap:22px;margin-bottom:14px}
.${id} .row .num{font:500 120px/1 "Newsreader";letter-spacing:-.03em;color:${C.ink};font-variant-numeric:tabular-nums}
.${id} .row em{font:500 42px "Plus Jakarta Sans";font-style:normal;color:${C.ink2}}
.${id} .row.big .num{font-size:300px;color:${C.rose}}
.${id} .row.big em{font-size:56px}`,
    html: `${mosaicHtml()}<div class="veil"></div>
<p class="kicker" style="top:340px">${esc(s.kicker ?? '')}</p><div class="counts">${rows}</div>`,
    js: `
var B=${BEAT}, order=${JSON.stringify(order)}, tiles=q('.mosaic i'), span=${(n * BEAT - 0.45).toFixed(3)};
order.forEach(function(k,i){ tl.fromTo(tiles[k],{opacity:0,scale:.85},{opacity:1,scale:1,duration:.22,ease:'power2.out'},i*span/order.length); });
tl.fromTo(q('.mwrap'),{y:0},{y:-60,duration:${(n * BEAT).toFixed(3)},ease:'none'},0);
q('.row').forEach(function(row,i){
  var num=row.querySelector('.num'), v=+num.getAttribute('data-v'), o={v:0};
  tl.fromTo(row,{y:50,opacity:0},{y:0,opacity:1,duration:.35,ease:'power3.out'},.08*i);
  tl.fromTo(o,{v:0},{v:v,duration:1.1,ease:'power2.out',onUpdate:function(){num.textContent=Math.round(o.v);}},.08*i);
});`,
  });
  return { beats: n, events: [{ t: 0, date: null }] };
}

/** Beat-cut burst. Stills hold `still` beats, clips `clip` beats; titles
 * (optional) slam over the first beats; `finale` accelerates and settles
 * into a 3×3 grid. */
function burst(s, id, { accelerate = false, bg = C.plum }) {
  // Chronological inside a burst: the year strip's dot only moves forward.
  const frames = [...s.frames].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // The approved pace (owner, F3 round 2: "the length of the bursts is
  // right now"): about one beat per frame — clips first up to 1.5 beats,
  // stills sharing the rest, never under half a beat — and ~0.6 beat per frame
  // in the finale, whose second half runs at half beats into the party.
  // Budgets are in quarter beats so every cut lands on the grid.
  // Titles: a beat each; with a heading ("Lo que más te gustó este año") the
  // heading gets a beat to itself and each activity 1.5 — they're sentences.
  const headingBeats = s.titles?.length && s.titlesKicker ? nb(1) : 0;
  const perTitle = Math.round((headingBeats ? 1.5 : 1) * TEMPO * 4) / 4; // quarter-beat grid
  const titleBeats = s.titles?.length ? headingBeats + s.titles.length * perTitle : 0;
  const titleOffset = titleBeats * BEAT;
  const tail = (i) => accelerate && i >= Math.ceil(frames.length * 0.5);
  const units = frames.map(() => 2);
  let spare = Math.max(0, Math.round(frames.length * (accelerate ? 0.6 : 1) * 4 * TEMPO) - units.reduce((x, y) => x + y, 0));
  for (const [cap, test] of [[6, isClip], [4, (f) => !isClip(f)]]) {
    for (let moved = true; spare > 0 && moved; ) {
      moved = false;
      frames.forEach((f, i) => {
        if (spare > 0 && !tail(i) && test(f) && units[i] < cap) { units[i]++; spare--; moved = true; }
      });
    }
  }
  let t = 0;
  const cuts = frames.map((f, i) => {
    const c = { f, t: +(titleOffset + t).toFixed(4), d: +(units[i] * BEAT / 4).toFixed(4) };
    t += units[i] * BEAT / 4;
    return c;
  });
  const n = Math.max(4, Math.ceil((titleOffset + t) / BEAT - 1e-6));
  const layers = cuts.map((c, i) => mediaLayer(c.f, { id: `${id}-f${i}`, start: c.t, dur: +(c.d + 0.05).toFixed(4) })).join('');
  const titleGrid = s.titles?.length ? frames.slice(0, 12).map((f) => `<i style="background-image:url(${still(f)})"></i>`).join('') : '';
  subcomp(id, {
    bg,
    css: `
.${id} .diag{position:absolute;left:-22%;top:-12%;width:144%;height:124%;display:grid;grid-template-columns:repeat(4,1fr);gap:22px}
.${id} .diag i{display:block;width:100%;aspect-ratio:3/4;background:center/cover;border-radius:24px}
.${id} .dwrap{position:absolute;inset:0;overflow:hidden}
.${id} .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(42,34,48,.55),rgba(42,34,48,.86) 30%,rgba(42,34,48,.86) 62%,rgba(42,34,48,.6))}
.${id} .tk{position:absolute;left:96px;right:150px;top:560px;font:500 40px/1.2 "Plus Jakarta Sans";letter-spacing:.12em;text-transform:uppercase;color:rgba(247,241,234,.78)}
.${id} .themes{position:absolute;left:96px;right:150px;top:${s.titlesKicker ? 660 : 620}px}
.${id} .themes span{display:block;margin-bottom:18px;font:500 ${s.titlesKicker ? 100 : 118}px/1.02 "Newsreader";letter-spacing:-.03em;color:${C.cream};opacity:0;transform-origin:left center;text-shadow:0 2px 18px rgba(20,14,24,.55)}`,
    html: `${titleGrid ? `<div class="dwrap"><div class="diag">${titleGrid}</div><div class="scrim"></div>${s.titlesKicker ? `<p class="tk">${esc(s.titlesKicker)}</p>` : ''}<div class="themes">${s.titles.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>` : ''}
${layers}`,
    js: `
var B=${BEAT}, cuts=${JSON.stringify(cuts.map((c) => [c.t, c.d]))};
${titleGrid ? `
${s.titlesKicker ? "tl.fromTo(q('.tk'),{y:24,opacity:0},{y:0,opacity:1,duration:.35,ease:'power3.out'},0);" : ''}
tl.fromTo(q('.diag'),{rotation:-9,y:0},{rotation:-9,y:-260,duration:${(titleOffset + 0.4).toFixed(3)},ease:'none'},0);
q('.themes span').forEach(function(el,i){ var at=(${headingBeats}+i*${perTitle})*B; tl.fromTo(el,{scale:1.35,opacity:0},{scale:1,opacity:1,duration:.22,ease:'power4.out'},at); ${headingBeats ? '' : "if(i>0) tl.to(q('.themes span')[i-1],{opacity:.45,duration:.2},at);"} });
tl.to(q('.dwrap'),{opacity:0,duration:.15},${titleOffset.toFixed(3)});` : ''}
cuts.forEach(function(c,i){
  var el=q('#${id}-f'+i)[0];
  tl.set(el,{opacity:1},c[0]);
  tl.set(el,{opacity:0},c[0]+c[1]);
  tl.fromTo(el.querySelector('.push'),{scale:1.0},{scale:1.07,duration:c[1]+.05,ease:'none'},c[0]);
});`,
  });
  return { beats: n, events: cuts.map((c) => ({ t: c.t, date: c.f.date ?? null })) };
}

function line(s, id) {
  const n = nb(7);
  const ws = s.quote.split(/\s+/);
  const quoteHtml = ws.map((w, i) => `<span class="word${i === ws.length - 1 ? ' mark' : ''}">${esc(i === 0 ? `“${w}` : w)}${i === ws.length - 1 ? '”' : ''}</span>`).join(' ');
  subcomp(id, {
    bg: C.cream,
    css: `
.${id} .qwrap{position:absolute;left:96px;right:150px;top:${s.frame ? 860 : 700}px}
.${id} .quote{font:700 118px/1.04 "Caveat";color:${C.ink}}
.${id} .mark{position:relative}
.${id} .under{position:absolute;left:0;right:0;bottom:6px;height:22px;background:rgba(214,62,120,.55);border-radius:8px;transform-origin:left center}
.${id} .by{margin-top:44px;font:500 44px "Plus Jakarta Sans";color:${C.ink2}}`,
    html: `<p class="kicker" style="top:330px">${esc(s.kicker ?? '')}</p>
${s.frame ? `<div class="card src" style="${fitCard(s.frame, { cx: 276, cy: 600, maxW: 360, maxH: 360, pad: 16 }).style}"><img src="${still(s.frame)}"></div>` : ''}
<div class="qwrap"><p class="quote">${quoteHtml}</p><p class="by">— ${esc(s.speakerName)}</p></div>`,
    js: `
var B=${BEAT};
var m=q('.mark')[0]; var u=document.createElement('i'); u.className='under'; m.appendChild(u);
tl.fromTo(q('.kicker'),{opacity:0,y:20},{opacity:1,y:0,duration:.4},0);
${s.frame ? `tl.fromTo(q('.src'),{scale:.6,rotation:-8,opacity:0},{scale:1,rotation:-3,opacity:1,duration:.6,ease:'back.out(1.7)'},.15);` : ''}
tl.fromTo(q('.quote .word'),{y:40,opacity:0},{y:0,opacity:1,duration:.4,ease:'power3.out',stagger:${Math.min(0.12, 1.6 / ws.length).toFixed(3)}},.4);
tl.fromTo(u,{scaleX:0},{scaleX:1,duration:.45,ease:'power2.inOut'},${(0.4 + Math.min(0.12, 1.6 / ws.length) * ws.length + 0.2).toFixed(3)});
tl.fromTo(q('.by'),{opacity:0},{opacity:1,duration:.4},${(0.8 + Math.min(0.12, 1.6 / ws.length) * ws.length).toFixed(3)});`,
  });
  return { beats: n, events: [{ t: 0, date: s.frame?.date ?? null }] };
}

/** A reveal per person — their photo turns into their drawing, their name
 * lands, and up to three moments with the child fan out as cards (owner, F3
 * round 2: "more personality and emotion") — then everyone together. */
const PERSON_BEATS = nb(3);
const TOGETHER_BEATS = nb(2);
function starring(s, id) {
  const people = s.people.slice(0, 6);
  const n = people.length * PERSON_BEATS + TOGETHER_BEATS;
  const fan = [[96, 830, -6], [352, 790, 3], [610, 845, -2]];
  const reveal = people.map((p, i) => `<div class="who p${i}">
  <div class="big disc"><img src="${asset(p.portrait.pairFile)}"><img class="drawn" src="${asset(p.portrait.file)}"></div>
  <h2 class="name">${esc(p.name)}</h2>
  ${(p.moments ?? []).filter((m) => m.file).slice(0, 3).map((m, k) => `<div class="card mo" style="${fitCard(m, { cx: fan[k][0] + 160, cy: fan[k][1] + 205, maxW: 320, maxH: 410, pad: 12 }).style}"><i style="background-image:url(${still(m)})"></i></div>`).join('')}
</div>`).join('');
  // The group shot: everyone who qualifies (film.json `together`), up to 9.
  const revealedPortrait = new Map(people.map((p) => [p.memberId, p.portrait]));
  const group = (s.together ?? people).slice(0, 9)
    .map((p) => (p.portrait?.file ? p : { ...p, portrait: revealedPortrait.get(p.memberId) ?? p.portrait }))
    .filter((p) => p.portrait?.file);
  const cols = group.length > 4 ? 3 : Math.min(2, group.length);
  const faces = group.map((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const rowCount = Math.min(cols, group.length - row * cols);
    const x = 540 - (rowCount * 250 + (rowCount - 1) * 40) / 2 + col * 290 - 45;
    const y = (group.length > 6 ? 440 : 520) + row * 330;
    return `<div class="face" style="left:${x.toFixed(0)}px;top:${y}px"><div class="disc"><i style="background-image:url(${asset(p.portrait.file)})"></i></div><span>${esc(p.name)}</span></div>`;
  }).join('');
  const momentDates = people.map((p) => (p.moments ?? []).filter((m) => m.file).slice(0, 3).map((m) => m.date ?? null));
  subcomp(id, {
    bg: C.cream,
    css: `
.${id} .who{position:absolute;inset:0;opacity:0}
.${id} .disc{position:absolute;border-radius:50%;overflow:hidden;box-shadow:0 10px 26px rgba(44,36,24,.2);background:#fff}
.${id} .disc img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.${id} .big{left:96px;top:400px;width:340px;height:340px}
.${id} .name{position:absolute;left:480px;right:150px;top:500px;font:500 128px/1 "Newsreader";letter-spacing:-.03em;color:${C.ink}}
.${id} .mo{border-radius:32px}
.${id} .mo i{display:block;width:100%;height:100%;border-radius:22px;background:center/cover no-repeat}
.${id} .together{position:absolute;inset:0;opacity:0}
.${id} .face{position:absolute;width:250px;height:300px}
.${id} .face .disc{left:0;top:0;width:250px;height:250px}
.${id} .face .disc i{position:absolute;inset:0;background:center/cover no-repeat}
.${id} .face span{position:absolute;left:0;top:266px;width:250px;text-align:center;font:700 34px "Plus Jakarta Sans";color:${C.ink}}`,
    html: `<p class="kicker" style="top:300px">${esc(s.kicker ?? '')}</p>${reveal}<div class="together">${faces}</div>`,
    js: `
var B=${BEAT}, P=${PERSON_BEATS}*B, k=${people.length}, rot=${JSON.stringify(fan.map((f) => f[2]))};
tl.fromTo(q('.kicker'),{opacity:0,y:20},{opacity:1,y:0,duration:.4},0);
for (var i=0;i<k;i++){
  var t0=i*P, w=q('.p'+i)[0];
  tl.fromTo(w,{opacity:0,y:160},{opacity:1,y:0,duration:.35,ease:'power3.out'},t0);
  tl.fromTo(w.querySelector('.disc'),{scale:.6},{scale:1,duration:.5,ease:'back.out(1.8)'},t0);
  tl.fromTo(w.querySelector('.drawn'),{clipPath:'inset(0 0 0 100%)'},{clipPath:'inset(0 0 0 0%)',duration:.55,ease:'power2.inOut'},t0+B*1.1);
  tl.fromTo(w.querySelector('.name'),{x:-40,opacity:0},{x:0,opacity:1,duration:.4,ease:'power3.out'},t0+.12);
  w.querySelectorAll('.mo').forEach(function(c,j){
    tl.fromTo(c,{y:120,scale:.7,rotation:0,opacity:0},{y:0,scale:1,rotation:rot[j],opacity:1,duration:.45,ease:'back.out(1.6)'},t0+.3+j*B*.5);
  });
  tl.to(w,{y:-240,opacity:0,duration:.28,ease:'power2.in'},t0+P-.28);
}
tl.fromTo(q('.together'),{opacity:0},{opacity:1,duration:.2},k*P);
tl.fromTo(q('.face'),{scale:0},{scale:1,duration:.45,ease:'back.out(1.8)',stagger:.05},k*P);`,
  });
  const events = [{ t: 0, date: null }];
  momentDates.forEach((ds, i) => ds.forEach((d, j) => events.push({ t: i * PERSON_BEATS * BEAT + 0.3 + j * BEAT * 0.5, date: d })));
  events.push({ t: people.length * PERSON_BEATS * BEAT, date: null });
  return { beats: n, events: events.sort((a, b) => a.t - b.t) };
}

/** Loudness-normalized copy of the voice excerpt: phone recordings sit far
 * below the music (Enzo Y4: −33 LUFS vs the bed's −13). */
function normalizedVoice(file) {
  const out = path.join(OUT_ASSETS, `${path.basename(file, path.extname(file))}-voice.m4a`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(OUT_ASSETS, path.basename(file)), '-vn', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', out]);
  return `assets/film/${path.basename(out)}`;
}
const SOUND_ON = { es: 'Sube el volumen', en: 'Sound on' };

/** A ticket caption, not the memory's whole story: its first sentence, cut at
 * a word near 90 characters (Enzo Y3's clip carried a 7-line paragraph). */
function ticketCaption(text) {
  if (!text) return '';
  const first = String(text).trim().split(/(?<=[.!?…])\s+/u)[0].trim();
  if (first.length <= 90) return first;
  const cut = first.slice(0, 90);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60)).replace(/[,;:]$/, '')}…`;
}

function sound(s, id) {
  const clip = s.frame;
  const dur = probeDuration(clip.file);
  const voiceSrc = normalizedVoice(clip.file);
  const n = Math.min(14, Math.max(8, Math.ceil((dur + 0.7) / BEAT)));
  const env = envelope(clip.file);
  const pts = env.map((v, i) => {
    const x = (i / (env.length - 1)) * 800;
    const y = 60 + (i % 2 === 0 ? -1 : 1) * (6 + v * 46);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const isVideo = isClip(clip);
  const voiceStart = 0.4;
  // A vertical clip is the scene (owner, F3: a small box with big gutters
  // wasted it): it plays full-screen, the ticket goes compact over its foot.
  const dims = isVideo ? probeDims(clip.file) : null;
  const hero = !!dims && dims.h / dims.w > 1.3;
  const soundOn = `<div class="son"><svg viewBox="0 0 56 56"><path class="cone" d="M6 21h10l13-11v36L16 35H6z"/><path class="w1" d="M36 20c3.5 4.5 3.5 11.5 0 16"/><path class="w2" d="M43 13c7 8.5 7 21.5 0 30"/></svg>${esc(SOUND_ON[film.language] ?? SOUND_ON.en)}</div>`;
  const clipTag = `<video id="${id}-clip" class="clip" src="${asset(clip.file)}" data-start="${voiceStart}" data-duration="${dur.toFixed(3)}" data-media-start="0" data-hf-media-start-basis="local" data-track-index="2" muted playsinline></video>`;
  subcomp(id, {
    bg: C.plum,
    css: `
/* Ticket, clip and pill stack in one column so a caption can't push the
   ticket into the clip; with a clip the column starts higher to stay clear
   of the bottom keep-out. */
.${id} .col{position:absolute;left:96px;right:96px;top:${isVideo ? 400 : 560}px;${isVideo ? 'height:1080px;' : ''}display:flex;flex-direction:column;gap:28px}
.${id} .stub{position:relative;background:${C.cream};border-radius:40px;overflow:hidden}
.${id} .band{position:relative;height:380px;background:#E6D7EE}
.${id} .wax{position:absolute;left:44px;top:44px;width:116px;height:116px;border-radius:50%;background:${C.rose};color:#fff;display:flex;align-items:center;justify-content:center;font:500 58px "Newsreader"}
.${id} svg{position:absolute;left:44px;top:190px;width:800px;height:120px;overflow:visible}
.${id} path{fill:none;stroke:${C.ink};stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
.${id} .play{position:absolute;left:44px;top:176px;width:6px;height:150px;background:${C.rose};border-radius:3px}
.${id} .time{position:absolute;right:44px;top:74px;font:700 32px ui-monospace,Menlo,monospace;color:${C.ink}}
/* The app's StubTear (src/components/audio/stub-tear.tsx) at film scale: a
   dashed perforation between two notches punched in the ground behind the
   card — the stub's overflow clips them to semicircular bites. */
.${id} .tear{position:relative;height:0}
.${id} .tear .perf{position:absolute;left:40px;right:40px;top:-1px;border-top:3px dashed #CFC8E0}
.${id} .tear .notch{position:absolute;top:-24px;width:48px;height:48px;border-radius:50%;background:${C.plum}}
.${id} .tear .nl{left:-24px}
.${id} .tear .nr{right:-24px}
.${id} .cap{padding:44px;font:italic 400 58px/1.15 "Newsreader";color:${C.ink};display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
/* The clip fills what the column has left and shows the whole frame on a
   blurred copy of itself — never cropped away (owner, F2 round 1). */
.${id} .clipbox{position:relative;flex:1 1 auto;min-height:0;border-radius:32px;overflow:hidden}
.${id} .stub,.${id} .son{flex-shrink:0}
.${id} .clipbox .bf{position:absolute;inset:-10%;background:center/cover no-repeat;filter:blur(40px) brightness(.6)}
.${id} .clipbox video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.${id} .son{align-self:center;display:flex;align-items:center;gap:18px;padding:22px 36px 22px 30px;border-radius:999px;background:rgba(247,241,234,.12);border:2px solid rgba(247,241,234,.35);color:${C.cream};font:700 40px "Plus Jakarta Sans";white-space:nowrap}
.${id} .son svg{position:static;width:56px;height:56px;overflow:visible}
.${id} .son path{stroke:${C.cream};stroke-width:5}
.${id} .son .cone{fill:${C.cream};stroke:none}
${isVideo ? `
.${id} .band{height:250px}
.${id} .wax{left:36px;top:30px;width:88px;height:88px;font-size:44px}
.${id} .time{top:54px}
.${id} .stub svg{top:128px;height:90px}
.${id} .play{top:118px;height:110px}
.${id} .cap{padding:28px 40px;font-size:50px}` : ''}
${hero ? `
.${id} .hero{position:absolute;inset:0;overflow:hidden}
.${id} .hero .bf{position:absolute;inset:-10%;background:center/cover no-repeat;filter:blur(48px) brightness(.55)}
.${id} .hero video{position:absolute;inset:0;width:100%;height:100%;object-fit:${dims.h / dims.w >= 1.6 ? 'cover' : 'contain'}}
.${id} .hero .hs{position:absolute;inset:0;background:linear-gradient(180deg,rgba(42,34,48,.82) 0%,rgba(42,34,48,.7) 20%,rgba(42,34,48,0) 34%,rgba(42,34,48,0) 48%,rgba(42,34,48,.85) 100%)}
.${id} .kicker.light{color:${C.cream}}
.${id} .col{top:auto;bottom:430px;height:auto}
.${id} .son{position:absolute;right:150px;top:272px;padding:16px 28px 16px 22px;font-size:34px;background:rgba(42,34,48,.55)}
.${id} .son svg{width:46px;height:46px}` : ''}`,
    html: `${hero ? `<div class="hero"><i class="bf" data-layout-allow-overflow style="background-image:url(${poster(clip.file)})"></i>${clipTag}<i class="hs"></i></div>` : ''}<p class="kicker light" style="top:${isVideo ? 300 : 440}px">${esc(s.kicker ?? '')}</p>
<div class="col"><div class="stub"><div class="band"><i class="wax">m.</i><svg viewBox="0 0 800 120" preserveAspectRatio="none"><path d="${pts}"/></svg><i class="play"></i><b class="time">0:00</b></div>${s.caption ? `<div class="tear"><i class="perf"></i><i class="notch nl"></i><i class="notch nr"></i></div><p class="cap">${esc(ticketCaption(s.caption))}</p>` : ''}</div>
${isVideo && !hero ? `<div class="clipbox"><i class="bf" data-layout-allow-overflow style="background-image:url(${poster(clip.file)})"></i>${clipTag}</div>` : ''}
${hero ? '' : soundOn}</div>${hero ? soundOn : ''}
<audio id="${id}-voice" src="${voiceSrc}" data-start="${voiceStart}" data-duration="${dur.toFixed(3)}" data-hf-media-start-basis="local" data-track-index="11" data-volume="1"></audio>`,
    js: `
var B=${BEAT}, dur=${dur.toFixed(3)}, t0=${voiceStart};
var path=q('path')[0], L=path.getTotalLength ? path.getTotalLength() : 2400, time=q('.time')[0], o={t:0};
tl.fromTo(q('.kicker'),{opacity:0},{opacity:1,duration:.4},0);
tl.fromTo(q('.stub'),{y:120,opacity:0},{y:0,opacity:1,duration:.55,ease:'power3.out'},0);
tl.fromTo(path,{strokeDasharray:L,strokeDashoffset:L},{strokeDashoffset:0,duration:.8,ease:'power2.out'},.2);
tl.fromTo(q('.play'),{x:0},{x:800,duration:dur,ease:'none'},t0);
tl.fromTo(o,{t:0},{t:dur,duration:dur,ease:'none',onUpdate:function(){var s=Math.floor(o.t);time.textContent='0:'+(s<10?'0':'')+s;}},t0);
tl.fromTo(q('.wax'),{scale:1},{scale:1.06,duration:B*2,ease:'sine.inOut',yoyo:true,repeat:${Math.max(0, Math.floor((dur + 1) / (BEAT * 2)) - 1)}},t0);
${s.caption ? `tl.fromTo(q('.cap'),{opacity:0},{opacity:1,duration:.5},.5);` : ''}
tl.fromTo(q('.son'),{y:40,opacity:0},{y:0,opacity:1,duration:.45,ease:'power3.out'},.25);
tl.fromTo(q('.son .w1'),{opacity:.25},{opacity:1,duration:B/2,ease:'sine.inOut',yoyo:true,repeat:${Math.max(1, Math.floor(dur / BEAT))}},.4);
tl.fromTo(q('.son .w2'),{opacity:1},{opacity:.25,duration:B/2,ease:'sine.inOut',yoyo:true,repeat:${Math.max(1, Math.floor(dur / BEAT))}},.4);`,
  });
  return { beats: n, events: [{ t: 0, date: clip.date ?? null }], voice: { start: voiceStart, dur } };
}

/** One slot per first: the milestone's own memory as a card (owner, F3
 * round 3) — a clip plays in it — with the stamped label over its foot. 4
 * beats with a card, 3 without; each slot leaves upward for the next. */
function firsts(s, id) {
  const items = s.items.slice(0, 3);
  const slots = [];
  let t = 0;
  for (const item of items) {
    const card = item.frame?.file ? item.frame : null;
    const beatsHeld = card ? nb(4) : nb(3);
    const box = card ? fitCard(card, { cx: 513, top: 500, maxW: 560, maxH: 600 }) : null;
    slots.push({ item, card, box, t: +t.toFixed(4), d: +(beatsHeld * BEAT).toFixed(4) });
    t += beatsHeld * BEAT;
  }
  const n = Math.max(3, Math.round(t / BEAT));
  const slotHtml = slots.map((sl, i) => {
    const media = !sl.card ? '' : isClip(sl.card)
      ? `<video id="${id}-c${i}" class="clip" src="${asset(sl.card.file)}" data-start="${sl.t}" data-duration="${sl.d}" data-media-start="0" data-hf-media-start-basis="local" data-track-index="2" muted playsinline></video>`
      : `<i style="background-image:url(${still(sl.card)})"></i>`;
    return `<div class="slot s${i}">
  ${sl.card ? `<div class="card mc" style="${sl.box.style}">${media}</div>` : ''}
  <div class="first${sl.card ? ' under' : ''}"${sl.card ? ` style="top:${sl.box.top + sl.box.h - 70}px"` : ''}><b>${esc(sl.item.label)}</b><span>${sl.item.childName ? `${esc(sl.item.childName)} · ` : ''}${esc(fdate(sl.item.date))}</span></div>
</div>`;
  }).join('');
  subcomp(id, {
    bg: C.cream,
    css: `
.${id} .slot{position:absolute;inset:0;opacity:0}
.${id} .mc{}
.${id} .mc i,.${id} .mc video{display:block;width:100%;height:100%;border-radius:26px;object-fit:cover;background:center/cover no-repeat}
.${id} .first{position:absolute;left:96px;right:150px;top:700px;border:6px solid ${C.rose};border-radius:30px;padding:30px 36px;background:${C.cream}}
.${id} .first.under{top:1010px;box-shadow:0 14px 30px rgba(44,36,24,.14)}
.${id} .first b{display:block;font:500 90px/1.05 "Newsreader";letter-spacing:-.02em;color:${C.ink}}
.${id} .first span{display:block;margin-top:18px;font:500 36px/1.2 "Plus Jakarta Sans";color:${C.rose}}`,
    html: `<p class="kicker" style="top:${slots.some((x) => x.card) ? 400 : 560}px">${esc(s.kicker ?? '')}</p>${slotHtml}`,
    js: `
var B=${BEAT}, slots=${JSON.stringify(slots.map((x) => [x.t, x.d, !!x.card]))};
tl.fromTo(q('.kicker'),{opacity:0},{opacity:1,duration:.3},0);
slots.forEach(function(sl,i){
  var el=q('.s'+i)[0], card=el.querySelector('.mc'), stamp=el.querySelector('.first');
  tl.fromTo(el,{opacity:0,y:0},{opacity:1,duration:.12},sl[0]);
  if (card) tl.fromTo(card,{scale:.7,rotation:-2,y:80},{scale:1,rotation:4,y:0,duration:.5,ease:'back.out(1.7)'},sl[0]);
  tl.fromTo(stamp,{scale:1.5,rotation:-9,opacity:0},{scale:1,rotation:-3,opacity:1,duration:.3,ease:'back.out(2.2)'},sl[0]+(card?B:.15));
  if (i<slots.length-1) tl.to(el,{y:-260,opacity:0,duration:.28,ease:'power2.in'},sl[0]+sl[1]-.28);
});`,
  });
  return { beats: n, events: slots.map((sl) => ({ t: sl.t, date: sl.item.date })) };
}

function emotion(s, id) {
  const frames = s.frames.slice(0, 4);
  const n = Math.max(nb(4), nb(1 + frames.length));
  const spots = [[130, 520, -6], [560, 600, 5], [160, 980, 4], [560, 1020, -5]];
  subcomp(id, {
    bg: C.lav,
    css: `.${id} .slam{position:absolute;left:96px;right:150px;top:300px;font:500 110px/1 "Newsreader";letter-spacing:-.03em;color:${C.ink}}`,
    html: `<h2 class="slam">${esc(s.titles[0] ?? '')}</h2>${frames.map((f, i) => `<div class="card st" style="${fitCard(f, { cx: spots[i][0] + 195, cy: spots[i][1] + 215, maxW: 390, maxH: 430 }).style}"><img src="${still(f)}"></div>`).join('')}`,
    js: `
var B=${BEAT}, rot=${JSON.stringify(spots.map((x) => x[2]))};
tl.fromTo(q('.slam'),{scale:1.3,opacity:0},{scale:1,opacity:1,duration:.25,ease:'power4.out'},0);
q('.st').forEach(function(el,i){ tl.fromTo(el,{scale:0,rotation:0},{scale:1,rotation:rot[i],duration:.45,ease:'back.out(2)'},B+i*B*.5); });`,
  });
  return { beats: n, events: frames.map((f, i) => ({ t: BEAT + i * BEAT * 0.5, date: f.date ?? null })) };
}

function close(s, id) {
  const n = nb(8);
  const frames = s.frames.slice(0, 2);
  const r = rng(11);
  const colors = [C.rose, '#F2B544', '#5B8DEF', '#EE8A4B'];
  // Confetti bursts from behind the party photos as they land.
  const conf = Array.from({ length: 32 }, (_, i) => ({ x: 540 + (r() - 0.5) * 520, y: 960 + (r() - 0.5) * 260, dx: (r() - 0.5) * 1100, dy: -380 - r() * 520, rot: r() * 540, c: colors[i % 4] }));
  const land = 2 * BEAT + 0.22;
  subcomp(id, {
    bg: C.lav,
    css: `
.${id} .conf{position:absolute;width:22px;height:40px;border-radius:6px;opacity:0;z-index:1}
.${id} .party{z-index:2}
.${id} .sub{position:absolute;left:96px;top:1300px;font:500 34px "Plus Jakarta Sans";color:${C.ink2}}`,
    html: `<h1 class="title" style="top:310px;font-size:128px">${words(s.line)}</h1>
${conf.map((c) => `<i class="conf" style="left:${c.x.toFixed(0)}px;top:${c.y.toFixed(0)}px;background:${c.c}"></i>`).join('')}
${frames.map((f, i) => `<div class="card party" style="${fitCard(f, { cx: i ? 730 : 340, cy: 970, maxW: 420, maxH: 540, pad: 16 }).style}"><img src="${still(f)}"></div>`).join('')}
${s.celebrationDate ? `<p class="sub">${esc(fdate(s.celebrationDate))}</p>` : ''}`,
    js: `
var B=${BEAT}, land=${land.toFixed(3)}, conf=${JSON.stringify(conf.map((c) => [Math.round(c.dx), Math.round(c.dy), Math.round(c.rot), Math.round(H + 80 - c.y)]))};
tl.fromTo(q('.title .word'),{y:70,opacity:0},{y:0,opacity:1,duration:.5,ease:'power3.out',stagger:.08},0);
tl.fromTo(q('.party'),{scale:0,rotation:0},{scale:1,rotation:function(i){return i?6:-5;},duration:.55,ease:'back.out(1.8)',stagger:.12},B*2);
q('.conf').forEach(function(el,i){ var c=conf[i];
  tl.fromTo(el,{x:0,y:0,rotation:0,opacity:0},{x:c[0],y:c[1],rotation:c[2],opacity:1,duration:.55,ease:'power3.out',immediateRender:false},land);
  tl.set(el,{zIndex:3},land+.55);
  tl.to(el,{y:c[3],rotation:c[2]+360,duration:1.1,ease:'power1.in'},land+.55); });
${s.celebrationDate ? `tl.fromTo(q('.sub'),{opacity:0},{opacity:1,duration:.4},B*3);` : ''}`,
  });
  return { beats: n, events: [{ t: 0, date: film.span.to, label: '' }], seal: true };
}

function endCard(s, id) {
  const n = nb(6);
  const cells = mosaicTiles();
  // Inner tiles fall in first, so the wall collapses toward the mark.
  const maxD = Math.max(...cells.map((c) => c.d));
  const moves = cells.map((c) => [Math.round(-c.cx), Math.round(-c.cy), +(0.35 + (c.d / maxD) * 0.75).toFixed(3)]);
  subcomp(id, {
    bg: C.lav,
    css: `${mosaicCss(id)}
.${id} .mark{position:absolute;left:390px;top:760px;width:300px;height:300px;border-radius:50%;background:${C.rose};color:#fff;display:flex;align-items:center;justify-content:center;font:500 170px "Newsreader"}
.${id} .sig{position:absolute;left:0;right:0;top:1100px;text-align:center;font:500 40px "Plus Jakarta Sans";color:${C.ink2};letter-spacing:.04em}
/* The app's Wordmark (src/components/wordmark.tsx): Newsreader medium, tight
   tracking, the period in the primary color. */
.${id} .wm{font:500 72px/1 "Newsreader";letter-spacing:-.025em;color:${C.ink};margin-left:14px}
.${id} .wm i{font-style:normal;color:${C.rose}}`,
    html: `${mosaicHtml()}<div class="mark">m.</div><p class="sig">${film.language === 'es' ? 'hecho con' : 'made with'}<b class="wm">Momora<i>.</i></b></p>`,
    js: `
var B=${BEAT}, moves=${JSON.stringify(moves)}, tiles=q('.mosaic i');
tl.fromTo(q('.mwrap'),{scale:1.08},{scale:1,duration:.9,ease:'power2.out'},0);
moves.forEach(function(m,i){ tl.fromTo(tiles[i],{x:0,y:0,scale:1,opacity:1},{x:m[0],y:m[1],scale:.1,opacity:0,duration:.55,ease:'power3.in'},m[2]); });
tl.fromTo(q('.mark'),{scale:0},{scale:1,duration:.6,ease:'back.out(1.8)'},1.05);
tl.fromTo(q('.sig'),{opacity:0,y:20},{opacity:1,y:0,duration:.5},1.4);`,
  });
  return { beats: n, events: [], hideStrip: true };
}

/** Monthly opener: "Nuestro" over a large month name and the year, while
 * the month's cards pop into a loose collage below. */
function title(s, id) {
  const n = nb(8);
  const spots = [[110, 820, -7], [560, 780, 5], [330, 1010, 2], [96, 1170, 4], [580, 1150, -4]];
  const cards = (s.cards ?? []).filter((f) => f.file).slice(0, spots.length);
  // Newsreader averages ~0.5em per lowercase letter: "agosto" keeps 230px,
  // "septiembre" drops to ~165px so it fits the 834px safe width.
  const titleSize = Math.min(230, Math.floor(834 / (0.52 * Math.max(1, String(s.title).length))));
  subcomp(id, {
    bg: C.lav,
    css: `
.${id} .pre{position:absolute;left:96px;top:300px;font:italic 400 96px/1 "Newsreader";color:${C.ink2}}
.${id} .big{position:absolute;left:90px;right:150px;top:${400 + (230 - titleSize) * 0.6}px;font:500 ${titleSize}px/0.95 "Newsreader";letter-spacing:-.04em;color:${C.ink};white-space:nowrap}
.${id} .yr{position:absolute;left:100px;top:650px;font:700 44px "Plus Jakarta Sans";letter-spacing:.12em;color:${C.rose}}
.${id} .tc{}
.${id} .tc i{display:block;width:100%;height:100%;border-radius:26px;background:center/cover no-repeat}`,
    html: `${s.kicker ? `<p class="pre">${esc(s.kicker)}</p>` : ''}<h1 class="big">${esc(s.title)}</h1><p class="yr">${esc(s.subtitle ?? '')}</p>
${cards.map((f, i) => `<div class="card tc" style="${fitCard(f, { cx: spots[i][0] + 185, cy: spots[i][1] + 225, maxW: 370, maxH: 450 }).style}"><i style="background-image:url(${still(f)})"></i></div>`).join('')}`,
    js: `
var B=${BEAT}, rot=${JSON.stringify(spots.map((x) => x[2]))};
tl.fromTo(q('.pre'),{y:30,opacity:0},{y:0,opacity:1,duration:.45,ease:'power3.out'},0);
tl.fromTo(q('.big'),{y:90,opacity:0},{y:0,opacity:1,duration:.6,ease:'power3.out'},.2);
tl.fromTo(q('.yr'),{opacity:0},{opacity:1,duration:.4},.7);
q('.tc').forEach(function(el,i){
  tl.fromTo(el,{scale:0,rotation:0},{scale:1,rotation:rot[i],duration:.5,ease:'back.out(1.8)'},B*2+i*B*.5);
  tl.fromTo(el,{y:0},{y:-40-i*12,duration:${(n * BEAT).toFixed(3)}-B*2-i*B*.5,ease:'none'},B*2+i*B*.5);
});`,
  });
  return { beats: n, events: [{ t: 0, date: null }] };
}

/** One award per child (monthly): the intro line, the child's verified photo
 * or clip as a card, their name slams in, and a rose ribbon names the award
 * when the intro didn't already say it. */
function award(s, id) {
  const n = nb(6);
  const f = s.frame;
  const portrait = f?.kind === 'portrait';
  const media = !f?.file ? '' : isClip(f)
    ? `<video id="${id}-clip" class="clip" src="${asset(f.file)}" data-start="${(BEAT * 0.5).toFixed(4)}" data-duration="${(n * BEAT - BEAT * 0.5).toFixed(4)}" data-media-start="0" data-hf-media-start-basis="local" data-track-index="2" muted playsinline></video>`
    : `<i style="background-image:url(${still(f)})"></i>`;
  const ribbon = s.award && !String(s.intro ?? '').includes(s.award);
  // Shaped like the photo; the name and ribbon follow its foot, above the keep-out.
  const box = fitCard(f, { cx: 513, top: 470, maxW: 740, maxH: ribbon ? 640 : 760, pad: portrait ? 18 : 16 });
  subcomp(id, {
    bg: C.cream,
    css: `
.${id} .intro{position:absolute;left:96px;right:150px;top:300px;font:500 50px/1.2 "Plus Jakarta Sans";color:${C.ink2}}
.${id} .ac{}
.${id} .ac.round{border-radius:50%;padding:18px}
.${id} .ac i,.${id} .ac video{display:block;width:100%;height:100%;border-radius:28px;object-fit:cover;background:center/cover no-repeat}
.${id} .ac.round i{border-radius:50%}
.${id} .who{position:absolute;left:96px;right:150px;top:${box.top + box.h + 40}px;font:500 150px/1 "Newsreader";letter-spacing:-.03em;color:${C.ink}}
.${id} .rib{position:absolute;left:96px;top:${box.top + box.h + 215}px;padding:14px 28px;border-radius:999px;background:${C.rose};color:#fff;font:700 36px "Plus Jakarta Sans"}`,
    html: `<p class="intro">${esc(s.intro ?? '')}</p><div class="card ac${portrait ? ' round' : ''}" style="${box.style}">${media}</div><h2 class="who">${esc(s.childName)}</h2>${ribbon ? `<p class="rib">${esc(s.award)}</p>` : ''}`,
    js: `
var B=${BEAT};
tl.fromTo(q('.intro'),{y:30,opacity:0},{y:0,opacity:1,duration:.4,ease:'power3.out'},0);
tl.fromTo(q('.ac'),{scale:.6,rotation:-6,opacity:0},{scale:1,rotation:-2,opacity:1,duration:.55,ease:'back.out(1.7)'},B*.5);
tl.fromTo(q('.who'),{scale:1.4,opacity:0},{scale:1,opacity:1,duration:.3,ease:'power4.out'},B*2);
${ribbon ? `tl.fromTo(q('.rib'),{x:-40,opacity:0},{x:0,opacity:1,duration:.35,ease:'power3.out'},B*2.6);` : ''}`,
  });
  return { beats: n, events: [{ t: 0, date: portrait ? null : f?.date ?? null }] };
}

/** Year-end family film: one chapter per child, the same 10 beats for every
 * child whatever their data (plan §3, the sibling trap). Their name and
 * portrait (photo → drawing), up to three verified moments fanned as cards,
 * and their line of the year when there is one. */
const CHAPTER_BEATS = nb(10);
function chapter(s, id) {
  const n = CHAPTER_BEATS;
  const frames = (s.frames ?? []).filter((f) => f.file).slice(0, 3);
  const hasLine = !!s.line?.quote;
  const fan = [[250, hasLine ? 990 : 1050, -6], [540, hasLine ? 940 : 1000, 3], [830, hasLine ? 1000 : 1060, -3]];
  const cards = frames.map((f, k) => {
    const box = fitCard(f, { cx: fan[k][0] - (k === 2 ? 60 : 0), cy: fan[k][1], maxW: 360, maxH: hasLine ? 460 : 540, pad: 12 });
    return `<div class="card cm" style="${box.style}"><i style="background-image:url(${still(f)})"></i></div>`;
  }).join('');
  const lineWords = hasLine ? s.line.quote.split(/\s+/) : [];
  subcomp(id, {
    bg: C.cream,
    css: `
.${id} .nm{position:absolute;left:470px;right:150px;top:470px;font:500 150px/1 "Newsreader";letter-spacing:-.03em;color:${C.ink}}
.${id} .disc{position:absolute;left:96px;top:380px;width:330px;height:330px;border-radius:50%;overflow:hidden;box-shadow:0 12px 30px rgba(44,36,24,.2);background:#fff}
.${id} .disc img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.${id} .cm{border-radius:30px}
.${id} .cm i{display:block;width:100%;height:100%;border-radius:20px;background:center/cover no-repeat}
.${id} .ln{position:absolute;left:96px;right:150px;top:1270px;font:700 84px/1.05 "Caveat";color:${C.ink}}`,
    html: `${s.portrait?.file ? `<div class="disc"><img src="${asset(s.portrait.pairFile ?? s.portrait.file)}"><img class="drawn" src="${asset(s.portrait.file)}"></div>` : ''}
<h2 class="nm">${esc(s.name)}</h2>${cards}
${hasLine ? `<p class="ln">${lineWords.map((w, i) => `<span class="word">${esc(i === 0 ? `“${w}` : w)}${i === lineWords.length - 1 ? '”' : ''}</span>`).join(' ')}</p>` : ''}`,
    js: `
var B=${BEAT}, rot=${JSON.stringify(fan.map((f) => f[2]))};
${s.portrait?.file ? `tl.fromTo(q('.disc'),{scale:.5,opacity:0},{scale:1,opacity:1,duration:.5,ease:'back.out(1.8)'},0);
tl.fromTo(q('.drawn'),{clipPath:'inset(0 0 0 100%)'},{clipPath:'inset(0 0 0 0%)',duration:.6,ease:'power2.inOut'},B*1.2);` : ''}
tl.fromTo(q('.nm'),{x:-50,opacity:0},{x:0,opacity:1,duration:.45,ease:'power3.out'},.12);
q('.cm').forEach(function(c,j){ tl.fromTo(c,{y:140,scale:.7,rotation:0,opacity:0},{y:0,scale:1,rotation:rot[j],opacity:1,duration:.5,ease:'back.out(1.6)'},B*2+j*B*.6); });
${hasLine ? `tl.fromTo(q('.ln .word'),{y:30,opacity:0},{y:0,opacity:1,duration:.35,ease:'power3.out',stagger:${Math.min(0.12, 1.4 / lineWords.length).toFixed(3)}},B*5);` : ''}`,
  });
  const events = [{ t: 0, date: null }].concat(frames.map((f, j) => ({ t: BEAT * 2 + j * BEAT * 0.6, date: f.date ?? null })));
  return { beats: n, events };
}

// ── Assemble in film order ───────────────────────────────────────────────

let i = 0;
for (const s of film.scenes) {
  const id = `s${String(++i).padStart(2, '0')}`;
  let r = null;
  switch (s.type) {
    case 'cold_open': r = coldOpen(s, id); break;
    case 'counters': r = counters(s, id); break;
    case 'burst':
      r = s.role === 'emotion' || s.role === 'together' ? emotion(s, id)
        : burst(s, id, { accelerate: s.role === 'finale' });
      break;
    case 'line': r = line(s, id); break;
    case 'starring': r = starring(s, id); break;
    case 'sound': r = sound(s, id); break;
    case 'firsts': r = firsts(s, id); break;
    case 'close': r = close(s, id); break;
    case 'end_card': r = endCard(s, id); break;
    case 'title': r = title(s, id); break;
    case 'award': r = award(s, id); break;
    case 'chapter': r = chapter(s, id); break;
    default:
      console.warn(`scene ${s.type} not implemented yet — skipped`);
      i--;
      continue;
  }
  const dark = (s.type === 'burst' && s.role !== 'emotion' && s.role !== 'together') || s.type === 'sound';
  scenes.push({ id, type: s.type, role: s.role, dark, ...r });
}

let t = 0;
for (const sc of scenes) {
  sc.start = beats(t);
  sc.dur = beats(sc.beats);
  t += sc.beats;
}
const total = beats(t);
if (total > MAX_SECONDS) console.warn(`film is ${total.toFixed(1)}s — over the ${MAX_SECONDS}s cap`);
if (total > BED.length) console.warn(`film is ${total.toFixed(1)}s — longer than its bed "${BED.id}" (${BED.length}s)`);

// ── Year strip events (global time) ─────────────────────────────────────
const [ay, am, ad] = film.span.from.split('-').map(Number);
const [by, bm, bd] = film.span.to.split('-').map(Number);
const d0 = Date.UTC(ay, am - 1, ad);
const d1 = Date.UTC(by, bm - 1, bd);
const frac = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.max(0, Math.min(1, (Date.UTC(y, m - 1, d) - d0) / Math.max(1, d1 - d0)));
};
const stripEvents = [];
for (const sc of scenes) {
  for (const e of sc.events ?? []) stripEvents.push({ t: +(sc.start + e.t).toFixed(4), f: e.date ? +frac(e.date).toFixed(4) : null, label: e.label ?? (e.date ? fdate(e.date) : ''), dark: sc.dark });
  if (sc.hideStrip) stripEvents.push({ t: sc.start, hide: true });
}
const seal = scenes.find((s) => s.seal);

// ── Music: bed + carve under the voice + fade out ───────────────────────
const voiceScene = scenes.find((s) => s.voice);
const lane = [{ t: 0, v: 0.9 }];
if (voiceScene) {
  const vs = voiceScene.start + voiceScene.voice.start;
  const ve = vs + voiceScene.voice.dur;
  lane.push({ t: +(vs - 0.5).toFixed(3), v: 0.9 }, { t: +(vs).toFixed(3), v: 0.07 }, { t: +(ve).toFixed(3), v: 0.07 }, { t: +(ve + 0.6).toFixed(3), v: 0.9 });
}
lane.push({ t: +(total - 1.8).toFixed(3), v: 0.9 }, { t: +total.toFixed(3), v: 0 });

// ── index.html ───────────────────────────────────────────────────────────
const [fy, fm] = film.span.from.split('-').map(Number);
const [ty, tm] = film.span.to.split('-').map(Number);
// A year strip reads "oct 2025 — oct 2026"; a month's reads "1 ago — 31 ago".
const oneMonth = fy === ty && fm === tm;
const dayMonth = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${months[m - 1]}`; };
const stripEnds = oneMonth ? [dayMonth(film.span.from), dayMonth(film.span.to)] : [`${months[fm - 1]} ${fy}`, `${months[tm - 1]} ${ty}`];
const indexHtml = `<!doctype html>
<html lang="${film.language}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}">
<title>${esc(film.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${FONTS}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${C.plum}}
#film{position:relative;width:100%;height:100%;overflow:hidden}
#strip{position:absolute;left:96px;right:150px;top:190px;z-index:20;opacity:0;color:${C.ink};font-family:"Plus Jakarta Sans",sans-serif}
#strip .track{position:relative;height:4px;border-radius:9px;background:currentColor;opacity:.25}
#strip .ends{display:flex;justify-content:space-between;margin-top:14px;font:500 26px/1 "Plus Jakarta Sans"}
#strip,#strip-label{text-shadow:0 1px 8px var(--strip-shadow,rgba(0,0,0,0))}
#strip-dot{position:absolute;left:96px;top:179px;width:26px;height:26px;margin-left:-13px;border-radius:50%;background:${C.rose};z-index:21;opacity:0}
#strip-label{position:absolute;top:-44px;left:0;white-space:nowrap;font:700 24px "Plus Jakarta Sans";color:inherit}
#strip-seal{position:absolute;left:${W - 150 - 17}px;top:175px;width:34px;height:34px;border-radius:50%;background:${C.rose};box-shadow:0 0 0 6px ${C.lav};z-index:22;opacity:0}
</style>
</head>
<body>
<div id="film" data-composition-id="film" data-start="0" data-width="${W}" data-height="${H}" data-duration="${total.toFixed(3)}">
${scenes.map((sc, k) => `  <div id="${sc.id}" class="clip" data-composition-id="${sc.id}" data-composition-src="compositions/${sc.id}.html" data-start="${sc.start}" data-duration="${sc.dur}" data-track-index="1" data-width="${W}" data-height="${H}"></div>`).join('\n')}
  <div id="strip"><div class="track"></div><div class="ends"><span>${esc(stripEnds[0])}</span><span>${esc(stripEnds[1])}</span></div></div>
  <div id="strip-dot"><span id="strip-label" data-layout-allow-overflow></span></div>
  ${seal ? '<div id="strip-seal"></div>' : ''}
  <audio id="bed" src="${BED.file}" data-start="0" data-duration="${total.toFixed(3)}" data-track-index="10" data-volume="1" data-automation='${JSON.stringify({ version: 1, lanes: [{ target: 'volume', points: lane }] })}'></audio>
</div>
<script>
(function(){
  var tl = gsap.timeline({ paused: true });
  var ev = ${JSON.stringify(stripEvents)};
  var strip = document.getElementById('strip'), dot = document.getElementById('strip-dot'), label = document.getElementById('strip-label');
  var span = ${W - 96 - 150};
  tl.fromTo(strip, { opacity: 0 }, { opacity: 1, duration: .6 }, .2);
  ev.forEach(function(e){
    if (e.hide) { tl.set([strip, dot], { opacity: 0 }, e.t); ${seal ? "tl.set('#strip-seal', { opacity: 0 }, e.t);" : ''} return; }
    tl.set(strip, { color: e.dark ? '${C.cream}' : '${C.ink}', opacity: 1 }, e.t);
    tl.set(strip.parentNode, { '--strip-shadow': e.dark ? 'rgba(20,14,24,.65)' : 'rgba(0,0,0,0)' }, e.t);
    tl.set(label, { color: e.dark ? '${C.cream}' : '${C.ink}' }, e.t);
    if (e.f === null) { tl.set(dot, { opacity: 0 }, e.t); return; }
    tl.set(dot, { opacity: 1 }, e.t);
    tl.to(dot, { x: e.f * span, duration: .18, ease: 'power2.out' }, e.t);
    tl.set(label, { textContent: e.label, xPercent: -e.f * 100, x: 13 - e.f * 26 }, e.t);
  });
  ${seal ? `tl.fromTo('#strip-seal', { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: .45, ease: 'back.out(2.2)' }, ${(seal.start + 2 * BEAT).toFixed(3)});` : ''}
  window.__timelines["film"] = tl;
})();
</script>
</body>
</html>
`;

fs.rmSync(path.join(PROJECT, 'compositions'), { recursive: true, force: true });
fs.mkdirSync(path.join(PROJECT, 'compositions'), { recursive: true });
for (const f of files) fs.writeFileSync(path.join(PROJECT, 'compositions', `${f.id}.html`), f.text);
fs.writeFileSync(path.join(PROJECT, 'index.html'), indexHtml);

console.log(`${slug}: ${scenes.length} scenes, ${total.toFixed(2)}s (${t} beats) · bed ${BED.id} (${BED.bpm} BPM)`);
for (const sc of scenes) console.log(`  ${sc.id} ${sc.type}${sc.role ? `/${sc.role}` : ''}  ${sc.start.toFixed(2)}–${(sc.start + sc.dur).toFixed(2)}s  (${sc.beats} beats)`);
