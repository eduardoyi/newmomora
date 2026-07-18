/**
 * Declarative content for the screenshot-only Momora demo household.
 *
 * Every person and every visual in this file is fictional and must be
 * generated from scratch. This module intentionally has no environment,
 * network, database, or storage dependencies so a seeding runner can import
 * it without accidentally mutating production while planning a run.
 */

export const DEMO_ACCOUNT_EMAIL = "hello+demo@usemomora.com";

export const DEMO_FAMILY = {
  slug: "kim-ortiz-family",
  name: "The Kim-Ortiz Family",
  accountDisplayName: "Nora Kim",
  portraitReferenceDate: "2026-04-18",
} as const;

export const CANDID_PHONE_PHOTO_PROMPT_PREFIX =
  `A candid, unretouched smartphone photo of wholly fictional people, not based on any real person. Preserve the supplied reference people's identity, age, facial structure, hair, and skin tone. Everyday lived-in setting, natural mixed light, imperfect framing, genuine mid-action expression, slight handheld softness where appropriate, ordinary clutter, and realistic skin texture. It should feel like a parent took it quickly on a phone, not like a commercial lifestyle shoot. No text, watermark, logo, studio lighting, glam retouching, posed smiles, or uncanny perfection.`;

export type DemoMemoryType = "text_only" | "text_illustration" | "media";
export type DemoMediaKind = "photo" | "video";

export interface DemoFamilyMemberSpec {
  slug: string;
  name: string;
  nicknames: readonly string[];
  dateOfBirth: string;
  gender: string;
  relationship: string;
  isUserProfile?: boolean;
  /** Synthetic portrait inputs to use after these member sources are ready. */
  profileReferenceSlugs?: readonly string[];
  additionalInfo: string;
  profilePhotoPrompt: string;
}

export interface DemoMediaAssetSpec {
  slug: string;
  kind: DemoMediaKind;
  /** Only the synthetic people visually used by this individual asset. */
  memberSlugs: readonly string[];
  prompt: string;
  aspectRatio: "2:3" | "9:16";
  durationSeconds?: 5;
}

interface DemoMemoryBase {
  slug: string;
  memoryDate: string;
  caption: string;
  tagSlugs: readonly string[];
}

export interface DemoTextOnlyMemorySpec extends DemoMemoryBase {
  memoryType: "text_only";
}

export interface DemoIllustratedMemorySpec extends DemoMemoryBase {
  memoryType: "text_illustration";
  illustrationPrompt: string;
}

export interface DemoMediaMemorySpec extends DemoMemoryBase {
  memoryType: "media";
  mediaAssets: readonly DemoMediaAssetSpec[];
}

export type DemoMemorySpec =
  | DemoTextOnlyMemorySpec
  | DemoIllustratedMemorySpec
  | DemoMediaMemorySpec;

export interface DemoFamilySeedSpec {
  family: typeof DEMO_FAMILY;
  account: {
    email: string;
    name: string;
    timezone: string;
  };
  members: readonly DemoFamilyMemberSpec[];
  memories: readonly {
    slug: string;
    type: DemoMemoryType;
    caption: string;
    memoryDate: string;
    tags: readonly string[];
    prompt?: string;
    assets?: readonly DemoMediaAssetSpec[];
  }[];
}

