# Topic Vocabulary — v2.1 (V1b final draft)

**Status:** v2.1 — Eduardo review applied 2026-08-23 (cut tummy-time, errands-shopping, caregivers, games-puzzles; dropped home-life; holiday granularity confirmed). Ready for V1c.
**Date:** 2026-08-23
**Parent plan:** [memory-book.md](memory-book.md) §5 Stage A (`topics[]`), §9 V1b
**Supersedes:** Draft v1 (41 tags derived purely from one archive)

## How v2 differs from v1

v1 was derived bottom-up from a single archive (726 memories, discovery run `2026-08-23T15-36-21-484Z`), which made it biased toward that family's life: beach but no mountains/snow/lake, grandparents but no aunts/uncles/cousins, Christmas/Thanksgiving but no Diwali/Eid/Lunar New Year. v2 keeps every v1 tag that earned its place and adds tags along four axes that one archive can't reveal:

- **Geography & climate:** lake/river, snow, mountains, countryside/farm, camping (deserts fold into nature).
- **Family structure:** extended family (aunts/uncles/cousins), caregivers ("our village"), relatives far away.
- **Culture & faith:** major non-Christian holidays as first-class tags, an `other-holiday` catch-all with a required `detail`, Mother's/Father's Day, national holidays, weddings, ceremonies, faith & traditions.
- **Life events & everyday care:** pregnancy/expecting, baby care, doctor visits, moving home, outfits, games, messy/sensory play.

Result: **61 tags in 8 groups** (38 observed on the source archive, 23 added for generality). Under the v1 mapping, 61% of the source archive's memories carried ≥1 tag; v2 can only raise that.

Design rules unchanged: tags are page titles, precision-first (0–3 per memory, empty allowed), deterministic axes (people, whose-birthday, season, milestones) stay out of the model, and catch-alls ("playtime", "family time") are negative examples, never tags.

## Vocabulary

"Source archive" = memories on Eduardo's archive that mapped to the tag in the discovery run; "—" = added in v2, not observable there (expected: that family doesn't do it, not that families don't).


### Places & outings

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `beach` | A day at the beach | Beach, sand, sea, seaside. | 8 | beach day (7), first beach (1), sandbox play (1), playing in sand (1) |
| `lake-river` ✦ | By the water | Lakes, rivers, creeks, docks, fishing, boating, paddling. | — | — |
| `pool-water` | Splash! | Pools, sprinklers, water tables, splash pads, swimming (not bath). | 13 | water play (3), pool day (2), splashing fun (2), water fun (2) |
| `snow-play` ✦ | Snow days | Snow, sledding, snowmen, skiing, ice skating, cold-weather play. | — | — |
| `mountains-hiking` ✦ | Up in the mountains | Hikes, trails, mountains, waterfalls, viewpoints. | — | — |
| `outdoors-nature` | Out in nature | Gardens, woods, fields, deserts, puddles, sunsets, nature exploration, neighborhood walks in nature. | 60 | outdoor fun (18), outdoor play (17), outdoor adventure (8), exploring nature (5) |
| `countryside-farm` ✦ | Country life | Farms, ranches, orchards, animals at the farm, harvest, pumpkin/berry picking, rural life. | — | — |
| `camping` ✦ | Under the stars | Camping, tents, campfires, RV trips, cabins. | — | — |
| `park-playground` | Park days | Parks, playgrounds, swings, slides, sandboxes. | 25 | playground fun (13), park day (6), swinging (5), slide adventure (2) |
| `days-out` | Big days out | Zoo, aquarium, fair, carnival, amusement/trampoline park, museum, exhibitions, theater, markets, concerts, sports games. | 24 | aquarium visit (4), zoo visit (2), amusement park (2), carnival fun (2) |
| `out-and-about` | Out and about | Everyday outings with no special venue: car rides, strolls, buses/subway, walks around town, errands, groceries, shopping trips. | 51 | family outing (37), car ride (5), walking together (2), first days out (1) |
| `travel` | Adventures away | Trips, vacations, flights, airports, road trips, hotels, visiting family far away, new cities. | 12 | first-plane (4), family trip (4), traveling together (3), family travel (2) |
| `eating-out` | Table for three | Restaurants, cafés, bakeries, picnics, barbecues. | 20 | restaurant outing (3), food festival (2), eating out (2), dining together (2) |

### Food

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `mealtime` | Yummy memories | Meals and snacks at home: feeding, messy eating, new foods, breakfast/dinner, food refusals. | 54 | snack time (19), mealtime (9), family meal (6), family dinner (4) |
| `cooking-baking` | Little chef | Cooking, baking, kitchen helping, holiday meal prep. | 14 | cooking together (9), kitchen fun (3), thanksgiving prep (2), baking (2) |
| `treats` | Sweet treats | Ice cream, cake, cookies, candy, desserts. | 17 | cake time (3), ice cream time (2), treats (2), ice cream treat (2) |

