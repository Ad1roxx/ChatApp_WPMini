/* eslint-disable react-refresh/only-export-components --
 * Provider and hook in one file, the same way AuthContext and
 * ConversationsContext do it: that is the standard context pattern, and
 * splitting the hook out purely to satisfy Fast Refresh would scatter one
 * coherent piece of the app across two modules.
 */

/**
 * WorkContext — how much assignment work is waiting on you
 *
 * The sidebar draws a count beside "Assignments" on every page, so the number
 * has to live above the router rather than inside the page that happens to be
 * open. Without it, work set for a student is silent until they think to go
 * and look.
 *
 * Two figures, because one person can be on both sides of the desk:
 *
 *   owed      set for you and not handed in — including a draft, which is
 *             attached but not handed in, and work sent back for changes
 *   toReview  handed in to you, waiting on your answer
 *
 * The badge shows their sum. They are counted by the server rather than
 * derived from a list here, so the shell never has to fetch every assignment
 * to draw one number.
 *
 * `assignment-changed` carries only an id, deliberately: what changed and how
 * many are now waiting are different questions, so this refetches the counts
 * rather than trying to patch them from the event.
 */

import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useAuth } from './AuthContext';

const WorkContext = createContext(null);

export function WorkProvider({ children }) {
  const { dbUser, socket, authFetch } = useAuth();
  const [counts, setCounts] = useState({ owed: 0, toReview: 0 });

  useEffect(() => {
    if (!dbUser) return undefined;

    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch('/api/assignments/counts');
        if (res.ok && !stale) setCounts(await res.json());
      } catch (err) {
        console.error('Error loading assignment counts:', err);
      }
    };

    load();
    if (!socket) {
      return () => {
        stale = true;
      };
    }

    socket.on('assignment-changed', load);
    return () => {
      stale = true;
      socket.off('assignment-changed', load);
    };
  }, [dbUser, authFetch, socket]);

  const value = useMemo(
    () => ({ ...counts, total: counts.owed + counts.toReview }),
    [counts]
  );

  return <WorkContext.Provider value={value}>{children}</WorkContext.Provider>;
}

/**
 * Safe outside the provider: the login and role-picker screens render before
 * it mounts, and a sidebar badge is not worth a crash.
 */
export function useWork() {
  return useContext(WorkContext) || { owed: 0, toReview: 0, total: 0 };
}
