// The "Edit" action on the player's completion overlay (owners/managers).
// Styled as FilmCompletion's secondary (outlined) button.
import { Pencil } from 'lucide-react-native';
import { Pressable, StyleSheet, Text } from 'react-native';

import { fonts } from '@/constants/theme';

const CREAM = '#F6F1E7';

export function EditFilmButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Edit this film"
      accessibilityRole="button"
      onPress={onPress}
      style={styles.button}
      testID="year-film-edit"
    >
      <Pencil color={CREAM} size={16} />
      <Text style={styles.text}>Edit</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderColor: 'rgba(246,241,231,0.4)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 168,
    paddingHorizontal: 22,
  },
  text: { color: CREAM, fontFamily: fonts.sansBold, fontSize: 14 },
});