### Home & routines

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `bath` | Bath time | Baths, towels, bathroom play. | 12 | bath time (11), towel time (1), bathroom fun (1) |
| `bedtime-sleep` | Sweet dreams | Bedtime routines, naps, sleeping baby, bedtime stories, sleeping through the night. | 21 | bedtime routine (8), sleeping baby (2), nap time (2), sleepy baby (1) |
| `mornings` | Good mornings | Wake-ups, morning routine, getting dressed, getting ready. | 10 | morning routine (4), morning moments (2), getting ready (1), getting dressed (1) |
| `baby-care` ✦ | Taking care of you | Diapers, bottles, nursing, babywearing, stroller life, baby gear — the caregiving everyday beyond the newborn weeks. | — | — |
| `helping-chores` | Little helper | Chores, laundry, cleaning up, recycling, gardening chores, fixing things, DIY. | 10 | helping each other (2), helping with chores (1), DIY projects (1), recycling day (1) |
| `tough-days` | The hard days | Sick days, fevers, tantrums, tears, time-outs, exhaustion, hard goodbyes. | 16 | sick day (3), hospital visit (1), hospital moments (1), hospital stay (1) |
| `doctor-dentist` ✦ | Check-up day | Doctor check-ups, vaccines, dentist, hospital visits that are not emergencies. | — | — |
| `moving-new-home` ✦ | A new home | Moving house, new room, renovations, settling into a new place. | — | — |
| `outfits-style` ✦ | Little fashionista | Outfits, first shoes, silly hair, costumes worn for fun (non-Halloween), hand-me-downs. | — | — |

### Play & creativity

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `pretend-play` | Pretend & dress-up | Imaginative play, role play, superheroes, characters, tea parties, hide and seek, treasure hunts. | 40 | imaginative play (20), dress-up (8), dressing up (3), costume party (3) |
| `arts-crafts` | Little artist | Drawing, painting, coloring, crafts, stickers, art displays. | 27 | creative play (7), art time (3), art display (3), creativity (2) |
| `sensory-messy-play` ✦ | Messy play | Playdough, slime, finger paint, sand/water tables, mud kitchens, bubbles. | — | — |
| `toys-building` | Blocks, trains & toys | Blocks, LEGO, trains, cars, dolls, stuffed animals, toy play. | 17 | building blocks (3), toys (3), playing with toys (2), building (2) |
| `books-reading` | Story time | Reading together, books, library visits. | 12 | story time (5), storytime (4), reading together (2), reading time (2) |
| `music-dance` | Music & dancing | Singing, dancing, instruments, dance parties, music/dance classes. | 9 | music time (2), musical moments (2), dancing (2), dance party (1) |
| `bikes-scooters` | On wheels | Balance bikes, bikes, scooters, ride-on toys, learning to ride. | 10 | bike riding (4), first bike (3), biking (2), learning to ride (2) |
| `sports-exercise` | On the move | Sports, team practice, swimming lessons, gymnastics, martial arts, yoga, climbing, active play. | 7 | exercise together (2), climbing (1), ice skating (1), active play (1) |

### Babyhood & growing

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `pregnancy-expecting` ✦ | Before you arrived | Pregnancy, bump photos, ultrasounds, nursery prep, baby showers, announcements. | — | — |
| `newborn-days` | The newborn days | Birth, hospital, first days/weeks/month at home, new arrival, meeting the baby, tummy time and early floor play. | 42 | newborn moments (17), first days at home (10), newborn (5), new beginnings (4) |
| `words-and-sayings` | Things you said | Babbling, first sounds, new words, funny sayings, conversations, questions, second language. | 12 | first-word (2), language development (2), language learning (2), toddler talk (2) |
| `big-kid-skills` | Growing up | Potty training, brushing teeth, dressing self, haircuts, independence wins. | 10 | potty training (4), brushing teeth (2), toddler independence (2), first-haircut (1) |

### People

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `grandparents` | With the grandparents | Time with grandparents, in person or on video calls. | 17 | grandparent bonding (8), grandparent time (3), grandparent love (2), generational bond (1) |
| `extended-family` ✦ | Aunts, uncles & cousins | Aunts, uncles, cousins, godparents, extended-family visits, reunions, relatives visiting from afar. | — | — |
| `friends` | Friends | Friends, playdates, classmates, neighbors, birthday guests. | 4 | friendship (2), cousins (1), friends together (1) |
| `animals-pets` | Furry friends | Pets, dogs, cats, animal encounters outside zoos/farms. | 3 | animal encounter (1), playtime with pets (1), child and dog (1), learning about animals (1) |

