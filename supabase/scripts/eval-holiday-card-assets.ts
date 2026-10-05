/**
 * Holiday Card C3 -- assets for the card design + print PDF
 * (docs/plans/holiday-cards.md §6 C3). Gathers everything `book-renderer`'s
 * card preview and `card:pdf` need for ONE real card into
 * `book-renderer/card-data/<slug>/` (gitignored: real family photos + letters):
 *
 *   card.json          the card's data (schema: book-renderer/src/card/types.ts)
 *   assets/photo-<id8>.<ext>  the front photo ORIGINAL plus the top ~12 C1 picks
 *                      (the editor's "Change photo" candidates), originals,
 *                      EXIF orientation baked in
 *   assets/portrait-<id8>.<ext>  each core member's current ready illustrated
 *                      portrait (the back's signature element)
 *   assets/illustration-<id>.webp   the illustrated front alternatives, copied
 *                      from eval-output (latest file per scene id)
 *
 * Inputs: the front photo (`--front-media`, default = Eduardo's chosen photo
 * #1), the letters JSON of `eval:holiday-card-letters` (4 variants + QR caption
 * + signature + family name), the card greeting and language.
 *
 * QR: `https://m.usemomora.com/f/<token>` with a freshly generated 22-char
 * base62 token (the same generator as the book's share tokens). The token is
 * PERSISTED in card.json and reused on every re-run, so it never changes for
 * this card (C5 registers it in `film_share_tokens`). Nothing is written to the
 * database here.
 *
 * READ-ONLY. The media row is read through the RLS-scoped client (the
 * service-role client only bootstraps the session); the photo comes from R2 by
 * a GET. PII rule: letter and memory text is NEVER printed; stdout is ids,
 * counts and pixel sizes only.
 *
 * Examples:
 *   npm run eval:holiday-card-assets -- --slug yi-2026
 *   npm run eval:holiday-card-assets -- --slug yi-2026 --greeting holidays --no-qr
 *   (--scenes tree,winter-walk,window-light  --language es-CO  --year 2026
 *    --front-json <C1 front json>  --options 12  --no-portraits  --today YYYY-MM-DD)
 *   npm run eval:holiday-card-assets -- --front-media <media id> --focal 0.5,0.4
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { generateShareToken } from '../functions/_shared/memory-book-manifest.ts';
import { coreFamilyMemberIds } from '../functions/_shared/holiday-card-photos.ts';
import { resolvePortraitVersionAtDate, type PortraitVersionCandidate } from '../functions/_shared/portrait-versions.ts';
import { getObjectBytes, getR2Config } from '../functions/_shared/r2.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

const DEFAULT_FRONT_MEDIA = 'e0683496-8ebf-4e49-844d-909b0721d8d8';
const DEFAULT_SLUG = 'family-2026';
const OUTPUT_DIR = 'supabase/scripts/eval-output/holiday-card';
const DEFAULT_LETTERS = `${OUTPUT_DIR}/2026-10-04T22-57-06-710Z-letters.json`;
const QR_BASE_URL = 'https://m.usemomora.com/f';
/** Scenes the owner kept (round 1 dropped snow and table as too much). */
const DEFAULT_SCENES = ['tree', 'winter-walk', 'window-light'];
/** The C1 front JSON whose ranked picks feed the picker (round 2 of the front eval). */
const DEFAULT_FRONT_JSON = `${OUTPUT_DIR}/2026-10-04T19-42-58-383Z-front.json`;

const GREETINGS = ['christmas', 'holidays', 'new-year'] as const;
type Greeting = (typeof GREETINGS)[number];

