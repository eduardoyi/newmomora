import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import type { LookingBackChapter, LookingBackFrame } from '@/utils/looking-back-frames';

function ProgressFill({ fill, activeProgress }: { fill: number; activeProgress?: SharedValue<number> }) {
  const animated = useAnimatedStyle(() => ({ width: `${Math.min(100, (activeProgress ? activeProgress.value : fill) * 100)}%` }));
  return <Animated.View style={[styles.fill, animated]} />;
}

export function StoryProgress({ chapters, frame, frameFraction, progress }: { chapters: LookingBackChapter[]; frame: LookingBackFrame | null; frameFraction: number; progress?: SharedValue<number> }) {
  const frames = chapters.flatMap((chapter) => chapter.frames);
  return <View accessibilityLabel={frame ? `Memory ${frame.chapterIndex + 1} of ${chapters.length}` : 'Package progress'} accessibilityRole="progressbar" style={styles.progress}>
    {frames.map((candidate, index) => {
      const previousFrame = frames[index - 1];
      const gap = index === 0 ? 0 : previousFrame?.chapterIndex === candidate.chapterIndex ? 2 : 5;
      const fill = !frame ? 0 : frame.index > candidate.index ? 1 : frame.index === candidate.index ? frameFraction : 0;
      return <View key={candidate.id} style={[styles.frame, { marginLeft: gap }]} testID={`looking-back-progress-frame-${candidate.index}`}><ProgressFill activeProgress={frame?.index === candidate.index ? progress : undefined} fill={fill} /></View>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  progress: { alignItems: 'center', flex: 1, flexDirection: 'row' },
  frame: { backgroundColor: 'rgba(246,241,231,0.2)', borderRadius: 2, flex: 1, height: 3, overflow: 'hidden' },
  fill: { backgroundColor: 'rgba(246,241,231,0.95)', borderRadius: 2, height: 3 },
});
