import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { handleWebHandoff, maskEmail, sha256Hex, type WebHandoffDependencies } from './index.ts';

// Fictional ids/emails only (the repo is public).
const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'jordan.example@example.test';
const TOKEN_HASH = 'pkce_fake-token-hash-for-tests';
const NOW = Date.parse('2026-10-06T15:00:00Z');
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

interface Harness {
  deps: Partial<WebHandoffDependencies>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  generateLinkCalls: Array<Record<string, unknown>>;
  logs: string[];
  restore: () => void;
}

interface HarnessOptions {
  user?: { id: string; is_anonymous?: boolean } | null;
  createRpc?: () => { data: unknown; error: unknown };
  claimRpc?: (args: Record<string, unknown>) => { data: unknown; error: unknown };
  adminUser?: Record<string, unknown> | null;
  adminUserError?: unknown;
  generateLink?: () => { data: unknown; error: unknown };
}

function harness(options: HarnessOptions = {}): Harness {
  const rpcCalls: Harness['rpcCalls'] = [];
  const generateLinkCalls: Harness['generateLinkCalls'] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  console.error = capture;
  console.log = capture;
  console.warn = capture;

  const user = options.user === undefined ? { id: USER_ID, is_anonymous: false } : options.user;
  const adminUser = options.adminUser === undefined
    ? { id: USER_ID, email: EMAIL, is_anonymous: false, banned_until: null, deleted_at: null }
    : options.adminUser;

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === 'create_web_handoff') {
        return Promise.resolve(options.createRpc?.() ?? { data: '2026-10-06T15:02:00+00:00', error: null });
      }
      if (name === 'claim_web_handoff') {
        return Promise.resolve(options.claimRpc?.(args) ?? { data: USER_ID, error: null });
      }
      throw new Error(`Unexpected rpc ${name}`);
    },
    auth: {
      admin: {
        getUserById: () =>
          Promise.resolve({ data: { user: adminUser }, error: options.adminUserError ?? null }),
        generateLink: (params: Record<string, unknown>) => {
          generateLinkCalls.push(params);
          return Promise.resolve(
            options.generateLink?.() ?? { data: { properties: { hashed_token: TOKEN_HASH } }, error: null },
          );
        },
        // A server-side verifyOtp-equivalent must never be reached.
      },
      verifyOtp: () => {
        throw new Error('verifyOtp must never be called server-side');
      },
    },
  };

  return {
    deps: {
      getAuthenticatedUser: () => Promise.resolve(user as never),
      createServiceClient: (() => client) as never,
      now: () => NOW,
    },
    rpcCalls,
    generateLinkCalls,
    logs,
    restore: () => {
      console.error = originalError;
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
}

function call(h: Harness, body: unknown) {
  return handleWebHandoff(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }),
    h.deps,
  );
}

const GOOD_CODE = 'A'.repeat(43);

// ── create ───────────────────────────────────────────────────────────────

Deno.test('create: refuses an anonymous / missing user (401)', async () => {
  const h = harness({ user: null });
  try {
    const response = await call(h, { op: 'create' });
    assertEquals(response.status, 401);
    assertEquals(h.rpcCalls.length, 0);
  } finally {
    h.restore();
  }
});

Deno.test('create: returns a 43-char base64url code and stores only its sha256 hex', async () => {
  const h = harness();
  try {
    const response = await call(h, { op: 'create' });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert(BASE64URL_43.test(body.code), 'code is base64url, 43 chars');
    assertEquals(body.expiresAt, '2026-10-06T15:02:00+00:00');

    assertEquals(h.rpcCalls.length, 1);
    const { name, args } = h.rpcCalls[0]!;
    assertEquals(name, 'create_web_handoff');
    assertEquals(args.p_user_id, USER_ID);
    assertEquals(args.p_code_hash, await sha256Hex(body.code));
    assertNotEquals(args.p_code_hash, body.code);
    assert(/^[0-9a-f]{64}$/.test(String(args.p_code_hash)));
    assertEquals(Object.keys(args).sort(), ['p_code_hash', 'p_user_id']);
    assert(!JSON.stringify(h.rpcCalls).includes(body.code), 'the plaintext code never reaches the DB');
  } finally {
    h.restore();
  }
});

