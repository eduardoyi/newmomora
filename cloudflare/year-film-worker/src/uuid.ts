// RFC 4122 v5 UUIDs: deterministic ledger ids (`ai_call_id`) per attempt +
// check, so a replayed step never records the same model call twice.
const NAMESPACE = 'f1a1b2c3-d4e5-4f60-8a7b-9c0d1e2f3a4b';

function parse(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function uuidV5(name: string, namespace = NAMESPACE): Promise<string> {
  const ns = parse(namespace);
  const data = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + data.length);
  input.set(ns);
  input.set(data, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
