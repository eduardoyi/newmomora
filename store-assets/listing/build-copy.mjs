#!/usr/bin/env node
// store-assets/listing/build-copy.mjs
//
// Generates the plain-text App Store Connect field files from the single
// canonical copy registry (registry.v2.json). Node ESM, no dependencies.
//
// Usage: node store-assets/listing/build-copy.mjs
//
// Output: store-assets/listing/out/en-US/{name,subtitle,promotional-text,
//         description,keywords,whats-new,screenshot-copy}.txt
//
// This script writes exactly what is in the registry: no added trailing
// blank lines, no Markdown, no JSON, no comments, no placeholder tokens.
// It fails loudly (non-zero exit, no partial/empty files written) if the
// registry is missing a required field.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, 'registry.v2.json');
const OUT_DIR = path.join(__dirname, 'out', 'en-US');

function fail(message) {
  console.error(`[build-copy] ERROR: ${message}`);
  process.exit(1);
}

function loadRegistry() {
  let raw;
  try {
    raw = readFileSync(REGISTRY_PATH, 'utf8');
  } catch (err) {
    fail(`cannot read registry at ${REGISTRY_PATH}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`registry is not valid JSON: ${err.message}`);
  }
  return data;
}

// Ensure LF-only line endings (defensive; the registry is authored LF already).
function toLf(str) {
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const REQUIRED_PUBLIC_FIELDS = [
  'name',
  'subtitle',
  'promotional_text',
  'description',
  'keywords',
  'whats_new',
];

const FIELD_TO_FILENAME = {
  name: 'name.txt',
  subtitle: 'subtitle.txt',
  promotional_text: 'promotional-text.txt',
  description: 'description.txt',
  keywords: 'keywords.txt',
  whats_new: 'whats-new.txt',
};

function main() {
  const registry = loadRegistry();

  const publicFields = registry.public_fields;
  if (!publicFields || typeof publicFields !== 'object') {
    fail('registry.public_fields is missing.');
  }

  const missing = REQUIRED_PUBLIC_FIELDS.filter(
    (key) => typeof publicFields[key] !== 'string' || publicFields[key].length === 0
  );
  if (missing.length > 0) {
    fail(`registry.public_fields is missing required field(s): ${missing.join(', ')}`);
  }

  const screenshots = registry.screenshots;
  if (!Array.isArray(screenshots) || screenshots.length !== 7) {
    fail(`registry.screenshots must be an array of exactly 7 frames (found ${Array.isArray(screenshots) ? screenshots.length : typeof screenshots}).`);
  }
  for (const frame of screenshots) {
    for (const key of ['id', 'position', 'headline', 'support']) {
      if (frame[key] === undefined || frame[key] === null || frame[key] === '') {
        fail(`screenshot frame ${frame.id ?? '(unknown)'} is missing required field "${key}".`);
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // Write the six ASC public fields, verbatim, no added trailing newline.
  for (const key of REQUIRED_PUBLIC_FIELDS) {
    const filename = FIELD_TO_FILENAME[key];
    const content = toLf(publicFields[key]);
    writeFileSync(path.join(OUT_DIR, filename), content, { encoding: 'utf8' });
    console.log(`[build-copy] wrote ${path.join('out', 'en-US', filename)} (${[...content].length} chars, ${Buffer.byteLength(content, 'utf8')} bytes)`);
  }

  // Internal, human-readable listing of the seven frames for the renderer
  // team. Not an ASC field — informational only.
  const screenshotLines = [];
  screenshotLines.push('MOMORA v2 SCREENSHOT COPY (internal — not an App Store Connect field)');
  screenshotLines.push('Generated from store-assets/listing/registry.v2.json. Do not upload this file.');
  screenshotLines.push('');
  for (const frame of screenshots) {
    screenshotLines.push(`Frame ${frame.position} — ${frame.id}`);
    screenshotLines.push(`Headline: ${frame.headline.replace(/\n/g, ' / ')}`);
    screenshotLines.push(`Support: ${frame.support}`);
    screenshotLines.push(`Disclosure: ${frame.disclosure ?? '(none)'}`);
    screenshotLines.push('');
  }
  // Remove the trailing blank line to avoid trailing blank-line drift.
  while (screenshotLines.length > 0 && screenshotLines[screenshotLines.length - 1] === '') {
    screenshotLines.pop();
  }
  const screenshotContent = toLf(screenshotLines.join('\n'));
  writeFileSync(path.join(OUT_DIR, 'screenshot-copy.txt'), screenshotContent, { encoding: 'utf8' });
  console.log(`[build-copy] wrote ${path.join('out', 'en-US', 'screenshot-copy.txt')}`);

  console.log('[build-copy] done.');
}

main();
