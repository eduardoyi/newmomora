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
describe('validateMemoryTags', () => {
  it('rejects more than 4 tags', () => {
    expect(validateMemoryTags(fiveIds)).toEqual({ ok: false, code: 'MAX_TAGS' });
  });
});
```

### What to unit test (Momora-specific)

- Tag limit (max 4), memory date validation, age-from-DOB formatting
- Voice recording duration cap (2 min)
- Illustration/portrait status label helpers
- Error code mapping from Edge Function JSON
- Prompt builders and style token resolution (pure functions)

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

it('creates memory and tags up to 4 members', async () => {
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

---

## Edge Function tests (Deno)

Colocate `index.test.ts` in each function folder.

```ts
Deno.test('rejects unauthenticated request', async () => {
  const res = await handler(createRequest({ auth: null }));
  assertEquals(res.status, 401);
});

Deno.test('rejects more than 4 tagged members', async () => {
  const res = await handler(validRequestWithFiveTags);
  assertEquals(res.status, 400);
});
```

Mock OpenAI and Supabase service client. Test auth, validation, error JSON, audio length rejection, idempotent regeneration.

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
