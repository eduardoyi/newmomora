import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/constants/theme';
import { formatArtworkMedium } from '@/utils/artwork-medium';
import { formatAgeFromDob, formatTaggedMemberAge } from '@/utils/family-members';
import { formatLongDisplayDate } from '@/utils/memories';

// The small museum placard under a piece on the gallery wall
// (docs/plans/artwork-scanning-v2.md decision 5): title in Newsreader italic,
// "Artist, age", then "<Medium> on paper . <date>" (a batch reads
// "<medium> . N pieces . <date>").

export interface PlacardMember {
  name: string;
  date_of_birth?: string | null;
}

export interface PlacardContentInput {
  /** The memory caption (the piece's title); blank = no title. */
  caption: string | null | undefined;
  /** First tagged member = the artist. */
  member: PlacardMember | null | undefined;
  /** `YYYY-MM-DD`. */
  memoryDate: string;
  /** Stored `artwork_medium`, lowercase. */
  medium: string | null | undefined;
  pieceCount: number;
}

export interface PlacardContent {
  title: string | null;
  /** "Mara, 2 years 4 months" (name only without a birth date or for adults). */
  artistLine: string | null;
  /** "Crayon on paper . October 10, 2026". */
  detailLine: string;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Full age at the memory date, e.g. "2 years 4 months". */
function formatPlacardAge(dateOfBirth: string, memoryDate: string): string | null {
  const reference = new Date(`${memoryDate}T12:00:00`);
  // Adults tagged as the artist show a name only (same rule as the member pills).
  if (formatTaggedMemberAge(dateOfBirth, reference) === null) {
    return null;
  }
  // The shared formatter separates years and months with a comma
  // ("2 years, 4 months"); on the placard the comma already follows the name.
  const age = formatAgeFromDob(dateOfBirth, reference).replace(', ', ' ');
  return age || null;
}

export function buildPlacardContent({
  caption,
  member,
  memoryDate,
  medium,
  pieceCount,
}: PlacardContentInput): PlacardContent {
  const title = caption?.trim() ? caption.trim() : null;

  let artistLine: string | null = null;
  if (member?.name) {
    const age = member.date_of_birth ? formatPlacardAge(member.date_of_birth, memoryDate) : null;
    artistLine = age ? `${member.name}, ${age}` : member.name;
  }

  const mediumLabel = formatArtworkMedium(medium);
  const date = formatLongDisplayDate(memoryDate);
  const parts: string[] = [];
  if (pieceCount > 1) {
    if (mediumLabel) parts.push(capitalize(mediumLabel));
    parts.push(`${pieceCount} pieces`);
  } else if (mediumLabel) {
    parts.push(`${capitalize(mediumLabel)} on paper`);
  }
  parts.push(date);

  return { title, artistLine, detailLine: parts.join(' · ') };
}

interface MuseumPlacardProps extends PlacardContentInput {
  testID?: string;
}

export function MuseumPlacard({ testID = 'memory-detail-artwork-placard', ...input }: MuseumPlacardProps) {
  const { title, artistLine, detailLine } = buildPlacardContent(input);

  return (
    <View accessible style={styles.placard} testID={testID}>
      {title ? (
        <Text style={styles.title} testID={`${testID}-title`}>
          {title}
        </Text>
      ) : null}
      {artistLine ? (
        <Text style={[styles.artist, title ? styles.afterTitle : null]} testID={`${testID}-artist`}>
          {artistLine}
        </Text>
      ) : null}
      <Text
        style={[styles.detail, title || artistLine ? styles.afterArtist : null]}
        testID={`${testID}-detail`}
      >
        {detailLine}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placard: {
    backgroundColor: colors.frameMat,
    borderColor: 'rgba(70,45,20,0.06)',
    borderRadius: 3,
    borderWidth: 1,
    minWidth: 236,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#46301A',
    shadowOffset: { height: 4, width: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 2,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.displayItalic,
    fontSize: 21,
    lineHeight: 25,
  },
  artist: {
    color: colors.ink,
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
  },
  afterTitle: {
    marginTop: 8,
  },
  detail: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 12.5,
  },
  afterArtist: {
    marginTop: 2,
  },
});
