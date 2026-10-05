import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Holiday card tooling (docs/plans/holiday-cards.md C3).
 *
 *   dev   (`npm run card:preview`): serves card.html; `card-data/` is a static
 *         passthrough at the site root (/<slug>/card.json, /<slug>/assets/*),
 *         like book-data/ for the book preview, plus /card-index.json listing
 *         the card slugs.
 *   build (`npm run card:build`, used by `card:pdf`): builds ONLY the print
 *         entry (card-print.html) into dist-card/. `publicDir: false` in the
 *         build is deliberate PII safety (same posture as vite.print.config.ts):
 *         card-data/ holds real family photos and letters and must never be
 *         copied into a build output. The PDF script serves card-data/ itself.
 */
function cardIndexPlugin(): Plugin {
  const dataDir = resolve(__dirname, 'card-data');
  return {
    name: 'card-index',
    configureServer(server) {
      // The editor saves its state (the card's edits model) beside the card:
      // PUT /api/card-edits/<slug> writes card-data/<slug>/edits.json, which
      // `card:pdf` prints with. Local dev server only (never part of a build).
      server.middlewares.use('/api/card-edits', (req, res) => {
        const slug = decodeURIComponent((req.url ?? '/').replace(/^\//, '').split('?')[0]);
        const dir = path.join(dataDir, slug);
        if (req.method !== 'PUT' || !/^[a-z0-9][a-z0-9-]*$/.test(slug) || !fs.existsSync(path.join(dir, 'card.json'))) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            JSON.parse(body); // refuse anything that is not JSON
            fs.writeFileSync(path.join(dir, 'edits.json'), body);
            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 400;
            res.end('bad request');
          }
        });
      });
      server.middlewares.use('/card-index.json', (_req, res) => {
        const cards = fs.existsSync(dataDir)
          ? fs
              .readdirSync(dataDir, { withFileTypes: true })
              .filter((e) => e.isDirectory() && fs.existsSync(path.join(dataDir, e.name, 'card.json')))
              .map((e) => e.name)
          : [];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ cards }));
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [react(), cardIndexPlugin()],
  publicDir: command === 'serve' ? 'card-data' : false,
  server: { port: 5174, fs: { allow: ['..', '.'] } },
  build: {
    outDir: 'dist-card',
    emptyOutDir: true,
    rollupOptions: { input: { 'card-print': resolve(__dirname, 'card-print.html') } },
  },
}));
