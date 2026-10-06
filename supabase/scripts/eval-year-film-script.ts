/**
 * Year Film F1 -- FilmScript + HTML storyboard eval (docs/plans/year-film.md
 * §10 F1). Builds FilmScripts from real data with the production modules
 * (`_shared/year-film-script.ts`, `-quotes.ts`, `-vision.ts`, `-i18n.ts`),
 * then writes a storyboard per film for owner review: every scene in order
 * (focus beats and bursts), its frames and *why* each was picked, the vision
 * verdicts behind every claim about a child, the quote candidates, the sound
 * (playable), and the scenes that were dropped and why.
 *
 * READ-ONLY against the database (RLS-scoped client, see
 * year-film-eval-data.ts). Calls OpenAI per film: one quote pick (skip with
 * --no-llm) and 1–2 frame-check calls (skip with --no-vision).
 *
 * PII: storyboards contain memory text, thumbnails and clips -- they are
 * written only under the gitignored supabase/scripts/eval-output/ (own
 * account, owner review). stdout stays counts-only.
 *
 * Examples:
 *   npm run eval:year-film-script -- --children Tomás,Lucía --film birthday:Tomás:4 --film month:2026-08
 *   npm run eval:year-film-script -- --children Tomás,Lucía --film birthday:Tomás:3 --subsample 60 --seed 1
 *   npm run eval:year-film-script -- --children Tomás,Lucía --film holiday:2026 [--today 2026-11-10] [--subsample 30 --seed 1] [--greeting christmas|holidays|new-year]
 *
 * `holiday:YYYY` is the Holiday Card film (docs/plans/holiday-cards.md §6 C2):
 * Jan 1 → `--today` inclusive, share-safe pool only, floors 20 moments / 12
 * visuals (no film, and no model calls, below them). Its film-script.json is
 * what `npm run eval:holiday-card-letters -- --script <path>` writes letters from.
 * Extra flags for it:
 *   --confirm-milestones <memoryId:milestoneId,...>  treat those candidate
 *     milestones as confirmed for the run (previews the firsts scene; the
 *     storyboard lists every unconfirmed candidate with ids to copy from)
 *   --preferred-close <mediaId,...>  the card front's top picks (media ids or
 *     object keys): the close uses them first when they qualify
 *   --greeting christmas|holidays|new-year  the end card's greeting (default holidays)
 */
import { getObjectBytesBatch } from '../functions/_shared/r2.ts';
import { resolvePortraitVersionAtDate } from '../functions/_shared/portrait-versions.ts';
import {
  birthdayFilmScope,
  birthdayPool,
  chapterChildren,
  evaluateHolidayFilm,
  familyPool,
  familyYearScope,
  HOLIDAY_MIN_POOL,
  HOLIDAY_MIN_VISUALS,
  holidayFilmScope,
  holidayPool,
  isFilmChild,
  monthScope,
} from '../functions/_shared/year-film-eligibility.ts';
import { detectJournalLanguage, type FilmLanguage, resolveFilmLanguage } from '../functions/_shared/year-film-i18n.ts';
import {
  buildQuotePrompt,
  buildQuoteRequestBody,
  parseQuoteResponse,
  HOLIDAY_QUOTE_MODEL,
  QUOTE_MODEL,
  type QuoteRejection,
  type QuoteSubject,
  selectQuotePool,
} from '../functions/_shared/year-film-quotes.ts';
import {
  type BirthdayInput,
  birthdayVisionCandidates,
  buildBirthdayScript,
  buildFamilyYearScript,
  buildHolidayScript,
  buildMonthlyScript,
  checkKey,
  type FilmMemorySource,
  type FilmPerson,
  type FilmScene,
  type FilmScript,
  type FrameChecks,
  type FrameRef,
  type FamilyYearInput,
  familyYearVisionCandidates,
  type HolidayInput,
  holidayVisionCandidates,
  DEFAULT_HOLIDAY_GREETING,
  HOLIDAY_GREETINGS,
  type HolidayGreeting,
  type MonthlyInput,
  monthlyVisionCandidates,
  shareSensitiveIds,
  type UnconfirmedFirst,
  unconfirmedFirsts,
  type VerifiedQuote,
} from '../functions/_shared/year-film-script.ts';
import {
  buildFrameCheckRequestBody,
  CLAIM_CHECK_MODEL,
  HOLIDAY_CLAIM_CHECK_MODEL,
  FRAME_CHECK_BATCH,
  parseFrameCheckResponse,
  type VisionImage,
} from '../functions/_shared/year-film-vision.ts';
import { createAuthedClient, type EvalFamilyData, firstName, loadFamilies, loadFamilyData, pickChildren } from './year-film-eval-data.ts';
import { formatUsage, recordUsage, resetUsage, usageSummary } from './year-film-eval-usage.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

type FilmRequest =
  | { kind: 'birthday'; childName: string; ageYear: number }
  | { kind: 'month'; yearMonth: string }
  | { kind: 'family'; year: number }
  | { kind: 'holiday'; year: number };

