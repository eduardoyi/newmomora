import { matchMemberIdsMentionedInText, type MemberWithNames } from './member-mentions.ts';

export type FamilyMemberNameRow = MemberWithNames;

/** When no explicit tags exist, match family members mentioned in memory text. */
export function resolveMemberIdsForIllustration(
  taggedMemberIds: string[],
  content: string,
  candidates: FamilyMemberNameRow[],
  maxMemberCount?: number,
): string[] {
  const resolvedMemberIds = taggedMemberIds.length > 0
    ? taggedMemberIds
    : matchMemberIdsMentionedInText(content, candidates);

  return maxMemberCount === undefined
    ? resolvedMemberIds
    : resolvedMemberIds.slice(0, maxMemberCount);
}
