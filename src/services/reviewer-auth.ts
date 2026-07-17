/**
 * The sole production account allowed through the password screen. The email
 * is intentionally not a secret; its password is never bundled with the app.
 */
export const REVIEWER_EMAIL = 'hello+testing@usemomora.com';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isReviewerEmail(email: string): boolean {
  return normalizeEmail(email) === REVIEWER_EMAIL;
}
