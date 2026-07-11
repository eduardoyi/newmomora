import { getDeviceTimezone, isUserNotFoundOtpError, mapAuthError } from '@/services/auth';

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

  describe('isUserNotFoundOtpError', () => {
    it('recognizes the otp_disabled code Supabase returns when shouldCreateUser is false', () => {
      expect(
        isUserNotFoundOtpError({ code: 'otp_disabled', message: 'Signups not allowed for otp' }),
      ).toBe(true);
    });

    it('recognizes a literal user_not_found code', () => {
      expect(isUserNotFoundOtpError({ code: 'user_not_found', message: 'User not found' })).toBe(true);
    });

    it('falls back to matching the message when no recognized code is present', () => {
      expect(isUserNotFoundOtpError({ message: 'Signup not allowed for otp' })).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(isUserNotFoundOtpError({ code: 'otp_expired', message: 'Token has expired' })).toBe(false);
      expect(isUserNotFoundOtpError({ message: 'Invalid login credentials' })).toBe(false);
    });
  });
});
