export interface MemberWithNames {
  id: string;
  name: string;
  nicknames?: string[] | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `name` appears as its own token, not as a substring inside another word. */
export function isNameMentionedInText(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`,
    'iu',
  );
  return pattern.test(text);
}

export function getNamesForMember(member: MemberWithNames): string[] {
  return [member.name, ...(member.nicknames ?? [])].filter((name) => name.trim().length > 0);
}

export function isMemberMentionedInText(text: string, member: MemberWithNames): boolean {
  return getNamesForMember(member).some((name) => isNameMentionedInText(text, name));
}

export function matchMemberIdsMentionedInText<T extends MemberWithNames>(
  text: string,
  members: T[],
): string[] {
  const matched: string[] = [];

  for (const member of members) {
    if (isMemberMentionedInText(text, member)) {
      matched.push(member.id);
    }
  }

  return matched;
}
