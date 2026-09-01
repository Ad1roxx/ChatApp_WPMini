/**
 * Authentication — proving a caller is who they claim to be.
 *
 * Until now every endpoint trusted a MongoDB `_id` sent in the request body.
 * The role gates were real (they read the stored role from the database, so a
 * client could not promote itself) but identity was not: anyone who knew
 * someone's id could act as them — edit their profile, read their
 * conversations, send messages as them.
 *
 * ## How the token is verified
 *
 * The frontend already holds a Firebase ID token: a JWT, signed by Google,
 * naming the user's `uid`. We verify it here.
 *
 * The usual way is `firebase-admin`, which needs a **service account JSON**
 * downloaded from the Firebase Console and kept secret. We deliberately avoid
 * that: verifying an ID token only needs Google's *public* signing
 * certificates, so there is nothing secret to distribute and no extra setup
 * step before the server will run. We fetch those certs, cache them, and
 * verify the signature ourselves.
 *
 * What is checked, and why each matters:
 * - **signature** against Google's current public cert for the token's `kid`
 *   — proves Google issued it and it has not been altered.
 * - **audience** equals our Firebase project id — stops a valid token from
 *   *someone else's* Firebase project being replayed against us.
 * - **issuer** is `https://securetoken.google.com/<projectId>` — same reason.
 * - **expiry** is enforced by `jsonwebtoken` (tokens last an hour; the client
 *   SDK refreshes them automatically).
 * - **`sub` is non-empty** — that field is the Firebase uid, and everything
 *   downstream keys off it.
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

// Cached public certs: { kid: pemCertificate }
let certCache = null;
let certCacheExpiry = 0;

/**
 * Fetch (and cache) Google's public signing certificates.
 *
 * Google rotates these, and the response's `Cache-Control: max-age` says how
 * long the current set is good for. Honouring it means we neither refetch on
 * every request nor serve a stale set after a rotation. If the header is
 * missing we fall back to an hour.
 */
async function getSigningCerts() {
  if (certCache && Date.now() < certCacheExpiry) {
    return certCache;
  }

  const response = await fetch(CERT_URL);
  if (!response.ok) {
    throw new Error(`Could not fetch Google signing certs (HTTP ${response.status})`);
  }

  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') || '');
  const ttlSeconds = maxAge ? parseInt(maxAge[1], 10) : 3600;

  certCache = await response.json();
  certCacheExpiry = Date.now() + ttlSeconds * 1000;

  return certCache;
}

/**
 * Verify a Firebase ID token and return its decoded payload.
 * Throws if the token is missing, malformed, expired or not ours.
 */
async function verifyIdToken(token) {
  if (!PROJECT_ID) {
    throw new Error(
      'FIREBASE_PROJECT_ID is not set — the server cannot verify tokens. ' +
        'See server/.env.example.'
    );
  }

  // The header names which key signed it. `complete: true` gives us the
  // header without trusting anything in the payload yet.
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) {
    throw new Error('Malformed token');
  }

  const certs = await getSigningCerts();
  const cert = certs[decoded.header.kid];
  if (!cert) {
    // A kid we don't recognise usually means the certs rotated since we
    // cached them; a forged token also lands here.
    throw new Error('Unknown signing key');
  }

  const payload = jwt.verify(token, cert, {
    algorithms: ['RS256'],
    audience: PROJECT_ID,
    issuer: `https://securetoken.google.com/${PROJECT_ID}`
  });

  if (!payload.sub) {
    throw new Error('Token has no subject');
  }

  return payload;
}

/**
 * DEV ONLY: allow an `X-Dev-User-Id` header to stand in for a real token.
 *
 * This exists so the app can be driven by an automated browser, which cannot
 * complete a Google sign-in popup, and so a role can be previewed without
 * juggling Google accounts.
 *
 * Two independent locks, because this bypasses authentication entirely:
 * - `NODE_ENV` must not be `production`
 * - `ALLOW_DEV_AUTH` must be exactly `'true'` (it is unset by default)
 *
 * The server logs a loud warning at startup whenever it is on, so it can
 * never be quietly left enabled.
 */
function devAuthEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_AUTH === 'true';
}

/**
 * Resolve the caller from a bearer token (or the dev header) to a User
 * document. Returns null when the caller cannot be identified.
 */
async function resolveUser({ authorization, devUserId }) {
  if (devAuthEnabled() && devUserId) {
    return User.findById(devUserId);
  }

  const match = /^Bearer (.+)$/i.exec(authorization || '');
  if (!match) return null;

  const payload = await verifyIdToken(match[1]);

  // The uid comes from the VERIFIED token, never from the request body.
  // This is the whole point: the client no longer chooses who it is.
  return User.findOne({ firebaseUid: payload.sub });
}

/**
 * Express middleware: require a signed-in user.
 *
 * On success attaches `req.authUser` (the Mongo document). Handlers should
 * use `req.authUser._id` rather than any id from the body or params.
 */
async function requireAuth(req, res, next) {
  try {
    const user = await resolveUser({
      authorization: req.headers.authorization,
      devUserId: req.headers['x-dev-user-id']
    });

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    req.authUser = user;
    next();
  } catch (err) {
    // Expired tokens are routine — the client retries after a refresh — so
    // they are not worth logging as errors.
    if (err.name !== 'TokenExpiredError') {
      console.error('Auth error:', err.message);
    }
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * Express middleware: require a valid token, but NOT an existing account.
 *
 * Only `/api/auth/login` uses this. That endpoint is what *creates* the Mongo
 * user, so on a genuinely first-ever sign-in there is nothing for
 * `requireAuth` to find and it would 401 every new user forever.
 *
 * Attaches `req.firebaseUser` — `{ uid, email, name, picture }` taken from the
 * verified token — and `req.authUser`, which is null on a first sign-in.
 */
async function requireToken(req, res, next) {
  try {
    const devUserId = devAuthEnabled() ? req.headers['x-dev-user-id'] : null;

    if (devUserId) {
      const user = await User.findById(devUserId);
      if (!user) return res.status(401).json({ error: 'Unknown dev user' });

      req.authUser = user;
      req.firebaseUser = {
        uid: user.firebaseUid,
        email: user.email,
        name: user.displayName,
        picture: user.photoURL
      };
      return next();
    }

    const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!match) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const payload = await verifyIdToken(match[1]);

    req.firebaseUser = {
      uid: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    };
    req.authUser = await User.findOne({ firebaseUid: payload.sub });

    next();
  } catch (err) {
    if (err.name !== 'TokenExpiredError') {
      console.error('Auth error:', err.message);
    }
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * Express middleware: require a specific role. Use AFTER requireAuth.
 *
 *   app.post('/api/admin/thing', requireAuth, requireRole('admin'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.authUser || !roles.includes(req.authUser.role)) {
      return res.status(403).json({ error: 'You do not have access to this' });
    }
    next();
  };
}

/**
 * Socket.IO handshake middleware — the socket equivalent of requireAuth.
 *
 * This matters as much as the REST side: the socket handlers used to trust a
 * `senderId` in the event payload, so a connected client could send messages
 * as anybody. Now the identity is fixed at connection time and every handler
 * reads it from `socket.data.user`.
 */
async function socketAuth(socket, next) {
  try {
    const user = await resolveUser({
      authorization: socket.handshake.auth?.token
        ? `Bearer ${socket.handshake.auth.token}`
        : null,
      devUserId: socket.handshake.auth?.devUserId
    });

    if (!user) {
      return next(new Error('Not signed in'));
    }

    socket.data.user = user;
    next();
  } catch (err) {
    console.error('Socket auth error:', err.message);
    next(new Error('Invalid or expired session'));
  }
}

module.exports = {
  requireAuth,
  requireToken,
  requireRole,
  socketAuth,
  verifyIdToken,
  devAuthEnabled
};
