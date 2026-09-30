// Segmented scene progress for the Year Film player -- the look of
// looking-back/story-progress.tsx (thin rounded bars, cream on translucent
// cream, 2px gaps), one segment per scene from scenes.json (a single segment
// when the file is missing). Segments are equal width whatever the scene
// length, so a tap-to-next always advances one visible segment.
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import type { FilmScene } from '@/utils/year-film-scenes';

interface FilmProgressProps {
  scenes: readonly FilmScene[];
  activeIndex: number;
  /** Playback position in ms; only the active segment reads it. */
  positionMs: SharedValue<number>;
  isComplete: boolean;
}

function ActiveFill({ scene, positionMs }: { scene: FilmScene; positionMs: SharedValue<number> }) {
  const animated = useAnimatedStyle(() => {
    const fraction = (positionMs.value - scene.startMs) / scene.durationMs;
    return { width: `${Math.min(1, Math.max(0, fraction)) * 100}%` };
  });
  return <Animated.View style={[styles.fill, animated]} />;
}

export function FilmProgress({ scenes, activeIndex, positionMs, isComplete }: FilmProgressProps) {
  const count = scenes.length;
  const label = count > 1 ? `Scene ${Math.min(activeIndex + 1, count)} of ${count}` : 'Film progress';
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: count, now: isComplete ? count : Math.min(activeIndex + 1, count) }}
      style={styles.progress}
      testID="year-film-progress"
    >
      {scenes.map((scene, index) => {
        const isActive = !isComplete && index === activeIndex;
        const isDone = isComplete || index < activeIndex;
        return (
          <View
            key={`${scene.id}-${index}`}
            style={[styles.segment, index > 0 && styles.segmentGap]}
            testID={`year-film-progress-segment-${index}`}
          >
            {isActive ? (
              <ActiveFill positionMs={positionMs} scene={scene} />
            ) : (
              <View style={[styles.fill, { width: isDone ? '100%' : '0%' }]} />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { alignItems: 'center', flexDirection: 'row' },
  segment: {
    backgroundColor: 'rgba(246,241,231,0.2)',
    borderRadius: 2,
    flex: 1,
    height: 3,
    overflow: 'hidden',
  },
  segmentGap: { marginLeft: 2 },
  fill: { backgroundColor: 'rgba(246,241,231,0.95)', borderRadius: 2, height: 3 },
});
