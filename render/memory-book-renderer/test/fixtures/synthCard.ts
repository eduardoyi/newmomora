import zlib from 'node:zlib';

/**
 * Fully synthetic card fixture (the repo is PUBLIC: nothing here comes from
 * book-renderer/card-data/). A fictional family ("Rivera Soto": Tomás and Lucía),
 * a generated gradient "photo" and generated portrait discs.
 */

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An RGB PNG; `pixel(x, y)` returns [r, g, b]. */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}

export function gradientPhoto(width: number, height: number): Buffer {
  return makePng(width, height, (x, y) => [Math.floor((x / width) * 200) + 30, Math.floor((y / height) * 160) + 50, 180 - Math.floor((x / width) * 90)]);
}

export function portraitDisc(size: number, hue: [number, number, number]): Buffer {
  const r = size / 2;
  return makePng(size, size, (x, y) => ((x - r) ** 2 + (y - r) ** 2 < r * r ? hue : [250, 246, 240]));
}

export const FRONT_FILE = 'assets/front.png';
export const TOMAS_FILE = 'assets/portrait-1.png';
export const LUCIA_FILE = 'assets/portrait-2.png';

const WORDS = 'la familia Rivera Soto salió al parque con Lucía y Tomás y comimos helado mientras el sol se escondía detrás de los árboles'.split(' ');
export function letterOf(chars: number): string {
  let out = '';
  for (let i = 0; out.length < chars; i += 1) out += `${WORDS[i % WORDS.length]} `;
  return out.trim();
}

export interface SynthOptions {
  /** Front picture pixel size (default 2000x1500: ~270 dpi on a 5R page). */
  photo?: [number, number];
  letterChars?: number;
  qr?: boolean;
}

export function synthCard(options: SynthOptions = {}) {
  const [photoW, photoH] = options.photo ?? [2000, 1500];
  const letter = `${letterOf(options.letterChars ?? 420)}\n\n${letterOf(160)}`;
  const card = {
    version: 1,
    slug: 'rivera-soto-synth',
    year: 2026,
    language: 'es',
    locale: 'es-ES',
    greeting: 'christmas',
    familyName: 'Rivera Soto',
    signature: 'Con cariño, la familia Rivera Soto',
    qrCaption: 'Escanea para ver nuestro año',
    qr: { enabled: options.qr ?? true, token: 'AAAAAAAAAAAAAAAAAAAAAA', url: 'https://m.usemomora.com/f/AAAAAAAAAAAAAAAAAAAAAA' },
    letters: [{ tone: 'classic', text: letter }],
    photo: { file: FRONT_FILE, width: photoW, height: photoH },
    illustrations: [],
    portraits: [
      { memberId: 'm-1', name: 'Tomás', role: 'child', file: TOMAS_FILE, width: 256, height: 256 },
      { memberId: 'm-2', name: 'Lucía', role: 'child', file: LUCIA_FILE, width: 256, height: 256 },
    ],
  };
  const edits = { version: 1, text: {}, letters: {}, focalPoints: {}, frontImage: null, choices: { layout: 'full-bleed', tone: 'classic' } };
  const assets: Record<string, Buffer> = {
    [FRONT_FILE]: gradientPhoto(photoW, photoH),
    [TOMAS_FILE]: portraitDisc(256, [120, 170, 210]),
    [LUCIA_FILE]: portraitDisc(256, [220, 150, 160]),
  };
  return { card, edits, assets };
}

/** Presigned-looking URLs (never fetched in tests: a fake fetchAsset reads the bytes by URL). */
export function fakeUrls(files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f, `https://assets.example.com/${encodeURIComponent(f)}?X-Amz-Signature=fake`]));
}
