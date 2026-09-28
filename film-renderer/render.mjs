#!/usr/bin/env node
/**
 * Local renders (docs/plans/year-film.md §10 F3): assemble each film into the
 * shared HyperFrames project, run `hyperframes check`, and render it to
 * composition/renders/<slug>.mp4 (gitignored — real family data). Films
 * render one at a time: they share the project folder.
 *
 * usage: node film-renderer/render.mjs <slug> [<slug> …]
 *        node film-renderer/render.mjs --all     (every film in film-data/)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, 'composition');
const HYPERFRAMES = 'hyperframes@0.8.80'; // same pin as composition/package.json

const args = process.argv.slice(2);
const slugs = args.includes('--all')
  ? fs.readdirSync(path.join(HERE, 'film-data')).filter((d) => fs.existsSync(path.join(HERE, 'film-data', d, 'film.json')) && d !== 'sample')
  : args;
if (slugs.length === 0) throw new Error('usage: node film-renderer/render.mjs <slug> [<slug> …] | --all');

fs.mkdirSync(path.join(PROJECT, 'renders'), { recursive: true });
const results = [];
for (const slug of slugs) {
  const started = Date.now();
  try {
    execFileSync('node', [path.join(HERE, 'assemble.mjs'), slug], { stdio: 'inherit' });
    execFileSync('npx', ['--yes', HYPERFRAMES, 'check'], { cwd: PROJECT, stdio: ['ignore', 'ignore', 'inherit'] });
    const out = `renders/${slug}.mp4`;
    execFileSync('npx', ['--yes', HYPERFRAMES, 'render', '-o', out, '--video-frame-format', 'jpg'], { cwd: PROJECT, stdio: ['ignore', 'ignore', 'inherit'] });
    results.push(`${slug}: ok → composition/${out} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (err) {
    results.push(`${slug}: FAILED (${err.message.split('\n')[0]})`);
  }
  console.log(results.at(-1));
}
console.log(`\n${results.join('\n')}`);
if (results.some((r) => r.includes('FAILED'))) process.exit(1);
