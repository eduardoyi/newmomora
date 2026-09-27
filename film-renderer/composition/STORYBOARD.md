---
format: 1080x1920
duration: 59.5s
message: "A year of your child, in one little film — made from moments you already kept"
arc: Who → How much → the year, in bursts, stopping for his words, his people, his voice, his firsts → the party → Momora
audience: parents of young children; then their followers
mode: collaborative
---

# Year Film — scene template, drawn on Enzo's Year Four

**Message:** a whole year of your child, in one little film, made from moments you already kept.
**Audience & arc:** parents, then whoever they share it with. Who → how much → the year in
bursts, pausing on his words, his people, his voice, his firsts → the party → a quiet Momora close.
**Format:** 1080×1920, ~60s (cap 60s — the bed's length; owner, F3 round 2), no voiceover, music bed (launch v1, 118 BPM,
beat 0.5085s, drop 8.146s). Must read on mute. Platform keep-out: 180px top, 420px bottom,
150px right rail.

**The spine — the year strip.** A thin line near the top labelled only with the film's two
dates (`oct 2025 ——— oct 2026`, from `film.json` `span`), with a small rose dot at the **real
date** of whatever is on screen: it jumps forward with each burst frame, rests on a focus
memory's date, and hides when a scene has no single date (counters, starring). At the close
it reaches the birthday end and the rose seal stamps it — the callback.

**Voice:** written from the parent to the child — "Recuerdos de tu cuarto año, Enzo", "Tu
año en", "Lo que nos dijiste", "Con tu gente", "Tu voz", "Tus logros", "Tus momentos más
graciosos". Family films use the family's voice ("Nuestro agosto"). All from the builder's
template strings (`kicker`s in `film.json`).

## Locked

v2 layout locked by the owner (2026-09-27, "looks good, go"): all 12 frames' placement,
hierarchy and copy; the parent-to-child voice; the two-date year strip with the real-date
dot; counters at 4 beats over the filling mosaic.

## Changes from v1

- Counters: "this is just fun fact" (owner) → cut from 8 to 4 beats, over a muted mosaic of
  the year's memories that fills in tile by tile behind the numbers (`counters.backdrop`).
  The music's drop now lands inside burst 03 and speeds its cuts up.
- Voice: every title and label written from the parent to the child (owner).
- Year strip: month ticks implied frames came from months they didn't (owner) → only the two
  span dates, plus a dot at each moment's real date.

**Template, not one film.** Every scene is a module filled from `film.json`; the frames below
are drawn with Enzo's real content. Scenes a film doesn't qualify for drop out; bursts grow
or shrink with the year (plan §5).

**Brand:** `frame.md` (launch palette/type on a 9:16 layout). Lavender ground for the open and
close, cream for focus beats, plum for bursts and the voice.

**Bans:** no invented numbers or copy, no rankings of people, no comparisons, no gradient
text, no static end card. Motion failures to avoid: the **slideshow** (every beat a fresh
card with the same fade) and the **screensaver** (drifting photos that say nothing).

**Held frame:** frame 7, the voice. The music carves down, the ribbon stops, only the
trace's playhead moves while his voice plays.

**Seams:** travel upward (feed direction). Focus → burst = hard cut on a downbeat;
burst → focus = the last burst frame shrinks into the focus beat's card (scale-swap).

## Frame 1 — Cold open: photo becomes drawing

- scene: His real photo from the start of the year dissolves into his drawn portrait, then the year-end pair does the same; title lands.
- duration: 4.07s
- status: animated
- src: assemble.mjs → compositions/sNN.html (cold-open)
- transition_in: cut
- poster: 3.2
- motion: rules scale-swap-transition + ambient-glow-bloom; registry cross-warp-morph for photo→drawing; title waterfall-entry
- beats: 0–8 (0.00–4.07s)

Lavender ground. Oct 2025 photo (002 → drawing 003) morphs at center; the 2026 pair (004 → 005)
slides up from below and repeats the morph. Title "Recuerdos de tu cuarto año, Enzo" in Newsreader, the
year ribbon draws in above it. Why: says whose film this is, in the way only Momora can —
the real child becoming his drawn self.

## Frame 2 — Counters

- scene: "Tu año en" · "141 momentos · 95 fotos · 20 vídeos · 26 dibujos · 2 sonidos" count up fast over a muted mosaic of the year that fills tile by tile.
- duration: 2.03s
- status: animated
- src: assemble.mjs → compositions/sNN.html (counters)
- transition_in: cut
- poster: 3.5
- motion: blueprint dataviz-countup; rules counting-dynamic-scale + waterfall-entry
- beats: 8–12 (4.07–6.10s)

Numbers stack as a tall column, "141 momentos" largest. Zero counts never shown. Why: the
size of the year, in his parents' own saving.

## Frame 3 — Burst: the first half of the year

- scene: 14 frames (5 clips, 6 photos, 3 drawings) cut on the beat, Oct → Apr; ribbon fills.
- duration: 6.10s
- status: animated
- src: assemble.mjs → compositions/sNN.html (burst-first-half)
- transition_in: cut (on the drop)
- poster: 2.5
- motion: rules viewport-change (slow push per frame) + motion-blur-streak on whips; off-aspect media on yt-vertical-fill-style blurred fill
- beats: 12–24 (6.10–12.20s) — the drop (8.146s) lands 4 beats in

Plum frame, full-bleed media, stills half a beat, clips a beat. Date chip small, top-left under
the ribbon. Why: density — the year is full, and you're watching it go by.

