// Controlled book-vocabulary topics for `analyze-memory`
// (docs/plans/memory-book.md §5 Stage A `topics[]`, docs/plans/topic-vocabulary.md
// v2.1 -- the source of truth this file is a typed, production-ready port of).
//
// This is production data, not eval scaffolding: `supabase/scripts/
// eval-memory-book-tagging.ts` parsed the markdown doc at runtime for the V1
// eval; this file hand-ports the same 61 entries into typed constants so the
// Edge Function has zero markdown-parsing dependency at request time. A sync
// test (memory-topics.test.ts) parses the doc the same way the eval script
// did and asserts these constants match it exactly (ids + count), so the doc
// and this file cannot silently drift.
//
// Three lessons from the V1c eval carry forward into how this vocabulary is
// used in the production prompt (see analyze-memory-core.ts):
// (a) the vocabulary list must sit IMMEDIATELY after the topics instruction
//     in the prompt -- an earlier draft with the vocabulary at prompt end
//     (after the milestone catalog) collapsed coverage from 30% to 2%;
// (b) parsers never silently drop an unresolvable model output -- every
//     rejected/unparsed item is recorded, never just discarded;
// (c) the topics instruction is example-led ("topics": ["beach",
//     "grandparents"], "most family memories match 1-2 topics").

/** Bumped whenever the vocabulary changes in a way that should invalidate
 * previously-analyzed rows (`memories.analysis_version`). Distinct from the
 * doc's own "v2.1" draft label -- this is the production schema version. */
export const TOPICS_VERSION = 1;

export type TopicDateGate =
  | { readonly type: 'none' }
  /** `startMonthDay`/`endMonthDay` are zero-padded "MM-DD" strings; a
   * `start > end` pair wraps the year boundary (e.g. christmas: 12-15 -> 01-06). */
  | { readonly type: 'fixed'; readonly startMonthDay: string; readonly endMonthDay: string }
  /** 4th Thursday of November (US), computed, not table-driven. */
  | { readonly type: 'thanksgiving' }
  /** 2nd Sunday of May (Mother's Day) or 3rd Sunday of June (Father's Day),
   * computed; `detail` on the topic assignment records which. */
  | { readonly type: 'mothers-fathers-day' }
  /** Per-year central date (YYYY-MM-DD) for a movable holiday, 2022-2027.
   * A year outside the table fails closed (topic is NOT date-plausible). */
  | { readonly type: 'movable'; readonly datesByYear: Readonly<Record<number, string>> };

export interface TopicDefinition {
  readonly id: string;
  readonly pageTitle: string;
  readonly definition: string;
  readonly group: string;
  /** Only true for other-holiday, national-holiday, ceremony,
   * mothers-fathers-day -- a canonical-English-name `detail` string. */
  readonly requiresDetail: boolean;
  readonly dateGate: TopicDateGate;
}

const NONE: TopicDateGate = { type: 'none' };
const THANKSGIVING: TopicDateGate = { type: 'thanksgiving' };
const MOTHERS_FATHERS_DAY: TopicDateGate = { type: 'mothers-fathers-day' };

function fixed(startMonthDay: string, endMonthDay: string): TopicDateGate {
  return { type: 'fixed', startMonthDay, endMonthDay };
}

function movable(datesByYear: Record<number, string>): TopicDateGate {
  return { type: 'movable', datesByYear };
}

// Per-year central dates for movable holidays 2022-2027 (approximate is fine
// -- these are date-plausibility gates, not liturgical calendars). Ported
// verbatim from eval-memory-book-tagging.ts's MOVABLE_HOLIDAY_DATES. Eid =
// Eid al-Fitr; Hanukkah = first night.
const EASTER_DATES: Record<number, string> = {
  2022: '2022-04-17',
  2023: '2023-04-09',
  2024: '2024-03-31',
  2025: '2025-04-20',
  2026: '2026-04-05',
  2027: '2027-03-28',
};

