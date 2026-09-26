// Everything an export writes lives under exports/<job id>/ in the private
// media bucket: the plan and per-group results (working state between
// Workflow steps) and the finished archives. Nothing under exports/ is ever
// signed by get-media-url -- only this Worker serves it, behind the job's
// download token -- and the daily cron deletes the whole prefix.

export function exportPrefix(jobId: string): string {
  return `exports/${jobId}/`;
}

export function planKey(jobId: string): string {
  return `${exportPrefix(jobId)}work/plan.json`;
}

export function groupResultKey(jobId: string, groupIndex: number): string {
  return `${exportPrefix(jobId)}work/group-${groupIndex}.json`;
}

export function archiveKey(jobId: string, groupIndex: number, part: number): string {
  return `${exportPrefix(jobId)}archives/${groupIndex}-${part}.zip`;
}

export async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
}

export async function getJson<T>(bucket: R2Bucket, key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`export_state_missing:${key.split('/').pop()}`);
  return await object.json<T>();
}

/** Deletes every object under a job's prefix. Returns how many were deleted. */
export async function deleteExportPrefix(bucket: R2Bucket, jobId: string): Promise<number> {
  const prefix = exportPrefix(jobId);
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const listing = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return deleted;
}