## Frame 4 — The line of the year

- scene: "papi, el mundo es un lugar mágico!" in Caveat, rose underline draws; "— Enzo"; the source drawing (020) as a small card.
- duration: 3.56s
- status: animated
- src: assemble.mjs → compositions/sNN.html (line)
- transition_in: scale-swap from the last burst frame
- poster: 2.8
- motion: blueprint kinetic-type-beats; rules waterfall-entry (per word) + css-marker-patterns (underline)
- beats: 24–31 (12.20–15.76s)

Cream. The words arrive as he said them. Why: his voice, on mute — the thing a camera roll
can't hold.

## Frame 5 — Starring

- scene: One reveal per person (3 beats each): their photo wipes into their drawing, their name lands, and up to three moments of Enzo with them fan out as cards. Then all six together (2 beats).
- duration: 3.56s
- status: animated
- src: assemble.mjs → compositions/sNN.html (starring)
- transition_in: cut
- poster: 2.8
- motion: rules spring-pop-entrance (stagger ≤0.5s) + scale-swap-transition (photo→drawing per face)
- beats: 31–38 (15.76–19.32s)

Cream, neutral order (family creation order), no counts. Kicker "Con tu gente" small above.
Round 2 (owner): "needs more personality and emotion" → per-person reveals with their moments
(`people[].moments` from the builder). Why: the people in his year, and what they did together.

## Frame 6 — Burst: the second half, titled

- scene: 13 frames Apr → Oct on a drifting diagonal grid, then full-bleed; titles "Grandes salidas / Días de parque / Un día de playa".
- duration: 5.09s
- status: animated
- src: assemble.mjs → compositions/sNN.html (burst-second-half)
- transition_in: cut
- poster: 2.5
- motion: blueprint grid-card-assemble (diagonal drift) → full-bleed beat cuts; titles kinetic-beat-slam
- beats: 38–48 (19.32–24.41s)

Google's themes beat: the three titles slam in one per two beats over the moving grid. Why:
what his year was about, from topics that set it apart.

## Frame 7 — The sound of the year (held)

- scene: Ticket-stub card with the inked trace; playhead crosses it while "Enzo hablando en su idioma inventado" plays; caption under.
- duration: 6.10s
- status: animated
- src: assemble.mjs → compositions/sNN.html (sound)
- transition_in: cut
- poster: 3.0
- motion: rules svg-path-draw (trace) + sine-wave-loop (wax seal breathe); music carve
- beats: 48–60 (24.41–30.51s)

Plum. The app's own sound card, big. Everything still except the playhead, and a "Sube el
volumen" pill for muted autoplay. His voice is normalized to −14 LUFS and the bed ducks to 7%
(round 2: "barely able to hear it"). Why: the held frame — the voice parents fear forgetting.

## Frame 8 — Firsts

- scene: "Tus logros" · "Primera bici sin pedales · 20 ago 2026" lands as a stamped label.
- duration: 1.53s
- status: animated
- src: assemble.mjs → compositions/sNN.html (firsts)
- transition_in: cut
- poster: 1.1
- motion: blueprint kinetic-type-beats (one label per 3 beats when several)
- beats: 60–63 (30.51–32.04s)

Cream. Only certain firsts (plan). Why: a small victory, celebrated.

## Frame 9 — Burst: tus momentos más graciosos

- scene: 4 frames pop as tilted cards under the title "Tus momentos más graciosos".
- duration: 2.54s
- status: animated
- src: assemble.mjs → compositions/sNN.html (burst-funny)
- transition_in: cut
- poster: 1.8
- motion: rules spring-pop-entrance + kinetic-beat-slam (title)
- beats: 63–68 (32.04–34.58s)

Lavender, sticker-like cards with a slight rotation each. Why: the laugh before the finale.

## Frame 10 — Burst: finale

- scene: 19 frames accelerating (about a beat → half beats), whole year; ribbon races to October; hard cut to the party (the closing grid was removed, round 2).
- duration: 5.09s
- status: animated
- src: assemble.mjs → compositions/sNN.html (burst-finale)
- transition_in: cut
- poster: 2.5
- motion: accelerating hard cuts on the beat grid
- beats: 68–78 (34.58–39.66s)

Plum. Why: the rush of a whole year, ending in stillness.

## Frame 11 — ¡Feliz cumpleaños, Enzo!

- scene: The birthday party photos (2025-10-23 now; this year's party once it's logged) with "¡Feliz cumpleaños, Enzo!"; confetti; the ribbon's birthday tick gets its seal.
- duration: 4.07s
- status: animated
- src: assemble.mjs → compositions/sNN.html (close)
- transition_in: cut
- poster: 3.0
- motion: rules spring-pop-entrance (photos) + confetti (seeded) bursting from behind the photos as they land, then falling in front of them; title waterfall-entry
- beats: 78–86 (39.66–43.73s)

Lavender. Why: the reason the film exists, landing on the day itself.

## Frame 12 — End card

- scene: The counters' tilted mosaic of the year, in full color, collapses inward into the m. mark; "hecho con Momora".
- duration: 3.05s
- status: animated
- src: assemble.mjs → compositions/sNN.html (end-card)
- transition_in: cut
- poster: 2.4
- motion: blueprint logo-assemble-lockup (grid collapses to mark)
- beats: 86–92 (43.73–46.78s)

Lavender. Small and quiet — a signature, not an ad. Why: where it came from, for the
people it's shared with.
