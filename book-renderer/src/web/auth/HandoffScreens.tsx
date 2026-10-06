import { handoffController } from './handoffRuntime';
import { signOut } from './useAuthSession';
import './LoginScreen.css';
import './HandoffChip.css';

/** Shown while the handoff is being redeemed / verified. No route or login mounts meanwhile. */
export function SigningYouIn() {
  return (
    <div className="app-boot" role="status" aria-live="polite">
      <p>Signing you in…</p>
    </div>
  );
}

/**
 * Always asked before a handoff signs anyone in (login-CSRF defence: a crafted
 * link must not silently sign a victim in as someone else). With a different
 * account already signed in, the alternative is staying as that account; with
 * no session it is the normal email-code login.
 */
export function ConfirmSwitchAccount({
  maskedEmail,
  currentEmail,
  hasSession,
}: {
  maskedEmail: string;
  currentEmail: string | null;
  hasSession: boolean;
}) {
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card__wordmark">
          Momora<span className="login-card__wordmark-dot">.</span>
        </div>
        <h1 className="login-card__title">Continue as {maskedEmail}?</h1>
        <p className="login-card__subtitle">
          {!hasSession
            ? 'You tapped a sign-in link from the Momora app.'
            : currentEmail
              ? `This browser is signed in as ${currentEmail}.`
              : 'This browser is signed in to a different account.'}
        </p>
        <button type="button" className="login-card__button" onClick={handoffController.confirmSwitch}>
          Continue as {maskedEmail}
        </button>
        <button
          type="button"
          className="login-card__button login-card__button--ghost"
          onClick={handoffController.declineSwitch}
        >
          {!hasSession ? 'Use a different account' : currentEmail ? `Stay signed in as ${currentEmail}` : 'Stay signed in'}
        </button>
      </div>
    </div>
  );
}

/** Small "Signed in as … · Not you?" chip shown after a successful handoff. */
export function SignedInChip({ maskedEmail }: { maskedEmail: string }) {
  async function handleNotYou() {
    await signOut();
    handoffController.reset();
  }

  return (
    <div className="handoff-chip" role="status">
      <span className="handoff-chip__text">Signed in as {maskedEmail}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="handoff-chip__action" onClick={() => void handleNotYou()}>
        Not you?
      </button>
      <button
        type="button"
        className="handoff-chip__close"
        aria-label="Dismiss"
        onClick={handoffController.reset}
      >
        ×
      </button>
    </div>
  );
}

/** A handoff failed while another account is signed in: say so, dismissibly. */
export function HandoffFailedNotice({ currentEmail }: { currentEmail: string | null }) {
  return (
    <div className="handoff-chip handoff-chip--notice" role="status">
      <span className="handoff-chip__text">
        {currentEmail
          ? `That sign-in link expired — you're still signed in as ${currentEmail}`
          : "That sign-in link expired — you're still signed in"}
      </span>
      <button
        type="button"
        className="handoff-chip__close"
        aria-label="Dismiss"
        onClick={handoffController.reset}
      >
        ×
      </button>
    </div>
  );
}
