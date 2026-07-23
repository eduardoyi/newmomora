# Momora — Testing Strategy

Tests are built **alongside features**, not after. Every major feature PR includes **unit**, **integration**, and (when user-facing) **e2e** tests. Goal: reduce reliance on manual smoke testing.

**Full reference for agents:** read this doc before implementing or extending features.

---

## Test pyramid

| Layer | Tool | What to test |
|-------|------|--------------|
| **Unit** | Jest + `@testing-library/react-native` | Pure functions, isolated hook logic, presentational components |
| **Integration** | Jest + mocked Supabase / MSW + `@testing-library/react-native` | Service + hook + component wiring, multi-step client flows, API contract handling |
| **Edge Functions** | Deno `Deno.test` | Auth guards, validation, handler orchestration (mock OpenAI/Supabase admin) |
| **E2E** | [Maestro](https://maestro.mobile.dev/) | Full user journeys on EAS dev build |

**Integration tests** are the bridge between unit and e2e: they verify that layers work together (hook calls service, service parses Edge Function response, UI reflects state) without a device or real backend.

---

## When tests are required

| Change | Unit | Integration | E2E | Deno (Edge) |
|--------|------|-------------|-----|-------------|
| New/changed pure util or validator | **Required** | — | — | — |
| New/changed service (`src/services/`) | **Required** | **Required** | — | — |
| New/changed hook (`src/hooks/`) | **Required** | **Required** | — | — |
| New/changed screen/modal with logic | Optional | **Required** | — | — |
| New user-facing flow (auth, memory, voice, onboarding) | **Required** | **Required** | **Required** (≥1 flow) | If backend |
| Edge Function behavior change | — | — | Optional | **Required** |
| Bug fix | **Required** (regression) | If multi-layer | If user-visible | If backend |

**Rule:** Do not merge major features with untested business logic. Unit = edge cases; integration = layer wiring; e2e = happy path on device.

---

## Directory layout

```
src/
  utils/
    validate-memory-tags.ts
    validate-memory-tags.test.ts      # unit
  services/
    memories.ts
    memories.integration.test.ts      # integration
  hooks/
    useMemories.ts
    useMemories.test.ts               # unit (mocked deps)
    useMemories.integration.test.tsx  # integration (QueryClient + mocks)
  components/
    memory-card.tsx
    memory-card.test.tsx
supabase/functions/
  process-voice-memory/
    index.ts
    index.test.ts                     # Deno
.maestro/flows/
  auth/sign-up-and-login.yaml
  memories/create-text-memory.yaml
docs/features/<name>.md               # Testing section lists all of the above
```

Prefer **colocated** tests. Use `.integration.test.ts(x)` suffix for integration tests.

---

## Unit tests

### Stack

- `jest` + `jest-expo` preset
- `@testing-library/react-native`
- `@testing-library/jest-native` matchers

### Patterns

```tsx
// Pure function — no mocks
describe('validateIllustrationMemberLimit', () => {
  it('rejects more than 6 tags for an illustration', () => {
    expect(validateIllustrationMemberLimit(sevenIds)).toMatch(/up to 6/);
  });
});
```

### What to unit test (Momora-specific)

- Illustrated-memory limit (max 6), unlimited text-only/media tags, memory date validation, age-from-DOB formatting
- Voice recording duration cap (2 min)
- Illustration/portrait status label helpers
- Error code mapping from Edge Function JSON
- Prompt builders and style token resolution (pure functions)
- Family sharing: invite-code normalize/format/shape validation, role-gating helpers (`src/utils/roles.ts`), share-message builder, waiting-screen outcome derivation, `pendingInviteCode` storage helpers

### What not to unit test

- React Native / Expo internals
- Third-party library behavior
- Snapshot-only tests with no behavioral assertion

---

## Integration tests

Integration tests prove **multiple layers cooperate correctly** with mocked I/O (no real Supabase/OpenAI, no simulator).

### What belongs here

| Area | Example scenarios |
|------|-------------------|
| **Services** | `createMemory` inserts row + junction tags; maps Supabase errors to app errors |
| **Hooks + Query** | `useMemories` addMemory invalidates cache; loading/error states |
| **Hook + service** | `useVoiceInput` sends audio → populates text + suggested tags from mocked response |
| **Screen flows** | New memory form: fill text → select tags → save → calls service with correct payload |
| **Onboarding gates** | Layout redirects when no portrait ready; allows memory when portrait `ready` |
| **Edge Function handlers** | Full request → mocked DB/OpenAI → response shape (in Deno, see below) |
| **Family sharing** | `FamilyProvider` membership resolution + stale `active_family_id` correction; Settings family section by role; no-family screen create/redeem entry points + `pendingInviteCode` guard precedence; redeem screen definitive-vs-transient error handling |

### Stack

- Jest + `@testing-library/react-native`
- `@tanstack/react-query` `QueryClientProvider` with `retry: false` in tests
- Mock `@/lib/supabase` and `src/services/*` at the boundary you are **not** testing
- Optional: [MSW](https://mswjs.io/) for HTTP-level Edge Function mocks from the client

### Patterns

```tsx
// Service integration — mock Supabase client, test real service logic
import { createMemory } from './memories';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase');

it('creates an illustrated memory with up to 6 members', async () => {
  mockInsertMemory.mockResolvedValue({ data: { id: 'mem-1' }, error: null });
  await createMemory({ content: 'Hello', memberIds: ['a', 'b'] });
  expect(mockInsertMemory).toHaveBeenCalledWith(/* ... */);
});

// Hook + UI integration
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const wrapper = ({ children }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

it('useMemories addMemory updates list on success', async () => {
  const { result } = renderHook(() => useMemories(), { wrapper });
  await act(() => result.current.addMemory({ content: 'Test' }));
  await waitFor(() => expect(result.current.memories).toHaveLength(1));
});
```

### Integration test principles

- Mock at **system boundaries** (Supabase, Edge Function fetch), not every internal function.
- One integration file per feature area (`memories.integration.test.ts`, `voice.integration.test.tsx`).
- Test failure paths: network error, 401, validation rejection, max tags exceeded.
- Do not call production Supabase or OpenAI — use mocks or local `supabase start` in dedicated CI job only.

### Durable image-generation Workflow migrations

The illustration migration has a client/service contract test, Supabase Deno
tests, and Worker tests. Cover both legacy `{ success: true }` and queued
`{ success: true, queued: true, jobId }` dispatcher responses; the client must
never write illustration status/timestamps during recovery. Unit coverage must
exercise the recovery fallback clock (`started_at ?? updated_at ?? created_at`),
pending recovery at 3 minutes, and generating recovery only at 5 minutes 30
seconds. Worker/Deno coverage must exercise idempotent instance dispatch,
deterministic-R2 replay, one combined OpenAI/upload step, attempt caps,
moderation, total reference-load failure, stale publish rejection, and the
4:59 publication versus 5:30 recovery boundary.

Portrait migration coverage follows the same durable contract while preserving
portrait-specific retained-output and deletion semantics. Test the public
`{ portraitVersionId }` request against both legacy `{ success: true }` and
durable `{ success: true, queued: true, jobId? }` responses; the client must
never write portrait status/timestamps. Unit and hook integration coverage
must lock the unclaimed-pending 3:00 boundary (from immutable `created_at`,
not `updated_at`), the claimed 5:30 boundary (from
`generation_started_at`), manager-only once-per-attempt recovery, failed
manual retry, viewer observation, active polling, and the fresh-attempt
Regenerate guard.

Supabase/Worker tests must cover the private portrait job and nonce tables,
HMAC bridge, deterministic R2 replay, one combined OpenAI/upload step,
token/deletion CAS, retained prior portrait, missing source/style references,
style-first reference order, explicit WebP output, one `gpt-image-2` attempt
followed only by a retryable, reference-aware `gpt-image-1.5` fallback, and
the prohibition on text-only fallback. Cross-pipeline tests must prove that a
memory waiting on a portrait creates no memory job, then gets re-evaluated
after portrait terminal state through the separate signed internal retrigger
without forwarding a user JWT.

The SQL fixture suites are a required counterpart to mocked Deno tests:
`supabase/tests/memory_illustration_workflow.sql` covers exact provider and
upload leases, `portrait_generation_workflow.sql` covers the same contract plus
portrait/deletion fences, and `account_deletion_fences.sql` covers exact
soft-delete provenance, expired-cancel rejection, and hard-delete claim
serialization. Run them against a Supabase-compatible Postgres database with
pgTAP; a plain PostgreSQL server without the pgTAP extension can still verify
the migration in one transaction, but cannot replace those assertions.

Before production cutover, run real-provider evaluation with the checked-in
non-user profile fixture and style asset, then run one production synthetic
fixture-only family member/version under the authorized test account. Verify
only IDs, state transitions, model, duration, signed display, WebP, private
input scrubbing, and deferred-memory retrigger; remove every synthetic DB row
and R2 object afterward. Do not use an organic child photo or inspect/log PII.

---

## Edge Function tests (Deno)

Colocate `index.test.ts` in each function folder.

```ts
Deno.test('rejects unauthenticated request', async () => {
  const res = await handler(createRequest({ auth: null }));
  assertEquals(res.status, 401);
});

Deno.test('rejects more than 6 tagged members for illustration', async () => {
  const res = await handler(validRequestWithSevenTags);
  assertEquals(res.status, 400);
});
```

Mock OpenAI and Supabase service client. Test auth, validation, error JSON, audio length rejection, idempotent regeneration.

**Family sharing:** `redeem-family-invite`, `resolve-family-invite`, and
`notify-family-activity` cover the invite/redeem/approve/notify Edge
Functions (rate limiting, atomic claim, "manager of *this* family" checks,
debounce, Bento email success/skip/failure). `get-upload-url`,
`get-media-url`, `delete-storage-object`, `generate-illustration`,
`generate-portrait-illustration`, and `analyze-emotion` all gained
family-role authorization tests on top of their existing coverage. There is
no separate Deno-level RLS test suite — the DB-level RLS matrix (every
shared table × role × operation) is covered by the Jest integration tests
above (`use-family.integration.test.tsx` and the screen tests), not Deno.

Run: `npm run test:edge` or `deno test supabase/functions/`

---

## E2E tests (Maestro)

Run against **EAS development build** (not Expo Go for SDK 56).

### Flow naming

`.maestro/flows/<feature>/<scenario>.yaml`

Examples:

- `auth/sign-up-and-login.yaml`
- `onboarding/add-family-member-with-fixture.yaml` — reliable photo upload (dev fixture)
- `onboarding/add-family-member-with-picker.yaml` — real system gallery picker
- `memories/create-text-memory.yaml`
- `memories/voice-memory.yaml`
- `sharing/01-owner-create-invite.yaml` … `04-second-account-sees-timeline.yaml` — numbered sub-flows for the two-account invite → redeem → approve loop (see `.maestro/flows/sharing/README.md` for why it's split and the required run command)
- `sharing/viewer-readonly.yaml` — viewer sees timeline but no create FAB / no edit affordances

### Photo upload E2E (family profiles)

Two flows cover different layers:

| Flow | When to run |
|------|-------------|
| `add-family-member-with-fixture.yaml` | Every PR / CI — taps **Use E2E test photo** in dev builds |
| `add-family-member-with-picker.yaml` | Pre-release or manual — seeds gallery with `addMedia`, drives system picker |

Fixture assets: `assets/e2e/profile-fixture.jpg` (bundled in app) and `.maestro/assets/profile-fixture.jpg` (Maestro `addMedia`). The fixture button is `__DEV__` only and never ships in production builds.

### E2E principles

- One flow = one primary user goal (happy path first)
- Use `testID` on buttons, inputs, and key states
- Avoid flaky fixed sleeps; use `assertVisible` with timeouts
- No secrets in YAML — test account via env
- E2E complements integration: e2e catches navigation/native issues; integration catches logic faster

### Running locally

```bash
maestro test .maestro/flows/
```

---

## Commands

```bash
npm test                 # unit + integration (CI: --ci --coverage)
npm run test:watch       # local development
npm run test:edge        # Deno Edge Function tests
npm run test:e2e:family-fixture   # Maestro: family upload (fixture)
npm run test:e2e:family-picker    # Maestro: family upload (system picker)
```

Until CI exists, run `npm test` before marking work complete.

---

## Test data & security

- Use local `supabase start` or dedicated test project — never production
- `.env.test.local` for test credentials (gitignored)
- Do not log memory content or PII in test output
- Mock OpenAI in unit/integration; real AI only in optional nightly e2e against staging

Add to `.gitignore`: `.env.test.local`

---

## Feature doc requirement

Each `docs/features/<name>.md` **Testing** section must list:

- Unit test files
- Integration test files and scenarios covered
- E2E Maestro flow path(s)
- Deno test files (if applicable)
- Command to run tests for this feature only

---

## Definition of done (testing)

A major feature is not done until:

- [ ] **Unit** tests cover validators, helpers, and isolated hook logic
- [ ] **Integration** tests cover service + hook (+ screen when applicable)
- [ ] **E2E** Maestro happy path for user-facing flows
- [ ] **Deno** tests for changed Edge Functions
- [ ] `npm test` and `npm run test:edge` pass
- [ ] Feature doc Testing section updated
- [ ] `testID`s added for new interactive UI used in e2e

Bug fixes: at minimum add a **unit or integration regression test** that would have caught the bug.
