# App preview videos: inspiration, styles and storyboards

**Status:** research done 2026-09-23. Next: owner picks a storyboard, then we capture and compose.
**Scope:** one iPhone App Store preview and one Google Play promo video. iPad comes later.
**Tooling:** real screen recordings, scripted with Maestro in the iOS simulator on the demo family, then composed in HyperFrames (captions, pacing, transitions, music, export).

---

## 1. Recommendation in one paragraph

Make **one calm 18–20 s iPhone preview** that opens on the thing screenshots can't show: a sound card playing, with the words as a caption because the video autoplays muted. Then take four short, real UI beats (camera roll → memory, a line → illustration, grandparent comment, then & now) and end on the brand card with "Subscription required". A/B test it against the current screenshots-only page (PPO) before making it the default: previews can lower conversion as well as raise it. For Play, cut a **~30 s version** of the same story and add the printed-book beat.

## 2. Rules we must design within

| | App Store app preview | Google Play promo video |
|---|---|---|
| Footage | **Only screen captures of the app** (guideline 2.3.4). Overlays, captions, touch hotspots, dissolves, one music score and optional voiceover are allowed | YouTube link. Google recommends showing the real app within 10 s and making ≥80% of the video the real experience |
| Not allowed | Hands or people with devices, content outside the app, prices, unlicensed music, seasonal/dated wording, personal data | Ranking claims ("#1", "best"), price/promo wording ("free trial"), Play program terms |
| Paid app | **Must say it's a subscription** (in the footage or on the end frame) | No price or promo wording |
| Specs | 886×1920 portrait (covers 6.9", 6.5", 6.3" and 6.1"), 15–30 s, ≤30 fps, H.264 10–12 Mbps or ProRes 422 HQ, stereo AAC 256 kbps at 44.1/48 kHz, ≤500 MB, up to 3 per locale | Public or unlisted YouTube, ads off, not age-restricted, embeddable. Portrait is fine (the app is portrait) |
| Playback | Autoplays **muted** on the product page and in search. In search, a portrait preview sits next to 2 screenshots. Poster frame defaults to 5 s | Plays from the feature graphic (which acts as its poster). May autoplay muted inline for up to 30 s on some devices |
| Testing | Product Page Optimization can test previews (up to 3 treatments, 90 days) | Store listing experiments apparently can't test the video |

