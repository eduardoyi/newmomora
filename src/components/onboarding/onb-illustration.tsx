// Onboarding illustration primitive (docs/plans/onboarding-implementation.md
// WP0 §0.1). Renders the real asset once art exists for a slot
// (src/constants/onboarding-illustrations.ts), otherwise a layered
// `expo-linear-gradient` watercolor wash approximating the handoff's
// `Illustration` component (src/primitives.jsx): an emotion-soft highlight,
// a warm/accent scene wash, and a soft horizon band. `expo-linear-gradient`
// only does linear gradients (no CSS radial-gradient equivalent in React
// Native), so the "radial" highlights are approximated with off-center
// linear gradients rather than reproduced exactly.
import { Image, type ImageStyle } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { emotionColors, radius, type EmotionName } from '@/constants/theme';
import {
  onboardingIllustrations,
  type OnboardingIllustrationScene,
  type OnboardingIllustrationSlotId,
} from '@/constants/onboarding-illustrations';

// Kid tint cycling matches the handoff (src/screens/onboarding-story.jsx
// KID_TINTS): entry order determines the avatar tint, wrapping after 5.
// This is the one home for the helper -- both OnbIllustration-adjacent
// callers and KidChip (kid-chip.tsx) import it from here.
const KID_TINTS: EmotionName[] = ['tender', 'wonder', 'joy', 'calm', 'mischief'];

export function kidTint(index: number): EmotionName {
  const normalized = ((index % KID_TINTS.length) + KID_TINTS.length) % KID_TINTS.length;
  return KID_TINTS[normalized];
}

// Scene-specific warm/accent colors layered under the emotion tint --
// mirrors the handoff Illustration's `scenes` table.
const SCENE_WASHES: Record<OnboardingIllustrationScene, { warm: string; accent: string }> = {
  window: { warm: '#FCE0BB', accent: '#FBD3E2' },
  garden: { warm: '#E7F0CB', accent: '#FFE7B0' },
  bedroom: { warm: '#F4D9E0', accent: '#E5D2F1' },
  kitchen: { warm: '#FBE0B5', accent: '#F5D6CC' },
  park: { warm: '#D6EDDE', accent: '#FFE7B0' },
  bath: { warm: '#CFE1F4', accent: '#FBD6E1' },
};

interface OnbIllustrationProps {
  slot: OnboardingIllustrationSlotId;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function OnbIllustration({ slot, style, testID }: OnbIllustrationProps) {
  const meta = onboardingIllustrations[slot];
  const emo = emotionColors[meta.emotion];
  const wash = SCENE_WASHES[meta.scene];

  if (meta.asset) {
    return (
      <Image
        accessibilityLabel={meta.description}
        contentFit="cover"
        source={meta.asset}
        // Consumers pass plain layout styles (width/height/margin, all
        // valid for both View and Image); the component-level prop stays
        // ViewStyle since the wash branch below renders a View.
        style={[styles.fill, style] as StyleProp<ImageStyle>}
        testID={testID}
      />
    );
  }

  return (
    <View accessibilityLabel={meta.description} accessible style={[styles.fill, style]} testID={testID}>
      <LinearGradient
        colors={[wash.warm, emo.soft, wash.accent]}
        end={{ x: 0.75, y: 1 }}
        locations={[0, 0.75, 1]}
        start={{ x: 0.1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[emo.soft, 'transparent']}
        end={{ x: 0.2, y: 0.75 }}
        start={{ x: 0.7, y: 0.18 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['transparent', `${emo.c}1A`]}
        end={{ x: 0, y: 1 }}
        start={{ x: 0, y: 0.62 }}
        style={styles.horizon}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    width: '100%',
    height: '100%',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  horizon: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '38%',
  },
});
