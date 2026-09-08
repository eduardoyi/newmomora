import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RenderWorkerEnv } from './env';

/**
 * Node port of `supabase/functions/_shared/r2.ts`'s presign/put/head logic
 * (memory-book-5c plan, Step 3: "port the minimal presign logic; plan says
 * same _shared/r2.ts logic; it's Node-compatible aws-sdk usage"). Same
 * `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` calls, same
 * `forcePathStyle: true` R2 client shape — only the import specifiers differ
 * (plain npm package names here, vs. that file's `npm:@aws-sdk/...@3` Deno
 * specifiers) and config is threaded in explicitly (`env.ts`'s already-
 * validated `RenderWorkerEnv['r2']`) rather than read from `Deno.env`.
 *
 * `R2Client` (below) is a deliberately narrow, PLAIN interface — not the
 * real `@aws-sdk/client-s3` `S3Client` type — wrapping exactly the four
 * operations this worker needs (presign-GET, put, get-text, head-exists).
 * `status.ts`/`render.ts`/`server.ts` all depend on THIS interface, never on
 * `@aws-sdk/client-s3` directly, so this module's own test suite (and every
 * other module that touches R2) can substitute a plain in-memory fake with
 * no AWS SDK types/mocking machinery involved — see `test/fakeR2.ts`.
 */

export interface R2TextObject {
  text: string;
  /** Opaque version token (R2/S3 `ETag`) — the only way to condition a PUT on
   * "replace ONLY if the object still has the content I last read" (`IfMatch`),
   * which `status.ts`'s retry-after-failed claim needs (see that file's own
   * doc comment) since `IfNoneMatch: '*'` only ever expresses "must not
   * already exist" and this key always already exists once ANY status has
   * been written for an attemptId. */
  etag: string;
}

export interface R2Client {
  presignGet(objectKey: string, expiresInSeconds: number): Promise<string>;
  putObject(
    objectKey: string,
    body: Uint8Array,
    contentType: string,
    options?: { ifNoneMatch?: string; ifMatch?: string },
  ): Promise<void>;
  getObject(objectKey: string): Promise<R2TextObject | null>;
  headExists(objectKey: string): Promise<boolean>;
}

export type R2Config = RenderWorkerEnv['r2'];

/** R2's condition-failed response for a conditional `putObject` (`ifNoneMatch`)
 * — surfaced as a typed error so callers (status.ts's `claimRunning`) can
 * tell "someone else already created this marker" apart from a generic
 * failure without inspecting SDK-shaped error internals themselves. */
export class PreconditionFailedError extends Error {
  constructor() {
    super('R2 precondition failed (object already exists)');
  }
}

function isPreconditionFailed(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && '$metadata' in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  const name = error instanceof Error ? error.name : '';
  return status === 412 || name === 'PreconditionFailed';
}

function isNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const status =
    error && typeof error === 'object' && '$metadata' in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

export function createR2Client(config: R2Config): R2Client {
  const client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const bucket = config.bucket;

  return {
    async presignGet(objectKey, expiresInSeconds) {
      const command = new GetObjectCommand({ Bucket: bucket, Key: objectKey });
      return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    },

    async putObject(objectKey, body, contentType, options = {}) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: objectKey,
            Body: body,
            ContentType: contentType,
            ...(options.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
            ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
          }),
        );
      } catch (error) {
        if (isPreconditionFailed(error)) throw new PreconditionFailedError();
        throw error;
      }
    },

    async getObject(objectKey) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        const body = response.Body;
        if (!body) return null;
        const text = await (body as { transformToString: () => Promise<string> }).transformToString();
        return { text, etag: response.ETag ?? '' };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async headExists(objectKey) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}

/** Presigns every key in `objectKeys` concurrently (one `presignGet` call
 * per key — batched with `Promise.all` rather than serially, same reasoning
 * as `supabase/functions/_shared/r2.ts`'s `getObjectBytesBatch`). */
export async function presignMany(client: R2Client, objectKeys: string[], expiresInSeconds: number): Promise<Record<string, string>> {
  const uniqueKeys = [...new Set(objectKeys)];
  const entries = await Promise.all(
    uniqueKeys.map(async (objectKey): Promise<[string, string]> => [objectKey, await client.presignGet(objectKey, expiresInSeconds)]),
  );
  return Object.fromEntries(entries);
}
