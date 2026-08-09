# Looking Back design handoff

This directory contains the approved Claude Design handoff for the Looking
Back feature. It is a visual and interaction specification, not production
React Native code.

| Field | Value |
| --- | --- |
| Original file | `Momora screens-handoff (1).zip` |
| Export date | 2026-08-08 |
| SHA-256 | `7866b61a9f1860db9329b86cb4b29bd303cd1ce9db48c973f85b48c196b1487c` |
| Primary file | `momora-screens/project/Momora screens.html` |
| Resolved rail | `src/screens/rediscover-rail.jsx` — warm plate |
| Resolved viewer | `src/screens/story-viewer.jsx` |

## Required artboards

- `lb-live`, `lb-timeline`, `lb-cover-c`, `lb-states`, `lb-cover-text`,
  `lb-absent`, `lb-notes`
- Every `v-*` viewer artboard

## Visual acceptance checklist

- Timeline rail: resolved warm-plate cards, text-only plate, viewed lavender
  veil, no rail when empty, native horizontal snap and exact edge spacing.
- Viewer: warm dark mat, title card, equal-width slide progress, media and
  text frames, hold pause, unavailable media, completion and replay.
- Product-approved deviation (2026-08-08): progress segments have equal visual
  width per slide even when dwell durations differ.
- Product-approved deviation (2026-08-08): the title card waits for an explicit
  cream **Start** button instead of auto-advancing or showing the prototype's
  tap/hold instruction. Starting enters the first memory unpaused.
- Product-approved reliability treatment (2026-08-08): photos may retry and
  switch between preview/original without changing the fitted surface; videos
  retain a first-frame poster with a loading/video indicator until playback is
  visibly ready.
- Native platform changes may use platform fonts/icons only where necessary;
  any visible deviation needs before/after review before release.
