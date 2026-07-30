// Bundled real-content sample memories for onboarding's art-driven screens
// (docs/plans/onboarding-design-brief.md S5, S10b, S15; docs/plans/
// onboarding-implementation.md decision 5, WP2's S10b bullet). Real
// illustration/photo/video-poster assets now exist under assets/onboarding/
// (27 files) -- this is the one place that pairs each asset with its
// caption, emotion, and date, so artifact.tsx (S5), year.tsx (S10b), and
// paywall.tsx (S15) render from data instead of inventing per-screen
// literals. Every string below is copied verbatim from the design brief's
// curated rewrites -- do not paraphrase.
import type { EmotionName } from '@/constants/theme';

export type OnboardingMemoryType = 'illustrated' | 'photo' | 'video' | 'text';

export interface OnboardingSampleMemory {
  /** Stable slug -- used as the React key and testID suffix. */
  key: string;
  type: OnboardingMemoryType;
  /** `require('...')` -- the illustration, photo, or video poster. Absent for text. */
  asset?: number;
  text: string;
  /** Absent -> no emotion chip renders (some real memories genuinely have none). */
  emotion?: EmotionName;
  /** ISO date (yyyy-mm-dd), formatted for display via formatMemoryDayLabel. */
  isoDate: string;
  /** e.g. '0:05' -- video only, rendered in the duration chip. */
  durationLabel?: string;
  /** Caveat annotation hung off the card (S10b only, a few cards). */
  annotation?: string;
}

const DAY_LABEL_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  // Force UTC on the format side to match the UTC-anchored parse below --
  // an ISO date-only string names a calendar day, not an instant, so no
  // step here may depend on the device's local timezone.
  timeZone: 'UTC',
};

/**
 * 'Thu, Aug 14' style -- weekday + short month + day. Parses the ISO date's
 * year/month/day components directly into Date.UTC (rather than e.g.
 * `new Date(isoDate)`, which V8 treats as UTC midnight and can therefore
 * render as the PREVIOUS day in any timezone behind UTC) so the result never
 * shifts by a day depending on where the device is.
 */
export function formatMemoryDayLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString('en-US', DAY_LABEL_FORMAT);
}

// -- S5: the artifact demo (Founder intro B) --------------------------------
// Exactly 3 cards, this order, curated rewrites verbatim.
export const artifactMemories: readonly OnboardingSampleMemory[] = [
  {
    key: 'laundry-basket',
    type: 'illustrated',
    asset: require('../../assets/onboarding/s5-laundry-basket.webp'),
    text: 'Enzo and Mara decided the best place to play together was inside the laundry basket.',
    emotion: 'joy',
    isoDate: '2025-08-14',
  },
  {
    key: 'crib-hello-baby',
    type: 'illustrated',
    asset: require('../../assets/onboarding/s5-crib-hello-baby.webp'),
    text: "This morning the two of them were in Enzo's crib, Mara watching Enzo while he told her, 'Hello, my baby. Hello, my baby.'",
    emotion: 'tender',
    isoDate: '2025-07-22',
  },
  {
    key: 'no-nap-tears',
    type: 'illustrated',
    asset: require('../../assets/onboarding/s5-no-nap-tears.webp'),
    text: 'No nap today, and it showed. They bonked heads playing and both burst into tears while I held them.',
    emotion: 'weary',
    isoDate: '2025-08-16',
  },
];