export const DEMO_FAMILY_MEMBERS = [
  {
    slug: "nora-kim",
    name: "Nora Kim",
    nicknames: ["Nori"],
    dateOfBirth: "1992-11-04",
    gender: "woman",
    relationship: "Mom and account holder",
    isUserProfile: true,
    profileReferenceSlugs: [],
    additionalInfo:
      "Korean-American mom, a steady amused observer who always has a mug going cold nearby.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 kitchen-window selfie of Nora, a fictional 33-year-old Korean-American woman with warm beige skin, straight nearly-black shoulder-length hair in a center part, soft brown eyes, a gentle round face, and small gold hoops. Loose oatmeal cardigan and a dish towel over one shoulder, caught mid-laugh because someone off-camera interrupted her.`,
  },
  {
    slug: "gabe-ortiz",
    name: "Gabriel Ortiz",
    nicknames: ["Gabe"],
    dateOfBirth: "1990-04-27",
    gender: "man",
    relationship: "Dad",
    profileReferenceSlugs: [],
    additionalInfo:
      "Mexican-American dad, patient and playful, usually the one being climbed on.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 phone photo of Gabe, a fictional 36-year-old Mexican-American man with warm tan skin, thick loose dark-brown curls, brown eyes, a compact athletic build, and a short tidy beard. Faded navy tee at a park bench, looking down to zip a child's jacket before realizing he is being photographed.`,
  },
  {
    slug: "maya-kim-ortiz",
    name: "Maya Kim-Ortiz",
    nicknames: ["May"],
    dateOfBirth: "2020-08-29",
    gender: "girl",
    relationship: "Daughter",
    profileReferenceSlugs: ["nora-kim", "gabe-ortiz"],
    additionalInfo:
      "Tender-hearted, theatrical, and very serious about rules she invents.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 candid of Maya, a fictional five-year-old girl with warm tan-beige skin, big dark-brown eyes, long wavy dark hair in a messy half ponytail, and one missing lower baby tooth. By a bedroom window in an oversized yellow tee and mismatched socks, holding a crayon drawing partly out of frame with a shy crooked smile.`,
  },
  {
    slug: "theo-kim-ortiz",
    name: "Theo Kim-Ortiz",
    nicknames: ["Teo"],
    dateOfBirth: "2023-02-15",
    gender: "boy",
    relationship: "Son",
    profileReferenceSlugs: ["nora-kim", "gabe-ortiz"],
    additionalInfo:
      "Loudly affectionate, snack-motivated, and determined to help.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 candid of Theo, a fictional three-year-old boy with warm tan-beige skin, dark springy curls that never stay brushed, bright brown eyes, and a left-cheek dimple. In a hallway in a tiny striped shirt with one sneaker off, kneeling over toy cars with a suspiciously serious face.`,
  },
  {
    slug: "ari-kim-ortiz",
    name: "Ari Kim-Ortiz",
    nicknames: [],
    dateOfBirth: "2025-09-17",
    gender: "baby boy",
    relationship: "Baby son",
    profileReferenceSlugs: ["nora-kim", "gabe-ortiz"],
    additionalInfo: "Delighted by clapping, sneezes, and being included.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 candid of Ari, a fictional ten-month-old baby boy with soft medium-beige skin, thick dark hair sticking up at the crown, wide brown eyes, round cheeks, and two bottom teeth. On a play mat in a cream romper, turning toward a sound with one hand in his mouth and a cheeky half-smile.`,
  },
  {
    slug: "eunji-kim",
    name: "Eunji Kim",
    nicknames: ["Nana"],
    dateOfBirth: "1963-06-11",
    gender: "woman",
    relationship: "Nora's mother and grandmother",
    profileReferenceSlugs: ["nora-kim"],
    additionalInfo:
      "Korean-American grandmother, warm and practical, patient with small hands in the kitchen.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 candid of Eunji, a fictional 63-year-old Korean-American woman with light warm-beige skin, a softly waved silver-black bob, oval tortoiseshell glasses, and calm brown eyes. At the dining table in a pale-blue linen shirt, flour on one fingertip, looking over at a child rather than the camera.`,
  },
  {
    slug: "rafael-ortiz",
    name: "Rafael Ortiz",
    nicknames: ["Rafa", "Grandpa"],
    dateOfBirth: "1959-12-03",
    gender: "man",
    relationship: "Gabe's father and grandfather",
    profileReferenceSlugs: ["gabe-ortiz"],
    additionalInfo:
      "Mexican-American grandfather and gentle chaos agent with tools, sprinklers, and terrible jokes.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 candid of Rafael, a fictional 66-year-old Mexican-American man with deep warm-tan skin, silver curls, a salt-and-pepper mustache, laugh lines, and a sturdy build. Outside a garage in a worn green overshirt and gardening gloves, adjusting a hose with a big private grin.`,
  },
  {
    slug: "lucia-ortiz",
    name: "Lucía Ortiz",
    nicknames: ["Aunt Lucía"],
    dateOfBirth: "1995-03-18",
    gender: "woman",
    relationship: "Gabe's sister and aunt",
    profileReferenceSlugs: ["gabe-ortiz", "rafael-ortiz"],
    additionalInfo:
      "Art-teacher aunt who brings stickers and accidentally starts dance parties.",
    profilePhotoPrompt:
      `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Vertical 2:3 candid of Lucía, a fictional 31-year-old Mexican-American woman with warm tan skin, long dark curly hair in a low bun, expressive dark eyes, and colorful patterned earrings. Sitting cross-legged on a front stoop in a rust-colored jumpsuit while fixing a child's sticker on her sleeve.`,
  },
] as const satisfies readonly DemoFamilyMemberSpec[];

