// When the Family tab's "Who's who" card shows (docs/features/family-relationships.md).
// Server state (pending suggestions, the account link) is the source of
// truth; the only local state is the × dismissal, stored per family: the
// newest suggestion seen when dismissed (the card returns when a newer one
// arrives) and whether the "Which one is you?" prompt was waved off.
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface WhosWhoDismissal {
  suggestionsSeenAt: string | null;
  selfPromptDismissed: boolean;
}

export const EMPTY_WHOS_WHO_DISMISSAL: WhosWhoDismissal = { suggestionsSeenAt: null, selfPromptDismissed: false };

function storageKey(familyId: string): string {
  return `momora.whosWhoDismissal.${familyId}`;
}

export async function getWhosWhoDismissal(familyId: string): Promise<WhosWhoDismissal> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(familyId));
    if (!raw) return EMPTY_WHOS_WHO_DISMISSAL;
    const parsed = JSON.parse(raw) as Partial<WhosWhoDismissal>;
    return {
      suggestionsSeenAt: typeof parsed.suggestionsSeenAt === 'string' ? parsed.suggestionsSeenAt : null,
      selfPromptDismissed: parsed.selfPromptDismissed === true,
    };
  } catch {
    return EMPTY_WHOS_WHO_DISMISSAL;
  }
}

export async function setWhosWhoDismissal(familyId: string, value: WhosWhoDismissal): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(familyId), JSON.stringify(value));
  } catch {
    // Best-effort: worst case the card shows again.
  }
}

export function newestSuggestionAt(suggestions: { created_at: string }[]): string | null {
  return suggestions.reduce<string | null>((max, s) => (max === null || s.created_at > max ? s.created_at : max), null);
}

export type WhosWhoCardKind = 'suggestions' | 'self' | null;

export function whosWhoCardKind(input: {
  canEdit: boolean;
  suggestions: { created_at: string }[];
  isLinked: boolean;
  notInList: boolean;
  hasLinkableMember: boolean;
  dismissal: WhosWhoDismissal;
}): WhosWhoCardKind {
  const newest = newestSuggestionAt(input.suggestions);
  if (
    input.canEdit &&
    newest !== null &&
    (input.dismissal.suggestionsSeenAt === null || newest > input.dismissal.suggestionsSeenAt)
  ) {
    return 'suggestions';
  }
  if (!input.isLinked && !input.notInList && input.hasLinkableMember && !input.dismissal.selfPromptDismissed) {
    return 'self';
  }
  return null;
}
