/** Guarded production fixture accounts allowed through the password screen. */
export const REVIEWER_EMAIL = 'hello+testing@usemomora.com';
export const DEMO_EMAIL = 'hello+demo@usemomora.com';

const PASSWORD_LOGIN_EMAILS = new Set([REVIEWER_EMAIL, DEMO_EMAIL]);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPasswordLoginEmail(email: string): boolean {
  return PASSWORD_LOGIN_EMAILS.has(normalizeEmail(email));
}
