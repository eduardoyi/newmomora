import type { FamilyActivityEvent, FamilyActivityGroup } from '@/services/family-activity';

export interface FamilyActivityCopySegment {
  text: string;
  /** Render this segment in `fonts.semibold` -- always an actor name. */
  bold?: boolean;
}

export interface FamilyActivityCopy {
  segments: FamilyActivityCopySegment[];
}

// Copy rule (plan §3, owner decision 2026-08-21): like/comment rows
// reference the memory itself, never the person who created it -- no "your
// memory", no "Ana's memory", no former-member fallback for the creator.
// The *actor* (who liked/commented/added), by contrast, does fall back to
// "A former member" when their account was hard-deleted.
function resolveActorName(event: FamilyActivityEvent): string {
  return event.actorIsFormer ? 'A former member' : event.actorName;
}

function uniqueActorNames(events: FamilyActivityEvent[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const event of events) {
    if (seen.has(event.actorId)) continue;
    seen.add(event.actorId);
    names.push(resolveActorName(event));
  }
  return names;
}

export function buildFamilyActivityCopy(group: FamilyActivityGroup): FamilyActivityCopy {
  const primaryActorName = resolveActorName(group.events[0]);

  switch (group.kind) {
    case 'memory_added': {
      const count = group.events.length;
      if (count <= 1) {
        return {
          segments: [
            { text: primaryActorName, bold: true },
            { text: ' added a memory' },
          ],
        };
      }
      const isGalleryImport = group.events.every(
        (event) => event.memoryCreationSource === 'gallery_import',
      );
      return {
        segments: [
          { text: primaryActorName, bold: true },
          {
            text: isGalleryImport
              ? ` added ${count} memories from their gallery`
              : ` added ${count} memories`,
          },
        ],
      };
    }

    case 'memory_commented': {
      return {
        segments: [
          { text: primaryActorName, bold: true },
          { text: ' commented on a memory' },
        ],
      };
    }

    case 'memory_liked': {
      const names = uniqueActorNames(group.events);
      if (names.length === 1) {
        return {
          segments: [
            { text: names[0], bold: true },
            { text: ' liked a memory' },
          ],
        };
      }
      if (names.length === 2) {
        return {
          segments: [
            { text: names[0], bold: true },
            { text: ' and ' },
            { text: names[1], bold: true },
            { text: ' liked a memory' },
          ],
        };
      }
      const others = names.length - 2;
      return {
        segments: [
          { text: names[0], bold: true },
          { text: ', ' },
          { text: names[1], bold: true },
          { text: ` and ${others} other${others === 1 ? '' : 's'} liked a memory` },
        ],
      };
    }

    case 'member_joined': {
      return {
        segments: [
          { text: primaryActorName, bold: true },
          { text: ' joined the family' },
        ],
      };
    }

    case 'member_pending': {
      return {
        segments: [
          { text: primaryActorName, bold: true },
          { text: ' is waiting for your approval' },
        ],
      };
    }

    default: {
      // Exhaustiveness guard -- new kinds must be handled explicitly above.
      const exhaustive: never = group.kind;
      return { segments: [{ text: String(exhaustive) }] };
    }
  }
}

export function familyActivityCopyPlainText(copy: FamilyActivityCopy): string {
  return copy.segments.map((segment) => segment.text).join('').trim();
}
