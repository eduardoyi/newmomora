import { useEffect, useRef, useState, type FormEvent } from 'react';
import { requestSignInOtp, verifyEmailOtp } from './useAuthSession';
import { friendlyAuthError, loginCopyForPath } from './authCopy';
import { clearLoginStep, getSessionStepStorage, loadLoginStep, saveLoginStep, type LoginStep } from './loginStep';
import { useDocumentTitle } from '../useDocumentTitle';
import './LoginScreen.css';

const RESEND_COOLDOWN_SECONDS = 60;

type Step = LoginStep;

/** A seconds countdown (ticks once a second, cleaned up on unmount). */
function useCountdown(): [number, (seconds: number) => void] {
  const [remaining, setRemaining] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  function start(seconds: number) {
    if (timer.current) clearInterval(timer.current);
    setRemaining(seconds);
    const interval = setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          clearInterval(interval);
          if (timer.current === interval) timer.current = null;
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    timer.current = interval;
  }

  return [remaining, start];
}

/**
 * Sign-in for an EXISTING Momora account (email OTP code) — mirrors the
 * app's own two-screen flow (`app/(auth)/login.tsx` + `.../verify-otp.tsx`,
 * `src/hooks/use-auth.tsx`) collapsed into one component since this app has
 * no navigation stack of its own (plan Design Decision 1: a third Vite
 * entry, not a framework with routing).
 *
 * `notice` is a banner above the form (e.g. a failed app -> shop sign-in
 * handoff: "That sign-in link expired — enter your email to get a code"). The
 * step (email form vs. code entry) is kept in sessionStorage so a reload after
 * switching to the Mail app resumes at the code step.
 */
export function LoginScreen({ notice }: { notice?: string } = {}) {
  const [step, setStepState] = useState<Step>(() => loadLoginStep(getSessionStepStorage()));
  const [email, setEmail] = useState(() => {
    const restored = loadLoginStep(getSessionStepStorage());
    return restored.kind === 'code' ? restored.email : '';
  });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Resend cooldown after a send, and a separate wait after GoTrue's "you can
  // only request this after N seconds" rate limit.
  const copy = loginCopyForPath(typeof window !== 'undefined' ? window.location.pathname : '/');
  useDocumentTitle('Sign in · Momora');
  const [cooldown, startCooldown] = useCountdown();
  const [rateWait, startRateWait] = useCountdown();

  function setStep(next: Step) {
    setStepState(next);
    saveLoginStep(getSessionStepStorage(), next);
  }

  async function handleRequestCode(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError('');
    const { error: reqError } = await requestSignInOtp(email);
    setBusy(false);
    if (reqError) {
      showAuthError(reqError);
      return;
    }
    setStep({ kind: 'code', email: email.trim() });
    startCooldown(RESEND_COOLDOWN_SECONDS);
  }

  /** GoTrue's "you can only request this after N seconds" gets friendly copy and a countdown. */
  function showAuthError(message: string) {
    const friendly = friendlyAuthError(message);
    setError(friendly.message);
    if (friendly.waitSeconds !== null) startRateWait(friendly.waitSeconds);
  }

  async function handleVerify(candidate: string, currentEmail: string) {
    if (candidate.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    const { error: verifyError } = await verifyEmailOtp(currentEmail, candidate);
    setBusy(false);
    if (verifyError) {
      showAuthError(verifyError);
      return;
    }
    clearLoginStep(getSessionStepStorage());
    // No further routing needed — App.tsx's auth gate re-renders on the
    // supabase-js session change this triggers.
  }

  async function handleResend(currentEmail: string) {
    if (cooldown > 0 || rateWait > 0 || busy) return;
    setBusy(true);
    setError('');
    const { error: reqError } = await requestSignInOtp(currentEmail);
    setBusy(false);
    if (reqError) {
      showAuthError(reqError);
      return;
    }
    setCode('');
    startCooldown(RESEND_COOLDOWN_SECONDS);
  }

  if (step.kind === 'email') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-card__wordmark">
            Momora<span className="login-card__wordmark-dot">.</span>
          </div>
          {notice && (
            <p className="login-card__notice" role="status">
              {notice}
            </p>
          )}
          <h1 className="login-card__title">{copy.title}</h1>
          <p className="login-card__subtitle">{copy.subtitle}</p>
          <form onSubmit={handleRequestCode} className="login-card__form">
            <label className="login-field">
              <span className="login-field__label">Email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="login-field__input"
                placeholder="you@example.com"
              />
            </label>
            {error && <p className="login-card__error">{error}</p>}
            <button type="submit" className="login-card__button" disabled={busy || rateWait > 0}>
              {busy ? 'Sending…' : rateWait > 0 ? `Try again in ${rateWait}s` : 'Send code'}
            </button>
          </form>
          <p className="login-card__hint">{copy.hint}</p>
        </div>
      </div>
    );
  }

  const digits = Array.from({ length: 6 }, (_, i) => code[i] ?? '');

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card__wordmark">
          Momora<span className="login-card__wordmark-dot">.</span>
        </div>
        {notice && (
          <p className="login-card__notice" role="status">
            {notice}
          </p>
        )}
        <h1 className="login-card__title">Check your email</h1>
        <p className="login-card__subtitle">Enter the 6-digit code we sent to {step.email}.</p>

        <div className="login-code-wrap">
          <div className="login-code" aria-hidden="true">
            {digits.map((d, i) => (
              <div key={i} className={`login-code__box${d ? ' login-code__box--filled' : ''}`}>
                {d}
              </div>
            ))}
          </div>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            value={code}
            onChange={(e) => {
              const digitsOnly = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
              setCode(digitsOnly);
              setError('');
              if (digitsOnly.length === 6) void handleVerify(digitsOnly, step.email);
            }}
            className="login-code__input"
            aria-label="6-digit verification code"
          />
        </div>

        {error && <p className="login-card__error">{error}</p>}
        {busy && <p className="login-card__hint">Verifying…</p>}

        <button
          type="button"
          className="login-card__button login-card__button--ghost"
          disabled={cooldown > 0 || rateWait > 0 || busy}
          onClick={() => void handleResend(step.email)}
        >
          {cooldown > 0 || rateWait > 0 ? `Resend code (${Math.max(cooldown, rateWait)}s)` : 'Resend code'}
        </button>
        <button type="button" className="login-card__link" onClick={() => setStep({ kind: 'email' })}>
          Wrong email? Go back
        </button>
      </div>
    </div>
  );
}
