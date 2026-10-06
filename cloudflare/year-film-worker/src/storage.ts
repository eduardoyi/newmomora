// R2 helpers over the FILM_BUCKET binding. Attempt files live under
// `{ownerId}/year-films/{filmId}/{attemptId}/` so the owner-prefix account
// deletion sweep covers them.
export function attemptPrefix(ownerId: string, filmId: string, attemptId: string): string {
  return `${ownerId}/year-films/${filmId}/${attemptId}/`;
}

export interface Storage {
  putJson(key: string, value: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;
  getBase64(key: string): Promise<string | null>;
  deleteKeys(keys: string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function createStorage(bucket: R2Bucket): Storage {
  return {
    async putJson(key, value) {
      await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
    },
    async getJson(key) {
      const object = await bucket.get(key);
      return object ? await object.json() : null;
    },
    async getBase64(key) {
      const object = await bucket.get(key);
      return object ? base64(new Uint8Array(await object.arrayBuffer())) : null;
    },
    async deleteKeys(keys) {
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    },
    async deletePrefix(prefix) {
      let deleted = 0;
      let cursor: string | undefined;
      do {
        const listed = await bucket.list({ prefix, cursor, limit: 1000 });
        const keys = listed.objects.map((o) => o.key);
        if (keys.length > 0) await bucket.delete(keys);
        deleted += keys.length;
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return deleted;
    },
  };
}

/** Holiday card attempt files (the prepared letters between Workflow steps)
 * live under `{ownerId}/holiday-cards/{cardId}/{attemptId}/` so the
 * owner-prefix account deletion sweep covers them; the Workflow deletes the
 * prefix when it ends. */
export function cardAttemptPrefix(ownerId: string, cardId: string, attemptId: string): string {
  return `${ownerId}/holiday-cards/${cardId}/${attemptId}/`;
}

/** Original/preview photo reads for the card front picks (ImageReaderPort of
 * _shared/holiday-card-generate-ports.ts). Never throws: a missing or
 * unreadable object is null (the probes then treat it as unmeasurable). */
export interface ImageReader {
  readRange(key: string, length: number): Promise<Uint8Array | null>;
  read(key: string): Promise<Uint8Array | null>;
}

export function createImageReader(bucket: R2Bucket): ImageReader {
  const bytes = async (key: string, range?: { offset: number; length: number }): Promise<Uint8Array | null> => {
    try {
      const object = await bucket.get(key, range ? { range } : undefined);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
  return {
    readRange: (key, length) => bytes(key, { offset: 0, length }),
    read: (key) => bytes(key),
  };
}
