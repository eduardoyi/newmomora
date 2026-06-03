# Momora — Agent Instructions

Memory journal for parents. Capture moments in text or voice; AI generates consistent family character illustrations.

**Read first:** [docs/PRD.md](docs/PRD.md) (product) · [docs/TECH_SPEC.md](docs/TECH_SPEC.md) (architecture)

---

## Product constraints (MVP)

- **Capture first:** Memory text must save even if AI fails.
- **Child-first onboarding:** Nudge adding a child first; one family member required before journaling.
- **Plain text memories** — no rich text in MVP.
- **Max 4 tagged family members** per memory (enforce in UI + backend).
- **Voice:** Tap start/stop, 2-minute max; audio never persisted.
- **Privacy:** Private storage, RLS everywhere, signed URLs for images, no public sharing in MVP.
- **Account deletion:** 15-day grace period before hard delete.
- **Illustration style:** Single token (`illustration_style: 'default'`) — extensible later.
- **Out of scope:** Monetization, data export, SSO, photo-based illustrations, family sharing.

---

## Stack (do not drift without discussion)

| Layer | Choice |
|-------|--------|
| Client | Expo SDK **56**, React Native 0.85, React 19.2, Expo Router, TypeScript strict |
| Server state | TanStack Query v5 |
| Backend | Supabase (Auth, Postgres, Edge Functions) + **Cloudflare R2** (images) |
| Audio | `expo-audio` (not deprecated `expo-av`) |
| Images (display) | `expo-image` |
| Builds | EAS + development client (not Expo Go for SDK 56) |
| AI | OpenAI: `gpt-4o-mini-transcribe`, `gpt-4o-mini`, `gpt-image-2` (fallback `gpt-image-1`) |

Install compatible versions: `npx expo install --fix`

---

## Repository layout

```
app/                    # Expo Router screens (auth, app, modals)
src/
  components/           # UI components
  hooks/                # useMemories, useFamilyMembers, useVoiceInput
  lib/                  # supabase client, query client
  services/             # Edge Function wrappers
  types/                # DB types (generated)
supabase/
  migrations/           # SQL migrations only
  functions/            # Deno Edge Functions
docs/                   # PRD, TECH_SPEC — source of truth for product/architecture
```

---

## Commands (after scaffold)

```bash
# Dev
npx expo start --dev-client

# Typecheck & lint
npm run typecheck
npm run lint

# Supabase local
supabase start
supabase db reset
supabase functions serve

# Generate types after schema change
npx supabase gen types typescript --local > src/types/database.ts
```

Verify commands exist before running. Do not invent scripts.

---

## Coding standards

### General

- **Minimal diffs** — solve the task; don't refactor unrelated code.
- **Reuse patterns** — match existing files before introducing abstractions.
- **No secrets in client** — OpenAI keys and service role keys only in Edge Function secrets.
- **No generated file edits** — regenerate `src/types/database.ts` from Supabase, don't hand-edit.
- **English-only UI** — i18n-ready strings, no hardcoded copy scattered in logic.

### TypeScript

- Strict mode. Prefer `interface` for object shapes; avoid `enum` (use const objects).
- Named exports for components and hooks.
- Descriptive boolean names: `isLoading`, `hasPortrait`, `canSaveMemory`.
- Early returns for errors; avoid deep nesting.

### React Native / Expo

- Functional components only.
- **Expo Router** for navigation — no parallel React Navigation setup.
- **TanStack Query** for server state — no Redux unless already established.
- Colocate hooks with domain (`useMemories`, not `useData`).
- Use `Pressable`, not deprecated Touchables.
- Safe areas via `react-native-safe-area-context` — no hardcoded notch padding.
- **Keyboard avoidance is required** for every screen, modal, bottom sheet, or drawer with `TextInput`/search fields. Use `KeyboardAvoidingView`, keyboard-aware scroll/content insets, or the existing local pattern so focused inputs and action buttons stay visible above the keyboard on iOS and Android.
- Lists: virtualize timeline/calendar (`FlashList` or `FlatList` with stable keys).
- Images: `expo-image` with explicit dimensions; signed URLs for private buckets.
- Never `{count && <Text>}` when count can be `0` — use ternary or `count > 0`.

### File naming

- Directories: `kebab-case` (e.g. `family-member-card`)
- Components: `PascalCase` files matching export (e.g. `MemoryCard.tsx`)
- Hooks: `useKebabCase.ts`
- Edge Functions: `kebab-case` folders matching TECH_SPEC names

