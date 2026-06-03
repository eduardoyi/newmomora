import { matchMemberIdsMentionedInText, type MemberWithNames } from '@/utils/member-mentions';
import { MAX_MEMORY_TAGS } from '@/utils/memories';

export function memberIdArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((id, index) => id === right[index]);
}

export interface ApplyAutoMemoryTagsInput {
  content: string;
  members: MemberWithNames[];
  selectedMemberIds: string[];
  suppressedMemberIds: string[];
}

export function applyAutoMemoryTags(input: ApplyAutoMemoryTagsInput): string[] {
  const { content, members, selectedMemberIds, suppressedMemberIds } = input;
  const mentioned = matchMemberIdsMentionedInText(content, members);
  const suppressed = new Set(suppressedMemberIds);
  const selected = new Set(selectedMemberIds);

  const toAdd = mentioned.filter((id) => !suppressed.has(id) && !selected.has(id));
  if (toAdd.length === 0) {
    return selectedMemberIds;
  }

  const toAddOrdered = members.map((member) => member.id).filter((id) => toAdd.includes(id));
  const merged = [...selectedMemberIds];

  for (const id of toAddOrdered) {
    if (merged.length >= MAX_MEMORY_TAGS) {
      break;
    }
    merged.push(id);
  }

  return memberIdArraysEqual(merged, selectedMemberIds) ? selectedMemberIds : merged;
}

export interface ToggleMemoryTagInput {
  memberId: string;
  selectedMemberIds: string[];
  suppressedMemberIds: string[];
  selecting: boolean;
}

export interface ToggleMemoryTagResult {
  selectedMemberIds: string[];
  suppressedMemberIds: string[];
}

export function toggleMemoryTag(input: ToggleMemoryTagInput): ToggleMemoryTagResult {
  const { memberId, selectedMemberIds, suppressedMemberIds, selecting } = input;

  if (selecting) {
    if (selectedMemberIds.includes(memberId) || selectedMemberIds.length >= MAX_MEMORY_TAGS) {
      return { selectedMemberIds, suppressedMemberIds };
    }

    return {
      selectedMemberIds: [...selectedMemberIds, memberId],
      suppressedMemberIds: suppressedMemberIds.filter((id) => id !== memberId),
    };
  }

  const nextSelected = selectedMemberIds.filter((id) => id !== memberId);
  const nextSuppressed = suppressedMemberIds.includes(memberId)
    ? suppressedMemberIds
    : [...suppressedMemberIds, memberId];

  if (
    memberIdArraysEqual(nextSelected, selectedMemberIds) &&
    memberIdArraysEqual(nextSuppressed, suppressedMemberIds)
  ) {
    return { selectedMemberIds, suppressedMemberIds };
  }

  return {
    selectedMemberIds: nextSelected,
    suppressedMemberIds: nextSuppressed,
  };
}
