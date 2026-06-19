import { useEffect, useState } from 'react';
import { subscribeAuth, type User } from './auth';

/**
 * Tracks the Firebase auth session. `authResolved` flips true once the first auth state
 * (a restored session or null) has arrived — gating the login modal so a remembered user
 * never sees it flash. When Firebase is disabled, `subscribeAuth` resolves immediately with
 * a null user, so the modal can show right away (in its "not configured" state).
 */
export function useAuth(): { user: User | null; authResolved: boolean } {
  const [user, setUser] = useState<User | null>(null);
  const [authResolved, setAuthResolved] = useState(false);

  useEffect(() => {
    const unsub = subscribeAuth((u) => {
      setUser(u);
      setAuthResolved(true);
    });
    return unsub;
  }, []);

  return { user, authResolved };
}