interface Args {
  frontMedia: string;
  letters: string;
  slug: string;
  greeting: Greeting;
  language: string | null;
  year: number;
  qr: boolean;
  scenes: string[];
  frontJson: string;
  options: number;
  portraits: boolean;
  today: string;
  greetingPosition: string | null;
  focal: { x: number; y: number } | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    frontMedia: DEFAULT_FRONT_MEDIA,
    letters: DEFAULT_LETTERS,
    slug: DEFAULT_SLUG,
    greeting: 'christmas',
    language: null,
    year: new Date().getFullYear(),
    qr: true,
    scenes: DEFAULT_SCENES,
    frontJson: DEFAULT_FRONT_JSON,
    options: 12,
    portraits: true,
    today: new Date().toISOString().slice(0, 10),
    greetingPosition: null,
    focal: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--front-media':
        if (!next) throw new Error('--front-media needs a media id');
        args.frontMedia = next;
        i += 1;
        break;
      case '--letters':
        if (!next) throw new Error('--letters needs a path');
        args.letters = next;
        i += 1;
        break;
      case '--slug':
        if (!next || !/^[a-z0-9][a-z0-9-]*$/.test(next)) throw new Error('--slug must be kebab-case');
        args.slug = next;
        i += 1;
        break;
      case '--greeting':
        if (!next || !(GREETINGS as readonly string[]).includes(next)) {
          throw new Error(`--greeting must be one of ${GREETINGS.join('|')}`);
        }
        args.greeting = next as Greeting;
        i += 1;
        break;
      case '--language':
        if (!next || !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(next)) throw new Error('--language must look like es-CO');
        args.language = next;
        i += 1;
        break;
      case '--year':
        if (!/^\d{4}$/.test(next ?? '')) throw new Error('--year must be a 4-digit year');
        args.year = Number(next);
        i += 1;
        break;
      case '--scenes':
        if (!next) throw new Error('--scenes needs a comma-separated list of scene ids');
        args.scenes = next.split(',').map((id) => id.trim()).filter(Boolean);
        i += 1;
        break;
      case '--greeting-position':
        if (!/^(top|bottom)-(left|center|right)$/.test(next ?? '')) throw new Error('--greeting-position must be e.g. top-center');
        args.greetingPosition = next!;
        i += 1;
        break;
      case '--front-json':
        if (!next) throw new Error('--front-json needs a path');
        args.frontJson = next;
        i += 1;
        break;
      case '--options':
        if (!/^\d+$/.test(next ?? '')) throw new Error('--options needs a number (picker photos, default 12)');
        args.options = Number(next);
        i += 1;
        break;
      case '--today':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next ?? '')) throw new Error('--today must be YYYY-MM-DD');
        args.today = next!;
        i += 1;
        break;
      case '--no-portraits':
        args.portraits = false;
        break;
      case '--no-qr':
        args.qr = false;
        break;
      case '--focal': {
        const m = /^(\d*\.?\d+),(\d*\.?\d+)$/.exec(next ?? '');
        if (!m || Number(m[1]) > 1 || Number(m[2]) > 1) throw new Error('--focal must be "x,y" with both in 0..1');
        args.focal = { x: Number(m[1]), y: Number(m[2]) };
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

// ── Auth (same pattern as the other holiday-card evals) ──────────────────

function supabaseEnv() {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceRoleKey || !anonKey) throw new Error('Missing Supabase env vars in supabase/.env.local');
  return { supabaseUrl, serviceRoleKey, anonKey };
}

