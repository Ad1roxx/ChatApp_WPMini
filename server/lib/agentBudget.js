/**
 * Each person's share of the model calls, per minute and per day.
 *
 * Every agent turn spends calls on a free-tier allowance the whole app shares
 * (480 a day on Gemini, counted by the AI service). AGENT_PLAN S4: "a per-user
 * budget on the agent route, counted in model calls, per minute and per day, so
 * no one user can spend the 480-a-day allowance."
 *
 * A turn's cost is not known until it ends: from one model call to the turn's
 * cap plus a file summary's calls. So a turn **reserves its worst case** before
 * it starts, and is **settled** to what it actually spent when it ends. A turn
 * that ends without saying what it spent (a timeout, a broken upstream) keeps
 * its reservation: it may have spent all of it.
 *
 * Windows are rolling, as the AI service's own count is. In memory, per process:
 * a restart forgets it. The AI service's count is the limit that protects the
 * allowance itself; this one stops a single person from using it up.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

class ModelCallBudget {
  constructor({ perMinute, perDay, now = Date.now }) {
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.now = now;
    this.entries = new Map(); // user id -> [{ at, calls }]
  }

  /** Calls this person has spent or reserved in the last `windowMs`. */
  used(userId, windowMs) {
    const now = this.now();
    return (this.entries.get(userId) || []).filter((e) => now - e.at < windowMs).reduce((n, e) => n + e.calls, 0);
  }

  /**
   * Reserve `calls` for one turn. Returns `{ entry }` to settle later, or
   * `{ limit: 'minute' | 'day' }` if it would take this person past either.
   */
  reserve(userId, calls) {
    const now = this.now();
    const kept = (this.entries.get(userId) || []).filter((e) => now - e.at < DAY_MS);
    this.entries.set(userId, kept);
    if (this.used(userId, DAY_MS) + calls > this.perDay) return { limit: 'day' };
    if (this.used(userId, MINUTE_MS) + calls > this.perMinute) return { limit: 'minute' };
    const entry = { at: now, calls };
    kept.push(entry);
    return { entry };
  }

  /** What the turn actually spent: never more than it reserved, never less than none. */
  settle(entry, spent) {
    if (!entry || !Number.isFinite(spent)) return;
    entry.calls = Math.min(entry.calls, Math.max(0, Math.round(spent)));
  }
}

module.exports = { ModelCallBudget, MINUTE_MS, DAY_MS };