interface Options {
  children: string[] | null;
  films: FilmRequest[];
  subsample: number[];
  seed: number;
  llm: boolean;
  vision: boolean;
  model: string;
  visionModel: string;
  /** --model / --vision-model passed: they win over the holiday film's own models. */
  modelExplicit: boolean;
  visionModelExplicit: boolean;
  today: string;
  /** Holiday film: candidate milestones to treat as confirmed. */
  confirm: { memoryId: string; milestoneId: string }[];
  preferredClose: string[];
  /** Holiday film: the end card's greeting. */
  greeting: HolidayGreeting;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    children: null,
    films: [],
    subsample: [],
    seed: 1,
    llm: true,
    vision: true,
    model: QUOTE_MODEL,
    visionModel: CLAIM_CHECK_MODEL,
    modelExplicit: false,
    visionModelExplicit: false,
    today: new Date().toISOString().slice(0, 10),
    confirm: [],
    preferredClose: [],
    greeting: DEFAULT_HOLIDAY_GREETING,
  };
  for (let i = 0; i < args.length; i += 1) {
    const next = args[i + 1];
    switch (args[i]) {
      case '--children':
        options.children = (next ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
        i += 1;
        break;
      case '--film': {
        const parts = (next ?? '').split(':');
        if (parts[0] === 'birthday' && parts[1] && Number(parts[2]) > 0) {
          options.films.push({ kind: 'birthday', childName: parts[1].toLowerCase(), ageYear: Number(parts[2]) });
        } else if (parts[0] === 'month' && /^\d{4}-\d{2}$/.test(parts[1] ?? '')) {
          options.films.push({ kind: 'month', yearMonth: parts[1] });
        } else if (parts[0] === 'family' && /^\d{4}$/.test(parts[1] ?? '')) {
          options.films.push({ kind: 'family', year: Number(parts[1]) });
        } else if (parts[0] === 'holiday' && /^\d{4}$/.test(parts[1] ?? '')) {
          options.films.push({ kind: 'holiday', year: Number(parts[1]) });
        } else {
          throw new Error(`Bad --film "${next}". Use birthday:<Name>:<ageYear>, month:YYYY-MM, family:YYYY or holiday:YYYY`);
        }
        i += 1;
        break;
      }
      case '--subsample':
        options.subsample = (next ?? '').split(',').map(Number).filter((n) => n > 0);
        i += 1;
        break;
      case '--seed':
        options.seed = Number(next) || 1;
        i += 1;
        break;
      case '--no-llm':
        options.llm = false;
        options.vision = false;
        break;
      case '--no-vision':
        options.vision = false;
        break;
      case '--model':
        options.modelExplicit = true;
        options.model = next ?? options.model;
        i += 1;
        break;
      case '--vision-model':
        options.visionModelExplicit = true;
        options.visionModel = next ?? options.visionModel;
        i += 1;
        break;
      case '--today':
        options.today = next ?? options.today;
        i += 1;
        break;
      case '--confirm-milestones':
        options.confirm = (next ?? '').split(',').flatMap((pair) => {
          const [memoryId, milestoneId] = pair.trim().split(':');
          return memoryId && milestoneId ? [{ memoryId, milestoneId }] : [];
        });
        i += 1;
        break;
      case '--greeting':
        if (!(HOLIDAY_GREETINGS as readonly string[]).includes(next ?? '')) {
          throw new Error(`Bad --greeting "${next}". Use ${HOLIDAY_GREETINGS.join(' | ')}`);
        }
        options.greeting = next as HolidayGreeting;
        i += 1;
        break;
      case '--preferred-close':
        options.preferredClose = (next ?? '').split(',').map((v) => v.trim()).filter(Boolean);
        i += 1;
        break;
    }
  }
  if (options.films.length === 0) throw new Error('Pass at least one --film');
  return options;
}

// ── Subsampling (plan §10 F1: find where a year starts to feel "meh") ─────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Keeps a random `n` of the child's pool memories; everything else stays. */
function subsamplePool(memories: FilmMemorySource[], poolIds: Set<string>, n: number, seed: number): FilmMemorySource[] {
  const random = mulberry32(seed);
  const ids = [...poolIds].sort();
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const keep = new Set(ids.slice(0, n));
  return memories.filter((m) => !poolIds.has(m.id) || keep.has(m.id));
}

// ── OpenAI ───────────────────────────────────────────────────────────────

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
  recordUsage(String(body.model), payload.usage);
  return payload.choices?.[0]?.message?.content ?? null;
}

interface QuoteResult {
  accepted: VerifiedQuote[];
  rejected: QuoteRejection[];
  language: string | null;
  sent: number;
  skipped: string | null;
}

async function pickQuotes(pool: FilmMemorySource[], subjects: QuoteSubject[], options: Options): Promise<QuoteResult> {
  const candidates = selectQuotePool(pool, subjects);
  const none = { accepted: [], rejected: [], language: null, sent: 0 };
  if (!options.llm) return { ...none, skipped: '--no-llm' };
  if (candidates.length === 0) return { ...none, skipped: 'no memories with text' };
  const { system, user } = buildQuotePrompt(subjects, candidates);
  const content = await chat(buildQuoteRequestBody(system, user, options.model));
  if (content === null) return { ...none, sent: candidates.length, skipped: 'OpenAI call failed or no API key' };
  const parsed = parseQuoteResponse(content, subjects, new Map(candidates.map((m) => [m.id, m.text])));
  return { ...parsed, sent: candidates.length, skipped: null };
}

// ── Images for the vision check (downscaled with ffmpeg) ─────────────────

