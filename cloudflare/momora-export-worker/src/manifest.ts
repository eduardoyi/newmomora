import type { ExportPlan } from './types';

/**
 * A family's manifest.json: the structured data plus every file's path in
 * the combined unzipped folder. Paths (not archive names) are the stable
 * reference -- all of a family's archives unzip into the same tree.
 */
export function buildFamilyManifest(plan: ExportPlan, familyId: string, missingPaths: string[]): unknown {
  const family = plan.families.find((candidate) => candidate.id === familyId) ?? null;
  const data = plan.familyData[familyId];
  const missing = new Set(missingPaths);
  const files = plan.groups
    .filter((group) => group.familyId === familyId)
    .flatMap((group) => group.entries)
    .flatMap((entry) => (entry.type === 'object' && !missing.has(entry.path)
      ? [{
        path: entry.path,
        kind: entry.kind,
        ...(entry.memoryId ? { memoryId: entry.memoryId } : {}),
        ...(entry.familyMemberId ? { familyMemberId: entry.familyMemberId } : {}),
        ...(entry.portraitVersionId ? { portraitVersionId: entry.portraitVersionId } : {}),
      }]
      : []));
  const memoryFolders = new Map(plan.groups
    .filter((group) => group.familyId === familyId && group.kind === 'year')
    .flatMap((group) => group.entries)
    .flatMap((entry) => (entry.type === 'text' && entry.memoryId
      ? [[entry.memoryId, entry.path.replace(/\/memory\.txt$/, '')] as const]
      : [])));

  return {
    format: 'momora-export',
    version: 2,
    exportedAt: plan.exportedAt,
    ownerUserId: plan.ownerUserId,
    profile: plan.profile,
    family,
    familyMembers: data?.familyMembers ?? [],
    memories: (data?.memories ?? []).map((memory) => ({ ...memory, folder: memoryFolders.get(memory.id) ?? null })),
    memoryTags: data?.memoryTags ?? [],
    memoryMedia: data?.memoryMedia ?? [],
    memoryComments: data?.memoryComments ?? [],
    portraitVersions: data?.portraitVersions ?? [],
    files,
    missingFiles: missingPaths,
  };
}
