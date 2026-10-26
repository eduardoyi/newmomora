// Shared HogQL runner for the read-only eval scripts (eval-billing-trials,
// eval-trial-funnel). The personal query:read PostHog key is found by its
// phx_ prefix so scripts don't depend on the variable name; it is never
// printed. A query:read-only key can't list projects, so the project is an
// explicit *POSTHOG*PROJECT* env value or `@current` (the key's project).

const posthogKey = Object.values(Deno.env.toObject()).find((value) => value.startsWith('phx_'));
const posthogHost = (Deno.env.get('EXPO_PUBLIC_POSTHOG_HOST') ?? 'https://us.i.posthog.com')
  .replace('.i.posthog.com', '.posthog.com');
const posthogProject = Object.entries(Deno.env.toObject())
  .find(([name]) => /POSTHOG.*PROJECT/.test(name))?.[1] ?? '@current';

export function hasPosthogKey(): boolean {
  return Boolean(posthogKey);
}

/** Runs a HogQL query; returns null (after logging why) when unavailable or failed. */
export async function runHogQL(query: string): Promise<unknown[][] | null> {
  if (!posthogKey) {
    console.log('posthog: no phx_ key in the env files; skipped');
    return null;
  }
  const response = await fetch(`${posthogHost}/api/projects/${posthogProject}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${posthogKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!response.ok) {
    console.log('posthog query failed:', response.status, (await response.text()).slice(0, 500));
    return null;
  }
  const payload = await response.json() as { results?: unknown[][] };
  return payload.results ?? [];
}
