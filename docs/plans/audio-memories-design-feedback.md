# Feedback: Audio memories designs (handoff review, 2026-08-19)

Paste-ready feedback for Claude Design on the `Momora - Audio memories` canvas. Overall: approved direction — the ticket-stub / inked-trace / wax-seal system, the copy deck, and the state coverage are all keepers. Six changes before this is build-ready.

---

## Prompt

Great work on the audio memories canvas — the stub/trace/seal metaphor is approved, the copy deck is exactly right, and we're adopting your "Record again", clip-removed-with-Undo, and "Not on this phone yet" additions. Six changes needed:

1. **Remove the share button from the audio card and the audio detail screen.** Both engagement rows currently include the share/send icon. Audio memories cannot be shared in v1 (the share-card service rejects the type), so the button's only possible outcome is an error. Like and comment stay; share goes.

2. **Fix the pending-card copy — it promises something the app can't keep.** "Your note is saved already. Safe to close Momora — the sound will finish on its own" is not true: nothing is saved on the server until the clip finishes uploading, and closing the app while it posts loses the pending post (same as photos today). Rewrite both pending and failed states so they're honest without being alarming — e.g. posting: "Posting memory… keep Momora open just a moment." Failed: "The sound didn't finish posting. It's still on this phone — try again." Keep the warmth; drop the false promise. (The failed line's "still on this phone" is accurate and stays.)

3. **Add the pre-emotion (neutral) state for the stub, the timeline card, and the detail screen.** Every audio surface tints by the memory's emotion, but the emotion is computed *after* save — for the first seconds every new audio memory has no emotion, and some (babble with no note) never get one. Design the neutral treatment: what color is un-analyzed ink, the stub wash, and the detail gradient? This is the very first state every user sees, so it can't be an afterthought — and it should feel intentional, not broken, since some memories stay in it forever.

4. **Add the terminal transcription-failure state at the fork.** You designed the "rare wait" (still catching your words) — now design what happens when it fails outright (offline, server error). Requirements: "Keep the sound" stays fully available and unaffected (keeping never depends on the server — that's the point of the feature); "Turn into text" shows a gentle failure and may suggest keeping the sound instead. Recording on the subway with no signal must still end in a saved memory.

5. **Design the 2:00 auto-stop moment in the recorder.** Recording hard-stops at two minutes. Right now the recorder just shows a counting timer. Design the cap: ideally a subtle heads-up as it approaches (last ~15s) and the auto-stop landing directly on the fork sheet without feeling like an error.

6. **Add a Discard action next to "Try again" on the failed posting card.** The shipped photo/video pattern is Retry + Discard; the failed audio card currently offers only "Try again". Match the pattern — a parent must be able to let a failed post go.

Everything else is approved as-is, including the copy deck ("Ours / never" table), both keyboard artboards, the Android variants, and the edit screen's structural immutability. The dark boards stay proposed-only for now — don't spend more time there.
