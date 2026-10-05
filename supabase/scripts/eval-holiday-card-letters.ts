/**
 * Holiday Card C2 letters eval (docs/plans/holiday-cards.md §6 C2): writes the
 * card's letter variants from the year digest and lays them out next to the
 * moments they mention, for owner review. Answers: would you keep a letter
 * with light edits? does the letter match the film?
 *
 * v3 adds the parents' VOICE: ~40 of their own captions (share-safe, last 12
 * months, the core parents' accounts only) become a style card (one cheap
 * model call) and a few verbatim snippets for style; the letters are written
 * in that voice with one concrete detail per child, and never mention the
 * film. `--confirm-milestones memoryId:milestoneId,...` treats candidate
 * milestones as confirmed, so a confirmed first reaches the child's profile.
 *
 * v2 (owner review, 2026-10-04): the letters stand on their own and are
 * written from per-person PROFILES (what recurs for each child, mood, age),
 * not from a list of events; they never mention the film. The page shows
 * the profiles the writer saw, then the letters.
 *   - `--script <film-script.json>` (from `eval:year-film-script -- --film
 *     holiday:YYYY`): the digest is built from that holiday film's script (the
 *     film only adds the QR caption and each child's line of the year).
 *   - without `--script`: the digest is built from the pool (the no-film path
 *     for thin years), same scoring and themes.
 * Letters are generated in the journal language AND the other one (es + en)
 * only in the FAMILY'S language (families.gallery_caption_language is
 * authoritative for language and regional register; detection is a fallback
 * when the setting is missing). `--also-lang en|es` adds a second language (off
 * by default: "write it in English instead" on demand).
 *
 * READ-ONLY against the database (RLS-scoped client, see
 * year-film-eval-data.ts). One model call per language (LETTER_MODEL).
 *
 * PII: the HTML/JSON contain memory excerpts and tiny thumbnails -- they are
 * written only under the gitignored supabase/scripts/eval-output/holiday-card/
 * (own account, owner review). stdout is counts and flag codes only.
 *
 * Examples:
 *   npm run eval:holiday-card-letters -- --script supabase/scripts/eval-output/year-film-script/<run>/holiday-2026/film-script.json
 *   npm run eval:holiday-card-letters -- --subsample 30 --seed 1
 *   npm run eval:holiday-card-letters -- --today 2026-11-10 --also-lang en --no-llm
 */
import { getObjectBytesBatch } from '../functions/_shared/r2.ts';
import { PRICE_USD_PER_MTOK } from '../functions/_shared/memory-book-outline.ts';
import {
  buildDetailsPrompt,
  buildDetailsRequestBody,
  DETAILS_MODEL,
  type DetailsResult,
  parseDetails,
  selectDetailExcerpts,
} from '../functions/_shared/holiday-card-details.ts';
import {
  buildVoiceCardPrompt,
  buildVoiceCardRequestBody,
  type CaptionSample,
  parseVoiceCard,
  selectVoiceSamples,
  VOICE_CARD_MODEL,
  type VoiceCard,
  type VoiceCardFlag,
  voiceExamples,
} from '../functions/_shared/holiday-card-voice.ts';
import { buildDigestFromPool, buildDigestFromScript, type DigestTheme, type YearDigest } from '../functions/_shared/holiday-card-digest.ts';
import {
  buildLetterRequestBody,
  buildLetterSystemPrompt,
  buildLetterUserPrompt,
  defaultSignature,
  isHardFlag,
  LETTER_MAX_CHARS,
  LETTER_MODEL,
  type LetterFlag,
  type LetterResult,
  mergeLetterRetry,
  parseLetterResponse,
  resolveLetterLanguage,
  tonesNeedingLine,
  QR_CAPTION_MAX_CHARS,
  SPANISH_REGISTER,
} from '../functions/_shared/holiday-card-letter.ts';
import {
  buildEditorSystemPrompt,
  buildEditorUserPrompt,
  buildWriterSystemPrompt,
  buildWriterUserPrompt,
  checkV2Letter,
  type EditorResult,
  parseEditorFacts,
  parseWriterText,
  selectEditorCandidates,
  WRITER_ANGLES,
} from '../functions/_shared/holiday-card-letter-v2.ts';
import { holidayFilmScope, holidayPool } from '../functions/_shared/year-film-eligibility.ts';
import { detectJournalLanguage, type FilmLanguage, resolveFilmLanguage } from '../functions/_shared/year-film-i18n.ts';
import { type FilmMemorySource, type FilmScript, shareSensitiveIds } from '../functions/_shared/year-film-script.ts';
import { createAuthedClient, type EvalFamilyData, loadFamilies, loadFamilyData } from './year-film-eval-data.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

