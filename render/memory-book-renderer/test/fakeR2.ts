import { createHash } from 'node:crypto';
import { PreconditionFailedError, type R2Client } from '../src/r2';

/**
 * A tiny in-memory `R2Client` fake — no AWS SDK types, no network, no real
 * credentials — used by every test that needs "R2 mocked" (task brief's own
 * wording for the idempotency/409/status-transition suite).
 *
 * Conditional-PUT semantics mirror real R2/S3 closely enough for
 * `status.ts`'s `claimRunning` to be exercised honestly:
 *   - `ifNoneMatch: '*'` against a key that already exists throws
 *     `PreconditionFailedError`.
 *   - `ifMatch: <etag>` against a key whose CURRENT etag differs (or that no
 *     longer exists) throws `PreconditionFailedError`.
 * Etags are a content hash, not a real S3 opaque token — good enough to
 * prove "did the object change since I last read it", which is all
 * `claimRunning`'s retry-after-failed path actually needs.
 */
export function createFakeR2Client(): R2Client & { objects: Map<string, { body: Uint8Array; contentType: string; etag: string }> } {
  const objects = new Map<string, { body: Uint8Array; contentType: string; etag: string }>();

  function etagFor(body: Uint8Array): string {
    return createHash('sha256').update(body).digest('hex').slice(0, 16);
  }

  return {
    objects,
    async presignGet(objectKey, expiresInSeconds) {
      return `https://fake-r2.example.com/${encodeURIComponent(objectKey)}?ttl=${expiresInSeconds}`;
    },
    async putObject(objectKey, body, contentType, options = {}) {
      const current = objects.get(objectKey);
      if (options.ifNoneMatch === '*' && current) {
        throw new PreconditionFailedError();
      }
      if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) {
        throw new PreconditionFailedError();
      }
      objects.set(objectKey, { body, contentType, etag: etagFor(body) });
    },
    async getObject(objectKey) {
      const entry = objects.get(objectKey);
      if (!entry) return null;
      return { text: new TextDecoder().decode(entry.body), etag: entry.etag };
    },
    async headExists(objectKey) {
      return objects.has(objectKey);
    },
  };
}
