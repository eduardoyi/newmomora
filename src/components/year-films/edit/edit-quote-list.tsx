// "Line of the year" section of the Year Film edit sheet: a radio list of the
// (at most three) sticky quote candidates.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius } from '@/constants/theme';
import type { YearFilmQuoteCandidate } from '@/services/year-films';

export interface SelectedQuote {
  memoryId: string;
  textHash: string;
}

export function isSameQuote(a: SelectedQuote | null, b: SelectedQuote | null): boolean {
  return a?.memoryId === b?.memoryId && a?.textHash === b?.textHash;
}

/** A radio dot shared by the quote and music lists. */
export function RadioDot({ selected }: { selected: boolean }) {
  return (
    <View style={[styles.radio, selected && styles.radioSelected]}>
      {selected ? <View style={styles.radioInner} /> : null}
    </View>
  );
}

interface EditQuoteListProps {
  candidates: readonly YearFilmQuoteCandidate[];
  selected: SelectedQuote | null;
  onSelect: (quote: SelectedQuote) => void;
}

export function EditQuoteList({ candidates, selected, onSelect }: EditQuoteListProps) {
  return (
    <View style={styles.list} testID="film-edit-quote-list">
      {candidates.map((candidate, index) => {
        const isSelected = isSameQuote(selected, candidate);
        return (
          <Pressable
            accessibilityLabel={
              candidate.speakerName ? `${candidate.text}, said by ${candidate.speakerName}` : candidate.text
            }
            accessibilityRole="radio"
            accessibilityState={{ checked: isSelected }}
            key={`${candidate.memoryId}:${candidate.textHash}`}
            onPress={() => onSelect({ memoryId: candidate.memoryId, textHash: candidate.textHash })}
            style={({ pressed }) => [styles.row, isSelected && styles.rowSelected, pressed && styles.rowPressed]}
            testID={`film-edit-quote-${index}`}
          >
            <RadioDot selected={isSelected} />
            <View style={styles.textBlock}>
              <Text style={styles.quote}>{`“${candidate.text}”`}</Text>
              {candidate.speakerName ? <Text style={styles.speaker}>{candidate.speakerName}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  row: {
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderColor: 'transparent',
    borderRadius: radius.md,
    borderWidth: 1.5,
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
    padding: 12,
  },
  rowSelected: { backgroundColor: colors.primaryTint, borderColor: colors.primary },
  rowPressed: { opacity: 0.85 },
  textBlock: { flex: 1, gap: 3 },
  quote: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 15, lineHeight: 21 },
  speaker: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 12 },
  radio: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 10,
    borderWidth: 2,
    height: 20,
    justifyContent: 'center',
    marginTop: 1,
    width: 20,
  },
  radioSelected: { borderColor: colors.primary },
  radioInner: { backgroundColor: colors.primary, borderRadius: 5, height: 10, width: 10 },
});
