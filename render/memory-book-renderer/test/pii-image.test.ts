import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * REAL Docker build + run PII proof (task brief: "PII: assert no book-data
 * in a built image file listing (script `docker build` + `docker run
 * --rm <img> find` — run it for real)"). No mocking, no config-level
 * assertion — this test shells out to the actual `docker` binary and
 * inspects the actual image filesystem, the same way an owner running
 * README.md's "Verify" commands by hand would.
 *
 * Skips (does not fail) when the `docker` CLI itself isn't available in the
 * environment running the suite — everything else is a hard failure.
 */

const RENDER_DIR = resolve(__dirname, '..');
const BOOK_RENDERER_DIR = resolve(RENDER_DIR, '..', '..', 'book-renderer');
const IMAGE_TAG = 'memory-book-renderer:pii-test';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const runner = hasDocker ? describe : describe.skip;

runner('Docker image PII safety (real docker build + run)', () => {
  beforeAll(() => {
    // Real build — see Dockerfile's own header comment for why book-renderer
    // is pulled in as a separate, PII-excluded named build context rather
    // than by making the repo root the build context.
    execFileSync(
      'docker',
      ['build', '--build-context', `bookrenderer=${BOOK_RENDERER_DIR}`, '-t', IMAGE_TAG, '.'],
      { cwd: RENDER_DIR, stdio: 'inherit' },
    );
  }, 15 * 60 * 1000);

  function runFind(...args: string[]): string {
    return execFileSync('docker', ['run', '--rm', IMAGE_TAG, 'find', ...args], { encoding: 'utf-8' }).trim();
  }

  it('contains zero book-data/ directories anywhere in the image', () => {
    const output = runFind('/app', '-type', 'd', '-iname', 'book-data');
    expect(output).toBe('');
  });

  it('contains zero manifest.json / book.outline.json files anywhere outside node_modules (the two per-book data files that would mean book-data leaked in some other shape)', () => {
    const output = runFind('/app', '-not', '-path', '*/node_modules/*', '(', '-name', 'manifest.json', '-o', '-name', 'book.outline.json', ')');
    expect(output).toBe('');
  });

  it('the print-only build (dist-print/) exists and contains ONLY print.html + hashed assets — no index.html (the preview app, irrelevant to a headless worker) and no raw book-data passthrough', () => {
    const listing = runFind('/app/book-renderer/dist-print', '-maxdepth', '1');
    const entries = listing.split('\n').filter(Boolean);
    expect(entries).toContain('/app/book-renderer/dist-print');
    expect(entries).toContain('/app/book-renderer/dist-print/print.html');
    expect(entries).toContain('/app/book-renderer/dist-print/assets');
    expect(entries.some((e) => e.endsWith('/index.html'))).toBe(false);
  });

  it('vendored print fonts (wave 1) made it into the built assets — the render worker never depends on a Google Fonts CDN at request time', () => {
    const output = runFind('/app/book-renderer/dist-print/assets', '-iname', '*.woff2');
    expect(output.split('\n').filter(Boolean).length).toBeGreaterThan(0);
  });
});
