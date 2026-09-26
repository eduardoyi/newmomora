import { StyleSheet, Text, View } from 'react-native';

import { seedFromKey } from '@/components/audio/audio-seed';
import { SoundTile } from '@/components/audio/sound-tile';
import { colors, fonts, getEmotionColors } from '@/constants/theme';
import type { MemoryFallbackKind } from '@/utils/memory-fallback';

interface MemoryFallbackTileProps {
  memoryId: string;
  kind: MemoryFallbackKind;
  emotion: string | null;
  /** Inner size in points (inside any border the caller draws). */
  size: number;
  testID?: string;
}

/**
 * Small square stand-in for a memory with no image, filling its parent:
 * an emotion-tinted quote mark for text memories, a SoundTile for audio,
 * nothing (the parent's surface) otherwise. Used by the family activity
 * drawer and search results.
 */
export function MemoryFallbackTile({ memoryId, kind, emotion, size, testID }: MemoryFallbackTileProps) {
  if (kind === 'sound') {
    return (
      <SoundTile
        durationSeconds={0}
        emotion={emotion}
        seed={seedFromKey(memoryId)}
        showDuration={false}
        size={size}
        testID={testID ? `${testID}-sound` : undefined}
      />
    );
  }
  if (kind === 'quote') {
    const emo = getEmotionColors(emotion);
    // Member-profile thumbQuote (54px thumb) scaled by size.
    const fontSize = Math.round(size * 0.6);
    return (
      <View
        style={[styles.fill, { backgroundColor: emo?.soft ?? colors.surface }]}
        testID={testID ? `${testID}-quote` : undefined}
      >
        <Text style={[styles.quoteMark, { color: emo?.ink ?? colors.ink3, fontSize, lineHeight: fontSize, marginTop: -Math.round(fontSize * 0.12) }]}>“</Text>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  quoteMark: { fontFamily: fonts.display, opacity: 0.45 },
});
