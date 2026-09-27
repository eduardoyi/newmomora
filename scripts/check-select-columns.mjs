#!/usr/bin/env node
// Schema-contract check: every column the code asks PostgREST for must exist
// in the migrated database. Unit tests mock Supabase, so a select naming a
// column that doesn't exist sails through them and only fails in production
// -- which is exactly how the data export broke for two months
// (memory_media.preview_content_type, user_profiles.illustration_style).
//
// Scans app, Edge Function and Worker sources for:
//   .from('table') ... .select('a, b, c')      (supabase-js chains)
//   listRows(env, 'table', 'a,b,c'...)          (Worker PostgREST helpers)
// and verifies each plain column against information_schema of the local
// database (run after `supabase db start`, i.e. with every migration
// applied). Embedded relations `rel(...)`, `*`, aliases and casts are
// skipped -- they're resolved differently and rarer.
//
// Usage: DATABASE_URL=postgresql://... node scripts/check-select-columns.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SCAN_DIRS = ['src', 'app', 'supabase/functions', 'cloudflare', 'workers'];
const SKIP = /(node_modules|\.test\.|\.integration\.test\.|__tests__|\/test\/|\/dist\/|worker-configuration\.d\.ts)/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (SKIP.test(path)) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Plain column names from a select list; relations/aliases/casts/wildcards skipped. */
function plainColumns(selectList) {
  // Drop embedded relations, including nested parentheses.
  let flat = selectList;
  let previous;
  do {
    previous = flat;
    flat = flat.replace(/[\w!:.]+\s*\([^()]*\)/g, '');
  } while (flat !== previous);
  return flat
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/[*:!()]/.test(part) && !part.includes('->'))
    .map((part) => part.split(/\s+/)[0]);
}

const usages = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const source = readFileSync(file, 'utf8');
    // supabase-js: .from('table') followed (same chain, before the next
    // .from or statement end) by .select('...') / .select(`...`)
    const fromPattern = /\.from\(\s*['"`]([a-z_][a-z0-9_]*)['"`]\s*\)/g;
    for (const match of source.matchAll(fromPattern)) {
      const rest = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
      const stop = rest.search(/\.from\(|;\s*\n/);
      const window = stop === -1 ? rest : rest.slice(0, stop);
      const select = /\.select\(\s*(['"`])([\s\S]*?)\1/.exec(window);
      if (!select || select[2].includes('${')) continue;
      usages.push({ file, line: lineOf(source, match.index), table: match[1], columns: plainColumns(select[2]) });
    }
    // Worker helpers: listRows/listRowsByIds(<T>?)(env, 'table', 'a,b,c'
    const helperPattern = /listRows(?:ByIds)?(?:<[^>]*>)?\(\s*env\s*,\s*['"]([a-z_][a-z0-9_]*)['"]\s*,\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(helperPattern)) {
      usages.push({ file, line: lineOf(source, match.index), table: match[1], columns: plainColumns(match[2]) });
    }
  }
}

const tables = [...new Set(usages.map((usage) => usage.table))];
const sql = `select table_name || '.' || column_name from information_schema.columns
  where table_schema = 'public' and table_name in (${tables.map((t) => `'${t}'`).join(',') || "''"})`;
const known = new Set(
  execFileSync('psql', [DATABASE_URL, '-tAc', sql], { encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter(Boolean),
);
const knownTables = new Set([...known].map((entry) => entry.split('.')[0]));

const problems = [];
for (const usage of usages) {
  // Tables not in public (e.g. storage) or RPC-backed names: only check
  // tables the database actually has, and flag unknown tables separately.
  if (!knownTables.has(usage.table)) {
    problems.push(`${relative(ROOT, usage.file)}:${usage.line}  unknown table "${usage.table}"`);
    continue;
  }
  for (const column of usage.columns) {
    if (!known.has(`${usage.table}.${column}`)) {
      problems.push(`${relative(ROOT, usage.file)}:${usage.line}  ${usage.table}.${column} does not exist`);
    }
  }
}

console.log(`Checked ${usages.length} selects across ${tables.length} tables.`);
if (problems.length > 0) {
  console.error(`\n${problems.length} select(s) name columns the migrated schema doesn't have:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('Every selected column exists.');
