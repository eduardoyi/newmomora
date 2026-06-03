# Codex — Momora

OpenAI Codex reads **`AGENTS.md` from the repository root** automatically (walks from git root to cwd). No separate config required in this folder.

## Files Codex loads

1. `~/.codex/AGENTS.md` — your global preferences (optional)
2. `./AGENTS.md` — project-wide Momora instructions
3. `./app/AGENTS.md` — when working under `app/`
4. `./supabase/AGENTS.md` — when working under `supabase/`

## Optional global config

In `~/.codex/config.toml`, you can add fallback doc names:

```toml
project_doc_fallback_filenames = ["CLAUDE.md"]
```

## Start here

Read [../AGENTS.md](../AGENTS.md) and [../docs/TECH_SPEC.md](../docs/TECH_SPEC.md).
