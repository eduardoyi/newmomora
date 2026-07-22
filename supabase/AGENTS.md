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

Momora uses one **private** R2 bucket from `R2_BUCKET` (production:
`momora-prod`) for all family-owned uploads. Object keys, not bucket names,
distinguish profile photos, portrait versions, media, and memory
illustrations. The three old `momora-profile-pictures`,
`momora-character-portraits`, and `momora-memory-illustrations` buckets do
not exist and must not be introduced in code or deployment bindings.

- DB stores object **keys** (`profile_picture_key`, `illustration_key`, …).
- `_shared/r2.ts` uses the single `R2_BUCKET` S3 binding; `get-upload-url` /
  `get-media-url` issue private presigned URLs.
- Validate `{auth.uid()}/` prefix before presigning.
- Style reference PNGs are a separate small public-assets concern, fetched
  from `R2_PUBLIC_ASSETS_BASE_URL` as documented in TECH_SPEC; they are not
  family content and are not served through the private bucket helper.
- See [docs/COST_OPTIMIZATION.md](../docs/COST_OPTIMIZATION.md).

## Security

- RLS on every table (Postgres — not R2 RLS)
- JWT on user-facing functions; `CRON_SECRET` on schedulers
- OpenAI key from `Deno.env.get('OPENAI_API_KEY')` only
- Never log memory content, transcripts, or audio
- Validate inputs server-side (max 6 tags for illustrated memories, voice duration)
