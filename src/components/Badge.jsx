/**
 * Badge — a small status or category label.
 *
 * `RoleBadge` is exported alongside it because the student/mentor badge
 * appears on six screens and had drifted into three slightly different
 * inline versions. One definition, one appearance.
 */

import { roleLabel } from '../lib/roles';
import styles from './Badge.module.css';

export default function Badge({ variant = 'neutral', className = '', children, ...rest }) {
  return (
    <span
      className={[styles.badge, styles[variant], className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </span>
  );
}

/**
 * The one place the student/mentor label is defined.
 *
 * Renders nothing when `role` is missing — accounts created before roles
 * existed have none until their owner next signs in and hits the picker, and
 * an empty badge outline would look like a bug.
 */
export function RoleBadge({ role, className = '' }) {
  const label = roleLabel(role);
  if (!label) return null;

  // Admin gets its own colour so it is not mistaken for a mentor at a glance —
  // it is a different kind of thing, not a bigger mentor.
  const variant = role === 'admin' ? 'warning' : role === 'mentor' ? 'accent' : 'neutral';

  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}
