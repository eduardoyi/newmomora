// `resolveAttributionName` is a pure function colocated with the hook, but
// importing the module still pulls in `@/services/family` -> `@/lib/supabase`
// -> AsyncStorage at module-load time. Mock the service to keep this a fast,
// isolated unit test.
import { resolveAttributionName } from '@/hooks/useFamilyMemberProfiles';
import type { FamilyMemberProfile } from '@/services/family';

jest.mock('@/services/family', () => ({
  fetchFamilyMemberProfiles: jest.fn(),
}));

function profile(overrides: Partial<FamilyMemberProfile> = {}): FamilyMemberProfile {
  return {
    user_id: 'user-1',
    name: 'Rosa',
    role: 'owner',
    is_active_member: true,
    created_at: '2026-05-28T12:00:00Z',
    ...overrides,
  };
}

describe('resolveAttributionName', () => {
  it('returns the matching member name for a current member', () => {
    const profiles = [profile({ user_id: 'user-1', name: 'Rosa' })];
    expect(resolveAttributionName(profiles, 'user-1')).toBe('Rosa');
  });

  it('returns the matching member name for a former member (role null, is_active_member false)', () => {
    const profiles = [
      profile({ user_id: 'user-2', name: 'Ana', role: null, is_active_member: false }),
    ];
    expect(resolveAttributionName(profiles, 'user-2')).toBe('Ana');
  });

  it('falls back to "a former member" when user_id is null (hard-deleted creator)', () => {
    const profiles = [profile({ user_id: 'user-1', name: 'Rosa' })];
    expect(resolveAttributionName(profiles, null)).toBe('a former member');
  });

  it('falls back to "a former member" when user_id is undefined', () => {
    const profiles = [profile({ user_id: 'user-1', name: 'Rosa' })];
    expect(resolveAttributionName(profiles, undefined)).toBe('a former member');
  });

  it('falls back to "a former member" when no profile matches the creator id', () => {
    const profiles = [profile({ user_id: 'user-1', name: 'Rosa' })];
    expect(resolveAttributionName(profiles, 'user-unknown')).toBe('a former member');
  });
});
