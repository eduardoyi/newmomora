/**
 * Declarative engagement content for the screenshot-only demo household.
 *
 * These accounts are synthetic household viewers. Their names intentionally
 * match the fictional adult family-member profiles already in the demo family
 * so comments read like they came from the people shown in the journal.
 */

import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_MEMORIES,
} from "./demo-family-spec.ts";
import {
  DEMO_TOP_UP_MEMORIES,
  type DemoTopUpMemorySpec,
} from "./demo-top-up-spec.ts";

export interface DemoEngagementActorSpec {
  slug: string;
  email: string;
  name: string;
  timezone: string;
  role: "viewer";
}

export interface DemoEngagementCommentSpec {
  actorSlug: string;
  content: string;
}

export interface DemoMemoryEngagementSpec {
  memorySlug: string;
  comments: readonly DemoEngagementCommentSpec[];
}

export const DEMO_ENGAGEMENT_CURRENT_DATE = "2026-08-12";

export const DEMO_ENGAGEMENT_ACTORS = [
  {
    slug: "gabe-ortiz",
    email: "hello+demo-engagement-gabe@usemomora.com",
    name: "Gabe Ortiz",
    timezone: "America/Los_Angeles",
    role: "viewer",
  },
  {
    slug: "eunji-kim",
    email: "hello+demo-engagement-eunji@usemomora.com",
    name: "Eunji Kim",
    timezone: "America/Los_Angeles",
    role: "viewer",
  },
  {
    slug: "rafael-ortiz",
    email: "hello+demo-engagement-rafael@usemomora.com",
    name: "Rafael Ortiz",
    timezone: "America/Los_Angeles",
    role: "viewer",
  },
  {
    slug: "lucia-ortiz",
    email: "hello+demo-engagement-lucia@usemomora.com",
    name: "Lucía Ortiz",
    timezone: "America/Los_Angeles",
    role: "viewer",
  },
] as const satisfies readonly DemoEngagementActorSpec[];

const comment = (
  actorSlug: string,
  content: string,
): DemoEngagementCommentSpec => ({ actorSlug, content });

