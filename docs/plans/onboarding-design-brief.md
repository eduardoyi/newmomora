# Onboarding — Screen-by-Screen Design Brief

**For:** Claude Design handoff (mockups only, no code)
**Spec:** [docs/features/onboarding.md](../features/onboarding.md) has decisions, rationale, and routing; this doc is layout + copy.
**Tone reference:** https://usemomora.com/ (the copy below must sound like the site: tired-parent humor, self-deprecation, permission-giving, specific over general)
**Last updated:** 2026-07-23

## Global design direction

- **Design system:** Anchor Journal. Background `#FAFAFD`, primary pink `#D63E78`, lavender/purple undertones. Newsreader (display serif) for headlines, Plus Jakarta Sans for body/UI, Caveat (script) for handwritten accents. Emotion colors (joy, calm, wonder, tender, mischief) available for illustration backgrounds.
- **Register:** tired parent talking to tired parent. Funny, self-deprecating, warm. Guilt gets defused with humor, never amplified. If a line could appear in a sappy Mother's Day ad, cut it.
- **Component reuse:** onboarding must feel like the app it leads into. Reuse existing components wherever a screen has an in-app sibling: the capture screen borrows from `new-memory.tsx` (big serif textarea, bottom toolbar, type pill) and the voice-journaling recorder; the aha page IS a QuoteCard/SpreadCard from `memory-card.tsx`; the like-heart pop animation from likes-and-comments appears on S10. New visual inventions only where no app equivalent exists (story beats, trust screens, paywall).
- **Illustration:** Momora's own illustration style throughout. The onboarding is itself a demo of the artifact.
- **Affirmation CTAs:** story-screen buttons are statements the user agrees with, not "Next" or "Continue". Every CTA label below is deliberate copy. Vary them, never repeat.
- **Progress:** subtle dots or nothing. No percentage bars, no step counters ("3 of 14" reads as homework).
- **Forbidden:** countdowns, urgency badges, red/failure states, streak imagery, "limited time," discount wheels, stock-photo humans, em dashes in any copy.
- **Copy rules:** words from [voice-of-customer.md §6](../voice-of-customer.md): "the little things," "boring stuff," "it goes so fast," "quick," "no pressure." Never "preserve," "document," "keepsake," "legacy," "capture more." Be concrete: every number must say what it measures ("20 seconds of your evening," not "20 seconds").
- **Tokens:** `{name}` = child's first name (available from S7 onward). `{family}` = family name.

---

## Owner path

### S0 — Welcome / fork

**Job:** entry routing. (Only renders when no session exists; see spec step 0.)
**Layout:** full-bleed warm illustration (parent and small child, quiet moment, e.g. reading in lamplight), wordmark top. Three stacked actions bottom.

> **Headline (Newsreader):** Save the funny little things, before your brain deletes them.
> **Sub:** A journal made by tired parents, for tired parents. No blank pages, no homework.
>
> **Primary CTA:** Start your family's journal
> **Secondary CTA:** I have an invite
> **Tertiary (quiet text link):** I already have an account · Log in

---

### S1 — Story beat 1: the 2 a.m. scroll

**Job:** commitment (affirmation) + recognition.
**Layout:** dark-tinted illustration, phone glow on a parent's face at night, child asleep in the next room. Text below.

> **Headline:** You know the 2 a.m. scroll.
> **Body:** "Just checking the monitor," you say, forty minutes deep into photos from March. It's fine. No judgment. We do it too.
>
> **CTA (affirmation):** That's me

---

### S2 — Story beat 2: the baby book

**Job:** commitment + recognition (defuses guilt with humor).
**Layout:** soft illustration, a baby book shut on a closet shelf. Warm light, a little funny (dust motes, a sock on top of it), not sad.

> **Headline:** The baby book stops at month six.
> **Body:** Ours stopped at four. Turns out "fill this out nightly" was a big ask during the no-sleep years.
>
> **CTA (affirmation):** Who approved that homework

---

### S3 — Story beat 3: the stuff that actually goes

