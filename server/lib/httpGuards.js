/**
 * Which browser origins may call this server, and the headers every response carries.
 *
 * ## Origins
 *
 * REST used to answer `Access-Control-Allow-Origin` with whatever origin asked
 * (`origin: true`), while Socket.IO had its own hardcoded list of two (the audit,
 * H2). There is now one list for both, from `CORS_ORIGINS` (comma-separated), and
 * by default the two local front-end addresses the app has always run on.
 *
 * A request that names an origin outside the list is refused with 403, not just
 * left without a CORS header: CORS only stops a page READING the answer, and the
 * request would still have run. A request with no `Origin` header is not from a
 * page on another site (a same-origin GET, curl, the AI service, the tests) and
 * passes; who it is, is still the token's job.
 *
 * WebSockets are not covered by CORS at all, so the same list is applied to the
 * Socket.IO handshake (`allowSocketRequest`).
 *
 * ## Headers
 *
 * One middleware, before every route. A route that needs something stricter sets
 * it afterwards and wins: the file downloads set their own `Content-Security-Policy`
 * (`default-src 'none'; sandbox`), which replaces the one here.
 */

const DEFAULT_ORIGINS = Object.freeze(['http://localhost:5173', 'http://localhost:3000']);

/** The allowed origins from a `CORS_ORIGINS` value: trimmed, no trailing slash, or the defaults. */
function allowedOrigins(value) {
  const listed = String(value || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return listed.length > 0 ? listed : [...DEFAULT_ORIGINS];
}

/** Whether a request's `Origin` header is acceptable: absent, or exactly on the list. */
function originAllowed(origin, allowed) {
  if (origin === undefined || origin === null || origin === '') return true;
  return typeof origin === 'string' && allowed.includes(origin);
}

/** Express middleware: 403 for a request from an origin that is not on the list. */
function originGate(allowed) {
  return (req, res, next) => {
    if (!originAllowed(req.headers.origin, allowed)) {
      return res.status(403).json({ error: 'That origin is not allowed' });
    }
    next();
  };
}

/** Socket.IO `allowRequest`: the same rule for the handshake. */
function allowSocketRequest(allowed) {
  return (req, callback) => callback(null, originAllowed(req.headers.origin, allowed));
}

/**
 * The headers every response carries. This server sends JSON and file
 * downloads, never a page, so the policy is "nothing": no script, no frame.
 */
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-site',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
});

/** Express middleware: set them all, before any route. */
function securityHeaders(req, res, next) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}

module.exports = {
  DEFAULT_ORIGINS,
  SECURITY_HEADERS,
  allowedOrigins,
  originAllowed,
  originGate,
  allowSocketRequest,
  securityHeaders
};
