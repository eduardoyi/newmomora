# Momora — .agents index

This folder holds agent skills and cross-tool references.

**Canonical instructions:** [../AGENTS.md](../AGENTS.md)

## Skills

| Skill | Path | Use when |
|-------|------|----------|
| Momora development | [skills/momora-development/SKILL.md](skills/momora-development/SKILL.md) | Building features, fixing bugs, schema or AI pipeline work |

## Tool mapping

| Tool | Entry point |
|------|-------------|
| **Cursor** | `.cursor/rules/*.mdc` + this repo's `AGENTS.md` |
| **Codex** | Root `AGENTS.md` (auto-discovered); nested `app/AGENTS.md`, `supabase/AGENTS.md` |
| **Claude Code** | `CLAUDE.md` → `AGENTS.md` |

## Docs (source of truth)

- [docs/PRD.md](../docs/PRD.md)
- [docs/TECH_SPEC.md](../docs/TECH_SPEC.md)
- [docs/TESTING.md](../docs/TESTING.md)
- [docs/features/](../docs/features/) — **per-feature docs** (read before extending; write when shipping)
