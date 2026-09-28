import { assertEquals } from 'jsr:@std/assert@1';
import type { FamilySignals } from '../_shared/family-relationship-suggestions.ts';
import {
  handleSuggestFamilyRelationshipsWithDependencies,
  type SuggestFamilyRelationshipsDependencies,
} from './index.ts';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const SIGNALS: FamilySignals = {
  members: [
    { id: 'dad', first_name: 'Eduardo', nicknames: [], age_years: 38, gender: null, relationship: 'parent', family_side: null, side_member_id: null, is_own_child: false },
    { id: 'mirian', first_name: 'Mirian', nicknames: [], age_years: 66, gender: null, relationship: null, family_side: null, side_member_id: null, is_own_child: false },
  ],
  accounts: [],
  co_tags: [],
  snippets: [],
};

interface Harness {
  deps: SuggestFamilyRelationshipsDependencies;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  chatCalls: number;
}

function harness(options: {
  role?: string | null;
  claim?: { claimed: boolean; previous_suggested_at: string | null };
  signals?: FamilySignals;
  newMemories?: number;
  reply?: unknown;
  chatThrows?: boolean;
  billing?: Response | null;
} = {}): Harness {
  const h: Harness = { rpcCalls: [], chatCalls: 0, deps: undefined as unknown as SuggestFamilyRelationshipsDependencies };
  h.deps = {
    getAuthenticatedUser: async () => ({ id: USER_ID }),
    createServiceClient: () => ({
      rpc: (name, args) => {
        h.rpcCalls.push({ name, args });
        const data = name === 'claim_relationship_suggestion_run'
          ? [options.claim ?? { claimed: true, previous_suggested_at: null }]
          : name === 'family_relationship_signals'
          ? options.signals ?? SIGNALS
          : name === 'insert_family_member_suggestions'
          ? (args.p_rows as unknown[]).length
          : null;
        return Promise.resolve({ data, error: null });
      },
    }),
    getFamilyRole: async () => (options.role === undefined ? 'manager' : options.role),
    checkBilling: async () => options.billing ?? null,
    countMemoriesSince: async () => options.newMemories ?? 0,
    chatJson: async <T>() => {
      h.chatCalls += 1;
      if (options.chatThrows) throw new Error('OpenAI chat failed (429)');
      return (options.reply ?? { people: [{ ref: 'P2', relationship: 'grandparent', side: 'P1', confidence: 0.9 }] }) as T;
    },
  };
  return h;
}

function post(body: unknown): Request {
  return new Request('http://localhost/suggest-family-relationships', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

Deno.test('rejects viewers and bad input before claiming a run', async () => {
  const viewer = harness({ role: 'viewer' });
  assertEquals((await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: FAMILY_ID }), viewer.deps)).status, 403);
  const stranger = harness({ role: null });
  assertEquals((await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: FAMILY_ID }), stranger.deps)).status, 403);
  const bad = harness();
  assertEquals((await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: 'nope' }), bad.deps)).status, 400);
  for (const h of [viewer, stranger, bad]) assertEquals(h.rpcCalls, []);
});

Deno.test('a lapsed family gets the billing response and no run', async () => {
  const h = harness({ billing: new Response('{}', { status: 403 }) });
  assertEquals((await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: FAMILY_ID }), h.deps)).status, 403);
  assertEquals(h.rpcCalls, []);
});

Deno.test('throttled claim skips without calling the model', async () => {
  const h = harness({ claim: { claimed: false, previous_suggested_at: '2026-09-28T10:00:00Z' } });
  const response = await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: FAMILY_ID }), h.deps);
  assertEquals(await response.json(), { skipped: true, reason: 'throttled' });
  assertEquals(h.chatCalls, 0);
});

Deno.test('nothing new to sort skips the model call', async () => {
  const sorted: FamilySignals = {
    ...SIGNALS,
    members: [SIGNALS.members[0], { ...SIGNALS.members[1], relationship: 'family_friend' }],
  };
  const h = harness({ claim: { claimed: true, previous_suggested_at: '2026-09-27T10:00:00Z' }, signals: sorted, newMemories: 0 });
  const response = await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: FAMILY_ID }), h.deps);
  assertEquals(await response.json(), { skipped: true, reason: 'nothing_new' });
  assertEquals(h.chatCalls, 0);
});

Deno.test('happy path inserts validated rows only', async () => {
  const h = harness();
  const response = await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: FAMILY_ID }), h.deps);
  assertEquals(await response.json(), { skipped: false, suggested: 2 });
  const insert = h.rpcCalls.find((c) => c.name === 'insert_family_member_suggestions');
  assertEquals(insert?.args, {
    p_family_id: FAMILY_ID,
    p_rows: [
      { family_member_id: 'mirian', field: 'relationship', value: 'grandparent', based_on: null },
      { family_member_id: 'mirian', field: 'family_side', value: 'member', side_member_id: 'dad', based_on: null },
    ],
  });
});

Deno.test('model failure backs off instead of restoring the window', async () => {
  const h = harness({ chatThrows: true });
  const response = await handleSuggestFamilyRelationshipsWithDependencies(post({ familyId: FAMILY_ID }), h.deps);
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, 'SUGGESTION_FAILED');
  assertEquals(h.rpcCalls.map((c) => c.name), [
    'claim_relationship_suggestion_run',
    'family_relationship_signals',
    'fail_relationship_suggestion_run',
  ]);
});
