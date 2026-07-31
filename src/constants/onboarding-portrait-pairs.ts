// Bundled before/after (real photo -> illustrated portrait) pairs for S16's
// "pick a photo" state (app/(onboarding)/portrait.tsx). Extracted from the
// demo account (hello+demo@usemomora.com) via
// supabase/scripts/export-onboarding-portrait-pairs.ts -- see that script's
// header comment for exactly how to re-run it (it's deliberately reusable
// beyond this one screen/account).
//
// Why this exists: S16 used to pair an empty placeholder card with one
// fixed finished portrait (`portrait-sample`, a real generated portrait of
// one of the founders' own children) -- which read as "this is what YOUR
// child's illustration will look like" (or worse, "is") rather than
// demonstrating the transformation in general. Rotating through several
// real photo -> portrait pairs from a fictional family instead shows the
// transformation itself, not one fixed identity.
//
// These are safe to bundle: the demo account's member photos are
// AI-generated from CANDID_PHONE_PHOTO_PROMPT_PREFIX
// (supabase/scripts/demo-family-spec.ts), which explicitly specifies
// "wholly fictional people, not based on any real person" -- no real
// likeness is bundled here, unlike the old portrait-sample asset.
export interface OnboardingPortraitPair {
  /** Stable key -- used as the React key when a future consumer needs one, and in tests. */
  key: string;
  /** `require('...')` -- the real (fictional) source photo. */
  photo: number;
  /** `require('...')` -- the same person's finished illustrated portrait. */
  portrait: number;
}

// Order mirrors DEMO_FAMILY_MEMBERS in supabase/scripts/demo-family-spec.ts
// (account holder, partner, kids oldest-to-youngest, then extended family)
// rather than any extraction/query order, so this list reads deliberately
// rather than looking shuffled.
export const onboardingPortraitPairs: readonly OnboardingPortraitPair[] = [
  {
    key: 'nora',
    photo: require('../../assets/onboarding/portrait-pairs/nora-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/nora-portrait.webp'),
  },
  {
    key: 'gabriel',
    photo: require('../../assets/onboarding/portrait-pairs/gabriel-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/gabriel-portrait.webp'),
  },
  {
    key: 'maya',
    photo: require('../../assets/onboarding/portrait-pairs/maya-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/maya-portrait.webp'),
  },
  {
    key: 'theo',
    photo: require('../../assets/onboarding/portrait-pairs/theo-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/theo-portrait.webp'),
  },
  {
    key: 'ari',
    photo: require('../../assets/onboarding/portrait-pairs/ari-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/ari-portrait.webp'),
  },
  {
    key: 'eunji',
    photo: require('../../assets/onboarding/portrait-pairs/eunji-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/eunji-portrait.webp'),
  },
  {
    key: 'rafael',
    photo: require('../../assets/onboarding/portrait-pairs/rafael-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/rafael-portrait.webp'),
  },
  {
    key: 'lucia',
    photo: require('../../assets/onboarding/portrait-pairs/lucia-photo.webp'),
    portrait: require('../../assets/onboarding/portrait-pairs/lucia-portrait.webp'),
  },
];
