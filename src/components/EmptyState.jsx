/**
 * EmptyState — what a list shows when it has nothing in it.
 *
 * Worth having as a component rather than an ad-hoc paragraph: an empty
 * screen is the first thing a new user sees, and "No groups yet" alone tells
 * them nothing about what to do next. `action` is where the way out goes.
 */

import styles from './EmptyState.module.css';

export default function EmptyState({ icon, title, description, action, className = '' }) {
  return (
    <div className={[styles.empty, className].filter(Boolean).join(' ')}>
      {icon && (
        <div className={styles.icon} aria-hidden="true">
          {icon}
        </div>
      )}
      <p className={styles.title}>{title}</p>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