export const DEMO_MEMORY_ENGAGEMENT = [
  {
    memorySlug: "playground-emergency-crackers",
    comments: [
      comment("gabe-ortiz", "The emergency supply did not make it to the emergency."),
      comment("lucia-ortiz", "Honestly I support the purse."),
      comment("eunji-kim", "Emergency crackers are important."),
    ],
  },
  {
    memorySlug: "hallway-fort-admission",
    comments: [
      comment("lucia-ortiz", "Ari had the best admission policy."),
      comment("rafael-ortiz", "Crackers are a strong fort credential."),
      comment("gabe-ortiz", "Ari had the right idea from the beginning."),
      comment("eunji-kim", "I would like to visit the fort."),
    ],
  },
  {
    memorySlug: "bubble-mustaches",
    comments: [
      comment("rafael-ortiz", "Finally someone appreciates the mustache."),
      comment("eunji-kim", "Even the duck looked very pleased."),
      comment("lucia-ortiz", "This is the only kind of facial hair I approve."),
      comment("gabe-ortiz", "The duck really committed."),
    ],
  },
  {
    memorySlug: "peach-takes-a-walk",
    comments: [
      comment("eunji-kim", "She held that peach so carefully."),
      comment("gabe-ortiz", "The stroller tunnel was a bold choice."),
      comment("lucia-ortiz", "Peach rescue team was very effective."),
      comment("rafael-ortiz", "I would have eaten it before the stroller."),
      comment("eunji-kim", "It was a very good peach."),
    ],
  },
  {
    memorySlug: "pea-nap",
    comments: [
      comment("lucia-ortiz", "Protect the pea at all costs."),
      comment("eunji-kim", "Forty minutes is a very reasonable pause."),
      comment("gabe-ortiz", "He held on to that pea."),
    ],
  },
  {
    memorySlug: "taught-him-hands",
    comments: [
      comment("gabe-ortiz", "Theo has been waiting for this teaching credit."),
      comment("lucia-ortiz", "Tiny professor."),
      comment("eunji-kim", "Good job, both of you."),
    ],
  },
  {
    memorySlug: "ladybug-mommy",
    comments: [
      comment("eunji-kim", "Maya notices everything."),
      comment("rafael-ortiz", "I hope the ladybug found her mommy."),
      comment("lucia-ortiz", "I hope the ladybug got the message."),
    ],
  },
  {
    memorySlug: "thinking-singing-rule",
    comments: [
      comment("gabe-ortiz", "I have been warned."),
      comment("lucia-ortiz", "The rule seems fair until she starts singing."),
    ],
  },
  {
    memorySlug: "grandpa-sprinkler",
    comments: [
      comment("rafael-ortiz", "I regret nothing."),
      comment("gabe-ortiz", "The sprinkler has a fan club now."),
      comment("eunji-kim", "The grass needed a drink too."),
      comment("lucia-ortiz", "I got splashed from the sidewalk."),
      comment("gabe-ortiz", "Best block meeting ever."),
    ],
  },
  {
    memorySlug: "lettuce-leaf-picnic",
    comments: [
      comment("lucia-ortiz", "The lettuce leaf was honestly working."),
      comment("eunji-kim", "Next time I am bringing extra napkins."),
      comment("rafael-ortiz", "I brought the napkins. They were in the car."),
      comment("gabe-ortiz", "The bubbles were a nice dessert."),
      comment("lucia-ortiz", "Theo looked very committed to the plan."),
      comment("eunji-kim", "That was a surprisingly good sandwich."),
    ],
  },
  {
    memorySlug: "square-head-sandwiches",
    comments: [
      comment("gabe-ortiz", "I feel seen."),
      comment("rafael-ortiz", "Square heads are good for sandwiches."),
    ],
  },
  {
    memorySlug: "more-circles-pancakes",
    comments: [
      comment("eunji-kim", "More circles is a good breakfast plan."),
      comment("lucia-ortiz", "Theo's microphone career begins."),
      comment("rafael-ortiz", "I support more circles."),
      comment("gabe-ortiz", "Someone save me a pancake."),
    ],
  },
  {
    memorySlug: "stripey-horse-cat",
    comments: [
      comment("gabe-ortiz", "I cannot unhear stripey horse cat now."),
      comment("eunji-kim", "Close enough, little one."),
    ],
  },
  {
    memorySlug: "one-song-dance-party",
    comments: [
      comment("lucia-ortiz", "I stand by the song choice."),
      comment("rafael-ortiz", "I had a move. Nobody used it."),
      comment("gabe-ortiz", "I was doing the same move. In my head."),
      comment("eunji-kim", "I thought dinner was happening."),
      comment("lucia-ortiz", "The kitchen was not ready for this."),
      comment("rafael-ortiz", "Encore."),
    ],
  },
  {
    memorySlug: "achoo-hiccups",
    comments: [
      comment("eunji-kim", "I was only trying to sneeze."),
      comment("gabe-ortiz", "The encore was inevitable."),
    ],
  },
  {
    memorySlug: "big-baby-dumpling",
    comments: [
      comment("eunji-kim", "Big Baby was beautiful."),
      comment("lucia-ortiz", "That dumpling needed its own chair."),
    ],
  },
  {
    memorySlug: "extra-sticker",
    comments: [
      comment("gabe-ortiz", "That is a very good kind of emergency kit."),
      comment("eunji-kim", "What a sweet girl."),
    ],
  },
  {
    memorySlug: "soft-rock-soup",
    comments: [
      comment("rafael-ortiz", "I would like a bowl."),
      comment("lucia-ortiz", "Did the dandelion cover the tip?"),
    ],
  },
  {
    memorySlug: "goodnight-moon",
    comments: [
      comment("eunji-kim", "Moon checks are important."),
      comment("gabe-ortiz", "Goodnight moon took longer than expected."),
      comment("lucia-ortiz", "The moon probably appreciated the check-in."),
    ],
  },
  {
    memorySlug: "pink-sky-bubbles",
    comments: [
      comment("lucia-ortiz", "The sky was showing off."),
      comment("rafael-ortiz", "Nobody ever comes inside when the bubbles are good."),
    ],
  },
  {
    memorySlug: "sock-sandwich",
    comments: [
      comment("gabe-ortiz", "I would like to formally defend the sandwich."),
      comment("lucia-ortiz", "Where is the other sock though?"),
      comment("eunji-kim", "That is a very soft sandwich."),
      comment("rafael-ortiz", "Where is the receipt?"),
    ],
  },
  {
    memorySlug: "empty-corner-wave",
    comments: [
      comment("eunji-kim", "Maybe it was a very quiet visitor."),
      comment("rafael-ortiz", "I did not see anyone either."),
    ],
  },
  {
    memorySlug: "puddle-soup",
    comments: [
      comment("lucia-ortiz", "Menu sounds promising."),
      comment("gabe-ortiz", "I hope there was a soft rock option."),
      comment("rafael-ortiz", "I will have the house special."),
    ],
  },
  {
    memorySlug: "library-whisper-voice",
    comments: [
      comment("eunji-kim", "Thirty seconds is honestly impressive."),
      comment("lucia-ortiz", "The important story needed an audience."),
    ],
  },
  {
    memorySlug: "banana-pocket",
    comments: [
      comment("gabe-ortiz", "I stand by saving it for later."),
      comment("lucia-ortiz", "That banana has seen things."),
    ],
  },
  {
    memorySlug: "actually",
    comments: [
      comment("rafael-ortiz", "Actually, I think he is right sometimes."),
      comment("eunji-kim", "He is very committed to the word."),
    ],
  },
  {
    memorySlug: "potato-haircut",
    comments: [
      comment("gabe-ortiz", "The potato is grateful for the careful comb."),
      comment("lucia-ortiz", "Five stars for the salon."),
    ],
  },
  {
    memorySlug: "rainboot-treasure",
    comments: [
      comment("rafael-ortiz", "That rock is definitely treasure."),
      comment("eunji-kim", "Please do not eat it."),
    ],
  },
  {
    memorySlug: "snack-drawer-meeting",
    comments: [
      comment("lucia-ortiz", "Three cracker locations is basically organization."),
      comment("gabe-ortiz", "I cannot find anything now."),
    ],
  },
  {
    memorySlug: "good-job-baby",
    comments: [
      comment("gabe-ortiz", "His first management position."),
      comment("eunji-kim", "Buckets are important."),
    ],
  },
  {
    memorySlug: "ice-cube-medicine",
    comments: [
      comment("lucia-ortiz", "A very thoughtful little nurse."),
      comment("gabe-ortiz", "The ice cube did not survive."),
    ],
  },
  {
    memorySlug: "blanket-boat",
    comments: [
      comment("lucia-ortiz", "I regret giving the boat a snack passenger."),
      comment("rafael-ortiz", "Captain Maya ran a tight ship."),
      comment("gabe-ortiz", "The engine was making a lot of noise."),
      comment("eunji-kim", "Ari was an excellent passenger."),
      comment("lucia-ortiz", "I would ride it again."),
    ],
  },
  {
    memorySlug: "spring-sidewalk-restaurant",
    comments: [
      comment("gabe-ortiz", "I overpaid for the invisible noodles."),
      comment("lucia-ortiz", "The menu was excellent."),
    ],
  },
  {
    memorySlug: "nana-soup-spoon",
    comments: [
      comment("eunji-kim", "One spoonful was exactly right."),
      comment("gabe-ortiz", "Love is a necessary ingredient."),
    ],
  },
  {
    memorySlug: "ari-sneeze-audience",
    comments: [
      comment("eunji-kim", "I am not taking requests."),
      comment("lucia-ortiz", "The audience was very persistent."),
    ],
  },
  {
    memorySlug: "rainy-window-gallery",
    comments: [
      comment("lucia-ortiz", "I would like a ticket please."),
      comment("rafael-ortiz", "Cracker admission is fair."),
      comment("eunji-kim", "I would like to see the window exhibit."),
      comment("gabe-ortiz", "Crackers are a reasonable ticket price."),
    ],
  },
  {
    memorySlug: "pancake-sun",
    comments: [
      comment("gabe-ortiz", "The sun was delicious."),
      comment("eunji-kim", "She ate her artwork."),
      comment("lucia-ortiz", "Still a good sun."),
      comment("rafael-ortiz", "Solar snack."),
    ],
  },
  {
    memorySlug: "sidewalk-chalk-hair",
    comments: [
      comment("rafael-ortiz", "Much more handsome now."),
      comment("lucia-ortiz", "The sidewalk looks great."),
    ],
  },
  {
    memorySlug: "one-more-song-concert",
    comments: [
      comment("lucia-ortiz", "I accept partial responsibility."),
      comment("gabe-ortiz", "Encore!"),
      comment("eunji-kim", "I thought dinner was happening."),
    ],
  },
  {
    memorySlug: "grandpa-sneaker-check",
    comments: [
      comment("rafael-ortiz", "The foot was hiding."),
      comment("eunji-kim", "A very serious investigation."),
    ],
  },
  {
    memorySlug: "mystery-dishwasher-beep",
    comments: [
      comment("gabe-ortiz", "Case closed."),
      comment("lucia-ortiz", "This mystery had a very boring answer."),
      comment("eunji-kim", "At least we solved it."),
    ],
  },
  {
    memorySlug: "birthday-candle-committee",
    comments: [
      comment("gabe-ortiz", "Team birthday sounds right to me."),
      comment("eunji-kim", "I think everyone got a turn."),
      comment("lucia-ortiz", "Team birthday has a strong argument."),
      comment("rafael-ortiz", "I was ready to help blow it out."),
      comment("eunji-kim", "The candle did not stand a chance."),
    ],
  },
  {
    memorySlug: "raisin-negotiation",
    comments: [
      comment("rafael-ortiz", "What was the final offer?"),
      comment("lucia-ortiz", "A tough little negotiator."),
    ],
  },
  {
    memorySlug: "raincoat-inside",
    comments: [
      comment("lucia-ortiz", "Prepared for every weather."),
      comment("gabe-ortiz", "The umbrella was a nice touch."),
    ],
  },
  {
    memorySlug: "tiny-grocery-cart",
    comments: [
      comment("eunji-kim", "The pinecone was a good choice."),
      comment("gabe-ortiz", "We really needed those stickers."),
      comment("lucia-ortiz", "The pinecone was the real purchase."),
      comment("rafael-ortiz", "A successful shopping trip."),
    ],
  },
  {
    memorySlug: "question-at-bedtime",
    comments: [
      comment("lucia-ortiz", "Cloud jobs are a big topic."),
      comment("eunji-kim", "I want to hear the assignments."),
      comment("gabe-ortiz", "I have several cloud job ideas."),
    ],
  },
  {
    memorySlug: "sticker-emergency",
    comments: [
      comment("gabe-ortiz", "At least the emergency was handled."),
      comment("lucia-ortiz", "Very official bandage."),
    ],
  },
  {
    memorySlug: "pocket-rock-collection",
    comments: [
      comment("rafael-ortiz", "The cracker is a rare find."),
      comment("eunji-kim", "Please display them somewhere safe."),
    ],
  },
  {
    memorySlug: "chair-is-a-horse",
    comments: [
      comment("gabe-ortiz", "I have been respecting the horse."),
      comment("lucia-ortiz", "Best horse in the house."),
      comment("rafael-ortiz", "Feed the horse a cracker."),
    ],
  },
  {
    memorySlug: "picnic-sandwich-builder",
    comments: [
      comment("eunji-kim", "The leaf is definitely the important part."),
      comment("gabe-ortiz", "I would try it."),
      comment("lucia-ortiz", "The leaf had structural integrity."),
      comment("rafael-ortiz", "I would like to see the menu."),
      comment("eunji-kim", "A very ambitious sandwich."),
      comment("gabe-ortiz", "No notes."),
    ],
  },
  {
    memorySlug: "nana-glasses",
    comments: [
      comment("eunji-kim", "My eyes were right where I left them."),
      comment("lucia-ortiz", "Important question."),
      comment("gabe-ortiz", "Very fair question."),
    ],
  },
  {
    memorySlug: "bathroom-sticker-map",
    comments: [
      comment("lucia-ortiz", "I am lost near the moon."),
      comment("gabe-ortiz", "Have we tried the bathroom?"),
    ],
  },
  {
    memorySlug: "the-blue-cup",
    comments: [
      comment("gabe-ortiz", "The blue cup runs this house."),
      comment("eunji-kim", "Breakfast teamwork."),
    ],
  },
  {
    memorySlug: "shoe-phone",
    comments: [
      comment("lucia-ortiz", "I hope the shoe had good news."),
      comment("rafael-ortiz", "Very important meeting indeed."),
      comment("eunji-kim", "Did the shoe take notes?"),
    ],
  },
  {
    memorySlug: "bedtime-pajama-parade",
    comments: [
      comment("gabe-ortiz", "The parade outfit was perfect."),
      comment("eunji-kim", "No corrections necessary."),
    ],
  },
  {
    memorySlug: "very-serious-birthday",
    comments: [
      comment("gabe-ortiz", "A dangerous decision, but worth it."),
      comment("lucia-ortiz", "She was right to inspect first."),
      comment("eunji-kim", "The inspection face is perfect."),
      comment("rafael-ortiz", "Candle safety first."),
    ],
  },
] as const satisfies readonly DemoMemoryEngagementSpec[];

export const DEMO_ENGAGEMENT_ACCOUNT_EMAILS = [
  DEMO_ACCOUNT_EMAIL,
  ...DEMO_ENGAGEMENT_ACTORS.map((actor) => actor.email),
] as const;

export const DEMO_ENGAGEMENT_MEMORY_COUNT =
  DEMO_MEMORIES.length + (DEMO_TOP_UP_MEMORIES as readonly DemoTopUpMemorySpec[]).length;
