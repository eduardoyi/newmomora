/**
 * Declarative second-round content for the screenshot-only demo household.
 *
 * The original demo fixture remains intentionally frozen in
 * demo-family-spec.ts. This manifest is additive, date-pinned, and uses its
 * own deterministic ids so the top-up can be resumed without changing or
 * duplicating the original 20-memory fixture.
 */
import { CANDID_PHONE_PHOTO_PROMPT_PREFIX } from "./demo-family-spec.ts";

export const DEMO_TOP_UP_CURRENT_DATE = "2026-08-11";
export const DEMO_BASELINE_PORTRAIT_DATE = "2026-04-18";

export const DEMO_EXISTING_MEMORY_DATE_UPDATES = [
  {
    memorySlug: "soft-rock-soup",
    expectedCurrentDate: "2026-05-17",
    targetDate: "2026-03-29",
  },
  {
    memorySlug: "extra-sticker",
    expectedCurrentDate: "2026-05-28",
    targetDate: "2026-04-18",
  },
  {
    memorySlug: "big-baby-dumpling",
    expectedCurrentDate: "2026-06-11",
    targetDate: "2026-04-28",
  },
  {
    memorySlug: "achoo-hiccups",
    expectedCurrentDate: "2026-06-14",
    targetDate: "2026-05-08",
  },
] as const;

const HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX =
  `A candid, unretouched vertical smartphone photo of the same wholly fictional child shown in the supplied reference photo, not a real person. The reference is the child's present-day synthetic profile photo; age the child down to the exact target age while preserving the same identity, facial structure, skin tone, eye shape, hair color and texture, and distinctive family resemblance. Use age-appropriate body proportions, hair length, teeth, clothing, and motor skills. The child must look like a real child of the stated age, never like a miniature adult. Each historical pair must have its own distinct outfit; do not repeat clothing from another historical photo of this child or copy the current profile outfit. Natural household light, imperfect handheld framing, ordinary lived-in surroundings, genuine mid-action expression, realistic skin texture, and no studio polish, glam retouching, text, watermark, logo, or posed smile.`;

export interface DemoTopUpPortraitSpec {
  slug: string;
  memberSlug: "maya-kim-ortiz" | "theo-kim-ortiz" | "ari-kim-ortiz";
  referenceDate: string;
  wardrobe: string;
  prompt: string;
}

export interface DemoTopUpPhotoAssetSpec {
  slug: string;
  memberSlugs: readonly string[];
  prompt: string;
}

export type DemoTopUpMemoryType =
  | "text_only"
  | "text_illustration"
  | "media";

export interface DemoTopUpMemorySpec {
  slug: string;
  memoryType: DemoTopUpMemoryType;
  memoryDate: string;
  caption: string;
  tagSlugs: readonly string[];
  mediaAssets?: readonly DemoTopUpPhotoAssetSpec[];
}

