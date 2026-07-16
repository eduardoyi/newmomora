# Feature documentation

Per-feature docs for **AI agents and developers** building on or extending Momora. Read relevant feature docs **before** modifying or integrating with that area.

## When to write a feature doc

Create or update a doc in `docs/features/` when you ship a **major feature**:

| Qualifies | Does not qualify |
|-----------|------------------|
| New user-facing flow (auth, onboarding, journaling, voice) | Copy tweaks, styling-only changes |
| New Edge Function or AI pipeline | One-line bug fixes |
| New DB tables/columns with app behavior | Internal refactors with no behavior change |
| Cross-cutting capability (notifications, account deletion) | Test-only or tooling-only changes |

**Rule:** If another agent would need to read code across 3+ files to understand how to use or extend it, it needs a feature doc.

## When to update

- **Same PR** as the feature implementation (not a follow-up).
- When contracts, flows, or extension points change.
- Mark status: `planned` → `in-progress` → `done`.

## File naming

- `kebab-case.md` matching the feature domain: `voice-journaling.md`, `memory-illustrations.md`
- One feature per file; split if a domain grows too large (>300 lines).

## Index

| Feature | Doc | Status |
|---------|-----|--------|
| Auth | [auth.md](./auth.md) | done |
| Family sharing | [family-sharing.md](./family-sharing.md) | done |
| Family profiles | [family-profiles.md](./family-profiles.md) | done |
| Portrait timeline | [portrait-timeline.md](./portrait-timeline.md) | done |
| Memories & illustrations | [memories.md](./memories.md) | done |
| Media memories (photo & video) | [media-memories.md](./media-memories.md) | done |
| Calendar ribbon | [calendar.md](./calendar.md) | done |
| Inline links in memory text | [inline-links.md](./inline-links.md) | done |
| Likes & comments | [likes-and-comments.md](./likes-and-comments.md) | done |
| Voice journaling | [voice-journaling.md](./voice-journaling.md) | done |

## Template

Copy [\_template.md](./_template.md) when adding a new feature doc.

## Relationship to other docs

| Doc | Purpose |
|-----|---------|
| [PRD.md](../PRD.md) | **What** we build and why (product) |
| [TECH_SPEC.md](../TECH_SPEC.md) | **System** architecture, schema, API contracts |
| [TESTING.md](../TESTING.md) | **Test** strategy — unit, integration, e2e requirements |
| `docs/features/*.md` | **How** each feature works — flows, files, extension points, test inventory |

TECH_SPEC holds canonical API shapes; feature docs explain behavior, integration, and how to build on top.

## For AI agents

1. **Before building on a feature:** Read its `docs/features/<name>.md` + TECH_SPEC + TESTING.
2. **After shipping a major feature:** Add feature doc + **unit, integration, and e2e tests** in the same PR.
3. **When unsure:** Check this index; if missing, read the code and add the doc before extending.
