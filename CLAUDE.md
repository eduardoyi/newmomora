# Claude Code — Momora

This project uses shared agent instructions. **Read [AGENTS.md](AGENTS.md) first** — it is the canonical guide for architecture, conventions, and MVP scope.

## Quick context

- **Product:** Parent memory journal with AI family character illustrations
- **Docs:** [docs/PRD.md](docs/PRD.md) · [docs/TECH_SPEC.md](docs/TECH_SPEC.md) · [docs/TESTING.md](docs/TESTING.md) · [docs/features/](docs/features/)
- **Stack:** Expo SDK 56 + Supabase + OpenAI Edge Functions

## Claude-specific workflow

1. **Before coding:** Read AGENTS.md + relevant nested `AGENTS.md` (`app/` or `supabase/`) + `docs/features/<feature>.md` if extending existing work.
2. **Scope:** MVP only — see PRD §7 out-of-scope list. Ask before expanding.
3. **Changes:** Prefer minimal diffs; match existing patterns in the file you're editing.
4. **Schema/API changes:** Update migration + regenerate types + TECH_SPEC in the same change.
5. **Major features:** Add/update `docs/features/<name>.md` in the same PR — include how future agents should extend it.
6. **Tests:** Unit + integration in same PR; Maestro e2e for user-facing flows — see [docs/TESTING.md](docs/TESTING.md).
7. **Verify:** Run `npm test`, typecheck/lint when available; don't claim success without running commands.

## High-risk areas (extra care)

- **Secrets:** Never commit `.env*` or API keys. OpenAI/service role keys only in Edge Function secrets.
- RLS policies and storage bucket permissions
- Edge Function auth (JWT vs cron secret)
- Voice pipeline — no audio persistence
- AI async flows — text saves first, illustration status tracked separately
- Child/family PII — no logging of memory content
- Mobile keyboard UX — any `TextInput` in a screen, modal, bottom sheet, or drawer must stay visible and keep primary actions reachable when the keyboard opens

## Security checklist (before commit)

- [ ] No `.env.local` or keys in staged files
- [ ] No `EXPO_PUBLIC_` prefix on secret values
- [ ] `git diff` scanned for `sk-`, `eyJ`, `service_role`

## Project skills

- `.claude/skills/momora/SKILL.md` — Momora development workflows
- `.agents/skills/momora-development/SKILL.md` — shared skill (same content)

## When stuck

Check TECH_SPEC for Edge Function contracts and schema. Check `docs/features/` before extending an existing capability.
