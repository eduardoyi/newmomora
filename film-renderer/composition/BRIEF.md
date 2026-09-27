---
workflow: general-video
flow: companion
storyboard: yes
message: "A year of your child, in one little film — made from moments you already kept"
destination: tiktok-reels-stories
aspect: 1080x1920
language: es
length: 30-50s
audience: parents of young children (the film's own family first, then their followers)
---

## Intent

The Year Film product (docs/plans/year-film.md): personalized vertical recap
films — a birthday film per child, a monthly family recap, a year-end family
film — rendered from each family's `film.json` (FilmScript, built and
checked in F0–F2). This project is the **reusable template**, not one video:
scene modules filled from data. It is reviewed on real films, starting with
**Enzo's Year Four** (`../film-data/birthday-enzo-y4/film.json`), due as a
local first cut for 2026-10-26.

Feel: the motion language of the Momora launch video — beat-cut, camera
moves, kinetic type — alternating slow **focus beats** (portrait, line,
starring, voice, firsts, awards, party) with dense **bursts** of photos and
clips in quick succession, like Google Photos' monthly recap (owner). A gift
parents want to post, not an ad.

## Assets

- `assets/fonts/*` — Newsreader, Plus Jakarta Sans, Caveat (from the launch video).
- `assets/audio/bed-launch-v1.mp3` — the launch video's ElevenLabs music_v1
  bed (60s, 118 BPM, drop 8.146s), commercially cleared; first cut only.
- `../film-data/<slug>/` — each film's prepared stills, clips, voice excerpt
  and `film.json` (gitignored, real family data).

## Customizations

- Design spec: reuse the launch video's (`marketing/video/momora-launch/frame.md`),
  adapted for 9:16 in `frame.md` here (owner, 2026-09-27).
- Music: reuse the launch bed for the first cut; 4–6 dedicated film beds with
  beat maps in a later F3 round (owner).
- Portraits: real photo → illustration transform in the cold open and
  starring (owner, F1 round 2).
- Off-aspect media: shown whole on a blurred fill of itself, never cropped
  away (owner, F2 round 1).

## Notes

- Every on-screen string comes from `film.json` — never invent copy, counts,
  or claims (plan §3). No period-over-period comparisons, no ranking of people.
- The film must read on mute (social autoplay); the voice beat shows its caption.
- Keep type and faces clear of TikTok/Reels UI (right rail, bottom caption area).
- End card: "hecho con Momora" + m. mark; no print CTA inside the video.