async function toVisionImage(bytes: Uint8Array): Promise<VisionImage | null> {
  const dir = await Deno.makeTempDir();
  const input = `${dir}/in`;
  const output = `${dir}/out.jpg`;
  await Deno.writeFile(input, bytes);
  const { code } = await new Deno.Command('ffmpeg', {
    args: ['-v', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', "scale='min(512,iw)':-2", '-q:v', '5', output],
  }).output();
  const out = code === 0 ? await Deno.readFile(output) : null;
  await Deno.remove(dir, { recursive: true });
  if (!out) return null;
  let binary = '';
  for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return { base64: btoa(binary), contentType: 'image/jpeg' };
}

async function fetchVisionImages(keys: string[]): Promise<Map<string, VisionImage>> {
  const out = new Map<string, VisionImage>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 12) {
    const batch = await getObjectBytesBatch(unique.slice(i, i + 12));
    for (const [key, entry] of batch) {
      if (!entry.ok || !entry.bytes) continue;
      const image = await toVisionImage(entry.bytes);
      if (image) out.set(key, image);
    }
  }
  return out;
}

interface VisionResult {
  /** The model that made these verdicts. */
  model: string;
  checks: FrameChecks | undefined;
  checked: number;
  sent: number;
  skipped: string | null;
}

async function checkFrames(
  candidates: FrameRef[],
  kids: FilmPerson[],
  referenceDate: string,
  options: Options,
  /** The holiday card film: the strict public-audience prompt. */
  publicAudience = false,
): Promise<VisionResult> {
  if (!options.vision) return { model: options.visionModel, checks: undefined, checked: 0, sent: 0, skipped: '--no-vision' };
  if (candidates.length === 0) return { model: options.visionModel, checks: new Map(), checked: 0, sent: 0, skipped: null };
  const refKeys = kids.flatMap((k) => {
    const version = resolvePortraitVersionAtDate(k.portraits, referenceDate);
    return version ? [{ kid: k, key: version.profile_picture_key }] : [];
  });
  const images = await fetchVisionImages([...refKeys.map((r) => r.key), ...candidates.map(checkKey)]);
  const references = refKeys.flatMap((r) => {
    const image = images.get(r.key);
    return image ? [{ ...image, name: firstName(r.kid.name) }] : [];
  });
  if (references.length === 0) return { model: options.visionModel, checks: undefined, checked: 0, sent: 0, skipped: 'no reference photos' };
  const names = references.map((r) => r.name);
  const idByName = new Map(kids.map((k) => [firstName(k.name).toLowerCase(), k.id]));
  const checks: FrameChecks = new Map();
  const sendable = candidates.filter((f) => images.has(checkKey(f)));
  for (let i = 0; i < sendable.length; i += FRAME_CHECK_BATCH) {
    const batch = sendable.slice(i, i + FRAME_CHECK_BATCH);
    const content = await chat(
      buildFrameCheckRequestBody(names, references, batch.map((f) => images.get(checkKey(f))!), options.visionModel, { publicAudience }),
    );
    if (content === null) continue;
    for (const [index, check] of parseFrameCheckResponse(content, batch.length, idByName, { publicAudience })) {
      checks.set(checkKey(batch[index]), check);
    }
  }
  return { model: options.visionModel, checks, checked: checks.size, sent: sendable.length, skipped: null };
}

// ── Asset download for the storyboard ────────────────────────────────────

function allFrames(script: FilmScript): FrameRef[] {
  const out: FrameRef[] = [];
  for (const scene of script.scenes) {
    switch (scene.type) {
      case 'cold_open':
        if (scene.from) out.push(scene.from);
        out.push(scene.to);
        break;
      case 'title':
        out.push(...scene.cards);
        break;
      case 'burst':
        out.push(...scene.frames);
        break;
      case 'sound':
        out.push(scene.frame, ...scene.alternates);
        break;
      case 'line':
        if (scene.frame) out.push(scene.frame);
        break;
      case 'starring':
        out.push(...scene.people.map((p) => p.portrait));
        break;
      case 'award':
        out.push(scene.frame);
        break;
      case 'chapter':
        if (scene.portrait) out.push(scene.portrait);
        out.push(...scene.frames);
        break;
      case 'firsts':
        out.push(...scene.items.flatMap((i) => (i.frame ? [i.frame] : [])));
        break;
      case 'close':
        out.push(...scene.frames);
        break;
      case 'end_card':
        out.push(...scene.grid);
        break;
    }
  }
  return out;
}

const BROWSER_IMAGE = /\.(jpe?g|png|webp|gif)$/i;

/** The key to show as a still: previews/posters first; originals only when
 * the browser can display them (HEIC can't). */
function thumbKey(frame: FrameRef): string | null {
  if (frame.previewKey) return frame.previewKey;
  if ((frame.kind === 'photo' || frame.kind === 'illustration' || frame.kind === 'portrait') && BROWSER_IMAGE.test(frame.key)) {
    return frame.key;
  }
  return null;
}

function localName(key: string): string {
  const ext = key.match(/\.[a-z0-9]+$/i)?.[0] ?? '';
  return `${key.replace(/[^a-z0-9]+/gi, '_').slice(-80)}${ext}`;
}

