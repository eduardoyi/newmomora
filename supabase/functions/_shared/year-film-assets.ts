// Year Film asset step as pure logic (docs/plans/year-film-p1.md Decision 4,
// Step 2): what the prepare machine must produce, how the Worker walks the
// voice and frame checks over the prepared artifacts, and how the result is
// written into film.json — the same rules as the F2 eval
// (supabase/scripts/eval-year-film-assets.ts), split so the checks (OpenAI,
// Worker) and the media work (ffmpeg, Fly) can run in different places.
//
// The resolvers are iterative: given the verdicts known so far they return
// either the checks still needed or the final choice, so the Worker can
// persist each batch of verdicts (retries never pay twice) and call again.
//
// No I/O, no Deno APIs: imported by the Worker, the render job (Node) and
// tests.
import type { FilmScene, FilmScript, FrameRef } from './year-film-script.ts';
import type { Window } from './year-film-trim.ts';
import { burstFrameVerdict, type FrameCheck } from './year-film-vision.ts';
import { isVoiceVerified, type VoiceCheck } from './year-film-voice.ts';

// ── Usage mapping (mirrors the eval's uses() / stillKey()) ────────────────

export type Usage = 'still' | 'burst' | 'verified' | 'voice';

export interface Use {
  frame: FrameRef;
  usage: Usage;
  /** Shown in the film's dense/visual parts → frame-checked. */
  checked: boolean;
}

/** The holiday card film is watched by anyone who scans the card (owner,
 * 2026-10-05): every frame it shows goes through the strict public vision
 * check, and an unverified frame is dropped. */
export function isPublicFilm(film: Pick<FilmScript, 'kind'>): boolean {
  return film.kind === 'family_holiday';
}

/** Every frame of a scene with what it's used for. End cards and title
 * cards are small tiles → stills (video posters). With `publicAudience`
 * (holiday card film) every frame is checked, not just the dense parts; the
 * sound scene's video is checked per voice window (soundFrameNeeds). */
export function uses(scene: FilmScene, publicAudience = false): Use[] {
  const list = baseUses(scene);
  return publicAudience ? list.map((u) => ({ ...u, checked: u.usage !== 'voice' })) : list;
}

/** Drawings (illustrations, portraits) are made from the memory's tagged
 * people and aren't vision-checked. */
function isDrawing(frame: FrameRef): boolean {
  return frame.kind === 'illustration' || frame.kind === 'portrait';
}

function baseUses(scene: FilmScene): Use[] {
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
      return [
        ...as(scene.people.map((p) => p.portrait), 'still', false),
        ...as(scene.people.flatMap((p) => p.moments ?? []), 'still', false),
        ...as((scene.together ?? []).map((t) => t.portrait), 'still', false),
      ];
    case 'award':
      return [motion(scene.frame, true, false)];
    case 'close':
      return scene.frames.map((f) => motion(f, scene.source === 'then_now', scene.source === 'celebration'));
    case 'counters':
      return as(scene.backdrop ?? [], 'still', false);
    case 'firsts':
      return scene.items.flatMap((item) => (item.frame ? [motion(item.frame, false, false)] : []));
    case 'chapter':
      return [...as(scene.portrait ? [scene.portrait] : [], 'still', false), ...as(scene.frames, 'still', false)];
  }
}

/** Tiles of videos show the poster; everything else the original. */
export function stillKey(frame: FrameRef, usage: Usage): string {
  return usage === 'still' && frame.kind === 'video' && frame.previewKey ? frame.previewKey : frame.key;
}

export function assetId(usage: Usage | 'pair' | 'reference', key: string): string {
  return `${usage}:${key}`;
}

// ── Prepare plan (job.json) and manifest (prep.json) ──────────────────────

/** still = ≤1920px JPEG (+ 512px check image); clip = ranked burst windows;
 * verified = the first 3s; voice = ≤3 voiced windows with audio + WAVs;
 * pair / reference = still only (reference: check image only). */
export type PrepareMode = 'still' | 'clip' | 'verified' | 'voice' | 'pair' | 'reference';

