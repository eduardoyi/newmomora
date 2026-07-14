# Supabase — Momora backend

Parent instructions: [../AGENTS.md](../AGENTS.md) · Contracts: [../docs/TECH_SPEC.md](../docs/TECH_SPEC.md)

## Tables

`user_profiles` · `family_members` · `memories` · `memory_family_members`

## Function checklist (new or changed)

- [ ] JWT validated (or cron secret for schedulers)
- [ ] User ownership verified before read/write
- [ ] Status column updated (`generating` during work)
- [ ] Errors return structured JSON
- [ ] TECH_SPEC §4 updated if contract changed
- [ ] Feature doc updated in `docs/features/` if behavior or extension points changed
- [ ] Deno tests added/updated for function behavior
- [ ] `npm run test:edge` passes for touched functions
- [ ] Storage cleanup on regeneration/delete

## Cron jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `schedule-daily-reminders` | Hourly | Match user local time → push |
| `hard-delete-expired-accounts` | Daily | Purge past 15-day grace |

Both require `CRON_SECRET` header validation.

## Local dev

```bash
supabase start
supabase functions serve --env-file supabase/.env.local
supabase db reset   # applies migrations
```

Never commit `supabase/.env.local`, service role keys, or R2 credentials.

## R2 storage (not Supabase Storage)

| R2 bucket | Purpose |
|-----------|---------|
| `momora-profile-pictures` | User-uploaded photos |
| `momora-character-portraits` | AI portraits |
| `momora-memory-illustrations` | AI memory art |
| `momora-public-assets` | Style reference PNGs |

- DB stores object **keys** (`profile_picture_key`, `illustration_key`, …).
- `_shared/r2.ts` for S3 API; `get-upload-url` / `get-media-url` for client.
- Validate `{auth.uid()}/` prefix before presigning.
- See [docs/COST_OPTIMIZATION.md](../docs/COST_OPTIMIZATION.md).

## Security

- RLS on every table (Postgres — not R2 RLS)
- JWT on user-facing functions; `CRON_SECRET` on schedulers
- OpenAI key from `Deno.env.get('OPENAI_API_KEY')` only
- Never log memory content, transcripts, or audio
- Validate inputs server-side (max 6 tags for illustrated memories, voice duration)
