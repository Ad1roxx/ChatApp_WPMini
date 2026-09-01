/**
 * Spinner and PageLoader.
 *
 * Every page had its own copy of a loading div; three of them differed only
 * in wording. `PageLoader` is the full-screen one used while auth resolves,
 * `Spinner` the inline one.
 *
 * `role="status"` plus a visually-hidden label means a screen reader
 * announces that something is loading — a bare spinning div announces
 * nothing at all.
 */

import styles from './Loading.module.css';

export function Spinner({ size = 'md', className = '' }) {
  return (
    <span
      className={[styles.spinner, styles[size], className].filter(Boolean).join(' ')}
      aria-hidden="true"
    />
  );
}

export function PageLoader({ label = 'Loading' }) {
  return (
    <div className={styles.page} role="status">
      <Spinner size="lg" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function InlineLoader({ label = 'Loading' }) {
  return (
    <div className={styles.inline} role="status">
      <Spinner size="sm" />
      <span className={styles.inlineLabel}>{label}</span>
    </div>
  );
}
