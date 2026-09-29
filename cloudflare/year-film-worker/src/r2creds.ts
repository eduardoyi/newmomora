// Per-machine R2 credentials (docs/plans/year-film-p1.md Decision 3):
// minted inside the step that creates each machine, never persisted, TTL =
// machine timeout + margin. A read-only credential scoped to the exact
// source objects (family media lives under many uploaders' prefixes) and a
// read-write credential scoped to the attempt prefix. When the account
// isn't configured for it, returns null and the machine uses the Fly app's
// own R2 secrets (the documented fallback).
import type { Env } from './types';

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface MintedCredentials {
  read: R2Credentials | null;
  write: R2Credentials;
}

async function mint(
  env: Env,
  body: { permission: 'object-read-only' | 'object-read-write'; ttlSeconds: number; prefixes?: string[]; objects?: string[] },
  fetchFn: typeof fetch,
): Promise<R2Credentials> {
  const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/temp-access-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket: env.R2_BUCKET_NAME, parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID, ...body }),
  });
  if (!res.ok) throw new Error(`r2 temp credentials failed (${res.status})`);
  const json = await res.json() as { result?: R2Credentials };
  if (!json.result?.accessKeyId) throw new Error('r2 temp credentials missing');
  return json.result;
}

export async function mintMachineCredentials(
  env: Env,
  input: { attemptPrefix: string; sourceKeys: string[]; ttlSeconds: number },
  fetchFn: typeof fetch = fetch,
): Promise<MintedCredentials | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.R2_PARENT_ACCESS_KEY_ID) return null;
  const write = await mint(env, { permission: 'object-read-write', ttlSeconds: input.ttlSeconds, prefixes: [input.attemptPrefix] }, fetchFn);
  const read = input.sourceKeys.length > 0
    ? await mint(env, { permission: 'object-read-only', ttlSeconds: input.ttlSeconds, objects: input.sourceKeys }, fetchFn)
    : null;
  return { read, write };
}

export function credentialEnv(creds: MintedCredentials | null): Record<string, string> {
  if (!creds) return {};
  return {
    R2_WRITE_ACCESS_KEY_ID: creds.write.accessKeyId,
    R2_WRITE_SECRET_ACCESS_KEY: creds.write.secretAccessKey,
    R2_WRITE_SESSION_TOKEN: creds.write.sessionToken,
    ...(creds.read
      ? {
        R2_READ_ACCESS_KEY_ID: creds.read.accessKeyId,
        R2_READ_SECRET_ACCESS_KEY: creds.read.secretAccessKey,
        R2_READ_SESSION_TOKEN: creds.read.sessionToken,
      }
      : {}),
  };
}
