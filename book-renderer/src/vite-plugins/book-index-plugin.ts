import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Scans `book-data/<slug>/` for `manifest.json` + `book.outline.json` pairs
 * and writes `book-data/index.json` — a small directory listing the preview
 * app's BookPicker reads over HTTP (as a static asset under /book-data/).
 *
 * This is a dev/build-time convenience, not part of the data contract itself:
 * the manifest and outline are the real inputs (see book-renderer/README
 * intent in the loader). Runs once at server start and on every request to
 * /book-data/index.json so newly-dropped books (e.g. from the export script)
 * show up without restarting the dev server.
 */

export interface BookIndexEntry {
  slug: string;
  childName: string;
  scopeLabel: string;
}

export interface BookIndex {
  generatedAt: string;
  books: BookIndexEntry[];
}

const BOOK_DATA_DIR = 'book-data';

function scanBookData(root: string): BookIndex {
  const dataDir = path.join(root, BOOK_DATA_DIR);
  const books: BookIndexEntry[] = [];

  if (!fs.existsSync(dataDir)) {
    return { generatedAt: new Date().toISOString(), books };
  }

  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const manifestPath = path.join(dataDir, slug, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      books.push({
        slug,
        childName: manifest?.child?.name ?? slug,
        scopeLabel: manifest?.scope?.label ?? '',
      });
    } catch {
      // Malformed manifest — skip it rather than crash the dev server.
      continue;
    }
  }

  books.sort((a, b) => a.slug.localeCompare(b.slug));
  return { generatedAt: new Date().toISOString(), books };
}

function writeIndex(root: string) {
  const index = scanBookData(root);
  const outPath = path.join(root, BOOK_DATA_DIR, 'index.json');
  fs.mkdirSync(path.join(root, BOOK_DATA_DIR), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(index, null, 2));
  return index;
}

// book-data/ is Vite's publicDir, so it is served at the site root — the
// generated index therefore lives at the URL /index.json, not /book-data/index.json.
const INDEX_URL = '/index.json';

export function bookIndexPlugin(): Plugin {
  let projectRoot = process.cwd();

  return {
    name: 'book-index-plugin',

    configResolved(config) {
      projectRoot = config.root;
    },

    buildStart() {
      writeIndex(projectRoot);
    },

    configureServer(server: ViteDevServer) {
      writeIndex(projectRoot);

      server.middlewares.use((req, res, next) => {
        if (req.url === INDEX_URL) {
          const index = writeIndex(projectRoot);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(index, null, 2));
          return;
        }
        next();
      });
    },
  };
}