Sources: [Apple app previews](https://developer.apple.com/app-store/app-previews/), [App preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications/), [Review Guidelines 2.3.4/2.3.7](https://developer.apple.com/app-store/review/guidelines/), [PPO](https://developer.apple.com/help/app-store-connect/create-product-page-optimization-tests/overview-of-product-page-optimization/), [Play preview assets](https://support.google.com/googleplay/android-developer/answer/9866151), [Play metadata policy](https://support.google.com/googleplay/android-developer/answer/9898842).

## 3. What the conversion evidence says

- **Attention is tiny:** average iOS watch time is 4–6.5 s, fewer than 20% watch to the end, ~10% drop off every 5 s, and ~98% watch muted (Storemaven data via [Apptamin](https://www.apptamin.com/blog/app-preview-play-store-videos/); second-hand).
- **The first 3 seconds and the poster frame decide it.** Kabam got +66% install conversion from testing poster frames alone (same source).
- **Previews can hurt.** In Apple's own Simply Piano PPO case study, the page *without* a preview won by 3% ([Apple](https://developer.apple.com/app-store/product-page-optimization/)). So we test before committing.
- **Two short previews usually beat one long one** ([SplitMetrics](https://splitmetrics.com/blog/create-app-preview-video-app-store-ios/)). If the first works, the second should be voice or book, not a longer cut.
- **No parenting/photo/journaling category data exists publicly.** Treat all of this as direction, not a guarantee.
- **Most category leaders have no preview at all** (Day One, Headspace, Calm, 1SE, Tinybeans, Qeepsake, Google Photos, Journal, Finch, Chatbooks… checked 2026-09-23). A beautiful one is a real way to stand out.

## 4. Inspiration

Watched = we pulled the actual preview file and reviewed it frame by frame (1 fps contact sheets).

| App | What it does | Steal | Avoid |
|---|---|---|---|
| [FamilyAlbum](https://apps.apple.com/us/app/familyalbum-share-baby-photos/id935672069) (watched, 24.5 s) | Opens full-bleed on a sleeping newborn; scrolls back through months with age labels ("Luna, 11 mos"); a single caption card at about 11 s; ends with Grandma's comment typed in live | Child's face as hook; time passing as the emotion; **grandparent reply as payoff**; only one caption | Flat blue title card breaks the warmth |
| [The Short Years](https://apps.apple.com/us/app/the-short-years-baby-book/id1327539226) (watched, 27 s, silent) | Serif wordmark → prompt card → answer typed → "Baby Books Made Simple" / "Heirloom quality books" cards | Warm single palette, serif caption cards, slow dissolves, prompt → artifact arc | 2 s logo intro; no payoff in first 3 s; real-world baby photo at end is borderline for Apple's rules |
| [Lumy](https://apps.apple.com/us/app/lumy/id908905093) (watched, Apple Design Award) | One continuous take, no cuts, loops seamlessly | Calm; perfect loop, so the poster frame always matches | Uncaptioned; only works when the UI explains itself |
| [Things 3](https://apps.apple.com/us/app/things-3/id904237743) (watched, Apple Design Award) | Unbroken real screen recording with human data ("Call Mom and Dad") | Real, specific-feeling data; polish is the pitch | Assumes brand awareness |
| [VSCO](https://apps.apple.com/us/app/vsco-photo-video-editor/id588013838) (watched) | Full-bleed photo with editorial caption → match cut to the UI that made it | **Match cut**: watercolor ↔ the memory it came from; book spread ↔ in-app memory | Uppercase-label style is too cool for us |
| [BeReal](https://apps.apple.com/us/app/bereal-photos-friends-daily/id1459645446) (watched) | Notification cold open; 2–4 word captions; live-typed reply; "Your memories saved" recap | Notification-style hook; typed replies; memories-recap ending | ~10 cuts per 15 s — far too fast for us |
| [BabyCenter](https://apps.apple.com/us/app/babycenter-pregnancy-tracker/id386022579) (watched) | Persistent caption over a phone mockup, 8 features | Legibility | Feature-list captions with no emotion |
| [Journey](https://apps.apple.com/us/app/journey-diary-journal/id1300202543) (watched) | Raw recording; passcode screen early; best part ("1 Year Ago") at about 22 s | — | **Anti-example**: payoff arrives after most people have left |
| Google "Loretta" ([post](https://blog.google/products-and-platforms/products/assistant/google-super-bowl-here-to-help/)) (inferred) | 90 s told only through screen UI and a real voice | Proof that **UI plus a real voice can make people cry**, with no people on screen | Too long for the store; save the idea for a brand film |
| Chrome "Dear Sophie" ([Vimeo](https://vimeo.com/112397313)) (inferred) | A father's emails to his daughter from birth, all on screen | Almost exactly Momora's idea told in UI; perfect for a web/social film later | — |

## 5. Video styles we can use

| # | Style | Fit for Momora | Use it for |
|---|---|---|---|
| 1 | **Emotional cold open → UI** (FamilyAlbum, BeReal) | ★★★ best | iPhone preview #1 (Storyboard A) |
| 2 | **Single continuous UI take with caption beats** (Lumy, Things) | ★★★ calmest, easiest to produce | Alternative #1 or a second preview (Storyboard B) |
| 3 | **Outcome first, then how** (VSCO match cuts) | ★★ | Camera roll → memory; illustration ↔ source (Storyboard C) |
| 4 | **Prompt → typed answer → artifact** (Short Years) | ★★ | The "things a photo missed" beat; the book beat on Play |
| 5 | **Story told only in UI** (Loretta, Dear Sophie) | ★★★ emotionally, but 60–90 s | Website/social brand film later, not the store |
| 6 | Kinetic type + UI (Structured) | ★ only if slowed right down | — |
| 7 | Captioned mockup feature list (BabyCenter) | ✗ no warmth | — |

## 6. House rules for our videos

- **Frame 0 is the ad.** A child's face or a playing sound card, plus one serif caption. No logo intro, no onboarding or permission screens.
- **Poster frame = our screenshot 01's promise.** Pick it deliberately, and don't repeat what screenshots 2–3 show next to it in search.
- **Muted-first.** Every beat carries a caption. For the voice feature, show the waveform moving plus the words as a caption; hearing the voice is a bonus.
- **Captions:** Newsreader serif, 2–5 words, top third, held at least 2 s, on the listing's lavender/cream/plum palette. Keep them clear of the bottom, where store UI overlaps.
- **Pacing:** 4–6 beats per 20 s. Dissolves and slow push-ins only, with no motion blur, 3D tilt or hype cuts.
- **UI presentation:** full-bleed real captures, allowed to scale to about 90% on a brand-color ground with rounded corners, no device frame and no hands. Touch hotspots (a soft pulse) show taps.
- **Real, specific data:** the Kim-Ortiz demo family (Maya, Theo, Ari; Nora; Grandpa Gabriel). Names, ages, grandparent comments.
- **Honesty:** show only shipped features in the submitted build (not Looking Back, and not the widget unless it's in 1.4.1). If the book appears, it's shown as optional. End card: "Subscription required." No prices, no "free trial" on Play.
- **Audio:** one soft, licensed instrumental score. A child's voice clip only if it's a **consented demo recording**, never customer audio and never a synthetic "child" voice.

## 7. Storyboards

### A. "Keep more than the photos" (recommended for iPhone, ~20 s)

| Time | Shot (real capture) | Caption (top) |
|---|---|---|
| 0.0–3.5 | **Poster/hook.** Timeline: the "uh-oh" sound card plays, the waveform fills, the photo card of the same lunch sits below | **Their little voice.** then, typed in: *"uh-oh!"* |
| 3.5–7.5 | Camera roll → the suggestion deck: a grouped moment with a drafted caption; soft tap on **Keep this** | **Start with the photos you have.** |
| 7.5–11.5 | Composer: a line is typed ("Theo asked me to take the shadow off his book…"), the AI illustration toggle is on → dissolve to the saved illustrated memory (the wait is cut) | **For the things a photo missed.** |
| 11.5–14.5 | Memory detail: the breakfast photo; Grandpa Gabriel's comment appears | **Just your family. Not a feed.** |
| 14.5–17.5 | Then & now: Maya's photo ↔ portrait at 5, 3 and 1, with a slow scroll | **Look how little they were.** |
| 17.5–20 | End card on lavender: momora wordmark, "Keep more than the photos." Small: *Subscription required.* | — |

Why: it opens on the one thing screenshots can't do (sound and motion), follows the screenshot story in order, and ends on the most emotional feature.

### B. "A year of them" (one continuous take, ~20 s)

A single slow, eased scroll up the timeline through a year of one family's memories (photo, voice card playing, illustration, typed story, grandparent comment), ending on Then & now for Maya. The captions change every 4 s: **Every photo… / every funny thing they said… / their little voice… / for each child. / Look how little they were.** End card as in A.
Why: it's the calmest and most "Lumy/Things"-premium option, and it only needs one capture, so it's the cheapest to produce. Risk: it explains less (no camera-roll import beat).

### C. "Your camera roll. Their stories." (outcome first, ~20 s)

It opens on the finished memory card (photo, caption, emotion chip), then match-cuts back to the raw camera-roll grid and shows how that memory got there: grouped, caption drafted, Keep. Then comes a quick montage of the timeline filling up, and it ends on a voice card and the end card.
Why: it directly answers "I have 30,000 photos" (the strongest pain point for dads and camera-roll-overwhelmed parents in the voice-of-customer research) and pairs with opener C1. Best as preview #2 or a PPO challenger.

### Play promo (~30 s, portrait 1080×1920)

Storyboard A plus two beats before the end card:
- **17.5–22** Memory Books shelf (real capture) → slow dissolve to the layflat spread (our rendered page art; the only non-app shot, well within Google's ≥80% real-footage guidance). Caption: **And a book to hold, too.** Small: *Printed books are optional and sold separately.*
- **22–26** Then & now (moved from A).
- **26–30** End card: "Momora: Baby Book & Album", *Subscription required.* The feature graphic serves as the cover.

## 8. What we need to capture (Maestro-scripted, iOS simulator, demo family)

1. Timeline with the "uh-oh" sound card playing (the demo family must have an audio memory, plus a consented voice clip for the sound-on version).
2. The gallery-import deck with a real suggestion, then Keep. The simulator photo library has to be seeded with the demo photos.
3. Composer: typing the shadow line, AI illustration on, save → the illustrated memory once it's ready (the wait is cut).
4. Memory detail for the breakfast photo, with the comments in place.
5. Then & now for Maya.
6. (Play) the Memory Books shelf.

Captures at 1320×2868 (6.9" simulator), 60 fps, downscaled to 886×1920 at 30 fps in HyperFrames. Needs the demo account signed in (owner enters the OTP). Recording is read-only; the composer beat creates one new memory, which we delete afterwards (or do on a scratch child).

## 9. Test plan

1. Upload the iPhone preview and run **PPO**: control (screenshots only) vs treatment (preview + same screenshots), 50/50, up to 90 days or until significant.
2. Pick the poster frame deliberately (hook frame at about 1 s), and treat the poster as its own test variable later.
3. On Play, the video can't be A/B tested, so ship it once the iOS test is positive.

## 10. Decisions needed from the owner

1. Storyboard A, B or C for the iPhone preview? (Recommendation: **A**, with C as a later challenger.)
2. Voice clip audio: do we have a consented recording (e.g. your own child, with your consent) for the sound-on moment, or should it be music only?
3. Music: OK to use a royalty-free instrumental from HyperFrames' media library (licensed for all territories)?
4. Signing in to the demo family in the simulator (OTP) for the capture session: when works?
