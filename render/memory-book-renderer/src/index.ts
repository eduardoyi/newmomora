import { loadEnv } from './env';
import { createServer } from './server';

const env = loadEnv();
const server = createServer(env);

server.listen(env.port, () => {
  // ids/config only — never book content, never secrets.
  console.log(`memory-book-renderer: listening on :${env.port} (servedDistDir=${env.servedDistDir}, concurrency=${env.concurrency})`);
});

// Fail loudly rather than leave the process half-alive on an unhandled
// rejection from a fire-and-forget render job that also failed to persist
// its own `failed` status (see render.ts's `runRenderJob` — it already
// swallows a secondary write failure so the ORIGINAL error still surfaces
// here, ids-only, matching the project-wide "no memory content in logs" rule).
process.on('unhandledRejection', (reason) => {
  console.error('memory-book-renderer: unhandled rejection', reason instanceof Error ? reason.message : reason);
});
