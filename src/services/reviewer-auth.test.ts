import {
  DEMO_EMAIL,
  isPasswordLoginEmail,
  normalizeEmail,
  REVIEWER_EMAIL,
} from '@/services/reviewer-auth';

describe('guarded password auth', () => {
  it('normalizes whitespace and casing before matching the dedicated reviewer email', () => {
    expect(normalizeEmail('  HELLO+TESTING@USEMOMORA.COM  ')).toBe(REVIEWER_EMAIL);
    expect(isPasswordLoginEmail('  HELLO+TESTING@USEMOMORA.COM  ')).toBe(true);
  });

  it('allows the screenshot demo account through the guarded password flow', () => {
    expect(isPasswordLoginEmail('  HELLO+DEMO@USEMOMORA.COM  ')).toBe(true);
    expect(DEMO_EMAIL).toBe('hello+demo@usemomora.com');
  });

  it('does not match other email addresses', () => {
    expect(isPasswordLoginEmail('parent@example.com')).toBe(false);
  });
});
