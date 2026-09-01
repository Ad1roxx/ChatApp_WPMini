/**
 * Badge — a small status or category label.
 *
 * `RoleBadge` is exported alongside it because the student/mentor badge
 * appears on six screens and had drifted into three slightly different
 * inline versions. One definition, one appearance.
 */

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
  if (!role) return null;

  const isMentor = role === 'mentor';

  return (
    <Badge variant={isMentor ? 'accent' : 'neutral'} className={className}>
      {isMentor ? 'Mentor' : 'Student'}
    </Badge>
  );
}