export interface PrepareItem {
  id: string;
  key: string;
  mode: PrepareMode;
  /** For stills: whether a 512px check image is needed. */
  checkImage: boolean;
}

function prepareMode(frame: FrameRef, usage: Usage): PrepareMode {
  if (usage === 'voice') return 'voice';
  if (usage === 'still' || frame.kind !== 'video') return 'still';
  return usage === 'verified' ? 'verified' : 'clip';
}

/** Every distinct asset the film needs, once. */
export function planPrepare(film: FilmScript): PrepareItem[] {
  const strict = isPublicFilm(film);
  const out = new Map<string, PrepareItem>();
  const add = (item: PrepareItem) => {
    const existing = out.get(item.id);
    if (existing) existing.checkImage = existing.checkImage || item.checkImage;
    else out.set(item.id, item);
  };
  for (const scene of film.scenes) {
    if (scene.type === 'sound') {
      // A video sound candidate shows on screen: its windows get check images
      // in a public film.
      for (const f of [scene.frame, ...scene.alternates]) add({ id: assetId('voice', f.key), key: f.key, mode: 'voice', checkImage: strict && f.kind === 'video' });
      continue;
    }
    for (const use of uses(scene, strict)) {
      const key = stillKey(use.frame, use.usage);
      const mode = prepareMode(use.frame, use.usage);
      add({ id: assetId(use.usage, key), key, mode, checkImage: use.checked && mode === 'still' && !isDrawing(use.frame) });
      if (use.frame.pairKey) add({ id: assetId('pair', use.frame.pairKey), key: use.frame.pairKey, mode: 'pair', checkImage: strict });
    }
  }
  const people = film.references?.length ? film.references : film.subjects ?? [];
  for (const p of people) {
    if (p.referenceKey) add({ id: assetId('reference', p.referenceKey), key: p.referenceKey, mode: 'reference', checkImage: true });
  }
  return [...out.values()];
}

export interface PreparedWindow extends Window {
  score?: number;
  voicedSeconds?: number;
  coverage?: number;
  /** The cut (video: 1080p/30fps, keyframe every second; voice keeps audio). */
  file: string | null;
  /** 512px JPEG from the middle of the window (frame check). */
  checkImage?: string | null;
  /** 16 kHz mono WAV of the window (voice check). */
  wav?: string | null;
}

export interface PreparedAsset {
  id: string;
  key: string;
  mode: PrepareMode;
  /** Still/pair: the ≤1920px JPEG. Clips: null (see windows). */
  file: string | null;
  /** Still/reference: the 512px check image. */
  checkImage: string | null;
  source: { width: number | null; height: number | null; duration: number | null; hasVideo: boolean };
  /** clip: ranked (liveliest first, ≤3); verified: 1; voice: ≤3 ranked. */
  windows: PreparedWindow[];
  warnings: string[];
}

export interface PrepareManifest {
  version: 1;
  assets: Record<string, PreparedAsset>;
}

// ── Voice (sound scene) ────────────────────────────────────────────────────

export interface VoiceNeed {
  ref: string;
  assetId: string;
  windowIndex: number;
  wav: string;
}

export type VoiceVerdicts = Record<string, VoiceCheck | null>;

export interface SoundChoice {
  /** The chosen candidate (primary or an alternate), or null: the scene drops. */
  frame: FrameRef | null;
  assetId: string | null;
  windowIndex: number | null;
  voice: VoiceCheck | null;
  verified: boolean;
  note: string;
}

export function voiceRef(id: string, windowIndex: number): string {
  return `${id}#${windowIndex}`;
}

function soundScene(film: FilmScript): Extract<FilmScene, { type: 'sound' }> | undefined {
  return film.scenes.find((s): s is Extract<FilmScene, { type: 'sound' }> => s.type === 'sound');
}