**Job:** commitment + recognition (names the real fear, keeps it light).
**Layout:** bright, tender illustration, a toddler mid-babble, made-up words floating as little Caveat doodles.

> **Headline:** The camera caught the first steps.
> **Body:** Nobody caught the word she invented for helicopter. That's the stuff that goes, and 20,000 photos won't bring it back.
>
> **CTA (affirmation):** That's the stuff I want to keep

---

### S4 — Founder intro A

**Job:** social proof (unfakeable, placed after recognition per spec decision 14).
**Layout:** illustrated portrait of Eduardo & Adriana, Momora style, hand-drawn warmth. Caveat caption under portrait.

> **Caveat caption under portrait:** made by tired parents, for tired parents
> **Headline:** We're Eduardo & Adriana.
> **Body:** Two kids. Thousands of photos. A baby book that stops at month four (see above).
>
> **CTA:** Sounds familiar

---

### S5 — Founder intro B: the artifact demo

**Job:** social proof + product demo (shows the illustration style without generating anything).
**Layout:** THE money screen visually. 2 or 3 real illustrated memory pages from our kids, fanned like pages of a book, gently animated. This sets the quality bar for what the user's trial will produce. Assets must be current-pipeline quality.

> **Headline:** So we built this for our own kids.
> **Body:** Things we mumbled into our phones at 9 p.m., turned into pages like these.
> **Caveat caption on one page:** jotted in 20 seconds, kept forever
>
> **CTA:** Show me how it works

---

### S6 — Child's name

**Job:** personalization + the highest-value commitment (spec decision 8). The ONLY typed field before capture.
**Layout:** single centered input, big Newsreader entry text. Keyboard opens immediately. Small warm illustration behind, not competing with the input.

> **Headline:** Who's this journal for?
> **Input placeholder:** Their first name
> **Helper (small):** Nicknames welcome. Siblings can pile in later.
>
> **CTA:** Continue

**Note:** from here on, every headline that can carry `{name}` should.

---

### S7 — Family name

