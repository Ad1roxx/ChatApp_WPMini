/**
 * Button
 *
 * Variants:
 * - `primary`   charcoal, for the one main action on a screen
 * - `secondary` bordered white, for everything else
 * - `ghost`     no chrome until hovered, for toolbars and nav
 * - `danger`    destructive actions
 *
 * The accent colour is deliberately NOT used for primary buttons — it's
 * reserved for state (active nav, links, progress). Accent-coloured buttons
 * on every screen is the thing that makes an interface look generated.
 */

import styles from './Button.module.css';

export default function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.fullWidth : '',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      // A loading button must not be clickable twice
      disabled={disabled || loading}
      // Tells screen readers the control is busy rather than just dead
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}