// -- S10b: "A year of these" example cards -----------------------------------
// Exactly 20 entries, newest first, curated rewrites verbatim. Four are
// plain text (no asset); the rest pair a real illustration/photo/video-poster
// asset with its caption.
export const yearMemories: readonly OnboardingSampleMemory[] = [
  {
    key: 'crackers-purse',
    type: 'text',
    text: "Maya packed three crackers in her little purse 'in case the playground gets hungry.' Theo ate the emergency crackers before we left.",
    emotion: 'funny',
    isoDate: '2026-07-18',
  },
  {
    key: 'fort-hallway',
    type: 'photo',
    asset: require('../../assets/onboarding/year-fort-hallway.webp'),
    text: 'They built a fort in the hallway, then argued about whether babies can be in a fort. Ari was admitted because he brought crackers.',
    emotion: 'funny',
    isoDate: '2026-07-17',
  },
  {
    key: 'bath-mustache',
    type: 'illustrated',
    asset: require('../../assets/onboarding/year-bath-mustache.webp'),
    text: "We were ten minutes into bath when Theo said he needed a 'foam mustache like Grandpa.' Everyone got one. Even the duck.",
    emotion: 'funny',
    isoDate: '2026-07-16',
  },
  {
    key: 'farmers-market',
    type: 'photo',
    asset: require('../../assets/onboarding/year-farmers-market.webp'),
    text: 'Farmers market with Nana. Maya chose one peach, hugged it through three stalls, then it rolled under a stroller. She said it was taking a little walk.',
    emotion: 'joy',
    isoDate: '2026-07-15',
    annotation: 'a blurry market photo, still counts',
  },
  {
    key: 'pea-nap',
    type: 'photo',
    asset: require('../../assets/onboarding/year-pea-nap.webp'),
    text: 'Ari fell asleep in the high chair with one hand still holding a pea. I moved exactly nothing for forty minutes.',
    emotion: 'tender',
    isoDate: '2026-07-14',
  },
  {
    key: 'clapping-video',
    type: 'video',
    asset: require('../../assets/onboarding/year-clapping-poster.webp'),
    text: 'Ari figured out clapping today. Theo took full credit and said he "taught him hands."',
    isoDate: '2026-07-12',
    durationLabel: '0:05',
    annotation: 'five seconds of the clapping debut',
  },
  {
    key: 'ladybug',
    type: 'illustrated',
    asset: require('../../assets/onboarding/year-ladybug.webp'),
    text: 'Maya found a ladybug on the windowsill and asked if it had a mommy who knew where it was.',
    emotion: 'wonder',
    isoDate: '2026-07-10',
  },
  {
    key: 'no-singing-rule',
    type: 'text',
    text: 'New rule from Maya: no singing while she is thinking. This rule does not apply to her.',
    emotion: 'funny',
    isoDate: '2026-07-08',
  },
  {
    key: 'sprinkler',
    type: 'photo',
    asset: require('../../assets/onboarding/year-sprinkler.webp'),
    text: 'Grandpa turned on the sprinkler and immediately became the most popular person on the block.',
    emotion: 'joy',
    isoDate: '2026-07-06',
  },
  {
    key: 'picnic-lettuce',
    type: 'photo',
    asset: require('../../assets/onboarding/year-picnic-lettuce.webp'),
    text: 'We packed a picnic, forgot napkins, and then Theo used a lettuce leaf like it had been his plan all along.',
    emotion: 'funny',
    isoDate: '2026-07-04',
  },
  {
    key: 'family-drawing',
    type: 'illustrated',
    asset: require('../../assets/onboarding/year-family-drawing.webp'),
    text: 'Maya drew everyone at dinner. Apparently Dad has a square head because he likes sandwiches.',
    emotion: 'funny',
    isoDate: '2026-07-01',
  },
  {
    key: 'pancakes',
    type: 'photo',
    asset: require('../../assets/onboarding/year-pancakes.webp'),
    text: "Sunday pancakes. Theo kept yelling 'more circles!' and somehow that felt like a reasonable request.",
    emotion: 'joy',
    isoDate: '2026-06-29',
  },
  {
    key: 'zebra',
    type: 'text',
    text: "Theo saw a zebra in his book and said, 'Look, a stripey horse cat.' Honestly, close enough.",
    emotion: 'funny',
    isoDate: '2026-06-25',
    annotation: 'the name he invented for zebras',
  },
  {
    key: 'dance-video',
    type: 'video',
    asset: require('../../assets/onboarding/year-dance-poster.webp'),
    text: 'Lucía put on one song while dinner was cooking and now we have a family dance video where nobody is doing the same move.',
    isoDate: '2026-06-21',
    durationLabel: '0:05',
  },
  {
    key: 'nana-sneeze',
    type: 'illustrated',
    asset: require('../../assets/onboarding/year-nana-sneeze.webp'),
    text: 'Ari laughed so hard at Nana sneezing that he got the hiccups. Then every time we said achoo he laughed again.',
    emotion: 'funny',
    isoDate: '2026-06-14',
  },
  {
    key: 'dumplings',
    type: 'photo',
    asset: require('../../assets/onboarding/year-dumplings.webp'),
    text: 'Nana showed Maya how to fold dumplings. Maya made one the size of a pillow and named it Big Baby.',
    emotion: 'joy',
    isoDate: '2026-06-11',
  },
  {
    key: 'lonely-sticker',
    type: 'text',
    text: 'Maya asked if grown-ups ever get lonely at school. I said sometimes. She packed an extra sticker in my bag for tomorrow.',
    emotion: 'tender',
    isoDate: '2026-05-28',
  },
  {
    key: 'mud-kitchen',
    type: 'photo',
    asset: require('../../assets/onboarding/year-mud-kitchen.webp'),
    text: "Mud kitchen season. Theo served me 'soup with rocks, but the soft rocks.' I paid with a dandelion.",
    emotion: 'tender',
    isoDate: '2026-05-17',
  },
  {
    key: 'goodnight-moon',
    type: 'illustrated',
    asset: require('../../assets/onboarding/year-goodnight-moon.webp'),
    text: 'Bedtime took forever because Maya needed to check on the moon. She whispered goodnight through the window and then finally went down.',
    emotion: 'wonder',
    isoDate: '2026-05-03',
  },
  {
    key: 'porch-bubbles',
    type: 'text',
    text: 'First warm evening in forever. The kids were in pajamas on the porch after bath, chasing bubbles and refusing to come inside because the sky was still pink.',
    emotion: 'joy',
    isoDate: '2026-04-22',
  },
];

/** Looks up a required yearMemories entry by key -- throws on a typo/rename so a missing key fails loudly at import time rather than silently dropping a card. */
function requireYearMemory(key: string): OnboardingSampleMemory {
  const memory = yearMemories.find((candidate) => candidate.key === key);

  if (!memory) {
    throw new Error(`onboarding-memories: no yearMemories entry with key "${key}"`);
  }

  return memory;
}

// -- S15: paywall backdrop ----------------------------------------------
// The same three yearMemories objects (not duplicated literals) the design
// brief calls out for the paywall's fanned backdrop.
export const paywallBackdropMemories: readonly OnboardingSampleMemory[] = [
  requireYearMemory('bath-mustache'),
  requireYearMemory('goodnight-moon'),
  requireYearMemory('ladybug'),
];
