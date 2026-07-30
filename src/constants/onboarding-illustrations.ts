// Illustration slot map for onboarding (docs/plans/onboarding-implementation.md
// WP0 §0.2). Every slot the design handoff calls out via an `image-slot`
// element gets one entry here -- `OnbIllustration` (src/components/onboarding/
// onb-illustration.tsx) renders the real `asset` once art exists, otherwise
// the watercolor-wash placeholder driven by `emotion` + `scene`. Dropping
// real art in later touches only this file, never a screen.
//
// `description` is verbatim from the handoff's `placeholder` text (source:
// /project/src/screens/onboarding-story.jsx, onboarding-trust.jsx,
// onboarding-join.jsx) and doubles as the accessibility label and the dev
// caption. `emotion`/`scene` are not specified by the handoff for these
// slots (only the S5 sample-card `Illustration` calls in the prototype pass
// explicit emotion/scene, and those are runtime-generated sample cards, not
// named slots) -- the pairings below are this implementer's creative call,
// picked to match each placeholder's described mood/setting.
import type { EmotionName } from '@/constants/theme';

export type OnboardingIllustrationScene = 'window' | 'garden' | 'bedroom' | 'kitchen' | 'park' | 'bath';

export type OnboardingIllustrationSlotId =
  | 'welcome'
  | 'story-night'
  | 'story-book'
  | 'story-babble'
  | 'founders'
  | 'kids-doodle'
  | 'family-nest'
  | 'paywall-page-1'
  | 'paywall-page-3'
  | 'paywall-page-4'
  | 'portrait-sample'
  | 'join-door';

export interface OnboardingIllustrationSlot {
  /** Becomes the accessibilityLabel and the placeholder caption in dev. */
  description: string;
  /** Drives the placeholder wash. */
  emotion: EmotionName;
  scene: OnboardingIllustrationScene;
  /** `require('...')` once real art exists for this slot. */
  asset?: number;
}

export const onboardingIllustrations: Record<OnboardingIllustrationSlotId, OnboardingIllustrationSlot> = {
  welcome: {
    description: 'Warm illustration: parent + child reading in lamplight',
    emotion: 'tender',
    scene: 'bedroom',
  },
  'story-night': {
    description: "Dark illustration: phone glow on a parent's face at 2 a.m.",
    emotion: 'weary',
    scene: 'bedroom',
  },
  'story-book': {
    description: 'Soft illustration: baby book shut on a closet shelf, sock on top',
    emotion: 'bittersweet',
    scene: 'bedroom',
  },
  'story-babble': {
    description: 'Bright illustration: toddler mid-babble, invented words floating',
    emotion: 'joy',
    scene: 'garden',
  },
  founders: {
    description: 'Illustrated portrait: Eduardo & Adriana, Momora style',
    emotion: 'tender',
    scene: 'window',
  },
  'kids-doodle': {
    description: 'Small warm doodle',
    emotion: 'joy',
    scene: 'garden',
  },
  'family-nest': {
    description: 'Nest / house motif',
    emotion: 'calm',
    scene: 'window',
  },
  'paywall-page-1': {
    description: 'Illustrated page',
    emotion: 'joy',
    scene: 'park',
  },
  'paywall-page-3': {
    description: 'Illustrated page',
    emotion: 'wonder',
    scene: 'garden',
  },
  'paywall-page-4': {
    description: 'Illustrated page',
    emotion: 'tender',
    scene: 'kitchen',
  },
  'portrait-sample': {
    description: 'Sample portrait',
    emotion: 'tender',
    scene: 'bedroom',
  },
  'join-door': {
    description: 'Illustration: a door with warm light under it',
    emotion: 'calm',
    scene: 'window',
  },
};
