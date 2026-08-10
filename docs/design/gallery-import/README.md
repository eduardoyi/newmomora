# Gallery import design authority

The Claude design handoff in
[`claude-gallery-import-handoff.zip`](./claude-gallery-import-handoff.zip) is
the visual and interaction source of truth for gallery import. Its SHA-256 is:

```text
5bbdff88b96248736c18422baa84de819cc93789a2fab161fa54dc9b1d33c9fe
```

Implementations must preserve the handoff's composition, hierarchy, tone,
motion intent, platform-specific navigation, accessible non-gesture actions,
and complete state coverage. Translate the web prototype into Momora's React
Native components and live theme/safe-area/keyboard primitives; do not copy
hard-coded browser frame dimensions or simulated OS permission dialogs.

## Approved implementation clarifications

These decisions resolve contradictions between the prototype, its notes, and
`docs/plans/gallery-import.md`:

- The review deck is read-only and asks only **Keep** or **Set aside**. Photo,
  caption, date, and tag editing happens in the existing-style memory composer.
- Imported memories have one caption/content field and no separate title.
- Skipped suggestions are never intentionally resurfaced. Permanent receipts
  provide best-effort suppression across runs without storing raw photo IDs or
  privacy-sensitive visual fingerprints; an OS/reinstall identifier change can
  prevent recognition and must not be hidden in technical documentation.
- A family receives two initial device-bound runs during the first 30 days,
  with at most one active run at a time. Normal measured monthly admission
  applies afterward.
- Photo access is snapshotted before a run starts. Photos granted later are
  eligible for a later run, not silently added to the active corpus.
- Videos are not suggested in v1; the UI says "Momora suggests photos only for
  now" wherever their absence could otherwise look accidental.
- Candidate emotions are never shown. A validated curation emotion may be
  attached only when the memory is committed, avoiding a duplicate AI call.
- Persistent `gallery_import` provenance is stored for operations and retention
  questions but never displayed as a badge, label, or filter.
- Caption language/instruction settings autosave with visible saved/error
  feedback. Language choices come from the shared production locale registry,
  not the prototype's illustrative subset.
- Viewers see no entry points except the explanatory disabled Settings row.
- Cross-device copy is generic and exposes neither preview content, device name,
  nor exact candidate count.
- "Safe to close" copy means checkpointed resume. It must not claim foreground
  scanning, Wi-Fi waiting, local normalization, or cloud-original downloads
  continue after the process is killed.
- Run ceilings are server-provided. The prototype's `18` is fixture data, not a
  production constant.

When the handoff and plan disagree after these clarifications, update the plan
or feature documentation explicitly rather than silently drifting from the
design.
