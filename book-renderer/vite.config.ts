import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { bookIndexPlugin } from './src/vite-plugins/book-index-plugin';

export default defineConfig({
  plugins: [react(), bookIndexPlugin()],
  // book-data/ is served as static passthrough at the site root: manifest.json,
  // book.outline.json, assets/*, and the generated index.json are fetched as
  // /<slug>/manifest.json etc. from the preview app.
  publicDir: 'book-data',
  server: {
    fs: {
      allow: ['..', '.'],
    },
  },
  build: {
    outDir: 'dist',
    // Multi-page app: the interactive preview (index.html) AND the print
    // pipeline's one-page-per-load renderer (print.html, see
    // src/print/PrintApp.tsx + scripts/render-pdf.mts) are both built —
    // `vite build` doesn't auto-discover a second root-level HTML entry,
    // it must be listed explicitly.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        print: resolve(__dirname, 'print.html'),
      },
    },
  },
  test: {
    // Template snapshot tests render via react-dom/server (renderToStaticMarkup),
    // so no DOM environment (jsdom) dependency is needed — keeps deps minimal.
    environment: 'node',
    globals: true,
  },
});
