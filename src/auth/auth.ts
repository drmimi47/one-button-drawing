import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { auth, firebaseEnabled } from './firebase';

export type { User };

/** Thrown by the sign-in/up wrappers with a human-readable message for the modal. */
export class AuthError extends Error {}

/** Map a Firebase auth error code to a short, friendly sentence. */
function friendly(err: unknown): AuthError {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return new AuthError('That email address looks invalid.');
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return new AuthError('Incorrect email or password.');
    case 'auth/email-already-in-use':
      return new AuthError('An account with that email already exists.');
    case 'auth/weak-password':
      return new AuthError('Password should be at least 6 characters.');
    case 'auth/too-many-requests':
      return new AuthError('Too many attempts — please wait a moment and try again.');
    case 'auth/network-request-failed':
      return new AuthError('Network error — check your connection.');
    default:
      return new AuthError('Something went wrong. Please try again.');
  }
}

/** Sign in an existing user. Rejects with an {@link AuthError} on failure. */
export async function signInEmail(email: string, password: string): Promise<void> {
  if (!auth) throw new AuthError('Sign-in is not configured.');
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  } catch (err) {
    throw friendly(err);
  }
}

/** Create a new account, which also signs the user in. */
export async function signUpEmail(email: string, password: string): Promise<void> {
  if (!auth) throw new AuthError('Sign-in is not configured.');
  try {
    await createUserWithEmailAndPassword(auth, email.trim(), password);
  } catch (err) {
    throw friendly(err);
  }
}

/** Sign the current user out (no-op when Firebase isn't configured). */
export async function signOutUser(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

/**
 * Subscribe to auth-state changes. `cb` fires once on subscribe with the restored session
 * (or null), then on every sign-in/out. Returns an unsubscribe fn. When Firebase is off it
 * reports "no user, resolved" immediately so the app doesn't wait forever.
 */
export function subscribeAuth(cb: (user: User | null) => void): () => void {
  if (!firebaseEnabled || !auth) {
    cb(null);
    return () => {};
  }
  return onAuthStateChanged(auth, cb);
}