async function downloadAssets(keys: string[], dir: URL): Promise<Map<string, string>> {
  await Deno.mkdir(dir, { recursive: true });
  const local = new Map<string, string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 12) {
    const batch = await getObjectBytesBatch(unique.slice(i, i + 12));
    for (const [key, entry] of batch) {
      if (!entry.ok || !entry.bytes) continue;
      const name = localName(key);
      await Deno.writeFile(new URL(name, dir), entry.bytes);
      local.set(key, `assets/${name}`);
    }
  }
  return local;
}

// ── Storyboard HTML ──────────────────────────────────────────────────────

function esc(text: string | null | undefined): string {
  return (text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

interface Ctx {
  local: Map<string, string>;
  textById: Map<string, string | null>;
}

function img(src: string | undefined, kind: string): string {
  return src ? `<img src="${src}" loading="lazy">` : `<div class="ph">${esc(kind)}<br>no preview</div>`;
}

function badge(frame: FrameRef): string {
  if (frame.kind === 'video') return `<span class="badge">▶ ${frame.durationMs ? `${Math.round(frame.durationMs / 1000)}s` : 'video'}</span>`;
  if (frame.kind === 'illustration') return '<span class="badge ill">drawing</span>';
  return '';
}

function figure(frame: FrameRef, ctx: Ctx): string {
  const thumb = thumbKey(frame);
  const text = frame.memoryId ? ctx.textById.get(frame.memoryId) : null;
  return `<figure>
    <div class="img">${img(thumb ? ctx.local.get(thumb) : undefined, frame.kind)}${badge(frame)}</div>
    <figcaption><b>${esc(frame.date ?? '')}</b> · ${esc(frame.kind)}${frame.emotion ? ` · ${esc(frame.emotion)}` : ''}
    <div class="why">${esc(frame.why)}</div>${text ? `<div class="txt">${esc(text.slice(0, 140))}${text.length > 140 ? '…' : ''}</div>` : ''}</figcaption>
  </figure>`;
}

/** Portrait as a photo → illustration pair (the transform the motion will do). */
function pair(frame: FrameRef, label: string, ctx: Ctx): string {
  const photo = frame.pairKey ? ctx.local.get(frame.pairKey) : undefined;
  return `<div class="pair"><div class="img">${img(photo, 'photo')}</div><span class="arrow">→</span><div class="img">${
    img(ctx.local.get(frame.key), 'illustration')
  }</div><p class="note">${esc(label)} · ${esc(frame.date ?? 'undated')}</p></div>`;
}

function tiles(frames: FrameRef[], ctx: Ctx): string {
  return `<div class="tiles">${
    frames.map((f) => {
      const thumb = thumbKey(f);
      return `<div class="tile" title="${esc(`${f.date} · ${f.kind} · ${f.why}`)}">${img(thumb ? ctx.local.get(thumb) : undefined, f.kind)}${badge(f)}</div>`;
    }).join('')
  }</div>`;
}

function sceneBody(scene: FilmScene, ctx: Ctx): string {
  const grid = (frames: FrameRef[]) => `<div class="grid">${frames.map((f) => figure(f, ctx)).join('')}</div>`;
  switch (scene.type) {
    case 'cold_open':
      return `<p class="big">${esc(scene.title)}</p><div class="pairs">${scene.from ? pair(scene.from, 'start of the year', ctx) : ''}${
        pair(scene.to, 'at the birthday', ctx)
      }</div>${scene.from ? '' : '<p class="note">One portrait version → single photo → illustration transform.</p>'}`;
    case 'title':
      return `<p class="huge">${esc(scene.title)}</p><p>${esc(scene.subtitle)}</p>${tiles(scene.cards, ctx)}`;
    case 'counters':
      return `<div class="counters">${scene.counts.map((c) => `<div><span>${c.value}</span>${esc(c.label)}</div>`).join('')}</div>`;
    case 'burst': {
      const mix = { photo: 0, video: 0, illustration: 0 } as Record<string, number>;
      for (const f of scene.frames) mix[f.kind] = (mix[f.kind] ?? 0) + 1;
      return `${scene.titles.length ? `<p class="big">${scene.titles.map(esc).join(' / ')}</p>` : ''}<p class="note">${scene.frames.length} frames · ${
        mix.photo
      } photos · ${mix.video} clips · ${mix.illustration} drawings · ${scene.secondsPerFrame}s each (clips ~2×)</p>${tiles(scene.frames, ctx)}`;
    }
    case 'sound': {
      const src = ctx.local.get(scene.frame.key);
      const player = !src
        ? '<p class="note">Clip not downloaded.</p>'
        : scene.source === 'audio'
        ? `<audio controls src="${src}"></audio>`
        : `<video controls playsinline src="${src}" class="clip"></video>`;
      return `<p>Source: <b>${scene.source === 'audio' ? 'audio memory' : 'video clip (voice fallback)'}</b>${
        scene.needsVoiceCheck ? ' <span class="warn">needs F2 voice check</span>' : ''
      }</p>${player}${scene.caption ? `<p class="caption">“${esc(scene.caption)}”</p>` : ''}${grid([scene.frame])}${
        scene.alternates.length ? `<h4>Alternates</h4>${grid(scene.alternates)}` : ''
      }`;
    }
    case 'line':
      return `<p class="quote">“${esc(scene.quote)}”</p><p>— ${esc(scene.speakerName)}</p>${
        scene.alternates.length ? `<p class="note">Other verified candidates: ${scene.alternates.map((q) => `“${esc(q)}”`).join(' · ')}</p>` : ''
      }${scene.frame ? grid([scene.frame]) : ''}`;
    case 'starring':
      return `<div class="pairs">${scene.people.map((p) => pair(p.portrait, p.name, ctx)).join('')}</div>`;
    case 'chapter':
      return `<p class="big">${esc(scene.name)}</p><div class="pairs">${scene.portrait ? pair(scene.portrait, 'portrait', ctx) : '<p class="warn">no portrait</p>'}</div>${
        scene.frames.length ? grid(scene.frames) : '<p class="warn">no verified frames</p>'
      }${scene.line ? `<p class="quote">“${esc(scene.line.quote)}”</p>` : '<p class="note">no line of the year for this child</p>'}<p class="note">Equal length for every child (10 beats).</p>`;
    case 'firsts':
      return `<ul>${
        scene.items.map((f) =>
          `<li><b>${esc(f.label)}</b>${f.childName ? ` · ${esc(f.childName)}` : ''} — ${esc(f.date)}<div class="note">“${esc((ctx.textById.get(f.memoryId) ?? '').slice(0, 160))}”</div></li>`
        ).join('')
      }</ul>`;
    case 'award':
      return `<p class="intro">${esc(scene.intro)}</p><p class="big">${esc(scene.childName)}</p><p class="note">award: ${
        esc(scene.award)
      } · evidence: <b>${esc(scene.evidence)}</b></p>${
        scene.frame.kind === 'portrait' ? `<div class="pairs">${pair(scene.frame, 'portrait', ctx)}</div>` : grid([scene.frame])
      }`;
    case 'close':
      return `<p class="big">${esc(scene.line)}</p><p class="note">source: <b>${esc(scene.source)}</b>${
        scene.celebrationDate ? ` · birthday ${esc(scene.celebrationDate)}` : ''
      }</p>${
        scene.source === 'portraits' ? `<div class="pairs">${scene.frames.map((f) => pair(f, 'portrait', ctx)).join('')}</div>` : grid(scene.frames)
      }`;
    case 'end_card':
      return `${scene.greeting ? `<p class="big">${esc(scene.greeting)}</p><p>${esc(scene.from ?? '')}</p>` : ''}${tiles(scene.grid, ctx)}<p class="note">+ “made with Momora” m. mark</p>`;
  }
}

function unconfirmedSection(list: UnconfirmedFirst[], ctx: Ctx): string {
  const rows = list.map((f) => {
    const text = ctx.textById.get(f.memoryId) ?? '';
    return `<tr><td>${esc(f.childName ?? '—')}</td><td><b>${esc(f.label)}</b></td><td>${esc(f.date)}</td><td>${f.gatePasses ? '<span class="warn">gate passes</span>' : 'no'}<div class="note">${
      esc(f.reason)
    }</div></td><td class="txt">${esc(text.slice(0, 160))}${text.length > 160 ? '…' : ''}</td><td><code>${esc(f.memoryId)}:${esc(f.milestoneId)}</code></td></tr>`;
  }).join('');
  return `<section><h2>Unconfirmed milestones this year (${list.length})</h2>
<p class="note">Candidates the film does NOT show: a first appears only when it is confirmed, or the memory's own words say it is a first inside the age band. Tell us which are true, or re-run with <code>--confirm-milestones memoryId:milestoneId,…</code> to preview the scene.</p>${
    list.length
      ? `<table><thead><tr><th>Child</th><th>Milestone</th><th>Date</th><th>Text gate</th><th>The memory says</th><th>Confirm with</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="note">None.</p>'
  }</section>`;
}

function renderStoryboard(script: FilmScript, label: string, quotes: QuoteResult, vision: VisionResult, ctx: Ctx, unconfirmed?: UnconfirmedFirst[]): string {
  const rejectionCounts = quotes.rejected.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + 1;
    return acc;
  }, {});
  const kinds = new Set(['burst', 'end_card', 'title']);
  const scenes = script.scenes
    .map((scene, i) =>
      `<section class="${kinds.has(scene.type) ? 'fast' : 'focus'}"><h2><span>${i + 1}</span> ${esc(scene.type.replace('_', ' '))}${
        scene.type === 'burst' ? ` · ${esc(scene.role.replace('_', ' '))}` : ''
      } <em>${kinds.has(scene.type) ? 'burst' : 'focus'}</em></h2>${sceneBody(scene, ctx)}</section>`
    )
    .join('');
  const m = script.stats.mix;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${
    esc(script.title)
  } — storyboard</title>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Newsreader:opsz,wght@6..72,500&family=Plus+Jakarta+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#f6f3fb;color:#2a2438;margin:0;padding:24px;max-width:1100px;margin:auto}
h1{font-family:Newsreader,serif;font-size:40px;margin:0}
.meta{color:#6b6280;margin:6px 0 24px}
section{background:#fff;border-radius:16px;padding:18px 20px;margin:0 0 16px;box-shadow:0 1px 3px #0001}
section.fast{background:#2a2438;color:#f6f3fb}
section.fast .note{color:#c9c0dd}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#7a6aa8;margin:0 0 12px}
section.fast h2{color:#c9b8f5}
h2 span{display:inline-block;background:#ece6f7;color:#2a2438;border-radius:8px;padding:2px 8px;margin-right:6px}
h2 em{font-style:normal;float:right;font-size:11px;opacity:.7}
.big{font-family:Newsreader,serif;font-size:28px;margin:4px 0 10px}
.huge{font-family:Newsreader,serif;font-size:64px;margin:0;text-transform:uppercase}
.quote{font-family:Caveat,cursive;font-size:44px;margin:0}
.intro{font-size:18px;color:#6b6280;margin:0}
.caption{font-style:italic}
.note{color:#6b6280;font-size:13px}
.warn{background:#fff1d6;color:#8a5a00;border-radius:6px;padding:2px 6px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
figure{margin:0}
.img{position:relative;aspect-ratio:3/4;background:#eee;border-radius:10px;overflow:hidden}
.img img{width:100%;height:100%;object-fit:cover}
.ph{display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:12px;text-align:center}
.badge{position:absolute;top:4px;left:4px;background:#000a;color:#fff;border-radius:6px;padding:1px 5px;font-size:10px}
.badge.ill{background:#7a6aa8cc}
figcaption{font-size:11px;color:#6b6280;margin-top:4px}
.why{color:#9a90b0}
.txt{color:#2a2438;margin-top:2px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:4px}
.tile{position:relative;aspect-ratio:9/16;border-radius:6px;overflow:hidden;background:#443a5c}
.tile img{width:100%;height:100%;object-fit:cover}
.pairs{display:flex;flex-wrap:wrap;gap:18px}
.pair{display:grid;grid-template-columns:110px 24px 110px;align-items:center}
.pair .img{aspect-ratio:1}
.pair .arrow{text-align:center;color:#7a6aa8;font-size:20px}
.pair .note{grid-column:1/4;margin:4px 0 0}
.counters{display:flex;gap:28px;flex-wrap:wrap}
.counters div{font-size:13px;color:#6b6280}
.counters span{display:block;font-family:Newsreader,serif;font-size:40px;color:#2a2438}
.clip{max-height:420px;border-radius:10px}
table{border-collapse:collapse;font-size:12px;width:100%}th,td{border-top:1px solid #eee;padding:6px 8px;text-align:left;vertical-align:top}code{font-size:11px;word-break:break-all}
audio{width:100%}
</style></head><body>
<h1>${esc(script.title)}</h1>
<p class="meta">${esc(label)} · ${esc(script.scope.start)} → ${esc(script.scope.endExclusive)} (exclusive) · language <b>${script.language}</b> ·
pool ${script.stats.pool} memories · ${script.stats.videoClips} video clips · ${script.stats.sounds} sounds ·
<b>${script.stats.frames} burst frames</b> (${m.photo} photos · ${m.video} clips · ${m.illustration} drawings) ·
claims verified by <b>${script.verification}</b> · ~${script.estimatedSeconds}s · ${script.scenes.length} scenes</p>
${scenes}
<section><h2>Dropped</h2>${
    script.dropped.length ? `<ul>${script.dropped.map((d) => `<li><b>${esc(d.scene)}</b>: ${esc(d.reason)}</li>`).join('')}</ul>` : '<p class="note">None.</p>'
  }</section>
${unconfirmed ? unconfirmedSection(unconfirmed, ctx) : ''}
<section><h2>Quote pick & vision</h2><p class="note">Quotes: ${
    quotes.skipped
      ? `skipped (${esc(quotes.skipped)})`
      : `sent ${quotes.sent} memories · accepted ${quotes.accepted.length} · rejected ${quotes.rejected.length} ${JSON.stringify(rejectionCounts)} · model language ${
        esc(quotes.language ?? '—')
      }`
  }</p>${quotes.rejected.length ? `<ul>${quotes.rejected.map((r) => `<li>${esc(r.reason)}: “${esc(r.quote)}”</li>`).join('')}</ul>` : ''}
<p class="note">Vision: ${vision.skipped ? `skipped (${esc(vision.skipped)})` : `${vision.checked}/${vision.sent} candidate frames checked`}</p></section>
</body></html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────

const options = parseArgs(Deno.args);
const supabase = await createAuthedClient();
const families = await loadFamilies(supabase);
if (families.length !== 1) throw new Error(`Expected one family, found ${families.length}`);
const data: EvalFamilyData = await loadFamilyData(supabase, families[0]);
const children: FilmPerson[] = pickChildren(
  data.members,
  options.children,
  (m) => isFilmChild({ id: m.id, dateOfBirth: m.dateOfBirth, relationship: m.relationship }, options.today),
);
const textById = new Map(data.memories.map((m) => [m.id, m.text]));
// Share-sensitive memories never reach the quote picker (plan §3).
const sensitive = shareSensitiveIds(data.memories, data.milestones);
// The holiday card film is public: a stricter text/topic screen (the vision check is the real guard).
const publicSensitive = shareSensitiveIds(data.memories, data.milestones, { publicAudience: true });
const quotable = (pool: FilmMemorySource[]) => pool.filter((m) => !sensitive.has(m.id));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = new URL(`./eval-output/year-film-script/${runId}/`, import.meta.url);
await Deno.mkdir(runDir, { recursive: true });
const index: { slug: string; title: string; label: string; seconds: number; scenes: number; frames: number }[] = [];

/** The book's rule: the journal's own language first, then the setting. */
function languageFor(pool: FilmMemorySource[], quotes: QuoteResult): FilmLanguage {
  return resolveFilmLanguage(quotes.language, detectJournalLanguage(pool.map((m) => m.text)), data.language);
}

async function emit(slug: string, label: string, script: FilmScript, quotes: QuoteResult, vision: VisionResult, unconfirmed?: UnconfirmedFirst[]) {
  const dir = new URL(`${slug}/`, runDir);
  const frames = allFrames(script);
  const stills = frames.flatMap((f) => [thumbKey(f), f.pairKey ?? null].filter((k): k is string => !!k));
  const sound = script.scenes.find((s) => s.type === 'sound');
  const clips = sound && sound.type === 'sound' ? [sound.frame.key] : [];
  const local = await downloadAssets([...stills, ...clips], new URL('assets/', dir));
  await Deno.writeTextFile(new URL('film-script.json', dir), JSON.stringify(script, null, 2));
  await Deno.writeTextFile(new URL('quotes.json', dir), JSON.stringify(quotes, null, 2));
  // Vision verdicts per frame (model A/B comparisons) and this film's model cost.
  await Deno.writeTextFile(new URL('vision-checks.json', dir), JSON.stringify({ model: vision.model, checks: Object.fromEntries(vision.checks ?? []) }, null, 2));
  await Deno.writeTextFile(new URL('usage.json', dir), JSON.stringify(usageSummary(), null, 2));
  console.log(formatUsage(`${slug} F1 models`));
  resetUsage();
  await Deno.writeTextFile(new URL('storyboard.html', dir), renderStoryboard(script, label, quotes, vision, { local, textById }, unconfirmed));
  index.push({ slug, title: script.title, label, seconds: script.estimatedSeconds, scenes: script.scenes.length, frames: script.stats.frames });
  const m = script.stats.mix;
  console.log(
    `${slug}: ${script.scenes.length} scenes, ~${script.estimatedSeconds}s, ${script.language}, ${script.stats.frames} burst frames ` +
      `(${m.photo}p/${m.video}v/${m.illustration}i), quotes ${quotes.accepted.length}, vision ${vision.checked}/${vision.sent}`,
  );
}

const ownChildIds = children.map((c) => c.id);
for (const film of options.films) {
  if (film.kind === 'birthday') {
    const child = children.find((c) => firstName(c.name).toLowerCase() === film.childName);
    if (!child?.dateOfBirth) throw new Error(`No child "${film.childName}" in --children`);
    // The film window: the age-year through the day after the
    // birthday, so this year's party closes the film (owner, 2026-09-27).
    const scope = birthdayFilmScope(child.dateOfBirth, film.ageYear);
    const fullPool = birthdayPool(data.memories, child.id, scope, 'exclude');
    const variants = [null, ...options.subsample.filter((n) => n < fullPool.length)];
    for (const n of variants) {
      const memories = n === null ? data.memories : subsamplePool(data.memories, new Set(fullPool.map((m) => m.id)), n, options.seed);
      const pool = birthdayPool(memories, child.id, scope, 'exclude');
      const quotes = await pickQuotes(quotable(pool), [{ id: child.id, name: firstName(child.name) }], options);
      const input: BirthdayInput = {
        child,
        ageYear: film.ageYear,
        scope,
        memories,
        members: data.members,
        ownChildIds,
        milestones: data.milestones,
        quotes: quotes.accepted,
        language: languageFor(pool, quotes),
      };
      const vision = await checkFrames(birthdayVisionCandidates(input), children, scope.endExclusive, options);
      const script = buildBirthdayScript({ ...input, checks: vision.checks });
      const slug = `birthday-${film.childName}-y${film.ageYear}${n === null ? '' : `-sub${n}-seed${options.seed}`}`;
      const label = n === null
        ? `Birthday film · ${firstName(child.name)} · age-year ${film.ageYear}${scope.endExclusive > options.today ? ' (in progress)' : ''}`
        : `Birthday film · subsample ${n} of ${fullPool.length} (seed ${options.seed})`;
      await emit(slug, label, script, quotes, vision);
    }
  } else if (film.kind === 'holiday') {
    // Jan 1 → the day the card is made, inclusive (default: today).
    const madeOn = options.today.startsWith(String(film.year)) ? options.today : `${film.year}-12-31`;
    const scope = holidayFilmScope(film.year, madeOn);
    const fullPool = holidayPool(data.memories, scope, publicSensitive);
    const variants = [null, ...options.subsample.filter((n) => n < fullPool.length)];
    for (const n of variants) {
      const memories = n === null ? data.memories : subsamplePool(data.memories, new Set(fullPool.map((m) => m.id)), n, options.seed);
      const evaluation = evaluateHolidayFilm({ memories, children, scope, excludeIds: publicSensitive });
      const slug = `holiday-${film.year}${n === null ? '' : `-sub${n}-seed${options.seed}`}`;
      if (!evaluation.eligible) {
        console.log(
          `${slug}: NO FILM — ${evaluation.counts.moments} moments / ${evaluation.visuals} visuals ` +
            `below the floor (${HOLIDAY_MIN_POOL} / ${HOLIDAY_MIN_VISUALS})`,
        );
        continue;
      }
      const pool = holidayPool(memories, scope, publicSensitive);
      const kids = chapterChildren(children.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth })), scope)
        .map((k) => children.find((c) => c.id === k.id)!);
      // --confirm-milestones: preview the firsts scene with these treated as confirmed.
      const milestones = data.milestones.map((m) =>
        options.confirm.some((c) => c.memoryId === m.memoryId && c.milestoneId === m.milestoneId) ? { ...m, status: 'confirmed' } : m
      );
      // The holiday card film picks its quote and runs its claim checks on gpt-6.1-sol (owner, 2026-10-05).
      const holidayOptions: Options = {
        ...options,
        model: options.modelExplicit ? options.model : HOLIDAY_QUOTE_MODEL,
        visionModel: options.visionModelExplicit ? options.visionModel : HOLIDAY_CLAIM_CHECK_MODEL,
      };
      const quotes = await pickQuotes(pool, kids.map((k) => ({ id: k.id, name: firstName(k.name) })), holidayOptions);
      const input: HolidayInput = {
        year: film.year,
        scope,
        familyName: data.familyName,
        memories,
        children,
        members: data.members,
        milestones,
        quotes: quotes.accepted,
        language: languageFor(pool, quotes),
        ...(options.preferredClose.length ? { preferredCloseMedia: options.preferredClose } : {}),
        greeting: options.greeting,
      };
      const vision = await checkFrames(holidayVisionCandidates(input), kids, scope.endExclusive, holidayOptions, true);
      const script = buildHolidayScript({ ...input, checks: vision.checks });
      const label = `Holiday card film (${scope.start} → ${madeOn})${n === null ? '' : ` · subsample ${n} of ${fullPool.length} (seed ${options.seed})`}${
        options.confirm.length ? ` · ${options.confirm.length} milestone(s) confirmed for this run` : ''
      }`;
      const unconfirmed = unconfirmedFirsts(pool, milestones, data.members, script.language);
      await emit(slug, label, script, quotes, vision, unconfirmed);
      const close = script.scenes.find((s) => s.type === 'close');
      if (close && close.type === 'close') {
        const names = new Map(data.members.map((m) => [m.id, firstName(m.name)]));
        const byId = new Map(memories.map((m) => [m.id, m]));
        console.log(
          `  close (${close.source}): ${close.frames.map((f) => `${f.memoryId ?? 'portrait'} [${(byId.get(f.memoryId ?? '')?.taggedMemberIds ?? []).map((id) => names.get(id) ?? '?').join(', ')}]`).join(' · ')}`,
        );
      }
      console.log(`  firsts ${script.scenes.some((s) => s.type === 'firsts') ? 'in film' : 'none'} · ${unconfirmed.length} unconfirmed milestone(s), ${unconfirmed.filter((f) => f.gatePasses).length} pass the text gate`);
    }
  } else if (film.kind === 'family') {
    // Before the Dec 28 cut-off (dogfood), the film covers the year so far.
    const full = familyYearScope(film.year);
    const scope = full.endExclusive > options.today ? { start: full.start, endExclusive: options.today } : full;
    const pool = familyPool(data.memories, scope);
    const kids = chapterChildren(children.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth })), scope)
      .map((k) => children.find((c) => c.id === k.id)!);
    const quotes = await pickQuotes(quotable(pool), kids.map((k) => ({ id: k.id, name: firstName(k.name) })), options);
    const input: FamilyYearInput = {
      year: film.year,
      scope,
      memories: data.memories,
      children,
      members: data.members,
      milestones: data.milestones,
      quotes: quotes.accepted,
      language: languageFor(pool, quotes),
    };
    const vision = await checkFrames(familyYearVisionCandidates(input), kids, scope.endExclusive, options);
    const script = buildFamilyYearScript({ ...input, checks: vision.checks });
    const soFar = scope.endExclusive !== full.endExclusive;
    await emit(`family-${film.year}`, `Year-end family film${soFar ? ` (so far: through ${scope.endExclusive})` : ''}`, script, quotes, vision);
  } else {
    const scope = monthScope(film.yearMonth);
    const pool = familyPool(data.memories, scope);
    const kids = chapterChildren(children.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth })), scope)
      .map((k) => children.find((c) => c.id === k.id)!);
    const quotes = await pickQuotes(quotable(pool), kids.map((k) => ({ id: k.id, name: firstName(k.name) })), options);
    const input: MonthlyInput = {
      yearMonth: film.yearMonth,
      memories: data.memories,
      children,
      milestones: data.milestones,
      quotes: quotes.accepted,
      language: languageFor(pool, quotes),
    };
    const vision = await checkFrames(monthlyVisionCandidates(input), kids, scope.endExclusive, options);
    const script = buildMonthlyScript({ ...input, checks: vision.checks });
    const complete = scope.endExclusive <= options.today;
    await emit(`month-${film.yearMonth}`, `Monthly recap${complete ? '' : ' (month in progress)'}`, script, quotes, vision);
  }
}

await Deno.writeTextFile(
  new URL('index.html', runDir),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Year Film F1 storyboards</title><style>body{font-family:system-ui;padding:24px}li{margin:8px 0}</style>
<h1>Year Film F1 storyboards</h1><p>Run ${runId}</p><ul>${
    index.map((f) =>
      `<li><a href="${f.slug}/storyboard.html">${esc(f.title)}</a> — ${esc(f.label)} · ${f.scenes} scenes · ${f.frames} burst frames · ~${f.seconds}s</li>`
    ).join('')
  }</ul>`,
);
console.log(`\nDone.\n  Index: ${new URL('index.html', runDir).pathname}`);
