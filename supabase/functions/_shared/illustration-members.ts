import { matchMemberIdsMentionedInText, type MemberWithNames } from './member-mentions.ts';

export type FamilyMemberNameRow = MemberWithNames;

/** When no explicit tags exist, match family members mentioned in memory text. */
export function resolveMemberIdsForIllustration(
  taggedMemberIds: string[],
  content: string,
  candidates: FamilyMemberNameRow[],
): string[] {
  if (taggedMemberIds.length > 0) {
    return taggedMemberIds;
  }

  return matchMemberIdsMentionedInText(content, candidates);
}