---

## Security & secrets (required reading)

Momora handles family and child data. Treat security as a feature, not an afterthought.

### Never commit to git

| Category | Examples |
|----------|----------|
| Environment files | `.env`, `.env.local`, `.env.production`, `supabase/.env.local` |
| API keys | `OPENAI_API_KEY`, Supabase service role key, `CRON_SECRET` |
| Credentials | `*.jks`, `*.p8`, `*.p12`, `*.pem`, `*.mobileprovision` |
| Local config with secrets | `google-services.json`, `GoogleService-Info.plist` (if prod) |

- Copy [`.env.example`](.env.example) to `.env.local` locally — **never** put real values in tracked files.
- Before every commit, scan the diff for `sk-`, `eyJ`, `OPENAI`, `service_role`, or `password=`.
- If a secret is committed: **rotate the key immediately** in Supabase/OpenAI dashboards. Removing from git history is not enough.

### Where secrets live

| Secret | Allowed location | Never in |
|--------|------------------|----------|
| Supabase URL + anon key | Client `.env.local` as `EXPO_PUBLIC_*` | — (anon key is public by design; RLS protects data) |
| OpenAI API key | Supabase Edge Function secrets / `supabase/.env.local` | Client, `EXPO_PUBLIC_*`, committed files |
| R2 access keys | Supabase Edge Function secrets / `supabase/.env.local` | Client, `EXPO_PUBLIC_*`, committed files |
| Service role key | Edge Functions + cron jobs only | Mobile app, client code, git |
| Cron secret | Edge Functions validating scheduled jobs | Client, git |

**Rule:** Only variables prefixed with `EXPO_PUBLIC_` are embedded in the app bundle. Never use that prefix for secrets.

### Application security

- **RLS:** Every user-owned table filtered by `auth.uid() = user_id`. No exceptions.
- **Storage:** Private buckets only for user content. Path prefix `{userId}/...`. Display via signed URLs (short TTL).
- **Client:** Anon key + RLS only. Never import or ship the service role key.
- **Edge Functions:** Validate JWT on user-facing endpoints. Cron/scheduler endpoints require `CRON_SECRET` header.
- **Input:** Validate and sanitize on server; enforce max 4 memory tags, 2-min voice limit server-side.
- **Logging:** Never log memory content, transcripts, audio, or child PII in production. Log ids and status codes only.
- **Voice:** Process audio in memory; discard after transcription — do not write to storage.
- **Dependencies:** Prefer well-maintained Expo/Supabase packages; review new native deps for data collection.

### Child & family data

- Minimal PII in analytics (no journal text in event payloads).
- No public URLs for family photos or illustrations in MVP.
- Account deletion (15-day grace) must purge DB rows **and** all storage under the user's prefix.

### EAS / CI

- Store production secrets in **EAS Secrets** or CI secret managers — not in repo.
- Use separate Supabase projects for dev/staging/prod when possible.

---

## Data access patterns

- **RLS:** Every user-owned table filtered by `auth.uid() = user_id`.
- **Storage:** Cloudflare R2 (not Supabase Storage). Private buckets; keys in DB; presigned URLs via `get-media-url` / `get-upload-url`.
- **Client DB access:** Anon key + RLS only. No service role in app. No R2 credentials in client.
- **Edge Functions:** Validate JWT; cron functions require `CRON_SECRET`.
- **Child data:** Minimize PII in logs; never log memory content or audio in production.

---

## Domain rules

### Family profiles

- Portrait generation on save when photo is new/changed.
- Status flow: `pending → generating → ready | failed`
- DOB drives age display and age-at-memory-date in illustration prompts.

### Memories

- Save text to DB **before** invoking AI pipelines.
- Illustration status: `pending → generating → ready | failed` — always show status in UI.
- Tag limit: 4 family members — validate client-side and in Edge Functions.
- Backdating allowed via `memory_date`.

### Voice (`process-voice-memory`)

- Send base64 audio + family member list for name-aware transcription.
- Return `cleanedText` + `mentionedMemberIds`; user edits before save.
- Reject audio > 2 minutes.

### AI illustration pipeline

1. `analyze-emotion` → emotion + color palette
2. `generate-illustration` → safety pre-check, then image gen with portrait references
3. Portrait gen: `generate-portrait-illustration` at profile save

Never block memory save on illustration failure. Always offer retry.

---

## Edge Function conventions

