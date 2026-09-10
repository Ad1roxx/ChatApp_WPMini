/**
 * Achievements — earned from what actually happened
 *
 * Nothing here is stored. Every badge is a predicate over figures the app
 * already keeps — goals completed, sessions met, minutes, ratings — and the
 * server recomputes them on every read. That is the only version that cannot
 * lie: a persisted award drifts the moment the thing underneath it changes,
 * and a badge describing something no longer true is worse than no badge.
 *
 * Locked ones are shown with their progress rather than hidden. "7 of 10" is
 * an invitation; a grey square with no number is a locked door, and a wall of
 * them is just a reminder of what you have not done.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import Card from './Card';
import Progress from './Progress';
import { InlineLoader } from './Loading';
import { TrophyIcon } from './Icons';
import styles from './Achievements.module.css';

export default function Achievements() {
  const { authFetch } = useAuth();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch('/api/achievements/me');
        if (res.ok && !stale) setData(await res.json());
      } catch (err) {
        console.error('Error loading achievements:', err);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load();
    return () => {
      stale = true;
    };
  }, [authFetch]);

  if (loading) {
    return (
      <Card title="Achievements">
        <InlineLoader label="Counting" />
      </Card>
    );
  }

  const list = data?.achievements || [];
  if (list.length === 0) return null;

  const earned = list.filter((a) => a.earned);

  return (
    <Card
      title="Achievements"
      subtitle={
        earned.length > 0
          ? `${earned.length} of ${list.length} earned`
          : 'Earned from goals finished and sessions met — nothing to collect'
      }
    >
      <ul className={styles.grid}>
        {list.map((a) => (
          <li
            key={a.id}
            className={[styles.badge, a.earned ? styles.earned : styles.locked]
              .filter(Boolean)
              .join(' ')}
          >
            <span className={styles.icon} aria-hidden="true">
              <TrophyIcon size={18} />
            </span>

            <div className={styles.body}>
              <span className={styles.name}>{a.name}</span>
              <span className={styles.description}>{a.description}</span>

              {/* Earned badges say so in words rather than showing a full
                  bar: "5 of 5" beside a finished thing is arithmetic nobody
                  needs, and the label is what carries meaning to a reader who
                  cannot see the colour change. */}
              {a.earned ? (
                <span className={styles.done}>Earned</span>
              ) : (
                <div className={styles.meter}>
                  {/* `showCount` off: it would print a second, raw "270 of
                      300" beside a label that already reads "4h of 5h". The
                      label is the one in units a person can hold. */}
                  <Progress
                    done={a.progress}
                    total={a.target}
                    label={a.label}
                    showCount={false}
                  />
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