interface Options {
  today: string;
  scriptPath: string | null;
  subsample: number | null;
  seed: number;
  alsoLang: FilmLanguage | null;
  model: string;
  voiceModel: string;
  detailsModel: string;
  llm: boolean;
  confirm: { memoryId: string; milestoneId: string }[];
  /** The card's greeting; the closing wish follows it. */
  greeting: 'christmas' | 'holidays' | 'new-year' | null;
  /** v2 = editor + writer (default); v1 = the single-call letter. */
  pipeline: 'v1' | 'v2';
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    today: new Date().toISOString().slice(0, 10),
    scriptPath: null,
    subsample: null,
    seed: 1,
    alsoLang: null,
    model: LETTER_MODEL,
    voiceModel: VOICE_CARD_MODEL,
    detailsModel: DETAILS_MODEL,
    llm: true,
    confirm: [],
    greeting: null,
    pipeline: 'v2',
  };
  for (let i = 0; i < args.length; i += 1) {
    const next = args[i + 1];
    switch (args[i]) {
      case '--today':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next ?? '')) throw new Error('--today needs YYYY-MM-DD');
        options.today = next;
        i += 1;
        break;
      case '--script':
        options.scriptPath = next ?? null;
        i += 1;
        break;
      case '--subsample':
        options.subsample = Number(next) > 0 ? Number(next) : null;
        i += 1;
        break;
      case '--seed':
        options.seed = Number(next) || 1;
        i += 1;
        break;
      case '--pipeline':
        if (next !== 'v1' && next !== 'v2') throw new Error('--pipeline needs v1 or v2');
        options.pipeline = next;
        i += 1;
        break;
      case '--greeting':
        if (next !== 'christmas' && next !== 'holidays' && next !== 'new-year') throw new Error('--greeting needs christmas, holidays or new-year');
        options.greeting = next;
        i += 1;
        break;
      case '--also-lang':
        if (next !== 'es' && next !== 'en') throw new Error('--also-lang needs es or en');
        options.alsoLang = next;
        i += 1;
        break;
      case '--model':
        options.model = next ?? options.model;
        i += 1;
        break;
      case '--voice-model':
        options.voiceModel = next ?? options.voiceModel;
        i += 1;
        break;
      case '--details-model':
        options.detailsModel = next ?? options.detailsModel;
        i += 1;
        break;
      case '--confirm-milestones':
        options.confirm = (next ?? '').split(',').flatMap((pair) => {
          const [memoryId, milestoneId] = pair.trim().split(':');
          return memoryId && milestoneId ? [{ memoryId, milestoneId }] : [];
        });
        i += 1;
        break;
      case '--no-llm':
        options.llm = false;
        break;
    }
  }
  return options;
}

// ── Subsampling (identical to eval-year-film-script.ts so seeds match) ───

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

const usage = new Map<string, { calls: number; input: number; output: number }>();

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
  const tally = usage.get(String(body.model)) ?? { calls: 0, input: 0, output: 0 };
  tally.calls += 1;
  tally.input += Number(payload.usage?.prompt_tokens ?? 0);
  tally.output += Number(payload.usage?.completion_tokens ?? 0);
  usage.set(String(body.model), tally);
  return payload.choices?.[0]?.message?.content ?? null;
}

/** USD per 1M tokens: the outline model from the book's table, the voice-card
 * model from the film eval's (year-film-eval-usage.ts, 2026-09-28). */
const PRICES: Record<string, { input: number; output: number }> = {
  ...PRICE_USD_PER_MTOK,
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6-sol': { input: 2.0, output: 10.0 },
  // Mirrors gpt-6-sol until OpenAI's rate for 6.1 is confirmed.
  'gpt-6.1-sol': { input: 2.0, output: 10.0 },
};

function costUsd(): number | null {
  let total = 0;
  for (const [model, t] of usage) {
    const price = PRICES[model];
    if (!price) return null;
    total += (t.input * price.input + t.output * price.output) / 1e6;
  }
  return usage.size ? total : null;
}

// ── Thumbnails (tiny, inline) ────────────────────────────────────────────

const BROWSER_IMAGE = /\.(jpe?g|png|webp|gif)$/i;

/** The key to show a memory as: video posters/previews first, then a photo
 * the browser can read, then the illustration. */
function thumbKeyOf(memory: FilmMemorySource): string | null {
  if (memory.illustrationReady && memory.illustrationKey) return memory.illustrationKey;
  for (const asset of memory.assets) {
    if (asset.previewKey) return asset.previewKey;
    if (asset.kind === 'image' && BROWSER_IMAGE.test(asset.key)) return asset.key;
  }
  return null;
}

