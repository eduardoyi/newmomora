// Fly Machines API client (docs/plans/year-film-p1.md Decision 2): one-off
// machines per job with a deterministic name, auto-destroy, no restarts,
// and a region/size fallback on capacity errors.
export type MachineMode = 'thumbs' | 'prepare' | 'render';

export interface MachineSize {
  cpuKind: 'performance' | 'shared';
  cpus: number;
  memoryMb: number;
}

/** Render: performance-8x (F5: 93s for a 63s film), falling back to 4x. */
export const MACHINE_SIZES: Record<MachineMode, MachineSize[]> = {
  thumbs: [{ cpuKind: 'performance', cpus: 2, memoryMb: 4096 }],
  prepare: [{ cpuKind: 'performance', cpus: 2, memoryMb: 4096 }, { cpuKind: 'performance', cpus: 4, memoryMb: 8192 }],
  render: [{ cpuKind: 'performance', cpus: 8, memoryMb: 16384 }, { cpuKind: 'performance', cpus: 4, memoryMb: 8192 }],
};

export interface MachineState {
  id: string;
  state: string;
}

export interface FlyClient {
  /** Creates (or finds, if a replayed step already created it) the machine. */
  create(input: {
    name: string;
    mode: MachineMode;
    env: Record<string, string>;
  }): Promise<MachineState>;
  get(id: string): Promise<MachineState | null>;
  destroy(id: string): Promise<void>;
}

export class FlyCapacityError extends Error {}

export function createFly(options: { token: string; app: string; image: string; regions: string[]; fetchFn?: typeof fetch }): FlyClient {
  const base = `https://api.machines.dev/v1/apps/${options.app}/machines`;
  const f = options.fetchFn ?? fetch;
  const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' };

  async function findByName(name: string): Promise<MachineState | null> {
    const res = await f(base, { headers });
    if (!res.ok) return null;
    const list = await res.json() as { id: string; name: string; state: string }[];
    const hit = list.find((m) => m.name === name);
    return hit ? { id: hit.id, state: hit.state } : null;
  }

  return {
    async create({ name, mode, env }) {
      const existing = await findByName(name);
      if (existing) return existing;
      let lastStatus = 0;
      for (const size of MACHINE_SIZES[mode]) {
        for (const region of options.regions) {
          const res = await f(base, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              name,
              region,
              config: {
                image: options.image,
                guest: { cpu_kind: size.cpuKind, cpus: size.cpus, memory_mb: size.memoryMb },
                auto_destroy: true,
                restart: { policy: 'no' },
                env,
                init: { cmd: [mode] },
              },
            }),
          });
          if (res.ok) {
            const m = await res.json() as { id: string; state: string };
            return { id: m.id, state: m.state };
          }
          lastStatus = res.status;
          if (res.status === 409) {
            const again = await findByName(name);
            if (again) return again;
          }
          // Capacity / placement errors try the next region/size; anything
          // else (auth, bad config) is not going to get better.
          if (res.status !== 412 && res.status !== 422 && res.status !== 503 && res.status !== 409) break;
        }
      }
      throw new FlyCapacityError(`machine create failed (${lastStatus})`);
    },
    async get(id) {
      const res = await f(`${base}/${id}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`machine get failed (${res.status})`);
      const m = await res.json() as { id: string; state: string };
      return { id: m.id, state: m.state };
    },
    async destroy(id) {
      const res = await f(`${base}/${id}?force=true`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) console.error('year film machine destroy failed', res.status);
    },
  };
}
