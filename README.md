# Momora

Parent memory journal — capture moments in text or voice, revisit through AI-generated family character illustrations.

## Docs

- [Product Requirements (PRD)](docs/PRD.md)
- [Technical Specification](docs/TECH_SPEC.md)
- [Cost Optimization](docs/COST_OPTIMIZATION.md) — R2 vs Supabase Storage, OpenAI costs
- [Testing Strategy](docs/TESTING.md) — unit, integration, e2e required with features
- [Feature docs](docs/features/) — per-feature guides for agents (required for major features)

## Agent instructions

| Tool | Start here |
|------|------------|
| **All agents** | [AGENTS.md](AGENTS.md) |
| **Cursor** | `.cursor/rules/` |
| **Claude Code** | [CLAUDE.md](CLAUDE.md) |
| **Codex** | [AGENTS.md](AGENTS.md) (auto-loaded) |

## Stack

Expo SDK 56 · Supabase · OpenAI (transcription, emotion, illustrations)

## Status

Foundation scaffolded — Supabase project linked, schema migrated, Expo SDK 56 app with auth shell.

```bash
npm install
npm start          # Expo dev client
npm run typecheck
npm test
```

Copy [`.env.example`](.env.example) to `.env.local` (already done if you have Supabase keys there).

Supabase project: **Momora** (`uglhonlaqkqvxcqudwlk`) in **eduardoyi89 Org**.

## Security

- Never commit `.env.local`, API keys, or keystores — see [AGENTS.md § Security](AGENTS.md#security--secrets-required-reading)
- Copy [`.env.example`](.env.example) and [`supabase/.env.example`](supabase/.env.example) for local setup
