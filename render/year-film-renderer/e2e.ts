/**
 * Local end-to-end test of the render image's job modes (docs/plans/
 * year-film-p1.md Step 6/10) — synthetic media only, no family data, no
 * OpenAI. Builds a real FilmScript with the production monthly builder,
 * uploads its source media to an S3-compatible test store, then runs the
 * image exactly as the Worker would: thumbs → prepare → (checks resolved with
 * stand-in "keep"/"clear" verdicts through the shared resolvers) → film.json
 * → render, and verifies every output.
 *
 *   docker network create yf-test
 *   docker run -d --name yf-s3 --network yf-test --network-alias s3 -p 9100:9090 \
 *     -e COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=momora-test adobe/s3mock
 *   ALLOW_DIRTY=1 ./build.sh
 *   deno run --allow-all --node-modules-dir=none --sloppy-imports render/year-film-renderer/e2e.ts
 *
 * Env: E2E_S3_HOST (default http://localhost:9100), E2E_S3_ALIAS (container
 * endpoint, default http://s3:9090), E2E_NETWORK (default yf-test),
 * E2E_OUT (where film.mp4/poster.jpg/scenes.json are copied).
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from 'npm:@aws-sdk/client-s3@3';
import {
  applyPrepared,
  planPrepare,
  type PrepareManifest,
  resolveFrames,
  resolveSound,
} from '../../supabase/functions/_shared/year-film-assets.ts';
import { buildMonthlyScript, checkKey, monthlyVisionCandidates, type FilmMemorySource, type FilmPerson } from '../../supabase/functions/_shared/year-film-script.ts';
import type { FrameCheck } from '../../supabase/functions/_shared/year-film-vision.ts';

const HOST = Deno.env.get('E2E_S3_HOST') ?? 'http://localhost:9100';
const ALIAS = Deno.env.get('E2E_S3_ALIAS') ?? 'http://s3:9090';
const NETWORK = Deno.env.get('E2E_NETWORK') ?? 'yf-test';
const BUCKET = 'momora-test';
const IMAGE = Deno.env.get('E2E_IMAGE') ?? 'year-film-renderer';
const OUT = Deno.env.get('E2E_OUT') ?? await Deno.makeTempDir({ prefix: 'yf-e2e-out-' });
const OWNER = '0e2e0000-0000-4000-8000-000000000001';
const FILM = '0e2e0000-0000-4000-8000-000000000f11';
const ATTEMPT = crypto.randomUUID();
const PREFIX = `${OWNER}/year-films/${FILM}/${ATTEMPT}/`;

const s3 = new S3Client({ region: 'auto', endpoint: HOST, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const put = async (key: string, body: Uint8Array | string, type: string) =>
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: type }));
const getJson = async <T>(key: string): Promise<T> =>
  JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body!.transformToString());
const getBytes = async (key: string) =>
  await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body!.transformToByteArray();

async function sh(cmd: string, args: string[], stderr = false): Promise<string> {
  const out = await new Deno.Command(cmd, { args, stdout: 'piped', stderr: 'piped' }).output();
  if (!out.success) throw new Error(`${cmd} failed: ${new TextDecoder().decode(out.stderr).slice(-800)}`);
  return new TextDecoder().decode(stderr ? out.stderr : out.stdout);
}

function check(cond: unknown, label: string) {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

// ── Synthetic media ───────────────────────────────────────────────────────

const media = await Deno.makeTempDir({ prefix: 'yf-e2e-media-' });
const f = (name: string) => `${media}/${name}`;
console.log('generating synthetic media…');
for (let i = 1; i <= 8; i += 1) {
  const [w, h] = i % 2 ? [1600, 1200] : [1200, 1600];
  await sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}`, '-frames:v', '1', '-vf', `hue=h=${i * 40}`, f(`photo${i}.jpg`)]);
}
await sh('sips', ['-s', 'format', 'heic', f('photo8.jpg'), '--out', f('photo8.heic')]);
for (let i = 1; i <= 3; i += 1) {
  await sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=12`, '-f', 'lavfi', '-i',
    `aevalsrc=0.4*sin(2*PI*${250 + i * 60}*t)*lt(mod(t\\,3)\\,2)+0.003*(2*random(0)-1):d=12`, '-vf', `hue=h=${i * 90}`, '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f(`clip${i}.mp4`)]);
}
// A phone-quiet voice: real (synthesized) speech at ≈ −46 LUFS, one short
// phrase at 3 s. ffmpeg 5.1's loudnorm (the image's) left exactly this kind
// of excerpt quiet under the bed (Sep 2026 canary); a steady tone doesn't
// reproduce it.
await sh('say', ['-o', f('speech.aiff'), 'Hola papá, mira, un perro']);
await sh('ffmpeg', ['-v', 'error', '-y', '-i', f('speech.aiff'), '-f', 'lavfi', '-i', 'aevalsrc=0.0005*(2*random(0)):d=8:s=22050',
  '-filter_complex', '[0:a]adelay=3000,volume=-30dB,apad[v];[v][1:a]amix=inputs=2:duration=shortest:normalize=0', '-c:a', 'aac', f('voice.m4a')]);
await sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=900x900', '-frames:v', '1', f('ref.jpg')]);
await sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1024x1024', '-frames:v', '1', '-vf', 'hue=s=0', f('portrait.jpg')]);

const src = (name: string) => `${OWNER}/memories/e2e/${name}`;
const uploads: [string, string, string][] = [
  ...[1, 2, 3, 4, 5, 6, 7].map((i) => [src(`photo${i}.jpg`), f(`photo${i}.jpg`), 'image/jpeg'] as [string, string, string]),
  [src('photo8.heic'), f('photo8.heic'), 'image/heic'],
  ...[1, 2, 3].map((i) => [src(`clip${i}.mp4`), f(`clip${i}.mp4`), 'video/mp4'] as [string, string, string]),
  [src('voice.m4a'), f('voice.m4a'), 'audio/mp4'],
  [src('ref.jpg'), f('ref.jpg'), 'image/jpeg'],
  [src('portrait.jpg'), f('portrait.jpg'), 'image/jpeg'],
];
for (const [key, file, type] of uploads) await put(key, await Deno.readFile(file), type);
console.log(`uploaded ${uploads.length} source objects`);

// ── A real FilmScript from the production builder ─────────────────────────

const kid: FilmPerson = {
  id: 'kid', name: 'Leo Test', dateOfBirth: '2023-05-01', relationship: 'child', createdAt: '2024-01-01T00:00:00Z',
  portraits: [{
    id: 'pv1', family_member_id: 'kid', reference_date: '2026-01-01', profile_picture_key: src('ref.jpg'),
    illustrated_profile_key: src('portrait.jpg'), illustrated_profile_status: 'ready', created_at: '2026-01-01T00:00:00Z',
  }],
};
const memory = (id: string, day: number, assets: FilmMemorySource['assets'], emotion = 'joy'): FilmMemorySource => ({
  id, date: `2026-09-${String(day).padStart(2, '0')}`, type: assets[0]?.kind === 'audio' ? 'audio' : 'media', text: `Moment ${id}`,
  emotion, topics: ['park'], taggedMemberIds: ['kid'], illustrationReady: false, illustrationKey: null,
  media: assets.map((a) => ({ kind: a.kind, durationMs: a.durationMs, hasPreview: a.kind === 'image' })), assets, reported: false,
});
const image = (name: string) => ({ kind: 'image' as const, key: src(name), previewKey: null, durationMs: null, aspectRatio: 1.33 });
const video = (name: string) => ({ kind: 'video' as const, key: src(name), previewKey: null, durationMs: 12000, aspectRatio: 1.78 });
const memories: FilmMemorySource[] = [
  ...[1, 2, 3, 4, 5, 6, 7].map((i) => memory(`p${i}`, i * 3, [image(`photo${i}.jpg`)], i % 2 ? 'joy' : 'funny')),
  memory('p8', 23, [image('photo8.heic')]),
  ...[1, 2, 3].map((i) => memory(`v${i}`, i * 4 + 1, [video(`clip${i}.mp4`)], 'joy')),
  memory('a1', 27, [{ kind: 'audio', key: src('voice.m4a'), previewKey: null, durationMs: 8000, aspectRatio: null }], 'funny'),
];
const input = { yearMonth: '2026-09', memories, children: [kid], milestones: [], quotes: [], language: 'en' as const };
const script = buildMonthlyScript(input);
console.log(`script: ${script.scenes.length} scenes (${script.scenes.map((s) => s.type).join(', ')})`);

// ── Run a mode like the Worker does ───────────────────────────────────────

async function runMode(mode: 'thumbs' | 'prepare' | 'render', job: unknown) {
  const jobKey = mode === 'thumbs' ? 'thumbs/job.json' : mode === 'prepare' ? 'prep/job.json' : 'job.json';
  await put(`${PREFIX}${jobKey}`, JSON.stringify(job), 'application/json');
  const started = Date.now();
  await sh('docker', [
    'run', '--rm', '--network', NETWORK, '--platform', 'linux/amd64',
    '-e', `JOB_PREFIX=${PREFIX}`, '-e', `R2_ENDPOINT=${ALIAS}`, '-e', `R2_BUCKET=${BUCKET}`,
    '-e', 'R2_ACCESS_KEY_ID=test', '-e', 'R2_SECRET_ACCESS_KEY=test', '-e', 'JOB_TIMEOUT_SECONDS=2400', '-e', 'JOB_DEBUG=1',
    IMAGE, mode,
  ]);
  const statusKey = mode === 'thumbs' ? 'thumbs/status.json' : mode === 'prepare' ? 'prep/status.json' : 'status.json';
  const status = await getJson<{ state: string; durationMs?: number }>(`${PREFIX}${statusKey}`);
  console.log(`${mode}: ${status.state} in ${Math.round((Date.now() - started) / 1000)}s`);
  check(status.state === 'done', `${mode} status is done`);
  return status;
}

// thumbs
const candidateKeys = [...new Set([...monthlyVisionCandidates(input).map(checkKey), src('ref.jpg')])];
await runMode('thumbs', { version: 1, mode: 'thumbs', prefix: PREFIX, items: candidateKeys.map((key) => ({ key })) });
const thumbs = await getJson<{ images: Record<string, string | null> }>(`${PREFIX}thumbs/manifest.json`);
check(candidateKeys.every((k) => thumbs.images[k]), `a thumbnail for each of ${candidateKeys.length} candidates (videos → frame 0)`);

// prepare
const items = planPrepare(script);
await runMode('prepare', { version: 1, mode: 'prepare', prefix: PREFIX, items });
const prep = await getJson<PrepareManifest>(`${PREFIX}prep/prep.json`);
const assets = Object.values(prep.assets);
check(assets.length === items.length, `prep.json covers all ${items.length} items`);
const heic = assets.find((a) => a.key.endsWith('.heic'));
check(!heic || heic.file, 'the HEIC still was decoded (heif-convert)');
const clips = assets.filter((a) => a.mode === 'clip');
check(clips.every((c) => c.windows.length > 0 && c.windows[0].file && c.windows[0].checkImage), `every clip has ranked cuts with check frames (${clips.length} clips)`);
const voice = assets.filter((a) => a.mode === 'voice');
check(voice.length > 0 && voice.every((v) => v.windows.length > 0 && v.windows.every((w) => w.wav && w.file)), `voice candidates have cut windows + WAVs (${voice.length} candidates)`);
check(assets.filter((a) => a.mode === 'reference').every((r) => r.checkImage), 'reference portraits have check images');

// checks (stand-in verdicts) → film.json
const keep: FrameCheck = { mainSubject: 'kid', childrenVisible: ['kid'], faceVisible: true, expression: 'smiling', quality: 'good', unsafe: false, screenCapture: false };
const voiceVerdicts: Record<string, { childVoice: 'clear'; adultDominant: false; startsCleanly: true; heard: string }> = {};
let sound = resolveSound(script, prep, voiceVerdicts);
for (let i = 0; i < 12 && 'need' in sound; i += 1) {
  voiceVerdicts[sound.need.ref] = { childVoice: 'clear', adultDominant: false, startsCleanly: true, heard: '' };
  sound = resolveSound(script, prep, voiceVerdicts);
}
const frameVerdicts: Record<string, FrameCheck> = {};
const ctx = { requiredChildId: null, ownChildIds: new Set(['kid']), hasReferences: true };
let frames = resolveFrames(script, prep, frameVerdicts, ctx);
for (let i = 0; i < 6 && 'needs' in frames; i += 1) {
  for (const n of frames.needs) frameVerdicts[n.ref] = keep;
  frames = resolveFrames(script, prep, frameVerdicts, ctx);
}
check('done' in sound && 'done' in frames, 'voice and frame resolution complete');
const film = applyPrepared(script, prep, 'done' in sound ? sound.done : null, 'done' in frames ? frames.done : { windows: {}, removed: [] }, 'playful-piano');
await put(`${PREFIX}film.json`, JSON.stringify(film), 'application/json');

// render
const rendered = await runMode('render', { version: 1, mode: 'render', prefix: PREFIX, film: 'film.json' });
check((rendered.durationMs ?? 0) > 15_000, `film is ${Math.round((rendered.durationMs ?? 0) / 100) / 10}s`);
await Deno.writeFile(`${OUT}/film.mp4`, await getBytes(`${PREFIX}film.mp4`));
await Deno.writeFile(`${OUT}/poster.jpg`, await getBytes(`${PREFIX}poster.jpg`));
const scenes = await getJson<{ scenes: { type: string }[]; durationMs: number }>(`${PREFIX}scenes.json`);
await Deno.writeTextFile(`${OUT}/scenes.json`, JSON.stringify(scenes, null, 2));
const probe = JSON.parse(await sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', `${OUT}/film.mp4`]));
const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
check(v?.width === 1080 && v?.height === 1920, 'film.mp4 is 1080×1920');
check(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'), 'film.mp4 has audio');
check(scenes.scenes.length > 3, `scenes.json lists ${scenes.scenes.length} scenes`);
// The voice must sit well above the carved bed (0.07 ≈ −23 dB, ≈ −39 dB
// mean) in the sound scene.
const soundScene = (scenes.scenes as { type: string; startMs: number }[]).find((s) => s.type === 'sound');
check(soundScene, 'film has a sound scene');
if (soundScene) {
  const at = soundScene.startMs / 1000 + 0.7;
  const vol = await sh('ffmpeg', ['-hide_banner', '-nostats', '-ss', at.toFixed(2), '-t', '1.2', '-i', `${OUT}/film.mp4`, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], true);
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(vol)?.[1] ?? -99);
  check(mean > -28, `sound scene voice is audible (${mean} dB mean)`);
}
console.log(`\nAll render modes passed. Output: ${OUT}`);