async function toThumbDataUri(bytes: Uint8Array): Promise<string | null> {
  const dir = await Deno.makeTempDir();
  const input = `${dir}/in`;
  const output = `${dir}/out.jpg`;
  try {
    await Deno.writeFile(input, bytes);
    const { code } = await new Deno.Command('ffmpeg', {
      args: ['-v', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', "scale='min(220,iw)':-2", '-q:v', '6', output],
    }).output();
    if (code !== 0) return null;
    const out = await Deno.readFile(output);
    let binary = '';
    for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return null;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function thumbnails(digest: YearDigest, byId: Map<string, FilmMemorySource>): Promise<Map<string, string>> {
  const keyById = new Map<string, string>();
  const ids = [...digest.highlights.map((h) => h.memoryId), ...digest.children.flatMap((c) => c.excerpts.map((e) => e.memoryId))];
  for (const id of ids) {
    const memory = byId.get(id);
    const key = memory ? thumbKeyOf(memory) : null;
    if (key) keyById.set(id, key);
  }
  const out = new Map<string, string>();
  const keys = [...new Set(keyById.values())];
  for (let i = 0; i < keys.length; i += 8) {
    const batch = await getObjectBytesBatch(keys.slice(i, i + 8));
    const uris = new Map<string, string>();
    for (const [key, entry] of batch) {
      if (!entry.ok || !entry.bytes) continue;
      const uri = await toThumbDataUri(entry.bytes);
      if (uri) uris.set(key, uri);
    }
    for (const [id, key] of keyById) if (uris.has(key)) out.set(id, uris.get(key)!);
  }
  return out;
}

// ── HTML ─────────────────────────────────────────────────────────────────

function esc(text: string | number | null | undefined): string {
  return String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function flagChips(flags: LetterFlag[]): string {
  return flags.map((f) => `<span class="flag ${isHardFlag(f) ? 'hard' : 'soft'}">${esc(f.code)}${f.detail ? `: ${esc(f.detail)}` : ''}</span>`).join('');
}

interface VoiceRun {
  /** Where the samples came from, for the page. */
  source: string;
  samples: CaptionSample[];
  card: VoiceCard | null;
  flags: VoiceCardFlag[];
  examples: string[];
  skipped: string | null;
  model: string;
  /** The model's raw card (style only), kept for the review JSON. */
  raw: string | null;
}

function voiceSection(v: VoiceRun): string {
  const c = v.card;
  const row = (k: string, val: string) => `<tr><th>${esc(k)}</th><td>${val}</td></tr>`;
  const list = (items: string[]) => (items.length ? items.map((i) => `<span class="theme">${esc(i)}</span>`).join('') : '—');
  return `<section><h2>The parents' voice</h2>
<p class="note">${v.samples.length} caption(s) from ${esc(v.source)} (share-safe, last 12 months, spread over the months and moods) → style card by <b>${esc(v.model)}</b>${
    v.flags.length ? ` · dropped/flagged: ${esc(v.flags.join(', '))}` : ''
  }${v.skipped ? ` · skipped: ${esc(v.skipped)}` : ''}</p>
${
    c
      ? `<table class="card">${row('How they address people', esc(c.register))}${row('How they name the kids', esc(c.kidsReference))}${
        row('Person · addressee', `${esc(c.person)} · ${esc(c.addressee.replaceAll('_', ' '))}`)
      }${row('Sentences', `${esc(c.sentenceLength)} — ${esc(c.rhythm)}`)}${row('Formality · humor', `${esc(c.formality)} · ${esc(c.humor)}`)}${
        row('Openers', list(c.openers))
      }${row('Closers', list(c.closers))}${
        row('Punctuation', `exclamations ${esc(c.punctuation.exclamations)}, emojis ${esc(c.punctuation.emojis)}, ellipses ${esc(c.punctuation.ellipses)}${c.punctuation.notes ? ` — ${esc(c.punctuation.notes)}` : ''}`)
      }${row('Words they really use', list(c.characteristic))}${row('They never', list(c.never))}</table>`
      : '<p class="note">No style card — the letters use the default register.</p>'
  }
<h3 style="margin-top:12px">Voice examples shown to the writer (style only)</h3>${
    v.examples.length ? v.examples.map((e) => `<p class="vex">“${esc(e)}”</p>`).join('') : '<p class="note">None.</p>'
  }
</section>`;
}

interface LanguageRun {
  language: FilmLanguage;
  skipped: string | null;
  result: LetterResult | null;
  /** Tones that lacked the required line and were retried once. */
  retried: string[];
  /** v2: what the editor chose (facts + evidence) and how many entries it read. */
  editor?: (EditorResult & { candidates: number; candidateTexts: Map<string, string> }) | null;
}

function themeChips(themes: DigestTheme[]): string {
  return themes.length
    ? themes.map((t) => `<span class="theme">${esc(t.phrase)} <b>×${t.memories}</b>${t.lift >= 1.3 ? ` <em>${t.lift.toFixed(1)}× usual</em>` : ''}${t.details?.length ? ` <em>(${esc(t.details.map((d) => d.label).join(', '))})</em>` : ''}</span>`).join('')
    : '<span class="note">no clear pattern</span>';
}

function thumb(thumbs: Map<string, string>, id: string): string {
  return thumbs.get(id) ? `<img src="${thumbs.get(id)}">` : '<div class="ph">no preview</div>';
}

function renderHtml(args: {
  runId: string;
  label: string;
  digest: YearDigest;
  runs: LanguageRun[];
  thumbs: Map<string, string>;
  model: string;
  cost: number | null;
  voice: VoiceRun;
  stats: Map<string, string>;
  setting: { raw: string | null; language: FilmLanguage; locale: string | null; source: string; guidance: string | null };
}): string {
  const { digest, runs, thumbs, stats, setting } = args;
  const people = digest.people.map((p) => `${esc(p.name)} <em>(${p.role}${p.ageYears !== null ? `, ${p.ageYears}` : ''})</em>`).join(' · ');
  const children = digest.children.map((c) => `
    <div class="profile">
      <h3>${esc(c.name)} <span class="count">age ${c.ageYears ?? '?'} today · ${c.ageThisYear ?? '?'} this December${c.birthdayThisYear ? ` · birthday ${esc(c.birthdayThisYear)}` : ''} · ${c.memories} moments</span></h3>
      ${c.firsts.length ? `<p><b>First:</b> ${c.firsts.map((f) => `<span class="theme">${esc(f.label)} <em>${esc(f.date)}${f.confirmed ? ' · confirmed' : ' · from the text'}</em></span>`).join('')}</p>` : ''}
      <p><b>Specific things (from their memories' own words):</b> ${
    c.specifics.length
      ? c.specifics.map((d) => `<span class="theme">${esc(d.detail)} <b>×${d.memories}</b>${d.recurring ? ' <em>recurring</em>' : ''}</span>`).join('')
      : '<span class="note">none extracted</span>'
  }${stats.get(c.memberId) ? ` <span class="note">${esc(stats.get(c.memberId)!)}</span>` : ''}</p>
      <p><b>Keeps coming back to:</b> ${themeChips(c.recurring)}</p>
      <p><b>Generic labels (fallback):</b> ${c.details.length ? c.details.map((d) => `<span class="theme">${esc(d.label)} <b>×${d.memories}</b></span>`).join('') : '<span class="note">none</span>'}</p>
      <p class="note">Usual mood: ${c.emotions.length ? c.emotions.map((e) => `${esc(e.emotion)} ${Math.round(e.share * 100)}%`).join(', ') : 'unclear'}${
    c.line ? ` · line: “${esc(c.line.quote)}”` : ''
  }</p>
      <div class="exs">${c.excerpts.map((e) => `<div class="ex2">${thumb(thumbs, e.memoryId)}<span>${esc(e.excerpt)}</span></div>`).join('')}</div>
    </div>`).join('');
  const parents = digest.parents.length
    ? digest.parents.map((p) => `<p><b>${esc(p.name)}</b> <span class="note">(${p.memories} moments)</span> ${themeChips(p.recurring)}</p>`).join('')
    : '<p class="note">No parent has enough evidence for a profile.</p>';
  const highlights = digest.highlights.map((h) => `
    <div class="hl${h.inFilm ? ' infilm' : ''}">
      <div class="th">${thumb(thumbs, h.memoryId)}</div>
      <div class="body">
        <div class="meta"><b>${esc(h.date)}</b> · ${esc(h.emotion ?? 'no emotion')} · ${esc(h.topics.join(', ') || 'no topics')}${h.inFilm ? ` · <span class="badge">in film${h.sceneHint ? `: ${esc(h.sceneHint)}` : ''}</span>` : ''}</div>
        <div class="ex">${esc(h.excerpt)}</div>
        <div class="meta">people: ${esc(h.taggedPeople.join(', ') || '—')}${h.withRoles.length ? ` · with: ${esc(h.withRoles.join(', '))}` : ''}</div>
      </div>
    </div>`).join('');
  const sections = runs.map((run) => {
    const r = run.result;
    const heading = `${run.language === 'es' ? 'Español' : 'English'}${run.language === digest.language ? ' (journal language)' : ''}`;
    const register = run.language === 'es' ? `<p class="note">Register: ${esc(SPANISH_REGISTER)} — no family-level setting suggests another.</p>` : '';
    if (!r) return `<section><h2>${heading}</h2>${register}<p class="note">Skipped: ${esc(run.skipped)}</p></section>`;
    const variant = (v: LetterResult['variants'][number]) => `
      <article class="variant">
        <h3>${esc(v.tone)} <span class="count${v.chars > LETTER_MAX_CHARS[v.tone] * 0.95 ? ' tight' : ''}">${v.chars} / ${LETTER_MAX_CHARS[v.tone]} chars</span>${
      digest.lineOfYear && run.language === digest.language ? (v.flags.some((f) => f.code === 'line_missing') ? ' <span class="flag soft">line of the year missing</span>' : ' <span class="ok">line of the year quoted</span>') : ''
    }</h3>
        <p class="letter">${esc(v.text)}</p>
        <p class="sig">${esc(r.signature)}</p>
        <div class="flags">${v.flags.length ? flagChips(v.flags) : '<span class="ok">no flags</span>'}</div>
      </article>`;
    const rejected = r.rejected.map((v) => `
      <article class="variant rejected">
        <h3>${esc(v.tone ?? '?')} — REJECTED <span class="count">${Array.from(v.text).length} chars</span></h3>
        <p class="letter">${esc(v.text)}</p>
        <div class="flags">${flagChips(v.flags)}</div>
      </article>`).join('');
    return `<section>
      <h2>${heading}</h2>${register}
      <p class="qr"><b>QR caption</b> <span class="count">${r.qrCaption ? `${Array.from(r.qrCaption).length} / ${QR_CAPTION_MAX_CHARS}` : '—'}</span><br>${
      r.qrCaption ? `<span class="caption">${esc(r.qrCaption)}</span>` : '<em>none</em>'
    } ${flagChips(r.qrCaptionFlags)}</p>
      <p class="note">Default signature: <b>${esc(r.signature)}</b> · ${r.variants.length} accepted, ${r.rejected.length} rejected ${flagChips(r.flags)}</p>
      <div class="variants">${r.variants.map(variant).join('')}${rejected}</div>
    </section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Holiday card letters — ${esc(args.runId)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f6f3fb;color:#2a2438;margin:0;padding:24px;max-width:1100px;margin:auto;line-height:1.45}
h1{font-size:30px;margin:0 0 4px}h2{font-size:20px;margin:0 0 10px}h3{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#7a6aa8;margin:0 0 8px}
section{background:#fff;border-radius:16px;padding:18px 20px;margin:0 0 18px;box-shadow:0 1px 3px #0001}
.note,.meta{color:#6b6280;font-size:13px}.meta{font-size:12px}
.variants{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:14px}
.variant{border:1px solid #e3dcf0;border-radius:12px;padding:14px 16px;background:#fcfbff}
.variant.rejected{border-color:#e0a0a0;background:#fff5f5}
.letter{font-family:Georgia,serif;font-size:16px;white-space:pre-wrap;margin:0 0 8px}.sig{font-family:Georgia,serif;font-style:italic;margin:0 0 10px}
.count{font-weight:400;color:#8a80a0;letter-spacing:0;text-transform:none;margin-left:8px}.count.tight{color:#b26a00}
.flag{display:inline-block;font-size:11px;border-radius:6px;padding:1px 6px;margin:0 4px 4px 0}.flag.soft{background:#fff1d6;color:#8a5a00}.flag.hard{background:#fbd5d5;color:#8a1c1c}.ok{font-size:11px;color:#3a7a4a}
.qr .caption{font-size:17px;font-weight:600}
table.card{border-collapse:collapse;font-size:13px}table.card th{text-align:left;color:#7a6aa8;padding:4px 14px 4px 0;vertical-align:top;white-space:nowrap}table.card td{padding:4px 0}.vex{font-family:Georgia,serif;font-size:14px;margin:4px 0;color:#4a4260}
.profile{border-top:1px solid #eee;padding:10px 0}.theme{display:inline-block;background:#ece6f7;border-radius:8px;padding:2px 8px;margin:0 6px 4px 0;font-size:13px}.theme em{font-style:normal;color:#7a6aa8;font-size:11px}
.exs{display:flex;flex-wrap:wrap;gap:10px}.ex2{display:flex;gap:8px;align-items:center;font-size:12px;color:#4a4260;width:320px}.ex2 img,.ex2 .ph{width:48px;height:48px;object-fit:cover;border-radius:6px;flex:none;background:#eee}
.hl{display:flex;gap:12px;padding:8px 0;border-top:1px solid #eee}.hl.infilm{border-left:3px solid #7a6aa8;padding-left:8px}
.th img,.th .ph{width:70px;height:70px;object-fit:cover;border-radius:8px;background:#eee;font-size:11px;color:#999;display:flex;align-items:center;justify-content:center}
.ex{font-size:14px}.badge{background:#ece6f7;border-radius:6px;padding:0 6px;font-size:11px;color:#4a3d7a}
</style></head><body>
<h1>Holiday card letters</h1>
<p class="note">${esc(args.label)} · ${esc(digest.scope.start)} → ${esc(digest.scope.endExclusive)} (exclusive) · journal language <b>${digest.language}</b> · model ${esc(args.model)}${
    args.cost !== null ? ` · ≈ $${args.cost.toFixed(3)}` : ''
  } · digest built <b>${digest.filmPresent ? 'from the holiday film script' : 'from the pool (no film)'}</b></p>
<section><h2>What the writer saw</h2>
<p><b>People:</b> ${people}</p>
<p class="note">${digest.counts.moments} moments over ${digest.counts.months} months · ${digest.counts.photos} photos · ${digest.counts.videos} videos · ${digest.counts.outings} outings</p>
<h3>Children</h3>${children}
<h3 style="margin-top:12px">Parents (light profile, only with evidence)</h3>${parents}
<h3 style="margin-top:12px">Family</h3>
<p><b>Themes:</b> ${themeChips(digest.familyThemes)}</p>
<p><b>Places that recur:</b> ${themeChips(digest.places)}</p>
${digest.lineOfYear ? `<p><b>Line of the year</b> — ${esc(digest.lineOfYear.speaker)}: “${esc(digest.lineOfYear.quote)}”</p>` : '<p class="note">No verified line of the year.</p>'}
<h3 style="margin-top:12px">Optional details (${digest.highlights.length}) — the writer may draw at most one</h3>${highlights || '<p class="note">None.</p>'}
</section>
<section><h2>Family setting used</h2>
<p><b>Caption language:</b> <code>${esc(setting.raw ?? '(not set)')}</code> → letters in <b>${setting.language === 'es' ? 'Spanish' : 'English'}</b>${setting.locale ? ` (${esc(setting.locale)}: regional register from the setting)` : ''} · source: <b>${esc(setting.source)}</b>${setting.source === 'fallback' ? ' (setting missing or unsupported → detected from the journal)' : ''}</p>
<p><b>Family guidance</b> (families.gallery_caption_instructions, passed to the writer as quoted data): ${setting.guidance ? `<span class="vex">“${esc(setting.guidance)}”</span>` : '<span class="note">none</span>'}</p>
<p class="note">Writer model: ${esc(args.model)}${runs.some((r) => r.retried.length) ? ` · line of the year missing in ${esc(runs.map((r) => r.retried.join('+')).filter(Boolean).join(', '))} → call retried once` : ''}</p></section>
${voiceSection(args.voice)}
${sections}
</body></html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────

const options = parseArgs(Deno.args);
const supabase = await createAuthedClient();
const families = await loadFamilies(supabase);
if (families.length !== 1) throw new Error(`Expected one family, found ${families.length}`);
const data: EvalFamilyData = await loadFamilyData(supabase, families[0]);

const script: FilmScript | null = options.scriptPath ? JSON.parse(await Deno.readTextFile(options.scriptPath)) as FilmScript : null;
if (script && script.kind !== 'family_holiday') throw new Error('--script must be a family_holiday film-script.json');
const scope = script?.scope ?? holidayFilmScope(Number(options.today.slice(0, 4)), options.today);
const sensitive = shareSensitiveIds(data.memories, data.milestones);

let memories = data.memories;
let subsampleLabel = '';
if (options.subsample !== null) {
  const fullPool = holidayPool(data.memories, scope, sensitive);
  if (options.subsample < fullPool.length) {
    memories = subsamplePool(data.memories, new Set(fullPool.map((m) => m.id)), options.subsample, options.seed);
    subsampleLabel = ` · subsample ${options.subsample} of ${fullPool.length} (seed ${options.seed})`;
  }
}
const pool = holidayPool(memories, scope, sensitive);
// The family's caption-language setting is authoritative (language AND regional
// register); detection is only the fallback when it is missing or unsupported.
const detected = resolveFilmLanguage(null, detectJournalLanguage(pool.map((m) => m.text)), null);
const familyLang = resolveLetterLanguage(data.language, detected);
const journalLanguage: FilmLanguage = familyLang.language;
const guidance = data.captionInstructions;
const context = { familyName: data.familyName };
// --confirm-milestones: treat these candidates as confirmed for the run.
const milestones = data.milestones.map((m) =>
  options.confirm.some((c) => c.memoryId === m.memoryId && c.milestoneId === m.milestoneId) ? { ...m, status: 'confirmed' } : m
);
const buildDigest = (specifics?: Record<string, { detail: string; memoryIds: string[]; recurring: boolean }[]>) =>
  script
    ? buildDigestFromScript(script, memories, data.members, journalLanguage, { ...context, milestones, specifics })
    : buildDigestFromPool(memories, milestones, data.members, scope, journalLanguage, { ...context, specifics });
let digest = buildDigest();

// Specific details per child, read from their memories' own text (one cheap
// pass per child over ≤25 excerpts) and verified there; labels are the fallback.
interface ChildDetails {
  name: string;
  excerpts: number;
  result: DetailsResult | null;
  skipped: string | null;
}
const childDetails: ChildDetails[] = [];
{
  const ownChildIds = digest.children.map((c) => c.memberId);
  const names = [...digest.people.map((p) => p.name), ...digest.forbiddenNames, ...digest.children.flatMap((c) => c.nicknames.flatMap((n) => [n, ...n.split(/\s+/)]))];
  const specifics: Record<string, { detail: string; memoryIds: string[]; recurring: boolean }[]> = {};
  for (const child of digest.children) {
    const childNames = Object.fromEntries(digest.children.map((c) => [c.memberId, c.name]));
    const excerpts = selectDetailExcerpts(memories, milestones, { childId: child.memberId, scope, ownChildIds, childNames });
    const entry: ChildDetails = { name: child.name, excerpts: excerpts.length, result: null, skipped: null };
    childDetails.push(entry);
    if (!options.llm) entry.skipped = '--no-llm';
    else if (excerpts.length === 0) entry.skipped = 'no excerpts';
    else {
      const { system, user } = buildDetailsPrompt(child.name, excerpts);
      // The cheap model sometimes returns too few: one retry, keep the better.
      for (let attempt = 0; attempt < 2 && (entry.result === null || entry.result.verified < 3); attempt += 1) {
        const content = await chat(buildDetailsRequestBody(options.detailsModel, system, user));
        if (content === null) {
          if (entry.result === null) entry.skipped = 'OpenAI call failed or no API key';
          continue;
        }
        const next = parseDetails(content, excerpts, names, { name: child.name, nicknames: child.nicknames });
        if (entry.result === null || next.verified > entry.result.verified) entry.result = next;
        entry.skipped = null;
      }
      if (entry.result) specifics[child.memberId] = entry.result.details;
    }
  }
  digest = buildDigest(specifics);
}

// The parents' voice: their own captions only (members whose role is parent,
// through the account each is linked to; if none is linked, the account that
// wrote the most memories). Independent of the subsample: it is how they write.
const parentAccounts = data.members.filter((m) => m.relationship === 'parent' && m.userId).map((m) => m.userId!);
let voiceSource = 'the parents\' linked accounts';
let authors = parentAccounts;
if (authors.length === 0) {
  const counts = new Map<string, number>();
  for (const m of data.memories) if (m.authorId) counts.set(m.authorId, (counts.get(m.authorId) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  authors = top ? [top[0]] : [];
  voiceSource = 'the account that wrote the most memories (no parent is linked to an account)';
}
const samples = selectVoiceSamples(data.memories, data.milestones, { parentAuthorIds: authors, today: options.today });
// Names the style card must not carry: the children (and their nicknames) and
// everyone outside the core family. The parents' own names are left out on
// purpose: families name themselves "Mami"/"Papi", which IS their voice.
const personNames = [
  ...digest.people.filter((p) => p.role === 'child').map((p) => p.name),
  ...data.members.filter((m) => digest.people.some((p) => p.role === 'child' && p.name === m.name.trim().split(/\s+/)[0])).flatMap((m) => m.nicknames ?? []),
  ...digest.forbiddenNames,
];
const voice: VoiceRun = { source: voiceSource, samples, card: null, flags: [], examples: [], skipped: null, model: options.voiceModel, raw: null };
if (!options.llm) voice.skipped = '--no-llm';
else if (samples.length === 0) voice.skipped = 'no caption samples';
else {
  const { system, user } = buildVoiceCardPrompt(samples);
  const content = await chat(buildVoiceCardRequestBody(options.voiceModel, system, user));
  if (content === null) voice.skipped = 'OpenAI call failed or no API key';
  else {
    voice.raw = content;
    const parsed = parseVoiceCard(content, { samples, names: personNames });
    voice.card = parsed.card;
    voice.flags = parsed.flags;
  }
}
voice.examples = voiceExamples(samples, { forbiddenNames: digest.forbiddenNames });

const languages: FilmLanguage[] = options.alsoLang && options.alsoLang !== journalLanguage ? [journalLanguage, options.alsoLang] : [journalLanguage];
const runs: LanguageRun[] = [];
for (const language of languages) {
  if (!options.llm) {
    runs.push({ language, skipped: '--no-llm', result: null, retried: [] });
    continue;
  }
  if (digest.highlights.length === 0) {
    runs.push({ language, skipped: 'no highlights with text in the pool', result: null, retried: [] });
    continue;
  }
  const own = language === journalLanguage; // the family's own language gets its regional register
  const letterOptions = {
    language,
    locale: own ? familyLang.locale : null,
    guidance: own ? guidance : null,
    voice: { card: voice.card, examples: voice.examples, language: journalLanguage },
    ...(options.greeting ? { greeting: options.greeting } : {}),
  };
  if (options.pipeline === 'v2') {
    const candidates = selectEditorCandidates(pool, {
      scope,
      milestones,
      children: digest.children.map((c) => ({ id: c.memberId, name: c.name })),
      people: data.members.map((m) => ({ id: m.id, name: m.name })),
    });
    const editorRaw = await chat(buildLetterRequestBody(options.model, buildEditorSystemPrompt(language), buildEditorUserPrompt(digest, candidates, language)));
    if (editorRaw === null) {
      runs.push({ language, skipped: 'editor call failed', result: null, retried: [] });
      continue;
    }
    const editor = parseEditorFacts(editorRaw, candidates, digest);
    const variants: LetterResult['variants'] = [];
    const rejected: LetterResult['rejected'] = [];
    for (const angle of WRITER_ANGLES) {
      const raw = await chat(buildLetterRequestBody(
        options.model,
        buildWriterSystemPrompt({ language, locale: letterOptions.locale, greeting: options.greeting ?? undefined }),
        buildWriterUserPrompt({ angle, facts: editor.facts, broadStrokes: editor.broadStrokes, children: digest.children.map((c) => ({ name: c.name, gender: c.gender })), voice: letterOptions.voice, language }),
      ));
      const text = raw === null ? null : parseWriterText(raw);
      const tone = angle === 'warm' ? 'reflective' : angle;
      if (!text) {
        rejected.push({ tone, text: '', flags: [{ code: 'empty' }] });
        continue;
      }
      const checks = checkV2Letter(text, angle, digest, language, { voice: letterOptions.voice, greeting: options.greeting ?? undefined, locale: letterOptions.locale });
      if (checks.hard.length) rejected.push({ tone, text, flags: checks.hard });
      else variants.push({ tone, text, chars: Array.from(text).length, flags: checks.soft });
    }
    runs.push({
      language,
      skipped: null,
      retried: [],
      result: { language, variants, rejected, qrCaption: editor.qrCaption, qrCaptionFlags: [], signature: defaultSignature(data.familyName, language), flags: [] },
      editor: { ...editor, candidates: candidates.length, candidateTexts: new Map(candidates.map((c) => [c.id, `${c.date}: ${c.text}`])) },
    });
    continue;
  }
  const content = await chat(
    buildLetterRequestBody(options.model, buildLetterSystemPrompt(letterOptions), buildLetterUserPrompt(digest, letterOptions)),
  );
  if (content === null) {
    runs.push({ language, skipped: 'OpenAI call failed or no API key', result: null, retried: [] });
    continue;
  }
  let result = parseLetterResponse(content, digest, letterOptions);
  // The line of the year is required (verbatim) in the classic and playful
  // letters: one retry of the call when it is missing, then keep and flag.
  const retried = tonesNeedingLine(result, digest);
  if (retried.length > 0) {
    const again = await chat(
      buildLetterRequestBody(options.model, buildLetterSystemPrompt(letterOptions), buildLetterUserPrompt(digest, letterOptions)),
    );
    if (again !== null) result = mergeLetterRetry(result, parseLetterResponse(again, digest, letterOptions), digest);
  }
  runs.push({ language, skipped: null, result, retried });
}

const byId = new Map(memories.map((m) => [m.id, m]));
const thumbs = await thumbnails(digest, byId);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = new URL('./eval-output/holiday-card/', import.meta.url);
await Deno.mkdir(outDir, { recursive: true });
const label = `${script ? `Film: ${options.scriptPath!.split('/').slice(-3).join('/')}` : 'No film (pool digest)'}${subsampleLabel}`;
const cost = costUsd();
const editorHtml = runs.filter((r) => r.editor).map((r) => {
  const e = r.editor!;
  const items = e.facts.map((f) => `<li><b>${esc(f.about ?? 'family')}</b> <span class="chip">${esc(f.kind)}</span> ${esc(f.fact)}${
    f.evidence.length ? `<details><summary>evidence (${f.evidence.length})</summary><ul>${f.evidence.map((id) => `<li>${esc(e.candidateTexts.get(id) ?? id)}</li>`).join('')}</ul></details>` : ' <i>(given)</i>'
  }</li>`).join('');
  const dropped = e.dropped.length ? `<p>Dropped by code: ${e.dropped.map((d) => `${esc(d.reason)}: ${esc(d.fact)}`).join(' · ')}</p>` : '';
  return `<section style="max-width:900px;margin:24px auto;padding:16px;border:1px solid #ddd;border-radius:12px;font-family:system-ui"><h2>Editor (${esc(r.language)}): what's worth telling</h2><p>Read ${e.candidates} entries. Broad strokes: <i>${esc(e.broadStrokes ?? '—')}</i></p><ol>${items}</ol>${dropped}</section>`;
}).join('');
await Deno.writeTextFile(new URL(`${runId}-letters.html`, outDir), renderHtml({ runId, label, digest, runs, thumbs, model: options.model, cost, voice, setting: { raw: data.language, language: journalLanguage, locale: familyLang.locale, source: familyLang.source, guidance }, stats: new Map(digest.children.map((c, i) => [c.memberId, childDetails[i]?.result ? `extracted ${childDetails[i].result!.extracted} · verified ${childDetails[i].result!.verified} · dropped ${childDetails[i].result!.dropped}` : `skipped: ${childDetails[i]?.skipped ?? '—'}`])) }).replace('</body>', `${editorHtml}</body>`));
await Deno.writeTextFile(
  new URL(`${runId}-letters.json`, outDir),
  JSON.stringify(
    {
      runId,
      model: options.model,
      scriptPath: options.scriptPath,
      subsample: options.subsample === null ? null : { n: options.subsample, seed: options.seed },
      usage: { byModel: Object.fromEntries(usage), usd: cost },
      setting: { captionLanguage: data.language, resolved: familyLang, hasGuidance: !!guidance, guidanceChars: guidance?.length ?? 0 },
      voice: { source: voice.source, model: voice.model, samples: voice.samples.length, card: voice.card, flags: voice.flags, examples: voice.examples, skipped: voice.skipped, raw: voice.raw },
      childDetails: childDetails.map((c) => ({ name: c.name, excerpts: c.excerpts, skipped: c.skipped, ...(c.result ? { extracted: c.result.extracted, verified: c.result.verified, dropped: c.result.dropped, reasons: c.result.reasons } : {}) })),
      digest,
      pipeline: options.pipeline,
      runs: runs.map((r) => ({ language: r.language, skipped: r.skipped, retried: r.retried, signature: r.result?.signature ?? defaultSignature(data.familyName, r.language), ...r.result, ...(r.editor ? { editor: { facts: r.editor.facts, broadStrokes: r.editor.broadStrokes, qrCaption: r.editor.qrCaption, dropped: r.editor.dropped, candidates: r.editor.candidates } } : {}) })),
    },
    null,
    2,
  ),
);

// stdout: counts and flag codes only.
console.log(
  `digest: ${digest.filmPresent ? 'from film script' : 'from pool'}, ${digest.children.length} child profiles ` +
    `(${digest.children.map((c) => `${c.name}: ${c.memories} moments, ${c.recurring.length} recurring`).join('; ')}), ` +
    `${digest.parents.length} parent profile(s), ${digest.familyThemes.length} family themes, ${digest.places.length} places, ` +
    `${digest.highlights.length} optional details, ${digest.counts.moments} moments, ` +
    `line of the year ${digest.lineOfYear ? `yes (${digest.lineOfYear.speaker})` : 'no'}, journal language ${digest.language}`,
);
for (const run of runs) {
  const r = run.result;
  if (!r) {
    console.log(`${run.language}: skipped (${run.skipped})`);
    continue;
  }
  const codes = [...r.variants.flatMap((v) => v.flags), ...r.rejected.flatMap((v) => v.flags), ...r.flags, ...r.qrCaptionFlags].map((f) => f.code);
  const usage = r.variants.map((v) => `${v.tone} ${v.flags.some((f) => f.code === 'line_missing') ? 'MISSING' : digest.lineOfYear && run.language === digest.language ? 'yes' : 'n/a'}`).join(', ');
  console.log(`${run.language}: line of the year per variant: ${usage}${run.retried.length ? ` (retried ${run.retried.join('+')})` : ''}`);
  console.log(
    `${run.language}: ${r.variants.map((v) => `${v.tone} ${v.chars}`).join(', ') || 'no variants'} chars · ${r.rejected.length} rejected · ` +
      `caption ${r.qrCaption ? Array.from(r.qrCaption).length : 'none'} · flags ${codes.length ? [...new Set(codes)].join(',') : 'none'}`,
  );
}
for (const [model, t] of usage) console.log(`model: ${model} · ${t.calls} call(s) · ${t.input} in / ${t.output} out`);
if (cost !== null) console.log(`≈ $${cost.toFixed(3)} total`);
for (const c of childDetails) {
  console.log(c.result ? `details ${c.name}: ${c.excerpts} excerpts → extracted ${c.result.extracted}, verified ${c.result.verified}, dropped ${c.result.dropped} ${JSON.stringify(c.result.reasons)}` : `details ${c.name}: skipped (${c.skipped})`);
}
console.log(`setting: gallery_caption_language=${data.language ?? '(none)'} → ${familyLang.language}${familyLang.locale ? ` (${familyLang.locale})` : ''} [${familyLang.source}], guidance ${guidance ? `present (${guidance.length} chars)` : 'absent'}, writer ${options.model}`);
console.log(
  `voice: ${voice.samples.length} caption sample(s) from ${authors.length} account(s), card ${voice.card ? 'ok' : 'none'}${voice.skipped ? ` (${voice.skipped})` : ''}, ` +
    `${voice.card?.characteristic.length ?? 0} characteristic phrase(s), ${voice.examples.length} example(s), flags ${voice.flags.length ? voice.flags.join(',') : 'none'}`,
);
console.log(`\nDone.\n  HTML: ${new URL(`${runId}-letters.html`, outDir).pathname}\n  JSON: ${new URL(`${runId}-letters.json`, outDir).pathname}`);