const EID_DATES: Record<number, string> = {
  2022: '2022-05-02',
  2023: '2023-04-21',
  2024: '2024-04-10',
  2025: '2025-03-30',
  2026: '2026-03-20',
  2027: '2027-03-09',
};

const DIWALI_DATES: Record<number, string> = {
  2022: '2022-10-24',
  2023: '2023-11-12',
  2024: '2024-11-01',
  2025: '2025-10-20',
  2026: '2026-11-08',
  2027: '2027-10-29',
};

const HANUKKAH_DATES: Record<number, string> = {
  2022: '2022-12-18',
  2023: '2023-12-07',
  2024: '2024-12-25',
  2025: '2025-12-14',
  2026: '2026-12-04',
  2027: '2027-12-24',
};

const LUNAR_NEW_YEAR_DATES: Record<number, string> = {
  2022: '2022-02-01',
  2023: '2023-01-22',
  2024: '2024-02-10',
  2025: '2025-01-29',
  2026: '2026-02-17',
  2027: '2027-01-26',
};

export const TOPICS: readonly TopicDefinition[] = [
  // ── Places & outings ──────────────────────────────────────────────────
  { id: 'beach', pageTitle: 'A day at the beach', definition: 'Beach, sand, sea, seaside.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'lake-river', pageTitle: 'By the water', definition: 'Lakes, rivers, creeks, docks, fishing, boating, paddling.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'pool-water', pageTitle: 'Splash!', definition: 'Pools, sprinklers, water tables, splash pads, swimming (not bath).', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'snow-play', pageTitle: 'Snow days', definition: 'Snow, sledding, snowmen, skiing, ice skating, cold-weather play.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'mountains-hiking', pageTitle: 'Up in the mountains', definition: 'Hikes, trails, mountains, waterfalls, viewpoints.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'outdoors-nature', pageTitle: 'Out in nature', definition: 'Gardens, woods, fields, deserts, puddles, sunsets, nature exploration, neighborhood walks in nature.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'countryside-farm', pageTitle: 'Country life', definition: 'Farms, ranches, orchards, animals at the farm, harvest, pumpkin/berry picking, rural life.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'camping', pageTitle: 'Under the stars', definition: 'Camping, tents, campfires, RV trips, cabins.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'park-playground', pageTitle: 'Park days', definition: 'Parks, playgrounds, swings, slides, sandboxes.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'days-out', pageTitle: 'Big days out', definition: 'Zoo, aquarium, fair, carnival, amusement/trampoline park, museum, exhibitions, theater, markets, concerts, sports games.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'out-and-about', pageTitle: 'Out and about', definition: 'Everyday outings with no special venue: car rides, strolls, buses/subway, walks around town, errands, groceries, shopping trips.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'travel', pageTitle: 'Adventures away', definition: 'Trips, vacations, flights, airports, road trips, hotels, visiting family far away, new cities.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },
  { id: 'eating-out', pageTitle: 'Table for three', definition: 'Restaurants, cafés, bakeries, picnics, barbecues.', group: 'Places & outings', requiresDetail: false, dateGate: NONE },

  // ── Food ─────────────────────────────────────────────────────────────
  { id: 'mealtime', pageTitle: 'Yummy memories', definition: 'Meals and snacks at home: feeding, messy eating, new foods, breakfast/dinner, food refusals.', group: 'Food', requiresDetail: false, dateGate: NONE },
  { id: 'cooking-baking', pageTitle: 'Little chef', definition: 'Cooking, baking, kitchen helping, holiday meal prep.', group: 'Food', requiresDetail: false, dateGate: NONE },
  { id: 'treats', pageTitle: 'Sweet treats', definition: 'Ice cream, cake, cookies, candy, desserts.', group: 'Food', requiresDetail: false, dateGate: NONE },

  // ── Home & routines ──────────────────────────────────────────────────
  { id: 'bath', pageTitle: 'Bath time', definition: 'Baths, towels, bathroom play.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'bedtime-sleep', pageTitle: 'Sweet dreams', definition: 'Bedtime routines, naps, sleeping baby, bedtime stories, sleeping through the night.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'mornings', pageTitle: 'Good mornings', definition: 'Wake-ups, morning routine, getting dressed, getting ready.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'baby-care', pageTitle: 'Taking care of you', definition: 'Diapers, bottles, nursing, babywearing, stroller life, baby gear -- the caregiving everyday beyond the newborn weeks.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'helping-chores', pageTitle: 'Little helper', definition: 'Chores, laundry, cleaning up, recycling, gardening chores, fixing things, DIY.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'tough-days', pageTitle: 'The hard days', definition: 'Sick days, fevers, tantrums, tears, time-outs, exhaustion, hard goodbyes.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'doctor-dentist', pageTitle: 'Check-up day', definition: 'Doctor check-ups, vaccines, dentist, hospital visits that are not emergencies.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'moving-new-home', pageTitle: 'A new home', definition: 'Moving house, new room, renovations, settling into a new place.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },
  { id: 'outfits-style', pageTitle: 'Little fashionista', definition: 'Outfits, first shoes, silly hair, costumes worn for fun (non-Halloween), hand-me-downs.', group: 'Home & routines', requiresDetail: false, dateGate: NONE },

  // ── Play & creativity ────────────────────────────────────────────────
  { id: 'pretend-play', pageTitle: 'Pretend & dress-up', definition: 'Imaginative play, role play, superheroes, characters, tea parties, hide and seek, treasure hunts.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },
  { id: 'arts-crafts', pageTitle: 'Little artist', definition: 'Drawing, painting, coloring, crafts, stickers, art displays.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },
  { id: 'sensory-messy-play', pageTitle: 'Messy play', definition: 'Playdough, slime, finger paint, sand/water tables, mud kitchens, bubbles.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },
  { id: 'toys-building', pageTitle: 'Blocks, trains & toys', definition: 'Blocks, LEGO, trains, cars, dolls, stuffed animals, toy play.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },
  { id: 'books-reading', pageTitle: 'Story time', definition: 'Reading together, books, library visits.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },
  { id: 'music-dance', pageTitle: 'Music & dancing', definition: 'Singing, dancing, instruments, dance parties, music/dance classes.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },
  { id: 'bikes-scooters', pageTitle: 'On wheels', definition: 'Balance bikes, bikes, scooters, ride-on toys, learning to ride.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },
  { id: 'sports-exercise', pageTitle: 'On the move', definition: 'Sports, team practice, swimming lessons, gymnastics, martial arts, yoga, climbing, active play.', group: 'Play & creativity', requiresDetail: false, dateGate: NONE },

  // ── Babyhood & growing ───────────────────────────────────────────────
  { id: 'pregnancy-expecting', pageTitle: 'Before you arrived', definition: 'Pregnancy, bump photos, ultrasounds, nursery prep, baby showers, announcements.', group: 'Babyhood & growing', requiresDetail: false, dateGate: NONE },
  { id: 'newborn-days', pageTitle: 'The newborn days', definition: 'Birth, hospital, first days/weeks/month at home, new arrival, meeting the baby, tummy time and early floor play.', group: 'Babyhood & growing', requiresDetail: false, dateGate: NONE },
  { id: 'words-and-sayings', pageTitle: 'Things you said', definition: 'Babbling, first sounds, new words, funny sayings, conversations, questions, second language.', group: 'Babyhood & growing', requiresDetail: false, dateGate: NONE },
  { id: 'big-kid-skills', pageTitle: 'Growing up', definition: 'Potty training, brushing teeth, dressing self, haircuts, independence wins.', group: 'Babyhood & growing', requiresDetail: false, dateGate: NONE },

  // ── People ───────────────────────────────────────────────────────────
  { id: 'grandparents', pageTitle: 'With the grandparents', definition: 'Time with grandparents, in person or on video calls.', group: 'People', requiresDetail: false, dateGate: NONE },
  { id: 'extended-family', pageTitle: 'Aunts, uncles & cousins', definition: 'Aunts, uncles, cousins, godparents, extended-family visits, reunions, relatives visiting from afar.', group: 'People', requiresDetail: false, dateGate: NONE },
  { id: 'friends', pageTitle: 'Friends', definition: 'Friends, playdates, classmates, neighbors, birthday guests.', group: 'People', requiresDetail: false, dateGate: NONE },
  { id: 'animals-pets', pageTitle: 'Furry friends', definition: 'Pets, dogs, cats, animal encounters outside zoos/farms.', group: 'People', requiresDetail: false, dateGate: NONE },

  // ── Occasions ────────────────────────────────────────────────────────
  // `birthday` is not calendar-date-gated here: whose birthday it is (and
  // whether the anniversary is even plausible) is resolved deterministically
  // by joining tagged members' DOBs, never by a topic date window -- see
  // memory-milestones.ts and analyze-memory-core.ts's birthday resolution.
  { id: 'birthday', pageTitle: 'Birthday!', definition: 'Birthday parties and celebrations (whose birthday is resolved from DOBs).', group: 'Occasions', requiresDetail: false, dateGate: NONE },
  { id: 'christmas', pageTitle: 'Christmas', definition: 'Christmas, Advent, decorations, lights, gifts, Santa, holiday season (Dec).', group: 'Occasions', requiresDetail: false, dateGate: fixed('12-15', '01-06') },
  { id: 'new-year', pageTitle: 'New Year', definition: "New Year's Eve/Day (Gregorian).", group: 'Occasions', requiresDetail: false, dateGate: fixed('12-26', '01-07') },
  { id: 'thanksgiving', pageTitle: 'Thanksgiving', definition: 'Thanksgiving and its prep (US late Nov / CA early Oct).', group: 'Occasions', requiresDetail: false, dateGate: THANKSGIVING },
  { id: 'halloween', pageTitle: 'Halloween', definition: 'Halloween costumes, pumpkins, trick-or-treat (Oct).', group: 'Occasions', requiresDetail: false, dateGate: fixed('10-21', '11-03') },
  { id: 'easter', pageTitle: 'Easter', definition: 'Easter, egg painting/hunts, Holy Week (spring, movable).', group: 'Occasions', requiresDetail: false, dateGate: movable(EASTER_DATES) },
  { id: 'valentines', pageTitle: "Valentine's Day", definition: "Valentine's Day (Feb 14).", group: 'Occasions', requiresDetail: false, dateGate: fixed('02-07', '02-21') },
  { id: 'lunar-new-year', pageTitle: 'Lunar New Year', definition: 'Chinese/Vietnamese/Korean New Year, red envelopes, lion dances (Jan-Feb, movable).', group: 'Occasions', requiresDetail: false, dateGate: movable(LUNAR_NEW_YEAR_DATES) },
  { id: 'hanukkah', pageTitle: 'Hanukkah', definition: 'Hanukkah, menorah, latkes, dreidel (Nov-Dec, movable).', group: 'Occasions', requiresDetail: false, dateGate: movable(HANUKKAH_DATES) },
  { id: 'eid', pageTitle: 'Eid', definition: 'Eid al-Fitr / Eid al-Adha, Ramadan iftars (movable).', group: 'Occasions', requiresDetail: false, dateGate: movable(EID_DATES) },
  { id: 'diwali', pageTitle: 'Diwali', definition: 'Diwali, diyas, rangoli, fireworks (Oct-Nov, movable).', group: 'Occasions', requiresDetail: false, dateGate: movable(DIWALI_DATES) },
  { id: 'dia-de-muertos', pageTitle: 'Día de Muertos', definition: 'Día de Muertos, ofrendas, calaveras (Nov 1-2).', group: 'Occasions', requiresDetail: false, dateGate: fixed('10-25', '11-09') },
  { id: 'mothers-fathers-day', pageTitle: "Mother's & Father's Day", definition: "Mother's Day / Father's Day (dates vary by country; detail = which).", group: 'Occasions', requiresDetail: true, dateGate: MOTHERS_FATHERS_DAY },
  { id: 'national-holiday', pageTitle: 'National holidays', definition: 'Independence days, July 4th, Canada Day, Carnival, national festivals (detail = which).', group: 'Occasions', requiresDetail: true, dateGate: NONE },
  { id: 'other-holiday', pageTitle: 'Holidays & festivals', definition: 'Any other religious or cultural holiday (detail required, e.g. Passover, Rosh Hashanah, Kwanzaa, Nowruz, Holi, Vesak, Onam, St. Patrick\'s).', group: 'Occasions', requiresDetail: true, dateGate: NONE },
  { id: 'wedding', pageTitle: 'Wedding day', definition: 'Weddings, vow renewals, engagement parties.', group: 'Occasions', requiresDetail: false, dateGate: NONE },
  { id: 'ceremony', pageTitle: 'A special ceremony', definition: 'Baptism/christening, naming ceremony, bris, first communion, dedication, red-egg party (detail = which).', group: 'Occasions', requiresDetail: true, dateGate: NONE },
  { id: 'family-gathering', pageTitle: 'All together', definition: 'Non-holiday family get-togethers, reunions, celebrations with extended family, anniversaries.', group: 'Occasions', requiresDetail: false, dateGate: NONE },

  // ── School & community ───────────────────────────────────────────────
  { id: 'school', pageTitle: 'School days', definition: 'Daycare, preschool, school days, drop-offs, school projects, performances, camps.', group: 'School & community', requiresDetail: false, dateGate: NONE },
  { id: 'faith-and-traditions', pageTitle: 'Our traditions', definition: 'Church/temple/mosque/synagogue visits, prayers, cultural traditions, heritage language and customs.', group: 'School & community', requiresDetail: false, dateGate: NONE },
];

export const TOPIC_IDS: ReadonlySet<string> = new Set(TOPICS.map((topic) => topic.id));

export const TOPICS_REQUIRING_DETAIL: ReadonlySet<string> = new Set(
  TOPICS.filter((topic) => topic.requiresDetail).map((topic) => topic.id),
);

/** Topic ids that carry a date gate applied in code, never trusted from the
 * model (see gateTopicsByDate in analyze-memory-core.ts). `birthday` is
 * deliberately excluded -- its "date plausibility" is the deterministic DOB
 * join, not a calendar window. */
export const DATE_GATED_TOPIC_IDS: ReadonlySet<string> = new Set(
  TOPICS.filter((topic) => topic.dateGate.type !== 'none').map((topic) => topic.id),
);

export function getTopicById(id: string): TopicDefinition | undefined {
  return TOPICS.find((topic) => topic.id === id);
}

/**
 * The doc's "Dropped catch-alls" -- v1's raw catch-all tags that must never
 * be treated as topics -- plus the 3 catch-alls freed up by dropping
 * `home-life` (topic-vocabulary.md Review decision #3). Hardcoded, not
 * parsed (this is prose in the doc, not a table). Used as the prompt's
 * negative-examples line (analyze-memory-core.ts).
 */
export const NEGATIVE_EXAMPLES: readonly string[] = [
  'playtime',
  'family time',
  'family moments',
  'family bonding',
  'smiles',
  'celebration',
  'growing up',
  'family fun',
  'toddler fun',
  'togetherness',
  'exploring',
  'playful moments',
  'happy moments',
  'childhood',
  'everyday moments',
  'adventure',
  'cozy moments',
  'home activities',
  'indoor fun',
];