### Occasions

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `birthday` | Birthday! | Birthday parties and celebrations (whose birthday is resolved from DOBs). | 63 | birthday celebration (45), birthday party (10), first birthday (7), birthday celebrations (1) |
| `christmas` | Christmas | Christmas, Advent, decorations, lights, gifts, Santa, holiday season (Dec). | 49 | holiday season (11), holiday spirit (8), christmas celebration (4), holiday decorations (4) |
| `new-year` | New Year | New Year's Eve/Day (Gregorian). | 15 | new year celebration (6), new year's celebration (5), new year's preparations (1), new year's eve (1) |
| `thanksgiving` | Thanksgiving | Thanksgiving and its prep (US late Nov / CA early Oct). | 10 | thanksgiving (8), thanksgiving dinner (1), thanksgiving memories (1) |
| `halloween` | Halloween | Halloween costumes, pumpkins, trick-or-treat (Oct). | 6 | halloween (2), first-halloween (1), Halloween fun (1), first costume (1) |
| `easter` | Easter | Easter, egg painting/hunts, Holy Week (spring, movable). | 2 | easter celebration (2), spring festivities (1) |
| `valentines` | Valentine's Day | Valentine's Day (Feb 14). | 5 | valentine's day (4), Valentine's Day (1) |
| `lunar-new-year` ✦ | Lunar New Year | Chinese/Vietnamese/Korean New Year, red envelopes, lion dances (Jan–Feb, movable). | — | — |
| `hanukkah` ✦ | Hanukkah | Hanukkah, menorah, latkes, dreidel (Nov–Dec, movable). | — | — |
| `eid` ✦ | Eid | Eid al-Fitr / Eid al-Adha, Ramadan iftars (movable). | — | — |
| `diwali` ✦ | Diwali | Diwali, diyas, rangoli, fireworks (Oct–Nov, movable). | — | — |
| `dia-de-muertos` ✦ | Día de Muertos | Día de Muertos, ofrendas, calaveras (Nov 1–2). | — | — |
| `mothers-fathers-day` ✦ | Mother's & Father's Day | Mother's Day / Father's Day (dates vary by country; `detail` = which). | — | — |
| `national-holiday` ✦ | National holidays | Independence days, July 4th, Canada Day, Carnival, national festivals (`detail` = which). | — | — |
| `other-holiday` ✦ | Holidays & festivals | Any other religious or cultural holiday (`detail` required, e.g. Passover, Rosh Hashanah, Kwanzaa, Nowruz, Holi, Vesak, Onam, St. Patrick's). | — | — |
| `wedding` ✦ | Wedding day | Weddings, vow renewals, engagement parties. | — | — |
| `ceremony` ✦ | A special ceremony | Baptism/christening, naming ceremony, bris, first communion, dedication, red-egg party (`detail` = which). | — | — |
| `family-gathering` | All together | Non-holiday family get-togethers, reunions, celebrations with extended family, anniversaries. | 25 | family gathering (21), celebrating together (1), celebrating life (1), gathering (1) |

### School & community

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| `school` | School days | Daycare, preschool, school days, drop-offs, school projects, performances, camps. | 12 | school day (3), school drop-off (1), after school (1), after school activities (1) |
| `faith-and-traditions` ✦ | Our traditions | Church/temple/mosque/synagogue visits, prayers, cultural traditions, heritage language and customs. | — | — |

✦ = added in v2 for generality.

## Date gating for occasions

Calendar-bound occasions are validated in code, not trusted from the model (plan §5): the tag survives only if the memory date is plausible for that occasion **or** the text names it explicitly. Fixed-date holidays (Christmas, Halloween, Valentine's, Día de Muertos, New Year) use ±10-day windows. **Movable holidays** (Easter, Eid, Diwali, Hanukkah, Lunar New Year, Thanksgiving, Mother's/Father's Day by country) need a small per-year date table maintained in code — or fall back to text evidence only. `other-holiday`, `national-holiday`, `ceremony`, and `mothers-fathers-day` carry a required `detail` string, normalized to a canonical name so memories cluster across years.

## Concepts owned by other axes (unchanged from v1)

| Axis | What the model kept wanting (source archive) | Where it lives |
|---|---|---|
| **Emotion** | cuddle time, tender moments, funny moments, silly faces (116 tokens) | `emotion` column |
| **People** | siblings ×50+, parent–child bonding (95 tokens) | `memory_family_members` + DOBs — joins, never model tags |
| **Milestone** | baby milestones, first steps, first smile (64 tokens) | explicit-text milestone axis ([milestone-catalog.md](milestone-catalog.md)) |
| **Season** | summer fun, winter fun (28 tokens) | derived from `memory_date` + hemisphere |

## Dropped catch-alls (negative examples for the prompt)

playtime, family time, family moments, family bonding, smiles, celebration, growing up, family fun, toddler fun, togetherness, exploring, playful moments, happy moments, childhood, everyday moments, adventure — 674 raw tokens on the source archive. The V1c prompt lists these explicitly as "not a theme".

## Review decisions (2026-08-23)

1. **Cut:** `tummy-time` (folded into `newborn-days`), `errands-shopping` (folded into `out-and-about`), `caregivers`, `games-puzzles`.
2. **Holiday granularity confirmed:** five first-class non-Christian holidays + `other-holiday` with required `detail`.
3. **`home-life` dropped** — no at-home fallback tag; cozy/indoor everyday memories stay untagged and live in the chronological backbone. Its would-be raw themes (cozy moments, home activities, indoor fun) join the negative examples.
4. Names approved as-is.
