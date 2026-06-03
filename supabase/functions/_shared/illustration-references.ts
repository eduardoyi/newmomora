import { describeAgeAtDate } from './age.ts';
import { capIllustrationReferenceImage } from './image-bytes.ts';
import type { ReferenceImageInput } from './openai.ts';
import { normalizeAdditionalInfo } from './prompts.ts';

export interface IllustrationFamilyMember {
  id: string;
  name: string;
  nicknames?: string[] | null;
  date_of_birth: string | null;
  gender: string | null;
  additional_info: string | null;
  illustrated_profile_key: string | null;
  profile_picture_key: string | null;
}

function formatMemoryNicknameAliases(nicknames?: string[] | null): string | null {
  const displayNicknames = (nicknames ?? []).filter((nickname) => nickname.trim().length > 0);

  if (displayNicknames.length === 0) {
    return null;
  }

  return `May appear in the memory as: ${displayNicknames.join(', ')}.`;
}

export interface IllustrationReferenceBundle {
  characterReferences: Array<{ referenceIndex: number; description: string }>;
  referenceImages: ReferenceImageInput[];
}

export function sortMembersByTagOrder<T extends { id: string }>(
  members: T[],
  memberIds: string[],
): T[] {
  const order = new Map(memberIds.map((id, index) => [id, index]));

  return [...members].sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
}

export function buildMemberIllustrationDescription(
  member: IllustrationFamilyMember,
  memoryDate: string,
): string {
  const age = member.date_of_birth
    ? describeAgeAtDate(member.date_of_birth, memoryDate)
    : 'young child';
  const gender = member.gender ? `, ${member.gender}` : '';
  const base = `${member.name} (${age}${gender})`;
  const nicknameAliases = formatMemoryNicknameAliases(member.nicknames);
  const normalized = normalizeAdditionalInfo(member.additional_info);
  const aliasPart = nicknameAliases ? ` ${nicknameAliases}` : '';
  const guidancePart = normalized
    ? aliasPart
      ? ` Additional guidance: ${normalized}`
      : `. Additional guidance: ${normalized}`
    : '';

  return `${base}${aliasPart}${guidancePart}`;
}

function sanitizeReferenceFilename(name: string, referenceIndex: number, extension: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `reference-${referenceIndex}-${slug || 'member'}.${extension}`;
}

export async function prepareIllustrationReferences(
  members: IllustrationFamilyMember[],
  memoryDate: string,
  getObjectBytes: (key: string) => Promise<Uint8Array>,
): Promise<IllustrationReferenceBundle> {
  const characterReferences: Array<{ referenceIndex: number; description: string }> = [];
  const referenceImages: ReferenceImageInput[] = [];

  for (const member of members) {
    const attempts: Array<{ key: string; contentType: string; extension: string }> = [];

    if (member.illustrated_profile_key) {
      attempts.push({
        key: member.illustrated_profile_key,
        contentType: 'image/webp',
        extension: 'webp',
      });
    }

    if (member.profile_picture_key) {
      attempts.push({
        key: member.profile_picture_key,
        contentType: 'image/jpeg',
        extension: 'jpg',
      });
    }

    for (const attempt of attempts) {
      try {
        const bytes = await getObjectBytes(attempt.key);
        const capped = await capIllustrationReferenceImage(bytes, attempt.contentType);
        const referenceIndex = referenceImages.length + 1;

        characterReferences.push({
          referenceIndex,
          description: buildMemberIllustrationDescription(member, memoryDate),
        });
        referenceImages.push({
          bytes: capped.bytes,
          contentType: capped.contentType,
          filename: sanitizeReferenceFilename(
            member.name,
            referenceIndex,
            capped.extension,
          ),
        });
        break;
      } catch {
        // Try the next source for this member.
      }
    }
  }

  return { characterReferences, referenceImages };
}
