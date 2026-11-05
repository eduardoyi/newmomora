import type { QueryClient } from '@tanstack/react-query';

import {
  familyMembersQueryKeyBase,
  memoriesQueryKeyBase,
  portraitVersionsQueryKeyBase,
} from '@/hooks/queryKeys';

// Its own module (not in usePortraitVersions.ts) so usePortraitVersionsRealtime,
// which FamilyProvider mounts, never imports a hook module that itself imports
// use-family (a cycle).

/** A portrait changed (created, finished, failed, deleted): refresh everything that embeds it. */
export function invalidatePortraitConsumers(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: [portraitVersionsQueryKeyBase] });
  queryClient.invalidateQueries({ queryKey: [familyMembersQueryKeyBase] });
  queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase] });
}