- One function per file/folder under `supabase/functions/`
- Consistent error JSON: `{ error: string, code?: string }`
- Idempotent where possible (regeneration deletes old storage object)
- Shared helpers in `_shared/` if needed (prompts, style token map, OpenAI client)
- Update TECH_SPEC if request/response contract changes

---

## Testing (test-as-you-build)

Read **[docs/TESTING.md](docs/TESTING.md)** — canonical testing strategy.

Tests ship in the **same PR** as the feature. Do not defer.

| Layer | Required for |
|-------|--------------|
| **Unit** | Pure utils, validators, isolated hook logic |
| **Integration** | Services, hooks, hook+UI flows (mocked Supabase/API) |
| **E2E (Maestro)** | User-facing flows (≥1 happy path per flow) |
| **Deno** | Edge Functions (auth, validation, errors) |

- Integration tests use `.integration.test.ts(x)` — verify layers work together without a device.
- Bug fixes include a regression test (unit or integration minimum).
- Add `testID` props for UI covered by Maestro flows.
- Run `npm test` and `npm run test:edge` before marking work complete.
- Update the feature doc **Testing** section with all test files.

---

## PR & change hygiene

- One concern per PR when possible.
- Schema changes: migration file + regenerate types + update TECH_SPEC if contract changes.
- New Edge Function: add to TECH_SPEC §4, wire RLS/storage policies if needed.
- **Major features:** add or update `docs/features/<feature>.md` in the **same PR** (see [Feature documentation](#feature-documentation)).
- **Tests:** unit + integration (+ e2e if user-facing) in the **same PR** — see [Testing](#testing-test-as-you-build).
- Don't commit `.env*`, API keys, keystores, or `supabase/.temp/`. Run `git diff` and scan for secrets before pushing.

---

## Feature documentation

Every **major feature** must be documented in `docs/features/` so future agents (and humans) can integrate with or extend it without reverse-engineering the codebase.

### What counts as major

- New user-facing flows (auth, onboarding, memories, voice, calendar, notifications)
- New or significantly changed Edge Functions / AI pipelines
- New database tables or columns that drive behavior
- Cross-cutting capabilities other features will depend on

Skip docs for trivial fixes, pure refactors, or cosmetic-only changes.

### Required in each feature doc

Use [docs/features/_template.md](docs/features/_template.md). At minimum include:

1. **Overview** — purpose and scope
2. **User-facing behavior** — what users see and do
3. **Architecture / data flow** — diagram + narrative
4. **Data model** — tables, buckets, status fields
5. **API & Edge Functions** — call order, auth, inputs/outputs (link TECH_SPEC for contracts)
6. **Client integration** — hooks, services, routes, key files
7. **Extension guide** — how to build *on* this feature; safe extension points; what not to break
8. **Constraints & gotchas** — limits, async rules, security, edge cases

### Agent workflow

| Situation | Action |
|-----------|--------|
| **Before** modifying an existing major feature | Read `docs/features/<name>.md` first |
| **After** shipping a new major feature | Create `docs/features/<name>.md`; add row to [docs/features/README.md](docs/features/README.md) index |
| **When** changing contracts or extension points | Update the feature doc in the same PR |

Feature docs explain **how things work in practice**. [TECH_SPEC.md](docs/TECH_SPEC.md) holds canonical schema/API contracts. [PRD.md](docs/PRD.md) holds product intent.

---

## Do not

- Add monetization, export, SSO, or photo-upload illustration flows (post-MVP).
- Use `expo-av` for new code — use `expo-audio`.
- Put OpenAI or service role keys in client code or `EXPO_PUBLIC_*` vars.
- Bypass RLS with service role from the app.
- Persist voice recordings to storage.
- Hand-edit generated Supabase types.
- Expand scope beyond the task (no drive-by refactors).
- Ship a major feature without a `docs/features/` doc.
- Ship a major feature without unit + integration tests (and e2e if user-facing).

---

## Nested instructions

When working in a subdirectory, also read:

- `app/AGENTS.md` — Expo Router screens and client UX
- `supabase/AGENTS.md` — migrations, RLS, Edge Functions
- `docs/features/` — per-feature docs before extending existing capabilities

---

## Domain glossary

| Term | Meaning |
|------|---------|
| Memory | Journal entry (`memories` table) |
| Family member | Person profile with optional AI character portrait |
| Portrait | AI character illustration for a family member |
| Illustration | AI image for a specific memory |
| Style token | `illustration_style` value mapping to a reference image |