**Job:** light commitment; needed for tenancy. One tap, zero typing.
**Layout:** pre-filled editable field. Default is **"{name}'s Family"** (we don't know a surname yet; auth comes later). Small illustrated nest/house motif.

> **Headline:** {name}'s stories need a home.
> **Pre-filled input:** {name}'s Family *(editable, e.g. to "The Rivera Family")*
>
> **CTA (affirmation):** That's us

---

### S8 — Bridge to action

**Job:** the reframe + setup for the aha.
**Layout:** minimal, lots of air, one Caveat line as the emotional anchor.

> **Headline:** You're not behind. There is no behind.
> **Body:** {name}'s journal starts with one little thing from this week. Silly counts. Boring counts double.
> **Caveat accent line:** no blank pages here
>
> **CTA:** Start with tonight

---

### S9 — Guided first capture

**Job:** THE AHA SETUP. A real product action that feels lighter than opening the camera app.
**Layout:** slimmed-down sibling of the in-app `new-memory.tsx` screen: same big serif textarea, same bottom toolbar and type pill, same voice-recorder component from voice journaling. Voice-first: large friendly record button (primary pink) with the prompt above. "Type instead" and "Add a photo" clearly secondary. This is a real TextInput screen: keyboard must never cover the input or the save action (hard project rule).

> **Prompt (Newsreader):** What's something small {name} did this week that made you smile?
> **Primary control:** ● Tap and talk. Label: *Say it like you'd text your best friend*
> **Secondary:** ⌨ I'd rather type
> **Tertiary:** ＋ Add a photo or video *(optional)*
> **Reassurance (small):** Twenty seconds of rambling is plenty. Grammar optional.

**States to design:** recording (soft waveform, no countdown timer), transcribing (brief), typed-entry variant, photo-attached variant.

---

### S10 — The aha: their first page

**Job:** the value moment. Their words, instantly beautiful.
**Layout:** the captured memory rendered with the actual `memory-card.tsx` components: QuoteCard for text-only (italic Newsreader serif, watermark quote), SpreadCard if a photo was added. Date stamp, {name}'s name, emotion-tinted background. The page is 90% of the screen.
**Animation:** page settles in (laying down on a desk), then the like-heart on the card fills with the same pop animation used in the app's likes feature. One beat of delight, not a fireworks show.

> **Eyebrow (small, above the page):** That cost you about 20 seconds of your evening.
> **Below the page:** {name}'s first page. Imagine a year of these.
>
> **CTA:** Keep it going

---

### S11 — Notification question (embedded permission)

**Job:** permission, embedded in a question that configures it (spec decision 12). Honest purpose: capture reminders. The OS prompt fires AFTER a choice here, confirming it.
**Layout:** question with 4 tappable option cards, illustrated glyphs per option.

> **Headline:** When do the little moments usually hit you?
> **Options:**
> - 🌙 Evenings, once they're finally asleep
> - ☕️ Weekend mornings
> - ✨ Random. Surprise me now and then
> - 🙅 No reminders. I'll show up on my own
> **Reassurance (small):** Gentle nudges only. Never a notification that starts with "Don't forget…"

**Behavior note:** first three options trigger the OS permission prompt immediately (it now reads as confirming their choice). Fourth option skips the OS prompt entirely, no penalty, no re-ask this session.

---

### S12 — Account (email OTP)

**Job:** protect the aha; the routing gate fires after this (spec decisions 17 and 18).
**Layout:** two sub-screens. A: email entry, with a small thumbnail of the memory they just made (the thing being kept safe). B: 6-digit code entry, large boxes, auto-advance.

> **A — Headline:** Let's put {name}'s first memory somewhere safe.
> **A — Body:** Email in, code back. No passwords, ever.
> **A — Input placeholder:** you@email.com
> **A — CTA:** Send my code
> **A — Reassurance (small):** The memory is already saved on this phone either way.
>
> **B — Headline:** Check your inbox.
> **B — Body:** We sent a 6-digit code to {email}.
> **B — Quiet link:** Resend code

**Behavior note:** the app will background (user checks mail); captured memory and flow position must survive the round trip. Post-auth, returning users may be routed out of onboarding entirely (see spec routing table); design only the happy new-user path here.

---

### S13 — Trust screen A: the trial timeline

**Job:** kill bill-shock fear before the paywall (spec decision 13).
**Layout:** vertical timeline graphic, 3 nodes, friendly icons. No prices on this screen.

> **Headline:** Try everything free for 7 days.
> **Timeline:**
> - **Today** · Full access. You pay $0.00 today.
> - **Day 5** · We remind you the trial is ending. Email and notification. No surprises.
> - **Day 7** · Only then does the subscription start. Cancelling takes about 10 seconds, we timed it.
>
> **CTA:** Sounds fair

---

### S14 — Trust screen B: what's included + the promise

**Job:** what unlocks + the export-is-always-yours line (spec decisions 4 and 13).
**Layout:** short checklist; the promise gets its own visually distinct block (bordered card, Caveat flourish). It should look like a signed promise, not a bullet point.

> **Headline:** Everything {name}'s journal comes with:
> - Unlimited memories: talk, type, photos, video
> - {name}'s illustrated portrait and storybook pages
> - The whole family can join, grandparents included, free
> - Every memory searchable, finally out of the camera roll
>
> **The promise (distinct card):**
> **Your memories are always yours.** Export everything, free, whenever you want, even if you cancel someday. We've been burned by those apps too.
>
> **CTA:** Almost done

---

### S15 — Paywall

**Job:** the decision. Hard paywall, trial-or-exit (spec decisions 1 to 3, 16).
**Layout:** founder-family illustrated pages as backdrop/carousel (reuse S5 assets plus 1 or 2 new ones). Single plan card. Restated trust bullets. Close affordance (X) present but quiet; on close, a simple confirm sheet, no discount wheel, no guilt character.

> **Headline:** Turn {name}'s little moments into something you'll hold forever.
> **Plan card:** 7 days free, then $XX.99/year *(that's $X.XX/month; price TBD)*
> **Under card:** $0.00 today · Reminder before your trial ends · Cancelling takes about 10 seconds · Your memories export free, forever
>
> **CTA:** Start my free week
> **On X/close (confirm sheet):** "Leave {name}'s first page here for now? It'll be waiting if you come back." · **Buttons:** Stay / Leave

**Compliance note:** trial terms in plain sight, no toggle tricks (Apple rejects these as of early 2026). Standard restore-purchases plus terms/privacy links, small, bottom.

---

### S16 — In-trial, immediately after: portrait kickoff *(technically post-onboarding; design with the set)*

**Job:** start the first delight (background generation), collect the photo with the right framing.
**Layout:** photo picker moment, framed as making something, not filling a form field.

> **Headline:** Let's make {name}'s portrait.
> **Body:** Pick a photo you love. We'll illustrate {name} in Momora's style.
> **CTA:** Choose a photo
> **After selection:** We're painting. It takes a few minutes, so go do literally anything else. It'll be here when you get back.

*(then the user lands in the journal, memory #1 already there)*

---

## Join path (invited managers/viewers)

Tone shift: the joiner didn't choose the product, a family member chose *them*. Zero selling, zero persona story, warm and fast. All typing happens before the OTP round trip, so after auth they land straight in the family (or the wait state) with nothing left to do.

### J1 — Invite code entry

**Layout:** single input for the word-code. Reached via deep link (pre-filled, skips to J2) or manually via the fork's "I have an invite" (the common case: the link got lost during App Store install, so the code must be comfortably typeable).

> **Headline:** Someone saved you a seat.
> **Body:** Type your invite code. It's a few words, like `sunny-otter-lake`. Whoever invited you has it.
> **Input placeholder:** your-invite-code
> **CTA:** Find my family

---

### J2 — Family found

**Layout:** family name plus a small cluster of illustrated member portraits (whatever exists). A confirmation, not a pitch.

> **Headline:** Join {family}?
> **Body:** {inviter-name} invited you to see and share the family's memories.
> **CTA:** Yes, that's my family
> **Quiet link:** Wrong family? Re-enter code

---

### J3 — Display name

**Layout:** single input. Deliberately before auth: it's the fun, easy question, and it means the OTP trip is the last step.

> **Headline:** What should the family call you?
> **Input placeholder:** Grandma Ana, Uncle Rob, Dad…
> **Helper:** This shows up next to your comments and memories.
> **CTA:** That's me

---

### J4 — Account (email OTP)

Same component as S12, different framing:

> **Headline:** Last step, promise.
> **Body:** Email in, code back. No passwords, ever.

---

### J5 — Approval wait state *(only if the owner hasn't pre-approved)*

**Layout:** calm, illustrated waiting moment (a door with warm light under it). This screen may sit for hours; it must feel fine, not broken.

> **Headline:** One sec. {owner-name} just needs to wave you in.
> **Body:** We told them you're here. You'll get a ping the moment you're in.
> **Quiet link:** Give them a nudge

---

## Asset checklist for this design pass

1. Welcome illustration (S0) · 3 story-beat illustrations (S1 to S3): night scroll, shut baby book with a sock on it, babbling toddler
2. Founder portrait illustration (S4): needs a real generation of Eduardo & Adriana
3. 3 to 5 real illustrated memory pages of the founders' kids (S5, S15): current-pipeline quality, this is the quality promise
4. Small motifs: nest/house (S7), door with light (J5), option glyphs (S11)
5. The rendered first-page templates (S10): QuoteCard and SpreadCard variants already exist in `memory-card.tsx`
6. Like-heart fill/pop animation (S10): already exists in the likes feature, reuse the exact curve

## Open items (don't block design)

- Final annual price (paywall shows `$XX.99` placeholder)
- Whether S11's OS prompt needs a pre-prompt interstitial on Android (design iOS-first)
- Lapsed-owner resubscribe screen: separate mini-brief later; reuses S15 minus trial framing, archive stays visible behind it
