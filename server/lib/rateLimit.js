/**
 * How often one account may do one thing.
 *
 * Only Copilot asks were limited (the audit, H1). A signed-in account could send
 * messages, file reports, upload files and sign in as fast as it could make
 * requests: flooding a chat, filling the moderation queue, or filling the
 * database with 10 MB files.
 *
 * A sliding window per key, in this process's memory. That is right for one
 * instance, which is what runs (BUILD_NOTES Entry 148: local only, no shared
 * store); a second instance would each count separately.
 *
 * The limits are generous on purpose: they are there to stop a script, not to
 * be noticed by a person. Each can be changed by its environment variable.
 */

/** `allow(key)` is true while `key` has made fewer than `max` calls in the last `windowMs`. */
function createLimiter({ max, windowMs, now = Date.now }) {
  const calls = new Map(); // key -> timestamps inside the window
  let lastSweep = now();

  // Keys that have gone quiet are dropped, or the map would grow by one entry
  // per account for as long as the process runs.
  function sweep(at) {
    if (at - lastSweep < windowMs) return;
    lastSweep = at;
    for (const [key, times] of calls) {
      if (times.length === 0 || at - times[times.length - 1] >= windowMs) calls.delete(key);
    }
  }

  function allow(key) {
    const at = now();
    sweep(at);
    const id = String(key);
    const recent = (calls.get(id) || []).filter((t) => at - t < windowMs);
    if (recent.length >= max) {
      calls.set(id, recent);
      return false;
    }
    recent.push(at);
    calls.set(id, recent);
    return true;
  }

  /** Seconds until `key` may call again; 0 if it may now. */
  function retryAfter(key) {
    const at = now();
    const recent = (calls.get(String(key)) || []).filter((t) => at - t < windowMs);
    if (recent.length < max) return 0;
    return Math.max(1, Math.ceil((recent[0] + windowMs - at) / 1000));
  }

  return { allow, retryAfter, size: () => calls.size, max, windowMs };
}

/** A whole number of at least 1 from an environment value, or the default. */
function limitFrom(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * Express middleware for a signed-in route (after requireAuth, or requireToken
 * with `keyOf`): 429 with `Retry-After` once the caller is over the limit.
 */
function limited(limiter, message, keyOf = (req) => req.authUser && req.authUser._id) {
  return (req, res, next) => {
    const key = keyOf(req);
    if (key === undefined || key === null || key === '') return next();
    if (limiter.allow(key)) return next();
    res.setHeader('Retry-After', String(limiter.retryAfter(key)));
    res.status(429).json({ error: message });
  };
}

module.exports = { createLimiter, limitFrom, limited };
