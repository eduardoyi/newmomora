#!/usr/bin/env node
// PII bundle guard for the `book.usemomora.com` web app (memory-book-5b
// plan, Step 7). `vite.web.config.ts` is SUPPOSED to make it impossible for
// `dist-web/` to contain book-data (1.9GB of real exported family books —
// child PII) or the preview/print entries — but "the config says so" is not
// something this task treats as sufficient proof for a build output that,
// if wrong, ships child PII to a public URL (`book.usemomora.com`). This
// script inspects the REAL build output on disk, every time `build:web`
// runs (see package.json — it is not optional/CI-only).
//
// What it checks, and why each one is a hard invariant:
//   1. `index.html` / `print.html` must not exist in dist-web/ — these are
//      the OTHER two Vite entries (`vite.config.ts`'s `main`/`print`); their
//      presence would mean this build somehow pulled in the wrong config or
//      the wrong outDir got reused.
//   2. `book-data/` must not exist in dist-web/ — this is the literal 1.9GB
//      PII directory (`vite.config.ts`'s `publicDir`). Its presence would
//      mean `publicDir: false` in `vite.web.config.ts` was bypassed or
//      reverted.
//   3. No `manifest.json` / `book.outline.json` anywhere in the tree — these
//      are the two per-book data files inside every `book-data/<slug>/`
//      folder (see `src/model/loader.ts`); their presence anywhere in the
//      bundle (even outside a literal `book-data/` folder name) is the same
//      class of leak this check exists to catch, so it is a name-based scan
//      of the whole tree, not just a check of one directory's absence.
//   4. `web.html` (or its hashed/renamed build output, at least one *.html)
//      DOES exist — a bundle check that would also pass on an EMPTY or
//      totally-broken build is not actually verifying anything.
//   5. No `.js`/`.mjs` chunk contains the substring "fixture" (case-
//      insensitive) — the DEV-ONLY `?fixture=<slug>` diagnostic mode
//      (`src/web/dev/fixture.ts`) is gated behind `import.meta.env.DEV` at
//      every call site specifically so a production build's dead-code
//      elimination removes it entirely (see that file's own header comment
//      for the mechanism) — this check proves that actually happened for
//      THIS build's real output, rather than trusting the gating alone.
//      Minifiers rename identifiers but never rewrite string-literal
//      VALUES, so a leftover reference (the `'fixture'` query-param name,
//      or any of that module's own function names surviving unminified in
//      a dev-mode/sourcemap build) is a reliable signal the elimination
//      didn't happen, even though none of this is itself book-content PII
//      — it would mean the fixture code path (and the `book-data/`-shaped
//      fetches it makes) is reachable from a production bundle at all.
//
// Exit code 0 = pass (safe to deploy the directory's contents). Any failure
// prints every violation found (not just the first) and exits 1 — a CI
// pipeline or the coordinator's own dry-run should treat non-zero as a hard
// stop, never a warning.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST_WEB = join(__dirname, '..', 'dist-web');

const FORBIDDEN_TOP_LEVEL = ['index.html', 'print.html', 'book-data'];
const FORBIDDEN_FILENAMES = new Set(['manifest.json', 'book.outline.json']);
const JS_FILE_PATTERN = /\.m?js$/;
const FIXTURE_REFERENCE_PATTERN = /fixture/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const violations = [];

  if (!existsSync(DIST_WEB)) {
    console.error(`check-web-bundle: ${DIST_WEB} does not exist — run "npm run build:web" first.`);
    process.exit(1);
  }
  if (!statSync(DIST_WEB).isDirectory()) {
    console.error(`check-web-bundle: ${DIST_WEB} is not a directory.`);
    process.exit(1);
  }

  for (const name of FORBIDDEN_TOP_LEVEL) {
    if (existsSync(join(DIST_WEB, name))) {
      violations.push(`dist-web/${name} must not exist (PII/other-entry guard)`);
    }
  }

  const allFiles = walk(DIST_WEB);
  for (const file of allFiles) {
    const base = file.split('/').pop();
    if (FORBIDDEN_FILENAMES.has(base)) {
      violations.push(`forbidden file present: ${relative(DIST_WEB, file)} (book-data manifest/outline shape)`);
    }
  }

  const hasHtml = allFiles.some((f) => f.endsWith('.html'));
  if (!hasHtml) {
    violations.push('no .html entry found at all — build likely produced an empty/broken bundle (this check would trivially "pass" on nothing)');
  }

  for (const file of allFiles) {
    if (!JS_FILE_PATTERN.test(file)) continue;
    const content = readFileSync(file, 'utf8');
    if (FIXTURE_REFERENCE_PATTERN.test(content)) {
      violations.push(
        `dev-only fixture mode leaked into the production bundle: ${relative(DIST_WEB, file)} contains "fixture" — ` +
          'src/web/dev/fixture.ts (or a reference to it) was not tree-shaken out; see that file\'s header comment',
      );
    }
  }

  if (violations.length > 0) {
    console.error('check-web-bundle: FAILED — dist-web/ is not safe to deploy:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  console.log(`check-web-bundle: OK — ${allFiles.length} file(s) in dist-web/, no book-data, no index.html/print.html.`);
}

main();
