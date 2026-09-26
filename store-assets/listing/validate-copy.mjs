#!/usr/bin/env node
// store-assets/listing/validate-copy.mjs
//
// Real validator for the v2 App Store listing copy. Node ESM, no dependencies.
// Run after store-assets/listing/build-copy.mjs.
//
// Usage: node store-assets/listing/validate-copy.mjs
//
// Checks (see docs/app-store-revamp/PLAN.md and the WP-B task brief):
//   1. Literal limits on the EXPORTED files read from disk (not the registry
//      in memory): name/subtitle <=30 chars, promotional_text <=170 chars,
//      description/whats_new <=4000 chars, keywords <=100 UTF-8 bytes.
//      Characters are counted with [...str].length (code points, not UTF-16
//      units) so astral characters are not miscounted.
//   2. Registry <-> export equality: regenerate the six fields in memory from
//      registry.v2.json and compare byte-for-byte against what's on disk.
//   3. No Markdown/JSON/placeholder delimiters leaked into public fields.
//   4. Owner reference dollar amounts never appear in any public field.
//   5. Forbidden-claim vocabulary (search, recap, widget, Looking Back) is
//      absent from public fields, word-boundary checked.
//   6. Stale-v1 scan over active listing paths only.
//
// Prints a JSON report to stdout and writes
// store-assets/listing/out/COPY-VALIDATION.json. Exits non-zero on error.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LISTING_DIR = __dirname; // store-assets/listing
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(LISTING_DIR, 'registry.v2.json');
const OUT_DIR = path.join(LISTING_DIR, 'out', 'en-US');
const REPORT_PATH = path.join(LISTING_DIR, 'out', 'COPY-VALIDATION.json');

const errors = [];
function check(condition, message) {
  if (!condition) errors.push(message);
}

function toLf(str) {
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ---------------------------------------------------------------------------
// Load registry + exported files
// ---------------------------------------------------------------------------

let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
} catch (err) {
  console.error(`[validate-copy] Cannot read registry: ${err.message}`);
  process.exit(1);
}

const FIELD_TO_FILENAME = {
  name: 'name.txt',
  subtitle: 'subtitle.txt',
  promotional_text: 'promotional-text.txt',
  description: 'description.txt',
  keywords: 'keywords.txt',
  whats_new: 'whats-new.txt',
};

const FIELD_LIMITS = {
  // key: [limit, unit]  unit: 'chars' (code points) or 'bytes' (UTF-8)
  name: [30, 'chars'],
  subtitle: [30, 'chars'],
  promotional_text: [170, 'chars'],
  description: [4000, 'chars'],
  whats_new: [4000, 'chars'],
  keywords: [100, 'bytes'],
};

const publicFields = registry.public_fields || {};
const counts = {};
const exported = {};

