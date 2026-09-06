/**
 * Progress — a linear meter for "n of m done".
 *
 * Takes `done` and `total` rather than a percentage, because the caller
 * always has the counts and the component needs them anyway: 0 of 0 must
 * render as empty rather than as NaN or as 100%, and only the raw numbers
 * make that distinction possible.
 *
 * Exposed as a real `progressbar` to assistive technology, with the label
 * naming what is being measured — a bare percentage announced on its own
 * tells a screen-reader user nothing about what it refers to.
 */

import styles from './Progress.module.css';

export default function Progress({ done = 0, total = 0, label, showCount = true }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const complete = total > 0 && done === total;

  return (
    <div className={styles.wrap}>
      {(label || showCount) && (
        <div className={styles.head}>
          {label && <span className={styles.label}>{label}</span>}
          {showCount && (
            <span className={styles.count}>
              {total === 0 ? 'No milestones' : `${done} of ${total}`}
            </span>
          )}
        </div>
      )}

      <div
        className={styles.track}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ? `${label}: ${percent}% complete` : `${percent}% complete`}
      >
        <div
          className={[styles.fill, complete ? styles.fillComplete : '']
            .filter(Boolean)
            .join(' ')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
