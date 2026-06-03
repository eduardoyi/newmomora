---
name: momora-development
description: >-
  Build and maintain Momora (Expo SDK 56 parent memory journal). Use when
  implementing features, fixing bugs, adding migrations, Edge Functions, or
  AI illustration/voice pipelines. Triggers on Momora, memory journal, family
  profiles, illustrations, Supabase Edge Functions, or expo-audio voice input.
---

# Momora Development

## Before starting

1. Read [AGENTS.md](../../AGENTS.md)
2. Read [docs/PRD.md](../../docs/PRD.md) for product scope
3. Read [docs/TECH_SPEC.md](../../docs/TECH_SPEC.md) for contracts
4. Read [docs/TESTING.md](../../docs/TESTING.md) for test requirements
5. Read [docs/features/](../../docs/features/) for any feature you're extending

## Feature implementation order

When building a new feature, follow this sequence:

1. **Schema** — migration + RLS + indexes if needed
2. **Types** — regenerate `src/types/database.ts`
3. **Edge Function** — if server/AI logic required; update TECH_SPEC §4
4. **Service layer** — `src/services/` wrapper
5. **Hook** — `src/hooks/` with TanStack Query
6. **UI** — screen/modal in `app/` + components in `src/components/`
7. **Tests** — unit + integration (+ e2e if user-facing, Deno if Edge Function) — **same PR**
8. **Feature doc** — `docs/features/<name>.md` + index row (major features only)

## Checklist: client UI with text input

- [ ] Keyboard avoidance keeps focused `TextInput`/search fields visible on iOS and Android.
- [ ] Primary actions in modals, bottom sheets, and drawers stay reachable when the keyboard is open.
- [ ] Safe area insets and keyboard behavior work together; no hardcoded notch or keyboard padding.

## Checklist: new memory-related work

- [ ] Text saves to DB before AI invocation
- [ ] Max 4 tags enforced (UI + backend)
- [ ] Illustration status displayed (`pending|generating|ready|failed`)
- [ ] Retry on failed illustration
- [ ] Plain text only (no rich text editor)

## Checklist: new family profile work

- [ ] Photo upload to private `profile-pictures` bucket
- [ ] Portrait generation triggered on new/changed photo
- [ ] Age from DOB displayed correctly
- [ ] Onboarding nudges child first (if onboarding touchpoint)

## Checklist: voice input work

- [ ] `expo-audio` (not `expo-av`)
- [ ] Tap start/stop UX
- [ ] 2-minute max with auto-stop
- [ ] Audio not persisted
- [ ] Transcript editable before save
- [ ] Auto-tags overridable

## Checklist: Edge Function work

- [ ] JWT validation (or CRON_SECRET for schedulers)
- [ ] Structured error responses
- [ ] Status columns updated during async work
- [ ] TECH_SPEC contract documented
- [ ] No secrets in logs
- [ ] No API keys in source code — use env/secrets only

## Checklist: tests (every major feature)

- [ ] Unit tests for utils/validators/hook logic
- [ ] Integration tests for services + hooks (`.integration.test.ts(x)`)
- [ ] Integration tests cover error paths (401, validation, limits)
- [ ] Maestro e2e happy path (user-facing flows)
- [ ] Deno tests for Edge Functions (if touched)
- [ ] `testID`s on interactive UI used in e2e
- [ ] Feature doc Testing section lists all test files
- [ ] `npm test` passes; `npm run test:edge` if backend changed

## Checklist: before commit

- [ ] No `.env.local`, keys, or credentials in diff
- [ ] `.env.example` has empty placeholders only
- [ ] Scanned diff for `sk-`, `OPENAI`, `service_role`
- [ ] Major feature: `docs/features/<name>.md` written/updated + index row added

## Anti-patterns

| Don't | Do instead |
|-------|------------|
| Block save on AI failure | Save text; async illustration with status |
| Service role in app | Anon key + RLS |
| Store voice audio | Transcribe and discard |
| Hand-edit database types | Regenerate from Supabase |
| Add Redux | TanStack Query for server state |
| Use expo-av | expo-audio |

## Key files (once scaffolded)

| Area | Location |
|------|----------|
| Routes | `app/` |
| Hooks | `src/hooks/useMemories.ts`, `useFamilyMembers.ts`, `useVoiceInput.ts` |
| Supabase client | `src/lib/supabase.ts` |
| Migrations | `supabase/migrations/` |
| AI functions | `supabase/functions/generate-illustration/`, etc. |

## Verify before done

```bash
npm run typecheck
npm run lint
npm test
npm run test:edge   # if Edge Functions changed
```

If Supabase changed: `supabase db reset` locally and run integration tests.
