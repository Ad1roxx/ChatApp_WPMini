/**
 * Stars — a five-point rating, read or written
 *
 * One component for both, because they are the same scale and drifting apart
 * is how a 4 comes to look like a different thing depending on the page.
 * Pass `onChange` and it becomes an input; leave it off and it is a label.
 *
 * ## The input is a real radio group
 *
 * Five radios, visually hidden, with the star as their label. That is what
 * makes it arrow-key operable, announced as "3 of 5 stars, radio button", and
 * submittable — none of which a row of clickable `<span>`s gives you, and all
 * of which someone would otherwise have to rebuild with `role` and `tabIndex`
 * and get subtly wrong.
 *
 * ## Halves are displayed but never entered
 *
 * An average of 4.3 is real and worth showing, so display mode fills a
 * partial star. Input mode is integers only: a person pressing stars does not
 * mean 3.5, and letting them express it would be false precision at the point
 * of collection.
 */

import { useId } from 'react';
import styles from './Stars.module.css';

const POINTS = [1, 2, 3, 4, 5];

/** One star, filled by `fill` (0–1). The clip is what makes halves possible. */
function Star({ fill = 0 }) {
  return (
    <span className={styles.star} aria-hidden="true">
      <span className={styles.starEmpty}>★</span>
      <span className={styles.starFill} style={{ width: `${fill * 100}%` }}>
        ★
      </span>
    </span>
  );
}

export default function Stars({
  value = 0,
  onChange,
  size = 'md',
  label = 'Rating',
  className = ''
}) {
  const name = useId();
  const interactive = typeof onChange === 'function';
  const classes = [styles.stars, styles[size], className].filter(Boolean).join(' ');

  if (!interactive) {
    return (
      <span
        className={classes}
        role="img"
        aria-label={value ? `${value} out of 5` : 'Not rated'}
      >
        {POINTS.map((p) => (
          // 4.3 fills the fifth star 30% of the way, not at all beyond it.
          <Star key={p} fill={Math.max(0, Math.min(1, value - p + 1))} />
        ))}
      </span>
    );
  }

  return (
    <span className={classes} role="radiogroup" aria-label={label}>
      {POINTS.map((p) => (
        <label key={p} className={styles.option}>
          <input
            type="radio"
            name={name}
            value={p}
            checked={value === p}
            onChange={() => onChange(p)}
            className={styles.radio}
          />
          <span className={styles.srOnlyLabel}>
            {p} star{p === 1 ? '' : 's'}
          </span>
          <Star fill={value >= p ? 1 : 0} />
        </label>
      ))}
    </span>
  );
}
