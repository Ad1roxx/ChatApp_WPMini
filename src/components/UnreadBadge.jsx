/**
 * UnreadBadge — the count pill
 *
 * Not the general `Badge`: that one is a label that happens to be small, and
 * this is a number that has to stay circular at one digit and grow into a
 * pill at three. Different job, different component.
 *
 * `max` caps the digits — past a point the exact number stops being
 * information and starts being a layout problem, which is why every messaging
 * app shows "99+". The real figure still goes in the accessible label, since
 * a screen reader has no layout to protect.
 *
 * Renders nothing at zero rather than a "0", so callers can pass the count
 * unconditionally.
 */

import styles from './UnreadBadge.module.css';

export default function UnreadBadge({ count = 0, max = 99, label = 'unread', className = '' }) {
  if (!count) return null;

  return (
    <span
      className={[styles.badge, className].filter(Boolean).join(' ')}
      aria-label={`${count} ${label}`}
      title={`${count} ${label}`}
    >
      <span aria-hidden="true">{count > max ? `${max}+` : count}</span>
    </span>
  );
}