/**
 * The first candidate (primary, then alternates) whose first passing window
 * wins, windows tried in rank order. A check that couldn't run (`null`) stops
 * that candidate's windows. Audio memories are the parent's own clips: an
 * unchecked one passes; video fallbacks must be verified. Returns the next
 * check needed (one at a time — early exit keeps cost down) or the choice.
 * `blocked` (public films: blockedSoundWindows) are voice refs that failed
 * the strict frame check — those windows are skipped like a failed voice check.
 */
export function resolveSound(
  film: FilmScript,
  prep: PrepareManifest,
  verdicts: VoiceVerdicts,
  blocked: ReadonlySet<string> = new Set(),
): { need: VoiceNeed } | { done: SoundChoice | null } {
  const scene = soundScene(film);
  if (!scene) return { done: null };
  const passes = (voice: VoiceCheck | null) =>
    scene.source === 'audio' ? voice === null || isVoiceVerified(voice) : isVoiceVerified(voice);

  for (const candidate of [scene.frame, ...scene.alternates]) {
    const id = assetId('voice', candidate.key);
    const p = prep.assets[id];
    const windows = (p?.windows ?? []).filter((w) => w.file);
    if (windows.length === 0) continue;
    let last: { index: number; voice: VoiceCheck | null } | null = null;
    for (let i = 0; i < windows.length; i += 1) {
      const index = p.windows.indexOf(windows[i]);
      const ref = voiceRef(id, index);
      if (blocked.has(ref)) continue;
      if (!(ref in verdicts)) {
        if (!windows[i].wav) {
          last = { index, voice: null };
          break;
        }
        return { need: { ref, assetId: id, windowIndex: index, wav: windows[i].wav! } };
      }
      const voice = verdicts[ref];
      last = { index, voice };
      if (voice === null || isVoiceVerified(voice)) break;
    }
    if (last && passes(last.voice)) {
      return {
        done: {
          frame: candidate,
          assetId: id,
          windowIndex: last.index,
          voice: last.voice,
          verified: true,
          note: candidate === scene.frame ? '' : `primary sound failed the voice check → alternate ${candidate.memoryId}`,
        },
      };
    }
  }
  return {
    done: { frame: null, assetId: null, windowIndex: null, voice: null, verified: false, note: 'no candidate passed the voice check → scene would drop' },
  };
}


/** Public films only: the checks a video sound candidate's windows still need
 * (the strict frame check of the window's check image). Batchable. */
export function soundFrameNeeds(film: FilmScript, prep: PrepareManifest, verdicts: FrameVerdicts): FrameNeed[] {
  const scene = isPublicFilm(film) ? soundScene(film) : undefined;
  if (!scene) return [];
  const needs: FrameNeed[] = [];
  for (const candidate of [scene.frame, ...scene.alternates]) {
    if (candidate.kind !== 'video') continue;
    const id = assetId('voice', candidate.key);
    const p = prep.assets[id];
    (p?.windows ?? []).forEach((w, windowIndex) => {
      const ref = frameRef(id, windowIndex);
      if (w.file && w.checkImage && !(ref in verdicts)) needs.push({ ref, assetId: id, windowIndex, checkImage: w.checkImage });
    });
  }
  return needs;
}

/** Public films only: the voice refs of video sound windows that may not
 * carry the scene — the strict frame check removed the frame, found no
 * verdict, or there was no check image (fail closed). */
export function blockedSoundWindows(film: FilmScript, prep: PrepareManifest, verdicts: FrameVerdicts): Set<string> {
  const blocked = new Set<string>();
  const scene = isPublicFilm(film) ? soundScene(film) : undefined;
  if (!scene) return blocked;
  for (const candidate of [scene.frame, ...scene.alternates]) {
    if (candidate.kind !== 'video') continue;
    const id = assetId('voice', candidate.key);
    (prep.assets[id]?.windows ?? []).forEach((w, windowIndex) => {
      const ref = frameRef(id, windowIndex);
      const verdict = w.checkImage && ref in verdicts
        ? burstFrameVerdict(verdicts[ref] ?? undefined, null, new Set(), undefined, { publicAudience: true })
        : 'remove';
      if (verdict === 'remove') blocked.add(voiceRef(id, windowIndex));
    });
  }
  return blocked;
}

