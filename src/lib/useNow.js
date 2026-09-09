/**
 * useNow — the clock, as state.
 *
 * Reading `Date.now()` while rendering makes a component impure: the same
 * props produce different output, and React's compiler rules reject it.
 * Holding the time in state fixes that and buys something real — a relative
 * label like "in 2 minutes" turns into "2 minutes ago" on its own, and a
 * session moves from Upcoming to Past without anyone refreshing the page.
 *
 * A minute is the resolution these labels are written at, so ticking faster
 * would re-render for nothing.
 *
 * It lived inside Sessions.jsx until the progress page needed the same thing.
 */

import { useState, useEffect } from 'react';

export default function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

/**
 * "in 3 days" / "2 hours ago", from the largest unit that fits.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder of strings: it
 * gets "tomorrow" and "last month" right for free, and it is built in.
 *
 * `now` is passed in rather than read here, so this stays a pure function of
 * its arguments — pair it with the hook above.
 */
export function relative(date, now) {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const mins = Math.round((date.getTime() - now) / 60000);

  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, 'day');
  return rtf.format(Math.round(days / 30), 'month');
}
