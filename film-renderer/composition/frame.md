# Momora films — design spec

Derived from the launch video's spec (`marketing/video/momora-launch/frame.md`),
adapted for 1080×1920 family films.

## Palette
- Lavender ground `#ECE8F5` (default), cream ground `#F7F1EA` (focus beats), plum `#2A2230` (bursts, voice).
- Ink `#2C2418`, ink-2 `#6B5E4F`, ink-3 `#8E7F6D`. Primary rose `#D63E78` — the one accent.
- Card `#FFFFFF`, border `#EBE7F2`. Blurred-fill scrim on plum at 35%.

## Type
- Display: Newsreader 500 — titles 132–180px, tight -0.03em; italic for spoken words.
- Labels & counts: Plus Jakarta Sans 500/700 — labels 38–46px, counters' numbers in Newsreader.
- Hand: Caveat 700 — the child's own words (line of the year), one rose word per scene at most.

## Layout (9:16)
- Safe area: 96px sides, 180px top, 420px bottom kept clear of platform UI; right 150px avoids the action rail.
- Media: full-bleed when 9:16; otherwise whole, centered on a blurred, scaled copy of itself.
- Cards: white, radius 40px, soft ink shadow; photos inside cards radius 28px.

## Motion
- Cuts land on downbeats (first cut: launch bed, 118 BPM, beat 0.5085s, drop 8.146s).
- Focus beats: one camera move each (push-in or pull-back), text lands sharp.
- Bursts: hard cuts on the beat or half-beat; clips hold ~2 beats, stills ~1.
- Blur only on snaps (whips between acts). Seams travel upward (feed direction).

## Bans
Gradient text, neon, invented numbers or claims, rankings of people,
comparisons to other months/years, device frames, static end card.
