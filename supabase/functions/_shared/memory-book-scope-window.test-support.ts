/**
 * Test-only support for the scope-window helper and its two consumers.
 * Not a test file itself (no `.test.ts` suffix).
 */

export interface FakeMemory {
  id: string;
  family_id: string;
  memory_date: string;
  tags: string[];
}

export interface FakeOptions {
  /** Error for the `memories` query whose select contains the tag embed, on
   * the given 0-based scan page. */
  scanError?: (page: number) => boolean;
  latestError?: boolean;
  log?: { scanSelects: string[]; ranges: Array<[number, number]>; gtes: unknown[] };
}

/**
 * A small in-memory `memories` table that, unlike the filter-blind stubs the
 * Edge Function tests use elsewhere, HONOURS `eq`, `gte`, `order` (multi-key,
 * both directions), `limit` and `range`, so the helper's paging and
 * date-floor semantics are actually exercised.
 */
export function createFakeClient(memories: FakeMemory[], options: FakeOptions = {}) {
  let scanPage = 0;
  return {
    from(table: string) {
      if (table !== 'memories') throw new Error(`unexpected table ${table}`);
      let columns = '';
      const eqs: Array<[string, unknown]> = [];
      let gte: [string, string] | null = null;
      const orders: Array<[string, boolean]> = [];
      let limit: number | null = null;
      let range: [number, number] | null = null;

      const run = () => {
        const isScan = columns.includes('memory_family_members');
        if (isScan) {
          options.log?.scanSelects.push(columns);
          if (range) options.log?.ranges.push(range);
          if (gte) options.log?.gtes.push(gte[1]);
          const page = scanPage;
          scanPage += 1;
          if (options.scanError?.(page)) return { data: null, error: { message: 'scan boom' } };
        } else if (options.latestError) {
          return { data: null, error: { message: 'latest boom' } };
        }
        let rows = memories.filter((m) => eqs.every(([col, value]) => (m as unknown as Record<string, unknown>)[col] === value));
        if (gte) rows = rows.filter((m) => (m as unknown as Record<string, string>)[gte![0]] >= gte![1]);
        rows = [...rows].sort((a, b) => {
          for (const [col, asc] of orders) {
            const av = (a as unknown as Record<string, string>)[col];
            const bv = (b as unknown as Record<string, string>)[col];
            if (av === bv) continue;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (limit !== null) rows = rows.slice(0, limit);
        const projected = rows.map((m) =>
          isScan
            ? {
              id: m.id,
              memory_date: m.memory_date,
              memory_family_members: m.tags.map((family_member_id) => ({ family_member_id })),
            }
            : { memory_date: m.memory_date }
        );
        return { data: projected, error: null };
      };

      const chain = {
        select: (cols: string) => {
          columns = cols;
          return chain;
        },
        eq: (col: string, value: unknown) => {
          eqs.push([col, value]);
          return chain;
        },
        gte: (col: string, value: string) => {
          gte = [col, value];
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orders.push([col, opts?.ascending ?? true]);
          return chain;
        },
        limit: (n: number) => {
          limit = n;
          return chain;
        },
        range: (from: number, to: number) => {
          range = [from, to];
          return chain;
        },
        maybeSingle: async () => {
          const result = run();
          return result.error ? result : { data: (result.data as unknown[])[0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => void) => resolve(run()),
      };
      return chain;
    },
  } as never;
}


/**
 * Wraps a base stub client so only the scope-window queries on `memories`
 * (the latest-date lookup and the tag-embed scan) hit the honouring fake;
 * every other query (counts, loads, other tables) goes to the base stub.
 * Lets the bridge and `memory-book-edits` be fed the SAME memory data.
 */
export function withFakeWindowMemories(base: unknown, memories: FakeMemory[], options: FakeOptions = {}) {
  const baseClient = base as { from(table: string): Record<string, unknown> };
  const fake = createFakeClient(memories, options) as unknown as { from(table: string): { select(cols: string): unknown } };
  return {
    from(table: string) {
      if (table !== 'memories') return baseClient.from(table);
      return {
        select: (cols: string, opts?: unknown) => {
          const isWindowQuery = !(opts as { head?: boolean } | undefined)?.head &&
            (cols.includes('memory_family_members') || cols === 'memory_date');
          return isWindowQuery
            ? fake.from('memories').select(cols)
            : (baseClient.from('memories').select as (c: string, o?: unknown) => unknown)(cols, opts);
        },
      };
    },
  } as never;
}
