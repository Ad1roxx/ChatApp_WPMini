/**
 * Card — the standard surface for a block of content.
 *
 * `title` renders a header row with a bottom border; `actions` puts controls
 * on the right of that row. Both optional, so a bare <Card> is just a padded
 * white surface.
 *
 * `padded={false}` is for content that needs to run to the edge — a list whose
 * rows have their own padding and dividers, for example.
 */

import styles from './Card.module.css';

export default function Card({
  title,
  subtitle,
  actions,
  padded = true,
  className = '',
  children,
  ...rest
}) {
  const hasHeader = Boolean(title || actions);

  return (
    <section className={[styles.card, className].filter(Boolean).join(' ')} {...rest}>
      {hasHeader && (
        <header className={styles.header}>
          <div className={styles.headings}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={padded ? styles.body : styles.bodyFlush}>{children}</div>
    </section>
  );
}
