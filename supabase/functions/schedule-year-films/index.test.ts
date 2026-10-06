import { assertEquals } from 'jsr:@std/assert@1';
import { filmPushCopy, runScheduler, type SchedulerDeps } from './index.ts';

function deps(overrides: Partial<SchedulerDeps> & { rpcData?: Record<string, unknown> } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const pushes: { token: string; body: string; data: unknown }[] = [];
  const d: SchedulerDeps = {
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve({ data: overrides.rpcData?.[name] ?? null, error: null });
    },
    now: () => new Date('2026-10-26T05:05:00Z'),
    dispatch: async () => true,
    listKeys: async () => [],
    deleteKey: async (key) => void deleted.push(key),
    recipients: async () => ['tok-1', 'tok-2'],
    memberName: async () => 'Tomás Rivera',
    sendPush: async (token, _title, body, data) => {
      pushes.push({ token, body, data });
      return true;
    },
    ...overrides,
  };
  return { d, calls, deleted, pushes };
}

Deno.test('a failed dispatch goes back to the queue without burning an attempt', async () => {
  const { d, calls } = deps({
    rpcData: { claim_year_film_dispatch: [{ film_id: 'f1', attempt_id: 'a1' }, { film_id: 'f2', attempt_id: 'a2' }] },
    dispatch: async (filmId) => filmId === 'f1',
  });
  const summary = await runScheduler(d);
  assertEquals(summary.dispatched, 1);
  assertEquals(calls.find((c) => c.name === 'year_film_end_cycle')?.args, {
    p_film_id: 'f2', p_attempt_id: 'a2', p_outcome: 'aborted', p_code: 'DISPATCH_FAILED',
  });
});

Deno.test('cleanup keeps only the published attempt directory', async () => {
  const owner = 'o';
  const { d, deleted, calls } = deps({
    rpcData: { year_films_needing_cleanup: [{ film_id: 'f1', owner_id: owner, video_key: 'o/year-films/f1/a2/film.mp4' }] },
    listKeys: async () => ['o/year-films/f1/a1/film.mp4', 'o/year-films/f1/a1/prep/x.jpg', 'o/year-films/f1/a2/film.mp4', 'o/year-films/f1/a2/poster.jpg'],
  });
  await runScheduler(d);
  assertEquals(deleted, ['o/year-films/f1/a1/film.mp4', 'o/year-films/f1/a1/prep/x.jpg']);
  assertEquals(calls.find((c) => c.name === 'mark_year_film_cleaned')?.args, { p_film_id: 'f1', p_video_key: 'o/year-films/f1/a2/film.mp4' });
});

Deno.test('recovery deletes a blocked film\'s old video; only year-film keys are ever deleted', async () => {
  const { d, deleted } = deps({
    rpcData: { year_film_recover: { retried: 0, ended: 1, delete_keys: ['o/year-films/f/a/film.mp4', 'o/memories/x.jpg'] } },
  });
  await runScheduler(d);
  assertEquals(deleted, ['o/year-films/f/a/film.mp4']);
});

Deno.test('surfaced films are announced to each recipient with the year-film route', async () => {
  const { d, pushes } = deps({
    rpcData: {
      year_film_notifications_due: [{
        film_id: 'f1', family_id: 'fam', kind: 'birthday', family_member_id: 'kid', age_year: 4, language: 'es', scope_start_date: '2025-03-14',
      }],
    },
  });
  const summary = await runScheduler(d);
  assertEquals(summary.notified, 2);
  assertEquals(pushes[0].body, 'El cuarto año de Tomás, en una pequeña película 🎂');
  assertEquals(pushes[0].data, { route: 'year-film', familyId: 'fam', filmId: 'f1' });
});

Deno.test('push copy per kind and language', () => {
  assertEquals(filmPushCopy({ kind: 'birthday', language: 'en', ageYear: 2, scopeStart: '2024-11-14', childName: 'Lucía' }).body,
    "Lucía's second year, in one little film 🎂");
  assertEquals(filmPushCopy({ kind: 'family_month', language: 'en', ageYear: null, scopeStart: '2026-09-01', childName: null }).body,
    'Your September, in one little film');
  assertEquals(filmPushCopy({ kind: 'family_month', language: 'es', ageYear: null, scopeStart: '2026-09-01', childName: null }).body,
    'Su septiembre, en una pequeña película');
  assertEquals(filmPushCopy({ kind: 'family_year', language: 'en', ageYear: null, scopeStart: '2026-01-01', childName: null }).body,
    "Your family's 2026, in one little film");
});

Deno.test('a failed RPC surfaces its stable error code but not its message', async () => {
  const { d } = deps({
    rpc: () => Promise.resolve({ data: null, error: { message: 'JWT issued at future', code: 'PGRST303' } }),
  });
  let message = '';
  try {
    await runScheduler(d);
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  assertEquals(message, 'year_film_due_failed PGRST303');
});
