import { useCallback, useRef, useState } from 'react';

import {
  applyAutoMemoryTags,
  memberIdArraysEqual,
  toggleMemoryTag,
} from '@/utils/auto-memory-tags';
import type { MemberWithNames } from '@/utils/member-mentions';
import { MAX_MEMORY_TAGS } from '@/utils/memories';

export interface UseAutoMemoryTagsOptions {
  members: MemberWithNames[];
  enabled: boolean;
}

export interface VoiceTagResult {
  cleanedText: string;
  mentionedMemberIds: string[];
}

export function useAutoMemoryTags({ members, enabled }: UseAutoMemoryTagsOptions) {
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [suppressedMemberIds, setSuppressedMemberIds] = useState<string[]>([]);

  const membersRef = useRef(members);
  membersRef.current = members;

  const suppressedRef = useRef(suppressedMemberIds);
  suppressedRef.current = suppressedMemberIds;

  const initializeTags = useCallback((memberIds: string[]) => {
    setSelectedMemberIds(memberIds);
    setSuppressedMemberIds([]);
  }, []);

  const applyForContent = useCallback(
    (content: string) => {
      if (!enabled) {
        return;
      }

      setSelectedMemberIds((current) => {
        const next = applyAutoMemoryTags({
          content,
          members: membersRef.current,
          selectedMemberIds: current,
          suppressedMemberIds: suppressedRef.current,
        });

        return memberIdArraysEqual(current, next) ? current : next;
      });
    },
    [enabled],
  );

  const toggleMember = useCallback((memberId: string) => {
    setSelectedMemberIds((currentSelected) => {
      const selecting = !currentSelected.includes(memberId);
      const result = toggleMemoryTag({
        memberId,
        selectedMemberIds: currentSelected,
        suppressedMemberIds: suppressedRef.current,
        selecting,
      });

      setSuppressedMemberIds((currentSuppressed) =>
        memberIdArraysEqual(currentSuppressed, result.suppressedMemberIds)
          ? currentSuppressed
          : result.suppressedMemberIds,
      );

      return memberIdArraysEqual(currentSelected, result.selectedMemberIds)
        ? currentSelected
        : result.selectedMemberIds;
    });
  }, []);

  const applyVoiceResult = useCallback(({ mentionedMemberIds }: VoiceTagResult) => {
    setSuppressedMemberIds([]);
    setSelectedMemberIds(mentionedMemberIds.slice(0, MAX_MEMORY_TAGS));
  }, []);

  return {
    selectedMemberIds,
    suppressedMemberIds,
    initializeTags,
    applyForContent,
    toggleMember,
    applyVoiceResult,
  };
}
