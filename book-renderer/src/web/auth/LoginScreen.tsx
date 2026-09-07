import { useState, type FormEvent } from 'react';
import { requestSignInOtp, verifyEmailOtp } from './useAuthSession';
import './LoginScreen.css';

const RESEND_COOLDOWN_SECONDS = 60;

type Step = { kind: 'email' } | { kind: 'code'; email: string };

/**
 * Sign-in for an EXISTING Momora account (email OTP code) — mirrors the
 * app's own two-screen flow (`app/(auth)/login.tsx` + `.../verify-otp.tsx`,
 * `src/hooks/use-auth.tsx`) collapsed into one component since this app has
 * no navigation stack of its own (plan Design Decision 1: a third Vite
 * entry, not a framework with routing).
 */
export function LoginScreen() {
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  async function handleRequestCode(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError('');
    const { error: reqError } = await requestSignInOtp(email);
    setBusy(false);
    if (reqError) {
      setError(reqError);
      return;
    }
    setStep({ kind: 'code', email: email.trim() });
    startCooldown();
  }

  function startCooldown() {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    const timer = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  async function handleVerify(candidate: string, currentEmail: string) {
    if (candidate.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    const { error: verifyError } = await verifyEmailOtp(currentEmail, candidate);
    setBusy(false);
    if (verifyError) {
      setError(verifyError);
      return;
    }
    // No further routing needed — App.tsx's auth gate re-renders on the
    // supabase-js session change this triggers.
  }

  async function handleResend(currentEmail: string) {
    if (cooldown > 0 || busy) return;
    setBusy(true);
    setError('');
    const { error: reqError } = await requestSignInOtp(currentEmail);
    setBusy(false);
    if (reqError) {
      setError(reqError);
      return;
    }
    setCode('');
    startCooldown();
  }

  if (step.kind === 'email') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-card__wordmark">
            Momora<span className="login-card__wordmark-dot">.</span>
          </div>
          <h1 className="login-card__title">Sign in to your Memory Book</h1>
          <p className="login-card__subtitle">Use the email address for your Momora family account.</p>
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
            <button type="submit" className="login-card__button" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
          <p className="login-card__hint">
            New to Momora? Create your family and start a book from the Momora app first.
          </p>
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
          disabled={cooldown > 0 || busy}
          onClick={() => void handleResend(step.email)}
        >
          {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
        </button>
        <button type="button" className="login-card__link" onClick={() => setStep({ kind: 'email' })}>
          Wrong email? Go back
        </button>
      </div>
    </div>
  );
}