async function createAuthedClient() {
  const { supabaseUrl, serviceRoleKey, anonKey } = supabaseEnv();
  const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: userEmail });
  if (linkError || !linkData.properties?.hashed_token) throw new Error(linkError?.message ?? 'Failed to generate auth link');
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: sessionData, error: sessionError } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });
  if (sessionError || !sessionData.session?.access_token) throw new Error(sessionError?.message ?? 'Failed to create session');
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Letters JSON (the eval's output; text is copied, never printed) ──────

interface LettersRun {
  language: string;
  signature: string;
  variants: { tone: string; text: string }[];
  qrCaption: string | null;
}

interface LettersFile {
  setting?: { resolved?: { language?: string; locale?: string | null } };
  digest: { familyName: string; language: string };
  runs: LettersRun[];
}

async function readLetters(path: string): Promise<LettersFile> {
  const parsed = JSON.parse(await Deno.readTextFile(path)) as LettersFile;
  if (!parsed.digest?.familyName || !Array.isArray(parsed.runs) || parsed.runs.length === 0) {
    throw new Error('Letters JSON has no digest or runs');
  }
  return parsed;
}

// ── Images ───────────────────────────────────────────────────────────────

interface Dims {
  width: number;
  height: number;
}

/** Pixel size with EXIF orientations 5-8 (90 degree turns) applied. */
async function probeDims(bytes: Uint8Array): Promise<{ dims: Dims; orientation: number }> {
  const { imageSize } = await import('npm:image-size@1.2.1');
  const { width, height, orientation } = imageSize(bytes);
  if (!width || !height) throw new Error('Could not read the image size');
  const turned = orientation !== undefined && orientation >= 5;
  return { dims: turned ? { width: height, height: width } : { width, height }, orientation: orientation ?? 1 };
}

/** JPEG with a non-upright EXIF orientation (or any non-JPEG/PNG/WebP format):
 * decode with ffmpeg (which applies the rotation) into a near-lossless JPEG. */
async function bakeOrientation(bytes: Uint8Array): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeFile(`${dir}/in`, bytes);
    const { code } = await new Deno.Command('ffmpeg', {
      args: ['-v', 'error', '-y', '-i', `${dir}/in`, '-frames:v', '1', '-q:v', '1', `${dir}/out.jpg`],
    }).output();
    if (code !== 0) throw new Error('ffmpeg could not decode the photo');
    return await Deno.readFile(`${dir}/out.jpg`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function sniff(bytes: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────

const args = parseArgs(Deno.args);
const cardDir = `book-renderer/card-data/${args.slug}`;
const assetsDir = `${cardDir}/assets`;
await Deno.mkdir(assetsDir, { recursive: true });

// 1. Letters.
const lettersFile = await readLetters(args.letters);
const resolved = lettersFile.setting?.resolved;
const locale = args.language ?? resolved?.locale ?? (resolved?.language ? resolved.language : 'es-CO');
const language = locale.slice(0, 2).toLowerCase();
const run = lettersFile.runs.find((r) => r.language === language) ?? lettersFile.runs[0];
if (!run || run.variants.length === 0) throw new Error('No letter variants in the letters JSON');
console.log(`letters: ${run.variants.map((v) => `${v.tone}=${Array.from(v.text).length}ch`).join(' ')}; caption ${run.qrCaption ? 'yes' : 'no'}; language ${language}`);

// 2. Photos: the chosen front photo + the top picks of the C1 front JSON.
getR2Config(); // fail fast with a clear error when R2 env is missing
const supabase = await createAuthedClient();

interface PhotoOut {
  id: string;
  memoryId: string;
  file: string;
  width: number;
  height: number;
  date: string | null;
  rank: number | null;
  thumb: string;
}

/** A 480 px JPEG preview for the picker grid (the originals are several MB each). */
async function writeThumb(source: string, target: string): Promise<void> {
  const { code } = await new Deno.Command('ffmpeg', {
    args: ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', "scale='if(gt(iw,ih),480,-2)':'if(gt(iw,ih),-2,480)'", '-q:v', '4', target],
  }).output();
  if (code !== 0) throw new Error('ffmpeg could not write a thumbnail');
}

/** Downloads one photo original (RLS-scoped media row, R2 GET) into assets/. Returns null when unreadable. */
async function savePhoto(mediaId: string, rank: number | null): Promise<PhotoOut | null> {
  const { data: media, error } = await supabase
    .from('memory_media')
    .select('id, memory_id, object_key, content_type')
    .eq('id', mediaId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read memory_media: ${error.message}`);
  if (!media || !String(media.content_type).startsWith('image/')) return null;
  const { data: memory } = await supabase.from('memories').select('memory_date').eq('id', media.memory_id).maybeSingle();
  const original = await getObjectBytes(media.object_key);
  const kind = sniff(original);
  const probe = await probeDims(original);
  let bytes = original;
  let ext: string = kind ?? 'jpg';
  if (kind === null || (kind === 'jpg' && probe.orientation !== 1)) {
    bytes = await bakeOrientation(original);
    ext = 'jpg';
  }
  const dims = bytes === original ? probe.dims : (await probeDims(bytes)).dims;
  const file = `assets/photo-${mediaId.slice(0, 8)}.${ext}`;
  await Deno.writeFile(`${cardDir}/${file}`, bytes);
  const thumb = `assets/thumb-${mediaId.slice(0, 8)}.jpg`;
  await writeThumb(`${cardDir}/${file}`, `${cardDir}/${thumb}`);
  console.log(
    `photo ${mediaId.slice(0, 8)} (rank ${rank ?? '-'}): ${dims.width}x${dims.height} px, ${(bytes.length / 1024 / 1024).toFixed(1)} MB${bytes === original ? '' : ', orientation baked'}`,
  );
  return { id: mediaId, memoryId: media.memory_id, file, width: dims.width, height: dims.height, date: memory?.memory_date ?? null, rank, thumb };
}

const pickIds: { id: string; rank: number }[] = [];
try {
  const front = JSON.parse(await Deno.readTextFile(args.frontJson)) as { picks?: { candidate: { mediaId: string } }[] };
  (front.picks ?? []).slice(0, args.options).forEach((p, i) => pickIds.push({ id: p.candidate.mediaId, rank: i + 1 }));
} catch {
  console.log(`front json not readable (${args.frontJson}): the picker will only have the chosen photo`);
}
const rankOf = new Map(pickIds.map((p) => [p.id, p.rank]));
const wanted = [{ id: args.frontMedia, rank: rankOf.get(args.frontMedia) ?? null }, ...pickIds.filter((p) => p.id !== args.frontMedia)];

// Drop stale photo files from earlier runs.
for await (const entry of Deno.readDir(assetsDir)) {
  if (/^(front|photo|portrait|thumb)-?.*\.(jpg|png|webp)$/.test(entry.name) || /^front\.(jpg|png|webp)$/.test(entry.name)) {
    await Deno.remove(`${assetsDir}/${entry.name}`);
  }
}
const photos: PhotoOut[] = [];
for (const w of wanted) {
  const saved = await savePhoto(w.id, w.rank);
  if (saved) photos.push(saved);
  else if (w.id === args.frontMedia) throw new Error(`The front media ${w.id} is not a readable photo`);
}
const front = photos[0];

// 3. Illustrated alternatives: the latest `*-front-scene-<id>.webp` per id.
const sceneFiles = new Map<string, string>();
for await (const entry of Deno.readDir(OUTPUT_DIR)) {
  const m = /^(.+)-front-scene-([a-z0-9-]+)\.webp$/.exec(entry.name);
  if (!m || !args.scenes.includes(m[2])) continue;
  const prev = sceneFiles.get(m[2]);
  if (!prev || entry.name > prev) sceneFiles.set(m[2], entry.name);
}
const illustrations: { id: string; file: string; width: number; height: number; source: string }[] = [];
for (const [id, name] of [...sceneFiles].sort(([a], [b]) => a.localeCompare(b))) {
  const bytes = await Deno.readFile(`${OUTPUT_DIR}/${name}`);
  const { dims } = await probeDims(bytes);
  const file = `assets/illustration-${id}.webp`;
  await Deno.writeFile(`${cardDir}/${file}`, bytes);
  illustrations.push({ id, file, width: dims.width, height: dims.height, source: name });
  console.log(`illustration ${id}: ${dims.width}x${dims.height} px (${name})`);
}

// 4. Core family portraits (the signature element): own children + parents,
//    each with their CURRENT ready illustrated portrait. A member without one
//    is left out (never a placeholder).
interface PortraitOut {
  memberId: string;
  name: string;
  role: 'parent' | 'child';
  file: string;
  width: number;
  height: number;
}
const portraits: PortraitOut[] = [];
if (args.portraits) {
  const { data: mem } = await supabase.from('memories').select('family_id').eq('id', front.memoryId).maybeSingle();
  const familyId = mem?.family_id as string | undefined;
  if (!familyId) throw new Error('Could not resolve the family of the front photo');
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth, relationship, illustrated_profile_key, illustrated_profile_status')
    .eq('family_id', familyId);
  if (membersError) throw new Error(`Failed to load family_members: ${membersError.message}`);
  const rows = (members ?? []) as {
    id: string;
    name: string;
    date_of_birth: string | null;
    relationship: string | null;
    illustrated_profile_key: string | null;
    illustrated_profile_status: string | null;
  }[];
  const { data: versionRows, error: versionError } = await supabase
    .from('family_member_portrait_versions')
    .select('id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, created_at')
    .in('family_member_id', rows.map((r) => r.id));
  if (versionError) throw new Error(`Failed to load portrait versions: ${versionError.message}`);
  const versions = (versionRows ?? []) as PortraitVersionCandidate[];
  const coreIds = coreFamilyMemberIds(rows.map((r) => ({ id: r.id, dateOfBirth: r.date_of_birth, relationship: r.relationship })), args.today);
  const core = rows.filter((r) => coreIds.has(r.id)).sort((a, b) => {
    const rank = (m: { relationship: string | null }) => (m.relationship === 'parent' ? 0 : 1);
    return rank(a) - rank(b) || (a.date_of_birth ?? '').localeCompare(b.date_of_birth ?? '') || a.id.localeCompare(b.id);
  });
  for (const member of core.slice(0, 6)) {
    const resolved = resolvePortraitVersionAtDate(versions.filter((v) => v.family_member_id === member.id), args.today);
    const key = resolved?.illustrated_profile_key ?? (member.illustrated_profile_status === 'ready' ? member.illustrated_profile_key : null);
    if (!key) {
      console.log(`portrait: member ${member.id.slice(0, 8)} has no ready illustrated portrait, left out`);
      continue;
    }
    const bytes = await getObjectBytes(key);
    const { dims } = await probeDims(bytes);
    const ext = sniff(bytes) ?? 'png';
    const file = `assets/portrait-${member.id.slice(0, 8)}.${ext}`;
    await Deno.writeFile(`${cardDir}/${file}`, bytes);
    portraits.push({ memberId: member.id, name: member.name.split(/\s+/)[0], role: member.relationship === 'parent' ? 'parent' : 'child', file, width: dims.width, height: dims.height });
    console.log(`portrait ${member.id.slice(0, 8)} (${portraits.at(-1)!.role}): ${dims.width}x${dims.height} px`);
  }
}

// 5. The QR token: persisted, never regenerated for this card.
let token: string | null = null;
let previousFocal: { x: number; y: number } | null = null;
let previousPosition: string | null = null;
try {
  const previous = JSON.parse(await Deno.readTextFile(`${cardDir}/card.json`));
  if (typeof previous?.qr?.token === 'string' && /^[0-9A-Za-z]{22}$/.test(previous.qr.token)) token = previous.qr.token;
  if (typeof previous?.photo?.greetingPosition === 'string') previousPosition = previous.photo.greetingPosition;
  const f = previous?.photo?.focal;
  if (previous?.photo?.mediaId === args.frontMedia && typeof f?.x === 'number' && typeof f?.y === 'number') previousFocal = f;
} catch {
  // First run for this slug.
}
const reusedToken = token !== null;
token ??= generateShareToken();

// 6. card.json.
const frontOptions = [
  ...photos.map((p) => ({ id: p.id, kind: 'photo' as const, file: p.file, width: p.width, height: p.height, thumb: p.thumb, ...(p.date ? { date: p.date } : {}), ...(p.rank ? { rank: p.rank } : {}) })),
  ...illustrations.map((i) => ({ id: `illustration-${i.id}`, kind: 'illustration' as const, file: i.file, width: i.width, height: i.height, label: i.id })),
];
const card = {
  version: 1,
  slug: args.slug,
  year: args.year,
  language,
  locale,
  greeting: args.greeting,
  familyName: lettersFile.digest.familyName,
  signature: run.signature,
  qrCaption: run.qrCaption,
  qr: { enabled: args.qr, token, url: `${QR_BASE_URL}/${token}` },
  letters: run.variants.map((v) => ({ tone: v.tone, text: v.text })),
  photo: {
    mediaId: front.id,
    memoryId: front.memoryId,
    file: front.file,
    width: front.width,
    height: front.height,
    ...((args.greetingPosition ?? previousPosition) ? { greetingPosition: args.greetingPosition ?? previousPosition } : {}),
    ...((args.focal ?? previousFocal) ? { focal: args.focal ?? previousFocal } : {}),
  },
  illustrations: illustrations.map(({ id, file, width, height }) => ({ id, file, width, height })),
  frontOptions,
  portraits,
};
await Deno.writeTextFile(`${cardDir}/card.json`, JSON.stringify(card, null, 2) + '\n');
console.log(
  `wrote ${cardDir}/card.json (QR token ${reusedToken ? 'reused' : 'new'}, ${args.qr ? 'QR on' : 'QR off'}, greeting ${args.greeting}, ${photos.length} photos, ${illustrations.length} illustrations, ${portraits.length} portraits)`,
);