export const DEMO_TOP_UP_PORTRAITS = [
  {
    slug: "maya-infant-2021-02",
    memberSlug: "maya-kim-ortiz",
    referenceDate: "2021-02-14",
    wardrobe: "a sage-green footed cotton sleeper printed with tiny moons",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: about five months old. Maya has warm tan-beige skin, very large dark-brown eyes, softly rounded cheeks, and a small amount of dark wavy hair just beginning to curl. She is wearing a sage-green footed cotton sleeper printed with tiny moons and reaching for a crinkly cloth book on a quilt in a normal living room, with a caregiver's sleeve cropped at the edge of frame.`,
  },
  {
    slug: "maya-toddler-2021-12",
    memberSlug: "maya-kim-ortiz",
    referenceDate: "2021-12-05",
    wardrobe: "a rust corduroy pinafore over a cream long-sleeve tee",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: about fifteen months old. Maya has warm tan-beige skin, the same big dark-brown eyes and round cheeks, and short dark wavy hair with curls at the ends. She is wearing a rust corduroy pinafore over a cream long-sleeve tee, standing unsteadily in socks beside a low coffee table while gripping a wooden spoon, looking intensely serious about whatever she is doing.`,
  },
  {
    slug: "maya-two-2022-09",
    memberSlug: "maya-kim-ortiz",
    referenceDate: "2022-09-18",
    wardrobe: "a faded lilac T-shirt with a small sun sticker",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: just over two years old. Maya has the same warm tan-beige skin, dark-brown eyes, round face, and dark wavy hair now cut into a tiny uneven bob. She is wearing a faded lilac T-shirt with a small sun sticker and sitting on a kitchen floor with a very solemn expression, caught halfway through deciding whether to share another sticker.`,
  },
  {
    slug: "maya-preschool-2024-01",
    memberSlug: "maya-kim-ortiz",
    referenceDate: "2024-01-20",
    wardrobe: "denim overalls over a red-and-cream striped tee",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: three years and four months old. Maya has the same warm tan-beige skin, big dark-brown eyes, softly round face, and long dark wavy hair gathered into a loose half ponytail. She is wearing denim overalls over a red-and-cream striped tee and crouching beside a box of crayons, glancing up with a shy crooked smile as if someone just said her name.`,
  },
  {
    slug: "maya-four-2025-03",
    memberSlug: "maya-kim-ortiz",
    referenceDate: "2025-03-16",
    wardrobe: "a sky-blue sweatshirt with a tiny embroidered flower",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: about four years and six months old. Maya has the same warm tan-beige skin, big dark-brown eyes, dark wavy hair in a messy half ponytail, and a tender theatrical expression. She is kneeling at a low table covered with a few crayon drawings, wearing a sky-blue sweatshirt with a tiny embroidered flower and mismatched socks, looking off-camera because a younger sibling made a noise.`,
  },
  {
    slug: "theo-baby-2023-07",
    memberSlug: "theo-kim-ortiz",
    referenceDate: "2023-07-22",
    wardrobe: "a cream ribbed knit romper with wooden buttons",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: about five months old. Theo has warm tan-beige skin, bright brown eyes, very round cheeks, and the same dark hair beginning to spring into curls. He is wearing a cream ribbed knit romper with wooden buttons on a play mat, reaching toward a stacking ring with one hand and looking surprised by his own success.`,
  },
  {
    slug: "theo-one-2024-03",
    memberSlug: "theo-kim-ortiz",
    referenceDate: "2024-03-10",
    wardrobe: "forest-green overalls over a pale yellow tee",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: about thirteen months old. Theo has warm tan-beige skin, bright brown eyes, the same dark springy curls, round cheeks, and the beginning of his recognizable left-cheek dimple. He is wearing forest-green overalls over a pale yellow tee, standing at a toy shelf, holding one block and looking back toward the person taking the photo.`,
  },
  {
    slug: "theo-toddler-2025-01",
    memberSlug: "theo-kim-ortiz",
    referenceDate: "2025-01-25",
    wardrobe: "a burgundy waffle-knit shirt and soft gray joggers",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: just under two years old. Theo has warm tan-beige skin, bright brown eyes, thick dark springy curls, round cheeks, and a visible left-cheek dimple. He is wearing a burgundy waffle-knit shirt and soft gray joggers, sitting backward on a little chair in a kitchen, holding a wooden spoon like a microphone, with one sock twisted around his ankle and a completely earnest face.`,
  },
  {
    slug: "ari-two-months-2025-11",
    memberSlug: "ari-kim-ortiz",
    referenceDate: "2025-11-30",
    wardrobe: "a pale blue footed sleeper with tiny clouds",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: about ten weeks old. Ari has soft medium-beige skin, wide brown eyes, round cheeks, and thick dark hair sticking up slightly at the crown. He is lying in a pale blue footed sleeper with tiny clouds on a play mat, turning his head toward a familiar sound with one tiny fist near his chin.`,
  },
  {
    slug: "ari-five-months-2026-02",
    memberSlug: "ari-kim-ortiz",
    referenceDate: "2026-02-28",
    wardrobe: "an oatmeal ribbed romper with two wooden buttons",
    prompt:
      `${HISTORICAL_CHILD_PHOTO_PROMPT_PREFIX} Target age: about five months old. Ari has the same soft medium-beige skin, wide brown eyes, round cheeks, and dark hair sticking up at the crown. He is wearing an oatmeal ribbed romper with two wooden buttons while doing tummy time on a folded blanket, pushing up on both forearms and grinning toward a toy just outside the frame.`,
  },
] as const satisfies readonly DemoTopUpPortraitSpec[];

