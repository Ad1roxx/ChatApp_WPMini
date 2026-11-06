/**
 * Checks for requests that only the AI service, on this machine, may make.
 *
 * Neither check is the access check. They are what stops anything else from
 * reaching the endpoint that does it: a browser page (which always sends
 * `Origin` on a cross-site POST), another host, or a local process that does
 * not hold the secret.
 */
const crypto = require('node:crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whether the TCP peer is this machine.
 *
 * Takes the socket's address, never `X-Forwarded-For`: this server trusts no
 * proxy, and a header is whatever the caller wrote.
 */
function isLoopback(remoteAddress) {
  return LOOPBACK.has(String(remoteAddress || ''));
}

/** Constant-time comparison of a presented secret with the expected one. */
function sameSecret(presented, expected) {
  if (typeof presented !== 'string' || !presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isLoopback, sameSecret };
