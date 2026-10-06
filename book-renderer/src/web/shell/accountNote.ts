import type { HandoffState } from '../auth/handoffController';

/**
 * The small account line a header carries after an app -> shop handoff:
 * "Signed in as j•••@gmail.com · Not you?" (only while the current session is
 * still that handoff's user), or -- the link failed while another account is
 * signed in -- a dismissible "still signed in as …" notice. Pure.
 */
export type AccountNote =
  | { kind: 'signedIn'; message: string; actionLabel: 'Not you?' }
  | { kind: 'failed'; message: string; actionLabel: 'Dismiss' };

export function accountNote(handoff: HandoffState, session: { userId: string; email: string | null } | null): AccountNote | null {
  if (!session) return null;
  if (handoff.phase === 'signedIn' && handoff.userId === session.userId) {
    return { kind: 'signedIn', message: `Signed in as ${handoff.maskedEmail}`, actionLabel: 'Not you?' };
  }
  if (handoff.phase === 'failed') {
    return {
      kind: 'failed',
      message: session.email ? `That sign-in link expired — you're still signed in as ${session.email}.` : "That sign-in link expired — you're still signed in.",
      actionLabel: 'Dismiss',
    };
  }
  return null;
}
