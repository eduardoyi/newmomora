# Design brief: Audio memories — UI/UX screens

Copy-paste prompt for the design pass. Context docs: `docs/features/audio-memories.md` (settled product decisions), `docs/voice-of-customer.md` (§6 language guide), `docs/plans/audio-memories-v1.md` (build plan).

---

## Prompt

You're designing the screens for a new memory type in **Momora**, a parent memory journal (Expo/React Native, iOS + Android). Momora's timeline is deliberately a *scrapbook* of visually distinct keepsake types — a small text note, an AI illustration, a photo/video carousel — not a uniform feed. We're adding a fourth type: **audio memories** — a kept recording of a sound (a toddler's babble, a mispronounced word, a laugh, a song), max 2 minutes, with a short editable description and an emotion chip.

**Design system:** the "Anchor Journal" redesign — lavender-forward palette, Newsreader (serif, editorial headings), Plus Jakarta Sans (UI), Caveat (handwritten accents). Warm, calm, paper-like. Existing memory detail screens carry a soft top-down gradient tinted by the memory's emotion.

**Emotional register (from our Voice-of-Customer research — this is the soul of the feature):** parents' deepest fear is losing *texture* — "I can still hear his little voice saying it. I'd give anything to have it on video." Audio is the most sacred medium (people who lost a parent treasure voice recordings above all photos). A photo memory says "look at this"; an audio memory says "close your eyes and listen." The design should feel like a treasured relic — think ticket stub, cassette, locket — not a media player or voice-memo utility.

**Copy rules (hard):** use parents' own words — "keep the sound," "record her laugh," "their little voice." NEVER "audio note," "voice memo," "artifact," "transcription." Tone is guilt-relieving, never pressuring. No streaks, no prompts to record more.

### Screens to design

1. **Post-recording fork (inside the existing voice modal).** The user just recorded via the composer mic. Today it always transcribes to text. New end state: a compact clip indication (duration; waveform optional) and **two equal-weight choices** — "Turn into text" and "Keep the sound." Constraints: one tap, zero perceived waiting (transcription already started in the background), no modal-on-modal, no scary confirmation. Choosing "Turn into text" should quietly convey the recording itself goes away (the chip disappears as the transcript fills in). Design all states: just-stopped, choice made → text path, choice made → keep path, and the rare still-processing wait.

2. **Composer in audio mode** (`new-memory` screen). After "Keep the sound": a playable clip chip (play/pause, duration, remove), the description field pre-filled by AI (editable; empty state placeholder: "Add a note about this sound"), family-member tag chips (some pre-selected from the recording), date pill, save. The photo-attach and AI-illustration controls are hidden in this mode. Must stay fully usable with the keyboard open (description field, primary actions reachable — this is a hard requirement on Android especially).

3. **Timeline card — the new keepsake.** The signature deliverable. A card that reads instantly as "a sound lives here" and looks *different in kind* from the text note, illustration, and photo cards around it. Contents: play/pause affordance, duration, playback progress (waveform or equivalent), description excerpt, emotion chip, up to 6 tagged-member avatars. Should invite a tap-to-play without looking like a music app. Design playing vs. idle states. Also design the "no description" variant (clip only).

4. **Memory detail screen — audio variant.** Playback is the hero: large play control, scrubber, duration, then description, tagged members, like/comment bar, and the standard date + emotion footer over the emotion-tinted gradient. Consider the "close your eyes and listen" moment — what does the screen do *while playing*? (Subtle motion tied to the audio is welcome; nothing gimmicky.)

5. **Edit screen — audio variant.** Description, tags, date are editable; the clip itself is fixed (playable but not replaceable). Make the immutability legible without an explanation.

6. **Small surfaces.** (a) Calendar day-stamp glyph for an audio memory (no image available — needs a tiny distinctive mark). (b) Member-profile memory-grid thumbnail for an audio memory. (c) The pending-upload card state while the clip uploads in the background ("Posting memory…" pattern exists for photos/videos — audio variant).

### Deliverables

Screen designs for 1–5 with states (idle/playing/loading/error where relevant), the small surfaces in 6, and a short rationale for the visual metaphor you chose for "a kept sound." Mobile-first, both light and dark contexts if the system supports it. Use realistic content: e.g. description "Mia singing Twinkle Twinkle in the bath," duration 0:42, emotion "joy."

### Out of scope

Share cards for audio (v1 rejects them), Looking Back story frames (v2), waveform-accurate rendering (a stylized representation is fine), onboarding (audio capture doesn't exist there).