Deno.test('create: two calls mint different codes (real randomness)', async () => {
  const h = harness();
  try {
    const a = await (await call(h, { op: 'create' })).json();
    const b = await (await call(h, { op: 'create' })).json();
    assertNotEquals(a.code, b.code);
  } finally {
    h.restore();
  }
});

Deno.test('create: a code with + and / bytes is url-safe base64 without padding', async () => {
  const h = harness();
  h.deps.randomBytes = () => new Uint8Array(32).fill(0xfb); // standard base64 would contain "+" and "/"
  try {
    const body = await (await call(h, { op: 'create' })).json();
    assert(BASE64URL_43.test(body.code));
    assert(body.code.includes('-') || body.code.includes('_'));
  } finally {
    h.restore();
  }
});

Deno.test('create: the rate_limited hint maps to 429 rate_limited', async () => {
  const h = harness({
    createRpc: () => ({ data: null, error: { code: 'P0001', message: 'rate_limited', hint: 'rate_limited' } }),
  });
  try {
    const response = await call(h, { op: 'create' });
    assertEquals(response.status, 429);
    assertEquals((await response.json()).code, 'rate_limited');
  } finally {
    h.restore();
  }
});

Deno.test('create: another DB error is a 500 without leaking the code', async () => {
  const h = harness({ createRpc: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) });
  try {
    const response = await call(h, { op: 'create' });
    assertEquals(response.status, 500);
    assertEquals((await response.json()).code, 'internal_error');
  } finally {
    h.restore();
  }
});

// ── redeem ───────────────────────────────────────────────────────────────

async function assertInvalid(response: Response) {
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body, { error: 'This sign-in link is no longer valid', code: 'handoff_invalid' });
}

