import type { FamilyActivityEvent, FamilyActivityGroup } from '@/services/family-activity';
import { filmTitle, type YearFilmMember } from '@/utils/year-films';

export interface FamilyActivityCopySegment {
  text: string;
  /** Render this segment in bold -- an actor name, or a film title. */
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
    // Actor-less (film_ready) events are never grouped with actors.
    if (!event.actorId || seen.has(event.actorId)) continue;
    seen.add(event.actorId);
    names.push(resolveActorName(event));
  }
  return names;
}

export interface FamilyActivityCopyOptions {
  /** The family's members, for `film_ready` titles ("Tomás's Year Four"). */
  members?: readonly YearFilmMember[];
}

function filmReadyTitle(event: FamilyActivityEvent, members: readonly YearFilmMember[]): string {
  // Defensive: a malformed row (unknown kind / no scope start) must not
  // throw inside a list row.
  if (
    (event.filmKind !== 'birthday' && event.filmKind !== 'family_month' && event.filmKind !== 'family_year')
    || !event.filmScopeStart
  ) {
    return 'A film';
  }
  return filmTitle(
    {
      kind: event.filmKind,
      family_member_id: event.filmMemberId,
      age_year: event.filmAgeYear,
      scope_start_date: event.filmScopeStart,
    },
    members,
  );
}

export function buildFamilyActivityCopy(
  group: FamilyActivityGroup,
  options: FamilyActivityCopyOptions = {},
): FamilyActivityCopy {
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

    case 'film_ready': {
      return {
        segments: [
          { text: filmReadyTitle(group.events[0], options.members ?? []), bold: true },
          { text: ' is ready' },
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