export const DEMO_MEMORIES = [
  {
    slug: "playground-emergency-crackers",
    memoryDate: "2026-07-18",
    memoryType: "text_only",
    caption:
      "Maya packed three crackers in her little purse 'in case the playground gets hungry.' Theo ate the emergency crackers before we left.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz"],
  },
  {
    slug: "hallway-fort-admission",
    memoryDate: "2026-07-17",
    memoryType: "media",
    caption:
      "They built a fort in the hallway, then argued about whether babies can be in a fort. Ari was admitted because he brought crackers.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz"],
    mediaAssets: [{
      slug: "hallway-fort",
      kind: "photo",
      aspectRatio: "2:3",
      memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Ari. Maya and Theo crouch inside a lumpy blanket fort made from sofa cushions in a narrow hallway. Ari sits at the entrance holding a rice cracker. Sunlight from a nearby room, one adult sock and toy dinosaurs on the floor.`,
    }],
  },
  {
    slug: "bubble-mustaches",
    memoryDate: "2026-07-16",
    memoryType: "text_illustration",
    caption:
      "We were ten minutes into bath when Theo said he needed a 'foam mustache like Grandpa.' Everyone got one. Even the duck.",
    tagSlugs: [
      "gabe-ortiz",
      "maya-kim-ortiz",
      "theo-kim-ortiz",
      "ari-kim-ortiz",
    ],
    illustrationPrompt:
      "Warm, playful evening bath scene with the tagged fictional family members, fluffy bubble mustaches, a rubber duck with its own mustache, toddler pride, and a soft peach and pale-blue palette.",
  },
  {
    slug: "peach-takes-a-walk",
    memoryDate: "2026-07-15",
    memoryType: "media",
    caption:
      "Farmers market with Nana. Maya chose one peach, hugged it through three stalls, then it rolled under a stroller. She said it was taking a little walk.",
    tagSlugs: ["eunji-kim", "maya-kim-ortiz", "theo-kim-ortiz"],
    mediaAssets: [
      {
        slug: "peach-choice",
        kind: "photo",
        aspectRatio: "2:3",
        memberSlugs: ["eunji-kim", "maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Eunji, Maya, and Theo. Maya seriously inspects peaches beside Nana's canvas tote at a small busy farmers market, while Theo reaches toward a basket of apricots. Outdoor shade and casual partial framing.`,
      },
      {
        slug: "peach-hug",
        kind: "photo",
        aspectRatio: "2:3",
        memberSlugs: ["eunji-kim", "maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Eunji and Maya. Maya hugs one peach to her chest as Nana smiles behind a market stall, crowd and handwritten produce signs softly out of focus in the background.`,
      },
      {
        slug: "peach-rescue",
        kind: "photo",
        aspectRatio: "2:3",
        memberSlugs: ["maya-kim-ortiz", "eunji-kim"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Eunji. Maya crouches under a stroller on a peach rescue mission, holding the recovered peach and laughing. Nana's hand reaches into frame to help, with realistic market clutter and imperfect crop.`,
      },
    ],
  },
  {
    slug: "pea-nap",
    memoryDate: "2026-07-14",
    memoryType: "media",
    caption:
      "Ari fell asleep in the high chair with one hand still holding a pea. I moved exactly nothing for forty minutes.",
    tagSlugs: ["ari-kim-ortiz", "nora-kim"],
    mediaAssets: [{
      slug: "ari-pea-nap",
      kind: "photo",
      aspectRatio: "2:3",
      memberSlugs: ["ari-kim-ortiz", "nora-kim"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Ari and Nora. Ari is asleep sideways in a normal messy high chair, tiny fingers holding one green pea. Nora's blurred hand just enters frame with a dish cloth. Late lunch window light.`,
    }],
  },
  {
    slug: "taught-him-hands",
    memoryDate: "2026-07-12",
    memoryType: "media",
    caption:
      "Ari figured out clapping today. Theo took full credit and said he 'taught him hands.'",
    tagSlugs: ["ari-kim-ortiz", "theo-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [{
      slug: "ari-claps",
      kind: "video",
      aspectRatio: "9:16",
      durationSeconds: 5,
      memberSlugs: ["ari-kim-ortiz", "theo-kim-ortiz"],
      prompt:
        `@Image1 is the fictional 10-month-old baby. @Image2 is the fictional 3-year-old sibling. The baby sits on a kitchen mat and discovers clapping while the sibling proudly claps much bigger beside them. One small imperfect handheld push-in, natural unsynchronized movement, no text, dialogue, generated audio, or music overlay.`,
    }],
  },
  {
    slug: "ladybug-mommy",
    memoryDate: "2026-07-10",
    memoryType: "text_illustration",
    caption:
      "Maya found a ladybug on the windowsill and asked if it had a mommy who knew where it was.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
    illustrationPrompt:
      "Quiet late-afternoon window scene. Maya holds one finger near a ladybug while Nora kneels beside her. Tender, observant mood with a leafy green and honey-gold palette.",
  },
  {
    slug: "thinking-singing-rule",
    memoryDate: "2026-07-08",
    memoryType: "text_only",
    caption:
      "New rule from Maya: no singing while she is thinking. This rule does not apply to her.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "grandpa-sprinkler",
    memoryDate: "2026-07-06",
    memoryType: "media",
    caption:
      "Grandpa turned on the sprinkler and immediately became the most popular person on the block.",
    tagSlugs: [
      "rafael-ortiz",
      "maya-kim-ortiz",
      "theo-kim-ortiz",
      "ari-kim-ortiz",
    ],
    mediaAssets: [{
      slug: "sprinkler-popular",
      kind: "photo",
      aspectRatio: "2:3",
      memberSlugs: [
        "rafael-ortiz",
        "maya-kim-ortiz",
        "theo-kim-ortiz",
        "ari-kim-ortiz",
      ],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Rafael, Maya, Theo, and Ari. Rafael kneels beside a wobbly lawn sprinkler while Maya and Theo dart through the water. Ari sits fascinated on a picnic blanket in the foreground. Uneven summer sun, wet grass, and imperfect partial crops.`,
    }],
  },
  {
    slug: "lettuce-leaf-picnic",
    memoryDate: "2026-07-04",
    memoryType: "media",
    caption:
      "We packed a picnic, forgot napkins, and then Theo used a lettuce leaf like it had been his plan all along.",
    tagSlugs: [
      "nora-kim",
      "gabe-ortiz",
      "maya-kim-ortiz",
      "theo-kim-ortiz",
      "ari-kim-ortiz",
      "lucia-ortiz",
      "eunji-kim",
      "rafael-ortiz",
    ],
    mediaAssets: [
      {
        slug: "picnic-blanket",
        kind: "photo",
        aspectRatio: "2:3",
        memberSlugs: [
          "nora-kim",
          "gabe-ortiz",
          "maya-kim-ortiz",
          "theo-kim-ortiz",
          "ari-kim-ortiz",
          "lucia-ortiz",
          "eunji-kim",
          "rafael-ortiz",
        ],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use all supplied fictional family references. A big blanket picnic in a neighborhood park, children absorbed in food and not looking at the camera, casually crowded with water bottles and picnic containers.`,
      },
      {
        slug: "lettuce-napkin",
        kind: "photo",
        aspectRatio: "2:3",
        memberSlugs: ["theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional reference for Theo. Theo solemnly holds a lettuce leaf beside his sandwich as if it is a napkin, with a smeared cheek and the family picnic softly visible behind him.`,
      },
      {
        slug: "aunt-ari-giggles",
        kind: "photo",
        aspectRatio: "2:3",
        memberSlugs: ["lucia-ortiz", "ari-kim-ortiz", "nora-kim"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Lucía, Ari, and Nora. Lucía makes Ari laugh on the picnic blanket while Nora reaches for a water bottle, a candid half-cropped moment.`,
      },
      {
        slug: "bubbles-past-grandparents",
        kind: "photo",
        aspectRatio: "2:3",
        memberSlugs: ["rafael-ortiz", "eunji-kim", "maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Rafael, Eunji, and Maya. Rafael and Eunji chat in the background as Maya runs past with a bubble wand, pink evening sky and a little motion blur.`,
      },
    ],
  },
  {
    slug: "square-head-sandwiches",
    memoryDate: "2026-07-01",
    memoryType: "text_illustration",
    caption:
      "Maya drew everyone at dinner. Apparently Dad has a square head because he likes sandwiches.",
    tagSlugs: [
      "nora-kim",
      "gabe-ortiz",
      "maya-kim-ortiz",
      "theo-kim-ortiz",
      "ari-kim-ortiz",
    ],
    illustrationPrompt:
      "The tagged fictional family sits around a real, slightly cluttered dinner table. Maya proudly displays a crayon drawing with Gabe as a square-headed figure. Cozy coral, tomato-red, and evening-blue palette.",
  },
  {
    slug: "more-circles-pancakes",
    memoryDate: "2026-06-29",
    memoryType: "media",
    caption:
      "Sunday pancakes. Theo kept yelling 'more circles!' and somehow that felt like a reasonable request.",
    tagSlugs: ["gabe-ortiz", "maya-kim-ortiz", "theo-kim-ortiz"],
    mediaAssets: [{
      slug: "more-circles",
      kind: "photo",
      aspectRatio: "2:3",
      memberSlugs: ["gabe-ortiz", "maya-kim-ortiz", "theo-kim-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Gabe, Maya, and Theo. Gabe flips a small pancake at the stove, Maya stands on a stool dusted with flour, and Theo grips a wooden spoon like a microphone. Morning kitchen light and one blurry mid-laugh motion.`,
    }],
  },
  {
    slug: "stripey-horse-cat",
    memoryDate: "2026-06-25",
    memoryType: "text_only",
    caption:
      "Theo saw a zebra in his book and said, 'Look, a stripey horse cat.' Honestly, close enough.",
    tagSlugs: ["theo-kim-ortiz", "nora-kim"],
  },
  {
    slug: "one-song-dance-party",
    memoryDate: "2026-06-21",
    memoryType: "media",
    caption:
      "Lucía put on one song while dinner was cooking and now we have a family dance video where nobody is doing the same move.",
    tagSlugs: [
      "lucia-ortiz",
      "maya-kim-ortiz",
      "theo-kim-ortiz",
      "ari-kim-ortiz",
    ],
    mediaAssets: [{
      slug: "one-song-dance",
      kind: "video",
      aspectRatio: "9:16",
      durationSeconds: 5,
      memberSlugs: [
        "lucia-ortiz",
        "maya-kim-ortiz",
        "theo-kim-ortiz",
        "ari-kim-ortiz",
      ],
      prompt:
        `@Image1 is the fictional adult aunt. @Image2 is the fictional 6-year-old child. @Image3 is the fictional 3-year-old child. @Image4 is the fictional 10-month-old baby. The aunt sways with the baby on her hip while the older child spins and the younger child does a tiny stomping dance. Warm kitchen at golden hour, slight phone shake, all movement natural and unsynchronized, no text, dialogue, generated audio, or music overlay.`,
    }],
  },
  {
    slug: "achoo-hiccups",
    memoryDate: "2026-06-14",
    memoryType: "text_illustration",
    caption:
      "Ari laughed so hard at Nana sneezing that he got the hiccups. Then every time we said achoo he laughed again.",
    tagSlugs: ["eunji-kim", "ari-kim-ortiz", "nora-kim", "maya-kim-ortiz"],
    illustrationPrompt:
      "Living-room scene with Eunji pretending to sneeze, Ari belly-laughing, and Nora and Maya trying not to laugh. Bright, buoyant apricot and mint palette.",
  },
  {
    slug: "big-baby-dumpling",
    memoryDate: "2026-06-11",
    memoryType: "media",
    caption:
      "Nana showed Maya how to fold dumplings. Maya made one the size of a pillow and named it Big Baby.",
    tagSlugs: ["eunji-kim", "maya-kim-ortiz", "theo-kim-ortiz"],
    mediaAssets: [{
      slug: "big-baby-dumpling",
      kind: "photo",
      aspectRatio: "2:3",
      memberSlugs: ["eunji-kim", "maya-kim-ortiz", "theo-kim-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Eunji, Maya, and Theo. Floury dining-table scene: Eunji guides Maya's fingers around a huge misshapen dumpling while Theo steals a tiny wrapper. Natural overhead kitchen light, flour fingerprints, and crooked chairs visible.`,
    }],
  },
  {
    slug: "extra-sticker",
    memoryDate: "2026-05-28",
    memoryType: "text_only",
    caption:
      "Maya asked if grown-ups ever get lonely at school. I said sometimes. She packed an extra sticker in my bag for tomorrow.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "soft-rock-soup",
    memoryDate: "2026-05-17",
    memoryType: "media",
    caption:
      "Mud kitchen season. Theo served me 'soup with rocks, but the soft rocks.' I paid with a dandelion.",
    tagSlugs: ["theo-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [{
      slug: "soft-rock-soup",
      kind: "photo",
      aspectRatio: "2:3",
      memberSlugs: ["theo-kim-ortiz", "gabe-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Theo and Gabe. Theo wears rain boots at a tiny outdoor mud kitchen, holding a saucepan of mud. Gabe's hand accepts a dandelion at the edge of frame. Cloudy light, dirty knees, and earnest toddler focus.`,
    }],
  },
  {
    slug: "goodnight-moon",
    memoryDate: "2026-05-03",
    memoryType: "text_illustration",
    caption:
      "Bedtime took forever because Maya needed to check on the moon. She whispered goodnight through the window and then finally went down.",
    tagSlugs: ["nora-kim", "maya-kim-ortiz"],
    illustrationPrompt:
      "Dim blue bedtime room. Maya in pajamas whispers toward a crescent moon at an open window while Nora watches from behind. Gentle indigo, lavender, and warm lamp glow.",
  },
  {
    slug: "pink-sky-bubbles",
    memoryDate: "2026-04-22",
    memoryType: "text_only",
    caption:
      "First warm evening in forever. The kids were in pajamas on the porch after bath, chasing bubbles and refusing to come inside because the sky was still pink.",
    tagSlugs: [
      "nora-kim",
      "gabe-ortiz",
      "maya-kim-ortiz",
      "theo-kim-ortiz",
      "ari-kim-ortiz",
    ],
  },
] as const satisfies readonly DemoMemorySpec[];

/**
 * Normalized contract for the demo-account seeder. It keeps stable slugs at
 * every boundary and makes per-asset character references explicit.
 */
export const DEMO_FAMILY_SPEC: DemoFamilySeedSpec = {
  family: DEMO_FAMILY,
  account: {
    email: DEMO_ACCOUNT_EMAIL,
    name: DEMO_FAMILY.accountDisplayName,
    timezone: "Europe/Lisbon",
  },
  members: DEMO_FAMILY_MEMBERS,
  memories: DEMO_MEMORIES.map((memory) => ({
    slug: memory.slug,
    type: memory.memoryType,
    caption: memory.caption,
    memoryDate: memory.memoryDate,
    tags: memory.tagSlugs,
    prompt: memory.memoryType === "text_illustration"
      ? memory.illustrationPrompt
      : undefined,
    assets: memory.memoryType === "media" ? memory.mediaAssets : undefined,
  })),
};
