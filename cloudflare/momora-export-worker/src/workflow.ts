import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { buildGroupArchives } from './builder';
import { sendExportEmail } from './email';
import { renderReadme } from './layout';
import { buildFamilyManifest } from './manifest';
import { buildExportPlan, fetchExportRows } from './plan';
import { archiveKey, getJson, groupResultKey, planKey, putJson } from './storage';
import { updateExportJob } from './supabase';
import { generateDownloadToken, sha256Hex } from './token';
import type {
  ExportArchiveRecord,
  ExportPlan,
  ExportWorkflowParams,
  GroupBuildResult,
  PlannedEntry,
} from './types';

export const DOWNLOAD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_GONE = 'export_job_not_active';

/**
 * Builds one owner's archive in the background and emails the link.
 *
 *   plan                 read every row, lay out the groups, save plan.json to R2
 *   archive i of n       one step per group (year, or Family & portraits) so a
 *                        failure retries only that group; results saved to R2
 *   publish              mark ready with a fresh download token, email the link
 *
 * Any unrecoverable failure marks the job failed and emails the owner that
 * it didn't work (the daily cron deletes whatever was written).
 */
export class ExportArchiveWorkflow extends WorkflowEntrypoint<Env, ExportWorkflowParams> {
  async run(event: WorkflowEvent<ExportWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { jobId, ownerUserId, origin } = event.payload;
    const env = this.env;

    try {
      const { groupCount } = await step.do(
        'plan',
        { retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
        async () => {
          const active = await updateExportJob(env, jobId, {
            status: 'building',
            started_at: new Date().toISOString(),
          }, ['queued', 'building']);
          if (!active) throw new NonRetryableError(JOB_GONE);
          const rows = await fetchExportRows(env, ownerUserId);
          const plan = buildExportPlan(jobId, ownerUserId, rows, new Date().toISOString());
          await putJson(env.MEDIA, planKey(jobId), plan);
          return { groupCount: plan.groups.length };
        },
      );

      for (let index = 0; index < groupCount; index += 1) {
        await step.do(
          `archive ${index + 1} of ${groupCount}`,
          { retries: { limit: 2, delay: '1 minute', backoff: 'exponential' }, timeout: '2 hours' },
          async () => {
            const plan = await getJson<ExportPlan>(env.MEDIA, planKey(jobId));
            const result = await buildGroup(env, plan, index);
            await putJson(env.MEDIA, groupResultKey(jobId, index), result);
            return { archives: result.archives.length };
          },
        );
      }

      await step.do(
        'publish',
        { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
        async () => {
          const plan = await getJson<ExportPlan>(env.MEDIA, planKey(jobId));
          const results = await Promise.all(plan.groups.map((_, index) =>
            getJson<GroupBuildResult>(env.MEDIA, groupResultKey(jobId, index))));
          const archives = orderArchives(plan, results);
          const totalBytes = archives.reduce((sum, archive) => sum + archive.bytes, 0);
          const missingCount = results.reduce((sum, result) => sum + result.missing.length, 0);
          const objectCount = plan.groups
            .flatMap((group) => group.entries)
            .filter((entry) => entry.type === 'object').length;

          const token = generateDownloadToken();
          const now = new Date();
          const expiresAt = new Date(now.getTime() + DOWNLOAD_LINK_TTL_MS).toISOString();
          // 'ready' is allowed so a retry after the email failed can mint a
          // fresh token and resend (the earlier link was never delivered).
          const active = await updateExportJob(env, jobId, {
            status: 'ready',
            archives,
            total_bytes: totalBytes,
            asset_count: objectCount - missingCount,
            download_token_hash: await sha256Hex(token),
            completed_at: now.toISOString(),
            expires_at: expiresAt,
          }, ['building', 'ready']);
          if (!active) throw new NonRetryableError(JOB_GONE);

          await sendExportEmail(env, {
            kind: 'ready',
            jobId,
            downloadUrl: `${origin}/download/${jobId}?t=${token}`,
            expiresAt,
            archiveCount: archives.length,
            totalBytes,
          });
          await updateExportJob(env, jobId, { email_sent_at: new Date().toISOString() });
          return { archives: archives.length };
        },
      );
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
      console.error('export workflow failed', code);
      if (code === JOB_GONE) return;
      await step.do('mark failed', { retries: { limit: 3, delay: '30 seconds' } }, async () => {
        const marked = await updateExportJob(env, jobId, {
          status: 'failed',
          failure_code: code,
          completed_at: new Date().toISOString(),
        }, ['queued', 'building', 'ready']);
        if (marked) await sendExportEmail(env, { kind: 'failed', jobId });
      });
      throw error;
    }
  }
}

/** Download order: per family, Family & portraits first, then years oldest first. */
function orderArchives(plan: ExportPlan, results: GroupBuildResult[]): ExportArchiveRecord[] {
  const ordered = plan.families.flatMap((family) => {
    const indexes = plan.groups.flatMap((group, index) => (group.familyId === family.id ? [index] : []));
    const familyFirst = [
      ...indexes.filter((index) => plan.groups[index].kind === 'family'),
      ...indexes.filter((index) => plan.groups[index].kind === 'year'),
    ];
    return familyFirst.flatMap((index) => results[index].archives);
  });
  return ordered.map((archive, index) => ({
    index: index + 1,
    key: archive.key,
    fileName: archive.fileName,
    bytes: archive.bytes,
  }));
}

/** Builds one group; the family group also gets README.txt and manifest.json. */
export async function buildGroup(env: Env, plan: ExportPlan, index: number): Promise<GroupBuildResult> {
  const group = plan.groups[index];
  const keyFor = (part: number) => archiveKey(plan.jobId, index, part);
  if (group.kind !== 'family') {
    return await buildGroupArchives(env.MEDIA, { groupId: group.id, baseName: group.baseName, keyFor, entries: group.entries });
  }

  // Year groups of this family always come before it in the plan, so their
  // results already exist.
  const siblingIndexes = plan.groups.flatMap((candidate, candidateIndex) =>
    (candidate.familyId === group.familyId && candidate.kind === 'year' ? [candidateIndex] : []));
  const siblings = await Promise.all(siblingIndexes.map((siblingIndex) =>
    getJson<GroupBuildResult>(env.MEDIA, groupResultKey(plan.jobId, siblingIndex))));
  const siblingMissing = siblings.flatMap((result) => result.missing);
  const root = plan.familyRoots[group.familyId];
  const family = plan.families.find((candidate) => candidate.id === group.familyId);

  const readme: PlannedEntry = {
    type: 'text',
    path: `${root}/README.txt`,
    modifiedAt: plan.exportedAt,
    text: renderReadme({
      familyName: family?.name ?? 'Your family',
      exportedAt: plan.exportedAt,
      archiveNames: [
        `${group.baseName}.zip (this file)`,
        ...siblings.flatMap((result) => result.archives.map((archive) => archive.fileName)),
      ],
      memoryCount: plan.familyData[group.familyId]?.memories.length ?? 0,
    }),
  };

  return await buildGroupArchives(env.MEDIA, {
    groupId: group.id,
    baseName: group.baseName,
    keyFor,
    entries: [readme, ...group.entries],
    trailingEntries: (missing) => [{
      type: 'text',
      path: `${root}/manifest.json`,
      modifiedAt: plan.exportedAt,
      text: JSON.stringify(buildFamilyManifest(plan, group.familyId, [...siblingMissing, ...missing]), null, 2),
    }],
  });
}
