/* eslint-disable react-refresh/only-export-components --
 * Exports the ToastProvider component and the useToast hook together, the
 * same context pattern as AuthContext. Splitting the hook into its own module
 * purely to satisfy Fast Refresh would scatter one small feature over two
 * files.
 */

/**
 * Toasts — the replacement for `alert()`.
 *
 * The app had nine `alert()` calls. They block the whole page until
 * dismissed, can't be styled, look like a browser error, and on some mobile
 * browsers say "localhost:5173 says". Nothing makes an app look unfinished
 * faster.
 *
 * Usage:
 *
 *   const toast = useToast();
 *   toast.error('Could not save your profile');
 *   toast.success('Profile saved');
 *
 * Notes on the details:
 *
 * - The container is `aria-live="polite"`, so a screen reader announces new
 *   messages without the user having to go looking. `alert()` got that for
 *   free; a custom toast has to ask for it.
 * - Errors stay up longer than successes (6s vs 3.5s). A success is a
 *   confirmation you already expected; an error is something you have to read
 *   and act on.
 * - Each toast can be dismissed early, and its timer is cleared on unmount so
 *   a pending timeout can't fire against an unmounted component.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import styles from './Toast.module.css';

const ToastContext = createContext(null);

const DURATION = { success: 3500, error: 6000, info: 4500 };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));

    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant, message) => {
      if (!message) return;

      // crypto.randomUUID is available in every browser this app targets, but
      // fall back rather than risk a crash inside an error handler — which is
      // exactly when toasts get used.
      const id =
        globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

      setToasts((prev) => [...prev, { id, variant, message }]);

      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION[variant] ?? DURATION.info)
      );
    },
    [dismiss]
  );

  // Clear every pending timer if the provider itself unmounts
  const timersRef = timers;
  useEffect(() => {
    const map = timersRef.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, [timersRef]);

  const api = useMemo(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message)
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div className={styles.viewport} role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={[styles.toast, styles[toast.variant]].join(' ')}>
            <span className={styles.message}>{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className={styles.dismiss}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }

  return context;
}
