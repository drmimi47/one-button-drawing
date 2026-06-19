import { useState, type FormEvent } from 'react';
import styles from './LoginModal.module.css';
import { signInEmail, signUpEmail, AuthError } from '../../auth/auth';

interface LoginModalProps {
  /** Continue without an account (closes the modal for the session, no saving). */
  onGuest: () => void;
  /** Whether Firebase is configured; when false the form is disabled and only Guest works. */
  enabled: boolean;
}

/**
 * First-visit sign-in gate for "Atom". Email/password via Firebase Auth; a successful
 * sign-in/up is observed by `useAuth` in App, which unmounts this modal. "Guest" skips
 * sign-in (no per-account saving). It's a gate: the dim backdrop does NOT dismiss it.
 */
export function LoginModal({ onGuest, enabled }: LoginModalProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !enabled || !email || !password) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') await signUpEmail(email, password);
      else await signInEmail(email, password);
      // On success the auth listener in App flips `user` and unmounts the modal.
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <>
      <div className={styles.backdrop} aria-hidden="true" />
      <div className={styles.card} role="dialog" aria-modal="true" aria-label="Sign in to Atom">
        <div className={styles.header}>
          <img src="/atom-black-48.png" alt="" className={styles.logo} />
          <span className={styles.brand}>Atom</span>
        </div>

        <form className={styles.form} onSubmit={submit}>
          <input
            type="email"
            className={styles.input}
            placeholder="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy || !enabled}
          />
          <input
            type="password"
            className={styles.input}
            placeholder="Password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || !enabled}
          />

          {error && <div className={styles.error}>{error}</div>}
          {!enabled && (
            <div className={styles.note}>
              Sign-in isn’t configured yet. Continue as a guest, or set up Firebase (see README).
            </div>
          )}

          <button
            type="submit"
            className={styles.primary}
            disabled={busy || !enabled || !email || !password}
          >
            {busy
              ? mode === 'signup'
                ? 'Creating…'
                : 'Signing in…'
              : mode === 'signup'
                ? 'Create account'
                : 'Sign in'}
          </button>
        </form>

        <button type="button" className={styles.guest} onClick={onGuest} disabled={busy}>
          Guest
        </button>

        <div className={styles.links}>
          {mode === 'signin' ? (
            <>
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  setMode('signup');
                  setError('');
                }}
                disabled={!enabled}
              >
                Sign up
              </button>
              <span className={styles.dot}>·</span>
              <button
                type="button"
                className={styles.link}
                title="Password reset isn’t available yet"
                onClick={() => setError('Password reset isn’t available yet — contact an admin.')}
                disabled={!enabled}
              >
                Reset Password
              </button>
            </>
          ) : (
            <>
              <span className={styles.muted}>Already have an account?</span>
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  setMode('signin');
                  setError('');
                }}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
