# Memory Book — Everything Phase 2d (dogfood round 3 feedback + known defects)

Status: approved 2026-10-01 (owner). Parent: memory-book-everything-phase2b.md, phase2.md.

Round 3 (Enzo c880ecf3: 102 kept, chapter keep-rates .167–.173; Mara 1e504065:
114 kept, .354/.359; 0 lost photos) met the balance/capacity goals. Owner feedback:

1. **Birthday titles over multi-month sections.** "El mes en que cumpliste dos
   años" heads an "agosto–octubre 2024" quarter section. Rule: a birthday-flagged
   section spanning >1 month must use period wording ("Cuando cumpliste dos años"
   / "When you turned two"); "El mes en que cumpliste…" only for a true
   single-month section. Applies to the multi-year prompt instruction, the
   birthday FLAGGED marker text in the user prompt, and any deterministic
   special-title code (find where birth/birthday special titles are produced).
2. **Text-only pages still too plain** (owner screenshot: the pooled
   quote-collection spread — small type, 2 mostly-empty pages for 3 quotes).
   Redesign quote-collection + the pull-quote text page into designed pages:
   a section title for pooled quotes ("Cosas que dijiste" / "Things you said",
   editable via existing sectionTitle edits if feasible), much larger type,
   lavender quote glyph per quote, balanced vertical rhythm filling the page,
   1–3 quotes on ONE page (spread only when more), text verbatim. Owner sees
   print rasters BEFORE deploy.
3. **Known defects (owner: fix them)** — ALL books:
   a. `geometric-overlap`: a tall solo photo beside a section header overlaps it
      (Enzo round 3: pages backbone:2023-07_2023-08_2023-09:0:minsize-a and
      backbone:2025-11_2025-12_2026-01:0).
   b. fitter `runFit` has no `case 'birthday'`: worker `birthday-N` elements
      (year books, ≥3 memories with the same birthday milestone) are silently
      never laid out. The WP-0 golden pins this defect on purpose.
   c. worker emits `firstsWarmNames` on the firsts element, fitter reads
      `firstsEntries` → AI warm names never reach the renderer. Fix in the
      fitter by accepting the stored key (fixes existing books too).
   d. `illustrated-stack-overflow`: a long illustrated story with a section
      header overflows when parity blocks the split.

Goldens: 2 and 3 change year-book output deliberately; implementers never run
`vitest -u`; orchestrator reviews and updates once. Worker golden: 1 is
Everything-only — must stay green except deliberate, explained prompt-hash rows.
