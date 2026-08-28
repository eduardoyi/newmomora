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
  },
  test: {
    // Template snapshot tests render via react-dom/server (renderToStaticMarkup),
    // so no DOM environment (jsdom) dependency is needed — keeps deps minimal.
    environment: 'node',
    globals: true,
  },
});
