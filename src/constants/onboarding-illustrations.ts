// Illustration slot map for onboarding (docs/plans/onboarding-implementation.md
// WP0 §0.2). Every slot the design handoff calls out via an `image-slot`
// element gets one entry here -- `OnbIllustration` (src/components/onboarding/
// onb-illustration.tsx) renders the real `asset` once art exists, otherwise
// the watercolor-wash placeholder driven by `emotion` + `scene`. Real art now
// exists for every slot below (assets/onboarding/*.webp) -- dropping more/
// different art still only touches this file, never a screen.
//
// The former `paywall-page-1/3/4` generic "illustrated page" slots are gone:
// S5's artifact.tsx and S15's paywall.tsx now render real, specific memory
// content from src/constants/onboarding-memories.ts (artifactMemories /
// paywallBackdropMemories) instead of sharing anonymous placeholder slots.
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
    asset: require('../../assets/onboarding/welcome.webp'),
  },
  'story-night': {
    description: "Dark illustration: phone glow on a parent's face at 2 a.m.",
    emotion: 'weary',
    scene: 'bedroom',
    asset: require('../../assets/onboarding/story-night.webp'),
  },
  'story-book': {
    description: 'Soft illustration: baby book shut on a closet shelf, sock on top',
    emotion: 'bittersweet',
    scene: 'bedroom',
    asset: require('../../assets/onboarding/story-book.webp'),
  },
  'story-babble': {
    description: 'Bright illustration: toddler mid-babble, invented words floating',
    emotion: 'joy',
    scene: 'garden',
    asset: require('../../assets/onboarding/story-babble.webp'),
  },
  founders: {
    description: 'Illustrated portrait: Eduardo & Adriana, Momora style',
    emotion: 'tender',
    scene: 'window',
    asset: require('../../assets/onboarding/founders.webp'),
  },
  'kids-doodle': {
    description: 'Small warm doodle',
    emotion: 'joy',
    scene: 'garden',
    asset: require('../../assets/onboarding/kids-doodle.webp'),
  },
  'family-nest': {
    description: 'Nest / house motif',
    emotion: 'calm',
    scene: 'window',
    asset: require('../../assets/onboarding/family-nest.webp'),
  },
  'portrait-sample': {
    description: 'Sample portrait',
    emotion: 'tender',
    scene: 'bedroom',
    asset: require('../../assets/onboarding/portrait-sample.webp'),
  },
  'join-door': {
    description: 'Illustration: a door with warm light under it',
    emotion: 'calm',
    scene: 'window',
    asset: require('../../assets/onboarding/join-door.webp'),
  },
};
