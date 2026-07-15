import { assertEquals } from 'jsr:@std/assert@1';
import {
  type PortraitVersionCandidate,
  resolvePortraitVersionAtDate,
} from './portrait-versions.ts';

function version(
  id: string,
  referenceDate: string | null,
  options: Partial<PortraitVersionCandidate> = {},
): PortraitVersionCandidate {
  return {
    id,
    family_member_id: 'member',
    reference_date: referenceDate,
    profile_picture_key: `photo-${id}`,
    illustrated_profile_key: `portrait-${id}`,
    illustrated_profile_status: 'ready',
    deletion_token: null,
    created_at: '2026-01-01T00:00:00Z',
    ...options,
  };
}

Deno.test('portrait resolver chooses latest dated portrait on or before target', () => {
  const selected = resolvePortraitVersionAtDate(
    [version('jan', '2026-01-01'), version('jun', '2026-06-01')],
    '2026-05-30',
  );
  assertEquals(selected?.id, 'jan');
});

Deno.test('portrait resolver prefers earliest after target over undated legacy', () => {
  const selected = resolvePortraitVersionAtDate(
    [version('legacy', null), version('jan', '2026-01-01'), version('jun', '2026-06-01')],
    '2025-05-30',
  );
  assertEquals(selected?.id, 'jan');
});

Deno.test('portrait resolver uses legacy only when no dated portrait is usable', () => {
  assertEquals(resolvePortraitVersionAtDate([version('legacy', null)], '2025-01-01')?.id, 'legacy');
});

Deno.test('portrait resolver uses newest creation and id for a same-day tie', () => {
  const selected = resolvePortraitVersionAtDate(
    [
      version('aaa', '2026-01-01', { created_at: '2026-02-01T00:00:00Z' }),
      version('bbb', '2026-01-01', { created_at: '2026-02-01T00:00:00Z' }),
    ],
    '2026-01-01',
  );
  assertEquals(selected?.id, 'bbb');
});

Deno.test(
  'portrait resolver excludes pending, failed, and deleting versions',
  () => {
    const selected = resolvePortraitVersionAtDate(
      [
        version('failed', '2026-05-15', {
          illustrated_profile_status: 'failed',
        }),
        version('pending', '2026-05-01', {
          illustrated_profile_key: null,
          illustrated_profile_status: 'pending',
        }),
        version('deleting', '2026-04-01', { deletion_token: 'token' }),
        version('ready', '2026-03-01'),
      ],
      '2026-06-01',
    );
    assertEquals(selected?.id, 'ready');
  },
);