Deno.test('redeem: bad shapes are handoff_invalid and never reach the DB', async () => {
  const h = harness();
  try {
    for (const code of [undefined, null, 123, '', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}+`, `${'A'.repeat(42)}/`, ' '.repeat(43)]) {
      await assertInvalid(await call(h, { op: 'redeem', code }));
    }
    assertEquals(h.rpcCalls.length, 0);
  } finally {
    h.restore();
  }
});

Deno.test('redeem: unknown / used / expired (claim returns null) are the same 400', async () => {
  const h = harness({ claimRpc: () => ({ data: null, error: null }) });
  try {
    const response = await call(h, { op: 'redeem', code: GOOD_CODE });
    await assertInvalid(response);
    assertEquals(response.headers.get('Cache-Control'), 'no-store');
    assertEquals(h.generateLinkCalls.length, 0);
  } finally {
    h.restore();
  }
});

Deno.test('redeem: a claim DB error is the same 400', async () => {
  const h = harness({ claimRpc: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) });
  try {
    await assertInvalid(await call(h, { op: 'redeem', code: GOOD_CODE }));
  } finally {
    h.restore();
  }
});

Deno.test('redeem: success returns only { tokenHash, maskedEmail, userId } with no-store', async () => {
  const h = harness();
  try {
    const response = await call(h, { op: 'redeem', code: GOOD_CODE });
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assertEquals(body, { tokenHash: TOKEN_HASH, maskedEmail: 'j•••@example.test', userId: USER_ID });

    assertEquals(h.rpcCalls.length, 1);
    assertEquals(h.rpcCalls[0]!.name, 'claim_web_handoff');
    assertEquals(h.rpcCalls[0]!.args, { p_code_hash: await sha256Hex(GOOD_CODE) });
    assertEquals(h.generateLinkCalls, [{ type: 'magiclink', email: EMAIL }]);
  } finally {
    h.restore();
  }
});

Deno.test('redeem: user missing / no email / banned / deleted / anonymous are the same 400', async () => {
  const cases: HarnessOptions[] = [
    { adminUser: null },
    { adminUser: { id: USER_ID, email: null } },
    { adminUser: { id: USER_ID, email: '' } },
    { adminUser: { id: USER_ID, email: EMAIL, banned_until: '2999-01-01T00:00:00Z' } },
    { adminUser: { id: USER_ID, email: EMAIL, deleted_at: '2026-10-01T00:00:00Z' } },
    { adminUser: { id: USER_ID, email: EMAIL, is_anonymous: true } },
    { adminUserError: { message: 'not found' }, adminUser: null },
    { generateLink: () => ({ data: null, error: { message: 'rate limit' } }) },
    { generateLink: () => ({ data: { properties: {} }, error: null }) },
  ];
  for (const options of cases) {
    const h = harness(options);
    try {
      await assertInvalid(await call(h, { op: 'redeem', code: GOOD_CODE }));
    } finally {
      h.restore();
    }
  }
});

Deno.test('redeem: a lapsed ban (banned_until in the past) does not block', async () => {
  const h = harness({
    adminUser: { id: USER_ID, email: EMAIL, banned_until: '2020-01-01T00:00:00Z', deleted_at: null },
  });
  try {
    assertEquals((await call(h, { op: 'redeem', code: GOOD_CODE })).status, 200);
  } finally {
    h.restore();
  }
});

Deno.test('redeem: a thrown error is the same 400 (no oracle)', async () => {
  const h = harness();
  h.deps.createServiceClient = (() => {
    throw new Error('Missing Supabase service role environment variables');
  }) as never;
  try {
    await assertInvalid(await call(h, { op: 'redeem', code: GOOD_CODE }));
  } finally {
    h.restore();
  }
});

Deno.test('logs contain no code, hash, token hash or email on any path', async () => {
  const secrets = [GOOD_CODE, await sha256Hex(GOOD_CODE), TOKEN_HASH, EMAIL, 'jordan'];
  const scenarios: Array<[HarnessOptions, unknown]> = [
    [{}, { op: 'redeem', code: GOOD_CODE }],
    [{ claimRpc: () => ({ data: null, error: { code: 'XX000', message: `boom ${GOOD_CODE}` } }) }, { op: 'redeem', code: GOOD_CODE }],
    [{ adminUser: null }, { op: 'redeem', code: GOOD_CODE }],
    [{ generateLink: () => ({ data: null, error: { message: EMAIL } }) }, { op: 'redeem', code: GOOD_CODE }],
    [{ createRpc: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) }, { op: 'create' }],
  ];
  for (const [options, body] of scenarios) {
    const h = harness(options);
    try {
      await call(h, body);
      for (const line of h.logs) {
        for (const secret of secrets) assert(!line.includes(secret), `log leaked a secret: ${line}`);
      }
    } finally {
      h.restore();
    }
  }
});

// ── Routing ──────────────────────────────────────────────────────────────

Deno.test('routing: OPTIONS ok, GET 405, bad JSON 400, unknown op 400', async () => {
  const h = harness();
  try {
    assertEquals((await handleWebHandoff(new Request('http://localhost', { method: 'OPTIONS' }), h.deps)).status, 200);
    assertEquals((await handleWebHandoff(new Request('http://localhost', { method: 'GET' }), h.deps)).status, 405);
    assertEquals((await handleWebHandoff(new Request('http://localhost', { method: 'POST', body: '{' }), h.deps)).status, 400);
    assertEquals((await call(h, { op: 'nope' })).status, 400);
    assertEquals(h.rpcCalls.length, 0);
  } finally {
    h.restore();
  }
});

Deno.test('maskEmail keeps the first character and the domain', () => {
  assertEquals(maskEmail('jane@gmail.com'), 'j•••@gmail.com');
  assertEquals(maskEmail('x@y.co'), 'x•••@y.co');
  assertEquals(maskEmail('weird'), '•••');
});