// ── Frame check ────────────────────────────────────────────────────────────

export interface FrameTarget {
  assetId: string;
  mode: PrepareMode;
  /** Where the frames sit: scene index + the frame objects (identity). */
  frames: { sceneIndex: number; frame: FrameRef }[];
  tags: string[] | undefined;
}

export interface FrameNeed {
  ref: string;
  assetId: string;
  windowIndex: number | null;
  checkImage: string;
}

export type FrameVerdicts = Record<string, FrameCheck | null>;

export interface FrameResolution {
  /** Chosen window per clip asset (default 0). */
  windows: Record<string, number>;
  /** Assets whose frames are removed from burst/title/end_card/close. */
  removed: string[];
}

export function frameRef(id: string, windowIndex: number | null): string {
  return windowIndex === null ? id : `${id}#${windowIndex}`;
}

/** Distinct prepared assets among checked uses. Drawings are made from the
 * memory's tagged people and aren't checked (F2 round 2). */
export function frameTargets(film: FilmScript, prep: PrepareManifest): FrameTarget[] {
  const targets = new Map<string, FrameTarget>();
  const strict = isPublicFilm(film);
  film.scenes.forEach((scene, sceneIndex) => {
    for (const use of uses(scene, strict)) {
      // A public film also checks the real photo behind a portrait's reveal.
      if (strict && use.frame.pairKey) {
        const pairId = assetId('pair', use.frame.pairKey);
        const pp = prep.assets[pairId];
        if (pp?.file && !targets.has(pairId)) targets.set(pairId, { assetId: pairId, mode: pp.mode, frames: [], tags: undefined });
      }
      if (!use.checked || isDrawing(use.frame)) continue;
      const id = assetId(use.usage, stillKey(use.frame, use.usage));
      const p = prep.assets[id];
      if (!p || (p.mode === 'still' ? !p.file : !p.windows.some((w) => w.file))) continue;
      const entry = targets.get(id) ?? { assetId: id, mode: p.mode, frames: [], tags: use.frame.tags };
      entry.frames.push({ sceneIndex, frame: use.frame });
      targets.set(id, entry);
    }
  });
  return [...targets.values()];
}

export interface FrameContext {
  /** Birthday films: the child who must be visible. */
  requiredChildId: string | null;
  ownChildIds: ReadonlySet<string>;
  /** False when no reference images exist — then nothing is checked. */
  hasReferences: boolean;
}

/**
 * Each target is checked on its first (or only) window; a flagged clip tries
 * its other windows in order until one is kept. Without a rescue,
 * 'prefer_other_window' (nobody in the window) keeps the original window and
 * 'remove' removes the frames. A missing check image or a failed check keeps
 * the frame (fail-open, like the eval) — except the holiday card film, which
 * is public and fails closed (docs/plans/holiday-cards.md §5): no verdict, no
 * check image, an upset face, or anything the strict public prompt flags
 * (bare torso, diaper, bath, nudity…: `underdressed`) removes the frame, same
 * as the F2 eval; and every frame of every scene is checked. Returns
 * every check needed for the current round (batchable) or the resolution.
 */
