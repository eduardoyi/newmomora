import { getDeviceTimezone, mapAuthError } from '@/services/auth';

describe('auth service', () => {
  it('maps Supabase auth errors', () => {
    expect(mapAuthError({ message: 'Invalid login credentials', code: 'invalid_credentials' })).toEqual({
      message: 'Invalid login credentials',
      code: 'invalid_credentials',
    });
  });

  it('returns a timezone string', () => {
    expect(typeof getDeviceTimezone()).toBe('string');
    expect(getDeviceTimezone().length).toBeGreaterThan(0);
  });
});
