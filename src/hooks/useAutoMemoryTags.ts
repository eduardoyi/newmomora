import { useCallback, useRef, useState } from 'react';

import {
  applyAutoMemoryTags,
  memberIdArraysEqual,
  toggleMemoryTag,
} from '@/utils/auto-memory-tags';
import type { MemberWithNames } from '@/utils/member-mentions';

export interface UseAutoMemoryTagsOptions {
  members: MemberWithNames[];
  enabled: boolean;
  onSelectedMemberIdsChange?: (memberIds: string[]) => void;
}

export interface VoiceTagResult {
  cleanedText: string;
  mentionedMemberIds: string[];
}

export function useAutoMemoryTags({
  members,
  enabled,
  onSelectedMemberIdsChange,
}: UseAutoMemoryTagsOptions) {
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [suppressedMemberIds, setSuppressedMemberIds] = useState<string[]>([]);

  const membersRef = useRef(members);
  membersRef.current = members;

  const suppressedRef = useRef(suppressedMemberIds);
  suppressedRef.current = suppressedMemberIds;

  const initializeTags = useCallback((memberIds: string[]) => {
    setSelectedMemberIds(memberIds);
    setSuppressedMemberIds([]);
    onSelectedMemberIdsChange?.(memberIds);
  }, [onSelectedMemberIdsChange]);

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

        if (memberIdArraysEqual(current, next)) {
          return current;
        }

        onSelectedMemberIdsChange?.(next);
        return next;
      });
    },
    [enabled, onSelectedMemberIdsChange],
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

      if (memberIdArraysEqual(currentSelected, result.selectedMemberIds)) {
        return currentSelected;
      }

      onSelectedMemberIdsChange?.(result.selectedMemberIds);
      return result.selectedMemberIds;
    });
  }, [onSelectedMemberIdsChange]);

  const applyVoiceResult = useCallback(({ mentionedMemberIds }: VoiceTagResult) => {
    const nextMemberIds = [...new Set(mentionedMemberIds)];
    setSuppressedMemberIds([]);
    setSelectedMemberIds(nextMemberIds);
    onSelectedMemberIdsChange?.(nextMemberIds);
  }, [onSelectedMemberIdsChange]);

  return {
    selectedMemberIds,
    suppressedMemberIds,
    initializeTags,
    applyForContent,
    toggleMember,
    applyVoiceResult,
  };
}