for (const [key, filename] of Object.entries(FIELD_TO_FILENAME)) {
  const filePath = path.join(OUT_DIR, filename);
  let diskContent;
  try {
    diskContent = readFileSync(filePath, 'utf8');
  } catch (err) {
    errors.push(`${filename}: cannot read exported file (${err.message}). Run build-copy.mjs first.`);
    continue;
  }
  exported[key] = diskContent;

  // 1. Literal limits, measured on the EXPORTED file.
  const [limit, unit] = FIELD_LIMITS[key];
  let count;
  if (unit === 'bytes') {
    count = Buffer.byteLength(diskContent, 'utf8');
  } else {
    count = [...diskContent].length;
  }
  counts[`${key}_${unit === 'bytes' ? 'utf8_bytes' : 'characters'}`] = count;
  check(count <= limit, `${key}: exported ${filename} is ${count} ${unit}, exceeds limit of ${limit}.`);

  // 2. Registry <-> export equality (byte-for-byte, regenerated in memory).
  const registryValue = typeof publicFields[key] === 'string' ? toLf(publicFields[key]) : undefined;
  check(
    registryValue !== undefined,
    `${key}: registry.public_fields.${key} is missing or not a string.`
  );
  if (registryValue !== undefined) {
    check(
      diskContent === registryValue,
      `${filename}: registry/export mismatch (byte-for-byte), including whitespace.`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Markdown / JSON / placeholder delimiter scan on public fields
// ---------------------------------------------------------------------------

const DELIMITER_PATTERNS = [
  { name: '**', re: /\*\*/ },
  { name: '##', re: /##/ },
  { name: '{{', re: /\{\{/ },
  { name: '}}', re: /\}\}/ },
  { name: 'TODO', re: /TODO/ },
  { name: 'TKTK', re: /TKTK/ },
  { name: '<', re: /</ },
  { name: '>', re: />/ },
  { name: 'backtick', re: /`/ },
];

function isPureJsonPunctuationLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return /^[{}\[\]",:]+$/.test(trimmed);
}

for (const [key, content] of Object.entries(exported)) {
  for (const { name, re } of DELIMITER_PATTERNS) {
    if (re.test(content)) {
      errors.push(`${key}: public field contains forbidden delimiter/markup ${JSON.stringify(name)}.`);
    }
  }
  for (const line of content.split('\n')) {
    if (isPureJsonPunctuationLine(line)) {
      errors.push(`${key}: public field contains a line that is pure JSON punctuation: ${JSON.stringify(line)}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Owner reference dollar amounts must never appear in public fields
// ---------------------------------------------------------------------------

const DOLLAR_AMOUNT_RE = /\$\d+/;
for (const [key, content] of Object.entries(exported)) {
  const match = content.match(DOLLAR_AMOUNT_RE);
  check(!match, `${key}: public field contains a dollar amount (${match ? match[0] : ''}); owner reference prices must not appear in public fields (see registry.commercial_context.public_exact_prices_guard).`);
}

// ---------------------------------------------------------------------------
// 5. Forbidden-claim vocabulary, word-boundary checked
// ---------------------------------------------------------------------------

const FORBIDDEN_VOCAB = registry.forbidden_public_vocabulary || ['search', 'recap', 'widget', 'Looking Back'];

function wordBoundaryRegexFor(term) {
  // Escape regex metacharacters, then wrap with word-boundary anchors.
  // "Looking Back" is a two-word phrase; \b works at its start/end too
  // since it starts/ends with word characters.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

for (const [key, content] of Object.entries(exported)) {
  for (const term of FORBIDDEN_VOCAB) {
    const re = wordBoundaryRegexFor(term);
    const match = content.match(re);
    if (match) {
      errors.push(`${key}: forbidden-claim vocabulary ${JSON.stringify(term)} found in public field (matched ${JSON.stringify(match[0])}). See PLAN.md §2.4 — this feature is not claimable.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Stale-v1 scan over ACTIVE listing paths only
// ---------------------------------------------------------------------------

const staleStrings = [
  ...(registry.superseded_active_strings || []),
  ...(registry.superseded_2026_08_slide_headlines || []),
];

// Active listing paths to scan: store-assets/listing/** (this tooling's own
// tree) and store-assets/manifest.v2.json if present. store-assets/manifest.json
// itself is the preserved v1 artifact and is EXEMPT, as are the handoff folder
// and any path containing "archive".
const TEXT_EXTENSIONS = new Set(['.json', '.mjs', '.js', '.txt', '.html', '.md']);

function isExempt(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  if (rel.startsWith(`momora-listing-handoff-v2${path.sep}`) || rel === 'momora-listing-handoff-v2') return true;
  if (rel.split(path.sep).includes('archive')) return true;
  if (rel === path.join('store-assets', 'manifest.json')) return true; // preserved v1 artifact, read-only, exempt
  // registry.v2.json is the source of truth that RECORDS the superseded
  // strings (superseded_active_strings / superseded_2026_08_slide_headlines)
  // so the scanner has something to check against; it is metadata about
  // history, not active default public/generated copy, so it is exempt from
  // being scanned for containing the very strings it documents.
  if (rel === path.join('store-assets', 'listing', 'registry.v2.json')) return true;
  // The generated validation report echoes any matches it finds in its own
  // "errors" array; exempt it so a past failing run's report can't cause a
  // permanent self-referential failure.
  if (rel === path.join('store-assets', 'listing', 'out', 'COPY-VALIDATION.json')) return true;
  return false;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (isExempt(abs)) continue;
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) out.push(abs);
    }
  }
}

const scanTargets = [];
const listingDirAbs = path.join(REPO_ROOT, 'store-assets', 'listing');
if (existsSync(listingDirAbs)) walk(listingDirAbs, scanTargets);
const manifestV2Path = path.join(REPO_ROOT, 'store-assets', 'manifest.v2.json');
if (existsSync(manifestV2Path) && !isExempt(manifestV2Path)) scanTargets.push(manifestV2Path);

const staleHits = [];
for (const filePath of scanTargets) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    continue;
  }
  for (const stale of staleStrings) {
    if (content.includes(stale)) {
      staleHits.push({ file: path.relative(REPO_ROOT, filePath), string: stale });
    }
  }
}
for (const hit of staleHits) {
  errors.push(`stale-v1 scan: superseded string ${JSON.stringify(hit.string)} found in ${hit.file}.`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const report = {
  brief_version: registry.brief_version,
  registry_version: registry.registry_version,
  scope: 'Literal copy limits, registry/export equality, forbidden vocabulary/markup/price scan, and a stale-v1 scan over active listing paths only. NOT live product, pricing, image or release QA.',
  status: errors.length === 0 ? 'pass' : 'fail',
  counts,
  errors,
  not_verified: [
    'Live feature availability and screenshot capture provenance',
    'Localized prices, book-preparation entitlement, shipping and legal links',
    'Final store images, native device captures, rendering pipeline and experiments',
    'Customer understanding, willingness to pay, conversion and retention',
    'Whether the What’s New text belongs to the actual release being submitted',
  ],
};

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8' });
console.log(JSON.stringify(report, null, 2));

process.exit(errors.length === 0 ? 0 : 1);
