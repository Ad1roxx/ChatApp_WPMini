/**
 * Stat / StatGrid — a number worth reading on its own
 *
 * The right form for a single magnitude is not a chart, it is the number at a
 * size you can read across a room. These were living in AdminPage's stylesheet;
 * the progress page needed the same tile, and copying thirty lines of CSS into
 * a second module is how a design system starts to drift.
 *
 * `sub` is for the denominator or the qualifier — "of 12", "this week" —
 * because a bare number often lies by omission. It stays visually quieter than
 * the label so the tile still reads value → label → context.
 */

import styles from './Stat.module.css';

/** Auto-fitting row of tiles. `min` sets how narrow one may get before wrapping. */
export function StatGrid({ min = 120, children }) {
  return (
    <div className={styles.grid} style={{ '--stat-min': `${min}px` }}>
      {children}
    </div>
  );
}

export default function Stat({ value, label, sub }) {
  return (
    <div className={styles.stat}>
      <span className={styles.value}>{value}</span>
      <span className={styles.label}>{label}</span>
      {sub && <span className={styles.sub}>{sub}</span>}
    </div>
  );
}
