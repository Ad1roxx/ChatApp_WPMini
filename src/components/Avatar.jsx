/**
 * Avatar — photo with an initial-letter fallback, and an optional presence dot.
 *
 * `presence` takes `true` / `false` / `undefined`. Undefined means "we don't
 * track presence here" and renders no dot at all, which is different from
 * `false` meaning "offline". That distinction matters: an announcement author
 * shouldn't get a grey dot implying they're offline when we simply never
 * asked.
 *
 * The `onError` fallback handles Google photo URLs that 403 — those expire,
 * and without it you get a broken-image icon rather than the initial.
 */

import { useState } from 'react';
import styles from './Avatar.module.css';

export default function Avatar({
  src,
  name = '',
  size = 'md',
  presence,
  className = ''
}) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const showImage = src && !failed;

  return (
    <span className={[styles.wrapper, styles[size], className].filter(Boolean).join(' ')}>
      {showImage ? (
        <img
          src={src}
          alt=""
          className={styles.image}
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className={styles.fallback} aria-hidden="true">
          {initial}
        </span>
      )}

      {presence !== undefined && (
        <span
          className={[styles.dot, presence ? styles.online : styles.offline].join(' ')}
          title={presence ? 'Online' : 'Offline'}
        />
      )}
    </span>
  );
}