export function resolveFrames(
  film: FilmScript,
  prep: PrepareManifest,
  verdicts: FrameVerdicts,
  ctx: FrameContext,
): { needs: FrameNeed[] } | { done: FrameResolution } {
  const resolution: FrameResolution = { windows: {}, removed: [] };
  if (!ctx.hasReferences) return { done: resolution };
  const needs: FrameNeed[] = [];
  const failClosed = isPublicFilm(film);

  for (const target of frameTargets(film, prep)) {
    const p = prep.assets[target.assetId];
    const verdictAt = (windowIndex: number | null): 'keep' | 'prefer_other_window' | 'remove' | 'need' | 'no_image' => {
      const image = windowIndex === null ? p.checkImage : p.windows[windowIndex]?.checkImage;
      if (!image) return 'no_image';
      const ref = frameRef(target.assetId, windowIndex);
      if (!(ref in verdicts)) {
        needs.push({ ref, assetId: target.assetId, windowIndex, checkImage: image });
        return 'need';
      }
      return burstFrameVerdict(verdicts[ref] ?? undefined, ctx.requiredChildId, ctx.ownChildIds, target.tags, { failClosed, publicAudience: failClosed });
    };

    if (p.mode === 'still' || p.mode === 'pair' || p.mode === 'reference') {
      const v = verdictAt(null);
      if (v === 'remove' || (failClosed && v === 'no_image')) resolution.removed.push(target.assetId);
      continue;
    }

    const cut = p.windows.map((w, i) => (w.file ? i : -1)).filter((i) => i >= 0);
    const first = verdictAt(cut[0]);
    if (first === 'need') continue;
    if (first === 'keep' || (first === 'no_image' && !failClosed)) {
      resolution.windows[target.assetId] = cut[0];
      continue;
    }
    let rescued: number | null = null;
    let pending = false;
    for (const i of cut.slice(1)) {
      const v = verdictAt(i);
      if (v === 'need') {
        pending = true;
        break;
      }
      if (v === 'keep') {
        rescued = i;
        break;
      }
    }
    if (pending) continue;
    if (rescued !== null) resolution.windows[target.assetId] = rescued;
    else if (first === 'prefer_other_window') resolution.windows[target.assetId] = cut[0];
    else resolution.removed.push(target.assetId);
  }

  return needs.length > 0 ? { needs } : { done: resolution };
}

// ── film.json ──────────────────────────────────────────────────────────────

export type AnnotatedFrame = FrameRef & {
  file?: string | null;
  usage?: Usage;
  trim?: PreparedWindow | null;
  source?: PreparedAsset['source'];
  pairFile?: string | null;
  voice?: VoiceCheck | null;
};

function windowOf(p: PreparedAsset | undefined, index: number): PreparedWindow | null {
  return p?.windows[index] ?? null;
}

/** The renderer's input: the script with every frame annotated with its
 * prepared file, trim window and source dimensions, the sound choice
 * applied, and removed frames dropped. `bed` pins the music. */
export function applyPrepared(
  script: FilmScript,
  prep: PrepareManifest,
  sound: SoundChoice | null,
  frames: FrameResolution,
  bed: string,
): FilmScript & { bed: string } {
  const film = JSON.parse(JSON.stringify(script)) as FilmScript;
  const removed = new Set(frames.removed);
  const strict = isPublicFilm(film);

  film.scenes.forEach((scene, sceneIndex) => {
    if (scene.type === 'sound') {
      const original = script.scenes[sceneIndex] as Extract<FilmScene, { type: 'sound' }>;
      if (sound?.frame && sound.assetId !== null && sound.windowIndex !== null) {
        const chosenIndex = [original.frame, ...original.alternates].indexOf(sound.frame);
        const chosen = chosenIndex <= 0 ? scene.frame : scene.alternates[chosenIndex - 1];
        const w = windowOf(prep.assets[sound.assetId], sound.windowIndex);
        scene.frame = chosen;
        // The caption (and the frame's own date) belong to the memory whose audio
        // plays: a fallback never shows the primary's caption (null when the
        // script predates `alternateCaptions` — no caption beats a wrong one).
        if (chosenIndex > 0) scene.caption = scene.alternateCaptions?.[chosenIndex - 1] ?? null;
        Object.assign(scene.frame as AnnotatedFrame, { file: w?.file ?? null, usage: 'voice', trim: w, voice: sound.voice });
        Object.assign(scene, { voiceVerified: sound.verified, note: sound.note });
      } else {
        Object.assign(scene.frame as AnnotatedFrame, { file: null, usage: 'voice', trim: null, voice: null });
        Object.assign(scene, { voiceVerified: false, note: sound?.note ?? 'no sound candidates' });
      }
      return;
    }
    for (const use of uses(scene)) {
      const id = assetId(use.usage, stillKey(use.frame, use.usage));
      const p = prep.assets[id];
      const isClip = p && (p.mode === 'clip' || p.mode === 'verified');
      const w = isClip ? windowOf(p, frames.windows[id] ?? 0) : null;
      // A public film shows nothing the strict check removed, wherever the
      // asset is used (chapter cards, firsts, the close…): its file goes, and
      // the pass below drops the frame or the scene.
      const file = strict && removed.has(id) ? null : isClip ? w?.file ?? null : p?.file ?? null;
      Object.assign(use.frame as AnnotatedFrame, {
        file,
        usage: use.usage,
        trim: w,
        source: p?.source,
      });
      if (use.frame.pairKey) {
        const pairId = assetId('pair', use.frame.pairKey);
        Object.assign(use.frame as AnnotatedFrame, { pairFile: strict && removed.has(pairId) ? null : prep.assets[pairId]?.file ?? null });
      }
    }
    if (removed.size === 0) return;
    const keep = (f: FrameRef) => {
      const usage = uses({ ...scene } as FilmScene).find((u) => u.frame === f)?.usage ?? 'still';
      return !removed.has(assetId(usage, stillKey(f, usage)));
    };
    if (scene.type === 'burst') scene.frames = scene.frames.filter(keep);
    if (scene.type === 'title') scene.cards = scene.cards.filter(keep);
    if (scene.type === 'end_card') scene.grid = scene.grid.filter(keep);
    if (scene.type === 'close') scene.frames = scene.frames.filter(keep);
  });

  return { ...pruneUnpreparedScenes(film), bed };
}