export const DEMO_TOP_UP_MEMORIES = [
  {
    slug: "sock-sandwich",
    memoryDate: "2026-08-11",
    memoryType: "media",
    caption:
      "Theo put a sock on his hand and called it a sandwich. He was very offended when I asked where the other one was.",
    tagSlugs: ["theo-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [{
      slug: "sock-sandwich-photo",
      memberSlugs: ["theo-kim-ortiz", "gabe-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Theo and Gabe. In a slightly messy hallway, Theo holds a clean striped sock over one hand like a sandwich and looks deeply serious about it. Gabe is crouched nearby holding the matching sock, caught halfway through laughing. Vertical 2:3 phone framing, ordinary afternoon light.`,
    }],
  },
  {
    slug: "empty-corner-wave",
    memoryDate: "2026-08-09",
    memoryType: "text_only",
    caption:
      "Ari waved at the empty corner of the kitchen for a full minute. I waved too because obviously I needed to know who was there.",
    tagSlugs: ["ari-kim-ortiz", "nora-kim"],
  },
  {
    slug: "puddle-soup",
    memoryDate: "2026-08-07",
    memoryType: "text_illustration",
    caption:
      "Theo stepped in one puddle and announced it was soup. Maya asked if it had a menu.",
    tagSlugs: ["theo-kim-ortiz", "maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "library-whisper-voice",
    memoryDate: "2026-08-05",
    memoryType: "media",
    caption:
      "Maya whispered in the library for about thirty seconds, then forgot and told us a very important story at full volume.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim", "theo-kim-ortiz"],
    mediaAssets: [
      {
        slug: "library-whisper",
        memberSlugs: ["maya-kim-ortiz", "nora-kim"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Nora. Maya stands between low library shelves with one finger near her lips, trying not to laugh, while Nora leans down to hear her. A few colorful picture books are crooked on the shelf, with soft overhead light and an imperfect crop.`,
      },
      {
        slug: "library-story",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Theo. Maya is whispering an elaborate story into Theo's ear while Theo holds two picture books upside down and looks more interested in a snack. Quiet library aisle, candid side angle, slightly soft phone focus.`,
      },
      {
        slug: "library-exit",
        memberSlugs: ["nora-kim", "maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Nora, Maya, and Theo. The family leaves a small neighborhood library with a stack of books. Maya is talking with both hands, Theo is dragging one book by its corner, and Nora is trying to open the door without dropping anything.`,
      },
    ],
  },
  {
    slug: "banana-pocket",
    memoryDate: "2026-08-03",
    memoryType: "media",
    caption:
      "Found a banana in Gabe's pocket. He said it was for later. The banana had been through a lot.",
    tagSlugs: ["gabe-ortiz", "ari-kim-ortiz"],
    mediaAssets: [{
      slug: "banana-pocket-photo",
      memberSlugs: ["gabe-ortiz", "ari-kim-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Gabe and Ari. Gabe stands in the kitchen holding a very squashed banana just pulled from his shorts pocket, looking caught. Ari sits in a high chair reaching toward it with delighted focus. Natural late-morning light, a dish towel and ordinary kitchen clutter in frame.`,
    }],
  },
  {
    slug: "actually",
    memoryDate: "2026-08-01",
    memoryType: "text_only",
    caption:
      "Theo has started every sentence with 'actually.' He is three and has not been right once.",
    tagSlugs: ["theo-kim-ortiz", "nora-kim"],
  },
  {
    slug: "potato-haircut",
    memoryDate: "2026-07-29",
    memoryType: "text_illustration",
    caption:
      "Maya gave Dad a haircut with a toy comb and told me he looked like a potato. Gabe said thank you.",
    tagSlugs: ["maya-kim-ortiz", "gabe-ortiz", "nora-kim"],
  },
  {
    slug: "rainboot-treasure",
    memoryDate: "2026-07-27",
    memoryType: "media",
    caption:
      "Rafael found a shiny rock in the rain boot pile and declared it treasure. Theo immediately asked if treasure could be eaten.",
    tagSlugs: ["rafael-ortiz", "theo-kim-ortiz", "maya-kim-ortiz"],
    mediaAssets: [{
      slug: "rainboot-treasure-photo",
      memberSlugs: ["rafael-ortiz", "theo-kim-ortiz", "maya-kim-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Rafael, Theo, and Maya. Rafael crouches by a row of wet rain boots holding up a small shiny rock like a priceless jewel. Theo reaches toward it with a hopeful face while Maya watches from behind a boot, amused. Cloudy porch light, muddy floor, imperfect vertical phone crop.`,
    }],
  },
  {
    slug: "snack-drawer-meeting",
    memoryDate: "2026-07-25",
    memoryType: "media",
    caption:
      "The kids reorganized the snack drawer. It is now just crackers in three different places.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz", "nora-kim"],
    mediaAssets: [
      {
        slug: "snack-drawer-plan",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "nora-kim"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Nora. Maya and Theo sit on the kitchen floor with the snack drawer pulled open, studying crackers and cereal like a serious planning committee. Nora's hand enters the frame holding a grocery bag.`,
      },
      {
        slug: "snack-drawer-helper",
        memberSlugs: ["ari-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Ari and Theo. Ari reaches from a play mat toward a low open snack drawer while Theo carefully carries one cracker at a time. The drawer is slightly crooked, with crumbs on the floor and warm kitchen light.`,
      },
      {
        slug: "three-cracker-places",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Ari. The three children sit around three separate little piles of crackers on the kitchen floor. Maya points to her pile like she is presenting evidence, Theo is already eating his, and Ari is holding one up to inspect it.`,
      },
    ],
  },
  {
    slug: "good-job-baby",
    memoryDate: "2026-07-23",
    memoryType: "text_illustration",
    caption:
      "Theo clapped for Ari putting one block in the bucket and yelled, 'Good job, baby!' like he had personally invented buckets.",
    tagSlugs: ["theo-kim-ortiz", "ari-kim-ortiz", "gabe-ortiz"],
  },
  {
    slug: "ice-cube-medicine",
    memoryDate: "2026-07-21",
    memoryType: "text_only",
    caption:
      "Maya brought me an ice cube because she thought I looked hot. It was gone by the time she got to me.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "blanket-boat",
    memoryDate: "2026-07-19",
    memoryType: "media",
    caption:
      "Lucía made a blanket boat in the living room. Maya was the captain, Theo was the engine, and Ari was mostly chewing the boat.",
    tagSlugs: ["lucia-ortiz", "maya-kim-ortiz", "theo-kim-ortiz", "ari-kim-ortiz"],
    mediaAssets: [
      {
        slug: "blanket-boat-captain",
        memberSlugs: ["lucia-ortiz", "maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Lucía, Maya, and Theo. In a normal living room, Lucía holds one end of a lumpy blanket boat while Maya sits inside wearing a paper captain hat and Theo pushes the cushions with both hands. Toys and laundry are visible at the edge of frame.`,
      },
      {
        slug: "blanket-boat-baby",
        memberSlugs: ["ari-kim-ortiz", "lucia-ortiz", "maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Ari, Lucía, and Maya. Ari is sitting at the entrance of a blanket boat chewing the edge while Lucía laughs and Maya points at him like a captain reporting a problem. Warm evening room light, candid close phone framing.`,
      },
    ],
  },
  {
    slug: "spring-sidewalk-restaurant",
    memoryDate: "2026-04-12",
    memoryType: "media",
    caption:
      "Maya opened a sidewalk restaurant with chalk menus. Theo ordered three bowls of invisible noodles and then refused to pay.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [{
      slug: "sidewalk-restaurant-photo",
      memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "gabe-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Gabe. On a quiet neighborhood sidewalk, Maya sits beside a chalk menu and serves invisible noodles from a plastic bowl. Theo waits at a tiny chair with an extremely serious customer face while Gabe crouches nearby holding a pretend receipt.`,
    }],
  },
  {
    slug: "nana-soup-spoon",
    memoryDate: "2026-04-05",
    memoryType: "text_illustration",
    caption:
      "Nana let Maya stir the soup. Maya said the pot needed one more spoonful of love, so we all waited while she added exactly one.",
    tagSlugs: ["eunji-kim", "maya-kim-ortiz", "theo-kim-ortiz"],
  },
  {
    slug: "ari-sneeze-audience",
    memoryDate: "2026-03-28",
    memoryType: "text_only",
    caption:
      "Ari laughed when Nana sneezed, then waited for her to do it again. Nana said she was not taking requests.",
    tagSlugs: ["ari-kim-ortiz", "eunji-kim", "maya-kim-ortiz"],
  },
  {
    slug: "rainy-window-gallery",
    memoryDate: "2026-03-15",
    memoryType: "media",
    caption:
      "Rainy afternoon. Maya taped three drawings to the window and called it a gallery. Theo charged admission in crackers.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "nora-kim"],
    mediaAssets: [
      {
        slug: "window-gallery",
        memberSlugs: ["maya-kim-ortiz", "nora-kim"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Nora. Maya presses three crayon drawings onto a rainy window with small pieces of tape while Nora steadies the paper from behind. Gray daylight, fingerprints on the glass, and a normal lived-in room.`,
      },
      {
        slug: "gallery-admission",
        memberSlugs: ["theo-kim-ortiz", "maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Theo and Maya. Theo sits beside the rainy window with a little bowl of crackers, holding one out like a ticket seller. Maya is blurred in the background looking at her drawings. Crooked phone framing and soft window light.`,
      },
      {
        slug: "window-drawing-close",
        memberSlugs: ["maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional reference for Maya. Maya's face is close to the rainy window as she studies one of her crayon drawings, with a smudge of blue on one cheek and her dark wavy hair falling into her eyes. The photo is a little off-center and clearly taken quickly by a parent.`,
      },
    ],
  },
  {
    slug: "pancake-sun",
    memoryDate: "2026-05-10",
    memoryType: "media",
    caption:
      "Maya made a pancake with a hole in it and said it was the sun. Then she ate the sun.",
    tagSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [{
      slug: "pancake-sun-photo",
      memberSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Gabe. In a slightly messy kitchen, Maya holds up a small pancake with a hole in the middle like she has discovered the sun. Gabe is at the stove behind her, caught mid-laugh with a spatula in one hand. Warm morning light, flour on the counter, vertical phone framing.`,
    }],
  },
  {
    slug: "sidewalk-chalk-hair",
    memoryDate: "2026-04-28",
    memoryType: "text_only",
    caption:
      "Theo drew hair on the sidewalk with chalk and then told me the sidewalk looked more handsome now.",
    tagSlugs: ["theo-kim-ortiz", "maya-kim-ortiz"],
  },
  {
    slug: "one-more-song-concert",
    memoryDate: "2026-03-20",
    memoryType: "media",
    caption:
      "We said one more song. They heard one more concert.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "nora-kim"],
    mediaAssets: [
      {
        slug: "one-more-song-dance",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Theo. The children dance in a living room after bedtime, Maya spinning with a blanket and Theo bouncing with both arms in the air. A speaker and scattered pajamas are visible, warm lamp light, quick imperfect phone photo.`,
      },
      {
        slug: "one-more-song-finale",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "nora-kim"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Nora. Maya and Theo perform an overly dramatic final pose in the living room while Nora sits on the sofa clapping and laughing. One child's sock is half off, natural motion blur, vertical phone framing.`,
      },
      {
        slug: "one-more-song-floor",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Theo. The concert has ended and both children are lying on the rug looking tired but pleased, with a toy microphone between them and the edge of a blanket fort in frame. Ordinary evening light and an unplanned crop.`,
      },
    ],
  },
  {
    slug: "grandpa-sneaker-check",
    memoryDate: "2025-12-14",
    memoryType: "media",
    caption:
      "Rafael put Ari's tiny sneaker on his own hand and spent five minutes asking where the foot was. Ari did not help.",
    tagSlugs: ["rafael-ortiz", "ari-kim-ortiz", "lucia-ortiz"],
    mediaAssets: [{
      slug: "grandpa-sneaker-check-photo",
      memberSlugs: ["rafael-ortiz", "ari-kim-ortiz", "lucia-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Rafael, Ari, and Lucía. Rafael sits on the living-room floor with a tiny baby sneaker over his hand, peeking into it with a completely puzzled face. Baby Ari is nearby in a soft seat staring at the shoe, while Lucía's laughing shoulder is cropped at the edge. Cozy afternoon light and ordinary toy clutter.`,
    }],
  },
  {
    slug: "mystery-dishwasher-beep",
    memoryDate: "2025-09-21",
    memoryType: "text_only",
    caption:
      "Maya said the dishwasher was making a mysterious beep. It was the dishwasher doing exactly what dishwashers do.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "birthday-candle-committee",
    memoryDate: "2025-06-08",
    memoryType: "media",
    caption:
      "Maya and Theo blew out the candle together even though it was only Maya's cupcake. Theo said that made it a team birthday.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [
      {
        slug: "birthday-candle-maya",
        memberSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Gabe. Maya leans toward one small cupcake with a single candle while Gabe steadies the plate. She looks intensely focused, not posed, with party crumbs and a paper napkin in the foreground.`,
      },
      {
        slug: "birthday-candle-theo",
        memberSlugs: ["theo-kim-ortiz", "maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Theo and Maya. Theo leans into the frame and blows at Maya's cupcake at the same time she does, cheeks puffed and eyes squeezed shut. Maya is laughing beside him. Indoor birthday light, slightly crooked phone crop.`,
      },
      {
        slug: "birthday-candle-aftermath",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "gabe-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Gabe. After the candle, Maya and Theo inspect the frosting-covered cupcake while Gabe reaches for a paper towel. One child has frosting on a cheek, with real kitchen clutter and soft low light.`,
      },
    ],
  },
  {
    slug: "raisin-negotiation",
    memoryDate: "2025-02-01",
    memoryType: "text_only",
    caption:
      "Theo held one raisin in his fist and negotiated like we had a very serious raisin shortage.",
    tagSlugs: ["theo-kim-ortiz", "gabe-ortiz"],
  },
  {
    slug: "raincoat-inside",
    memoryDate: "2024-11-16",
    memoryType: "media",
    caption:
      "Maya wore her raincoat inside because it was raining in her imagination. Theo brought an umbrella just in case.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "nora-kim"],
    mediaAssets: [{
      slug: "raincoat-inside-photo",
      memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "nora-kim"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Nora. In the hallway, preschool-age Maya wears a bright raincoat indoors and looks out at a perfectly dry window. Toddler Theo holds a small umbrella behind her while Nora crouches to zip the coat, caught in the middle of laughing.`,
    }],
  },
  {
    slug: "tiny-grocery-cart",
    memoryDate: "2024-08-24",
    memoryType: "media",
    caption:
      "Letting them push the little grocery cart was a mistake. We bought one banana, two stickers, and a pinecone.",
    tagSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [
      {
        slug: "tiny-grocery-cart-entrance",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz", "gabe-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Theo, and Gabe. Maya and toddler Theo share a tiny grocery cart at the entrance of a neighborhood market while Gabe tries to steer from behind. They are both looking in different directions, natural fluorescent light and an imperfect phone crop.`,
      },
      {
        slug: "tiny-grocery-cart-banana",
        memberSlugs: ["maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Theo. Maya carefully places one banana in the tiny grocery cart while Theo reaches for a sticker from the handle. The cart is slightly crooked and a shopper's basket is blurred behind them.`,
      },
      {
        slug: "tiny-grocery-cart-pinecone",
        memberSlugs: ["gabe-ortiz", "maya-kim-ortiz", "theo-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Gabe, Maya, and Theo. Outside the market, Gabe holds up a pinecone found in the cart while Maya and Theo look at it with total seriousness. A grocery bag and stroller handle are cropped into the frame, late-afternoon sidewalk light.`,
      },
    ],
  },
  {
    slug: "question-at-bedtime",
    memoryDate: "2024-05-05",
    memoryType: "text_only",
    caption:
      "At bedtime Maya asked if clouds have jobs. I said I didn't know. She said okay and assigned them some.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "sticker-emergency",
    memoryDate: "2024-02-18",
    memoryType: "media",
    caption:
      "Found Maya under the table with a sticker on her forehead. She said it was an emergency bandage.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
    mediaAssets: [{
      slug: "sticker-emergency-photo",
      memberSlugs: ["maya-kim-ortiz", "nora-kim"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Nora. A three-year-old Maya sits under the dining table with one bright sticker centered on her forehead, looking up at the phone like she has a medical explanation ready. Nora kneels nearby with a sheet of stickers, trying not to laugh. Warm kitchen light, low angle, ordinary clutter.`,
    }],
  },
  {
    slug: "pocket-rock-collection",
    memoryDate: "2023-11-12",
    memoryType: "text_only",
    caption:
      "Rafael emptied his pockets and found four rocks, a leaf, and one very old cracker. He said the collection was growing.",
    tagSlugs: ["rafael-ortiz", "maya-kim-ortiz"],
  },
  {
    slug: "chair-is-a-horse",
    memoryDate: "2023-09-03",
    memoryType: "media",
    caption:
      "That chair is a horse now. We are all expected to respect that.",
    tagSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [
      {
        slug: "chair-is-a-horse-rider",
        memberSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Gabe. Maya, just over three years old, sits backward on a dining chair pretending it is a horse, one hand raised like a rider. Gabe crouches beside her holding the chair steady, with a completely serious expression.`,
      },
      {
        slug: "chair-is-a-horse-stable",
        memberSlugs: ["maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional reference for Maya. Maya has parked the dining chair beside the sofa and is feeding it a pretend carrot, with one toy bowl on the floor. She looks deeply concerned about the horse's appetite. Lived-in living room, candid low phone angle.`,
      },
    ],
  },
  {
    slug: "picnic-sandwich-builder",
    memoryDate: "2023-07-30",
    memoryType: "media",
    caption:
      "Maya tried to make a sandwich out of crackers, a napkin, and one leaf. She said the leaf was the important part.",
    tagSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [{
      slug: "picnic-sandwich-builder-photo",
      memberSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Gabe. At a neighborhood picnic, two-year-old Maya carefully stacks crackers, a folded napkin, and one leaf into a pretend sandwich. Gabe sits beside the blanket looking at the creation with fond confusion. Casual summer shade, water bottle and picnic crumbs in frame.`,
    }],
  },
  {
    slug: "nana-glasses",
    memoryDate: "2023-06-17",
    memoryType: "text_only",
    caption:
      "Nana took off her glasses for one second and Maya asked if her eyes were still in there.",
    tagSlugs: ["eunji-kim", "maya-kim-ortiz"],
  },
  {
    slug: "bathroom-sticker-map",
    memoryDate: "2023-04-23",
    memoryType: "media",
    caption:
      "Maya put stickers on the bathroom tiles and called it a map to the moon. We are still looking for the bathroom moon.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
    mediaAssets: [
      {
        slug: "bathroom-sticker-map-wall",
        memberSlugs: ["maya-kim-ortiz", "nora-kim"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Nora. Two-year-old Maya kneels beside the bathroom tiles placing star stickers in a crooked line while Nora reaches down to stop the next one. The room is ordinary and slightly cluttered, with warm overhead light and a quick parent photo angle.`,
      },
      {
        slug: "bathroom-sticker-map-moon",
        memberSlugs: ["maya-kim-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional reference for Maya. Maya points proudly at a single sticker near the bottom bathroom tile and looks back at the camera as if she has reached the moon. One slipper and a laundry basket are visible at the edge, imperfect close framing.`,
      },
    ],
  },
  {
    slug: "the-blue-cup",
    memoryDate: "2023-01-28",
    memoryType: "text_only",
    caption:
      "Maya refused every cup except the blue one. The blue one was in the dishwasher, so breakfast became a group project.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "shoe-phone",
    memoryDate: "2022-10-09",
    memoryType: "media",
    caption:
      "Maya held a grown-up shoe to her ear and told me the shoe had a very important meeting.",
    tagSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
    mediaAssets: [{
      slug: "shoe-phone-photo",
      memberSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
      prompt:
        `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Gabe. Two-year-old Maya sits on the entryway floor holding one oversized adult sneaker to her ear like a phone, her face very serious. Gabe's knees and hands are cropped nearby as he tries not to laugh. Shoes and a tote bag make the scene feel genuinely lived in.`,
    }],
  },
  {
    slug: "bedtime-pajama-parade",
    memoryDate: "2022-07-04",
    memoryType: "text_only",
    caption:
      "Maya put her pajamas on backwards and said she was dressed for a parade. We did not correct her.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim"],
  },
  {
    slug: "very-serious-birthday",
    memoryDate: "2022-03-26",
    memoryType: "media",
    caption:
      "Maya saw the birthday candle and looked at us like we had made a dangerous decision.",
    tagSlugs: ["maya-kim-ortiz", "nora-kim", "gabe-ortiz"],
    mediaAssets: [
      {
        slug: "very-serious-birthday-candle",
        memberSlugs: ["maya-kim-ortiz", "nora-kim", "gabe-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya, Nora, and Gabe. A toddler Maya sits at the table in front of a tiny cupcake with one lit candle, staring at it with deep suspicion. Nora and Gabe lean into the frame from either side, waiting to see what she will do. Warm kitchen light, real crumbs, no posed smiles.`,
      },
      {
        slug: "very-serious-birthday-toast",
        memberSlugs: ["maya-kim-ortiz", "gabe-ortiz"],
        prompt:
          `${CANDID_PHONE_PHOTO_PROMPT_PREFIX} Use the supplied fictional references for Maya and Gabe. Maya holds a small paper cup in both hands like she is giving a formal toast after the birthday candle, while Gabe watches with exaggerated respect. A paper plate and crooked party hat sit nearby, candid home photo.`,
      },
    ],
  },
] as const satisfies readonly DemoTopUpMemorySpec[];
