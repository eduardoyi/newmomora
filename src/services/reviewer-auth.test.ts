import { isReviewerEmail, normalizeEmail, REVIEWER_EMAIL } from '@/services/reviewer-auth';

describe('reviewer auth', () => {
  it('normalizes whitespace and casing before matching the dedicated reviewer email', () => {
    expect(normalizeEmail('  HELLO+TESTING@USEMOMORA.COM  ')).toBe(REVIEWER_EMAIL);
    expect(isReviewerEmail('  HELLO+TESTING@USEMOMORA.COM  ')).toBe(true);
  });

  it('does not match other email addresses', () => {
    expect(isReviewerEmail('parent@example.com')).toBe(false);
  });
});