/** The assembler needs a file for every frame it shows: drops frames whose
 * asset couldn't be prepared (or was removed), and scenes left without what
 * they need (a sound scene with no passing candidate "drops", as the F2 eval
 * noted). Pure; shared by applyPrepared and the F2 eval's public films. */
export function pruneUnpreparedScenes(film: FilmScript): FilmScript {
  const hasFile = (f: FrameRef | null | undefined) => !!(f as AnnotatedFrame | null | undefined)?.file;
  const kept: FilmScene[] = [];
  const dropped = [...(film.dropped ?? [])];
  for (const scene of film.scenes) {
    const drop = (reason: string) => dropped.push({ scene: scene.type, reason });
    switch (scene.type) {
      case 'sound':
        if (!hasFile(scene.frame)) {
          drop('no sound candidate passed the voice check');
          continue;
        }
        break;
      case 'cold_open':
        if (!hasFile(scene.to)) {
          drop('portrait could not be prepared');
          continue;
        }
        if (scene.from && !hasFile(scene.from)) scene.from = null;
        break;
      case 'award':
        if (!hasFile(scene.frame)) {
          drop('award frame could not be prepared');
          continue;
        }
        break;
      case 'line':
        if (scene.frame && !hasFile(scene.frame)) scene.frame = null;
        break;
      case 'title':
        scene.cards = scene.cards.filter(hasFile);
        break;
      case 'end_card':
        scene.grid = scene.grid.filter(hasFile);
        break;
      case 'counters':
        scene.backdrop = (scene.backdrop ?? []).filter(hasFile);
        break;
      case 'burst':
      case 'close':
        scene.frames = scene.frames.filter(hasFile);
        if (scene.frames.length === 0) {
          drop('no frame could be prepared');
          continue;
        }
        break;
      case 'starring':
        scene.people = scene.people
          .filter((p) => hasFile(p.portrait))
          .map((p) => ({ ...p, moments: p.moments.filter(hasFile) }));
        if (scene.together) scene.together = scene.together.filter((t) => hasFile(t.portrait));
        if (scene.people.length === 0) {
          drop('no portrait could be prepared');
          continue;
        }
        break;
      case 'firsts':
        scene.items = scene.items.map((item) => (item.frame && !hasFile(item.frame) ? { ...item, frame: undefined } : item));
        break;
      case 'chapter':
        if (scene.portrait && !hasFile(scene.portrait)) scene.portrait = null;
        scene.frames = scene.frames.filter(hasFile);
        break;
    }
    kept.push(scene);
  }

  return { ...film, scenes: kept, dropped };
}
